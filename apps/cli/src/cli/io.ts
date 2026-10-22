// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { NinaClient } from "@maschinenlesbar.org/nina-warnungen-client/internal/client";
import type { EngineOptions } from "@maschinenlesbar.org/nina-warnungen-client/internal/engine";
import { NinaIOError, cutForMessage } from "@maschinenlesbar.org/nina-warnungen-client/internal/errors";
import { createLogger, type Logger } from "./log.js";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /**
   * Write `data` to the `-o` file. Without `overwrite` an existing path is refused (the
   * default one claims the name with an exclusive create, so a file that appeared during the
   * request is not replaced either); with it the file is replaced. The default one writes a
   * file atomically and a stream (`/dev/null`, a FIFO, `/dev/stdout`) in place
   * (`nodeWriteFile`). A failure throws, its message naming the file.
   */
  writeFile(path: string, data: Buffer, overwrite: boolean): void;
  /**
   * What the `-o` path is now, checked before any request: `"absent"`, `"directory"` (one, or
   * a link to one), `"stream"` (a character device, a FIFO, a socket, a descriptor path such
   * as `/dev/stdout`) or `"exists"` (a file, a link to one, a dangling link). An I/O without it
   * skips the early check; the default write still refuses an existing file.
   */
  outputState?(path: string): OutputState;
  /**
   * Why the file an `-o` path names (through any links, with `overwrite`) cannot be created where
   * it would go, or undefined: its directory is missing, not a directory or not writable, or the
   * links loop. Checked before the request. An I/O without it skips that check.
   */
  outputParentProblem?(path: string, overwrite: boolean): string | undefined;
  /** Write raw bytes to stdout (binary-safe). */
  outBinary(data: Buffer): void;
  /**
   * Whether stdout is a terminal. Raw downloads go out byte-for-byte only when this
   * returns `false` (a pipe or file); otherwise (a terminal, or an I/O without this
   * method) control characters are escaped so server bytes cannot drive the terminal.
   */
  isTerminal?(): boolean;
}

export interface CliDeps {
  io: CliIO;
  /** Build a client from the resolved global options (injectable for tests). */
  createClient(options: EngineOptions): NinaClient;
  /**
   * Where diagnostics go: one record per line on stderr, in the `--log-format`
   * (`log.ts`). `run()` sets it from argv; deps without it log text through `io.err`.
   */
  log?: Logger;
  /** The clock the log's timestamps come from. Unset, the real one. */
  now?: () => Date;
}

/**
 * What an `-o` path is before the write (`CliIO.outputState`): nothing, a directory, a stream (a
 * character device such as `/dev/null`, a FIFO, a socket, or a descriptor path such as
 * `/dev/stdout` or `/dev/fd/63` from `>(…)`), or anything else (a regular file, a link: a
 * dangling one too).
 */
export type OutputState = "absent" | "directory" | "stream" | "exists";

/** A path that names an open descriptor: `/dev/stdout`, `/dev/stderr`, `/dev/fd/N`, `/proc/self/fd/N`. */
const DESCRIPTOR_PATH = /^\/dev\/(?:stdout|stderr|fd\/\d+)$|^\/proc\/self\/fd\/\d+$/;

/** The longest file name (in bytes) most file systems take (NAME_MAX). */
const NAME_MAX = 255;

/** The message for an existing `-o` path without `--force`. */
export function refuseOverwrite(path: string): string {
  return `Refusing to overwrite existing file "${cutForMessage(path)}"; pass --force to overwrite.`;
}

/** The message for an `-o` path that is a directory, which `--force` can't fix. */
export function isDirectoryMessage(path: string): string {
  return `"${cutForMessage(path)}" is a directory; give a file path to --output.`;
}

/** What is at `path` on the real file system (`CliIO.outputState`): a dangling link counts as "exists". */
export function nodeOutputState(path: string): OutputState {
  // A descriptor path is the shell's redirection (`-o /dev/stdout`, `-o >(gzip > x.gz)`):
  // written in place even when it leads to a regular file, which the shell opened.
  if (DESCRIPTOR_PATH.test(path)) return "stream";
  try {
    const stats = statSync(path);
    if (stats.isDirectory()) return "directory";
    return stats.isFIFO() || stats.isCharacterDevice() || stats.isSocket() ? "stream" : "exists";
  } catch {
    // statSync follows a link; a dangling one is still something an exclusive create
    // refuses, so lstat decides between "exists" and "absent".
    try {
      lstatSync(path);
      return "exists";
    } catch {
      return "absent";
    }
  }
}

/**
 * Why the file `path` names (through any links, with `overwrite`) cannot be created where it
 * would go, on the real file system (`CliIO.outputParentProblem`), or undefined: its directory
 * is missing, not a directory, or not writable; or the link chain loops. A typo in the path is
 * then a usage error before the request, not an ENOENT after it.
 */
export function nodeOutputParentProblem(path: string, overwrite: boolean): string | undefined {
  let target: string;
  try {
    target = overwrite ? linkTarget(path) : path;
  } catch (err) {
    return `Cannot write to "${cutForMessage(path)}": ${reasonOf(err)}`;
  }
  const dir = dirname(target);
  try {
    if (!statSync(dir).isDirectory()) return `Cannot write to "${cutForMessage(path)}": "${cutForMessage(dir)}" is not a directory.`;
    accessSync(dir, constants.W_OK | constants.X_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return `Cannot write to "${cutForMessage(path)}": the directory "${cutForMessage(dir)}" does not exist.`;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      return `Cannot write to "${cutForMessage(path)}": no permission to create files in "${cutForMessage(dir)}".`;
    }
    return `Cannot write to "${cutForMessage(path)}": ${reasonOf(err)}`;
  }
  return undefined;
}

/**
 * Node's error text without its `, open '<path>'` tail, which named the hidden temporary file
 * (`ENAMETOOLONG: name too long, open '.x….json.123-0d1a.tmp'`) instead of the user's file.
 */
function reasonOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/, \w+ '.*'$/s, "");
}

/**
 * The real `-o` write (`CliIO.writeFile`). A stream (`/dev/null`, a FIFO, a socket,
 * `/dev/stdout`, `/dev/fd/N`) can't be renamed over and nothing in it can be lost: it is written
 * in place, every byte, with no claim and no temporary file. A file is written atomically: the
 * data goes to a temporary file beside the target, renamed over it when complete, so a write cut
 * short (a full disk, a quota) leaves the old file as it was, never half of the new one. Without
 * `overwrite` the name is claimed first with an exclusive create, which fails for any existing
 * path (a dangling link too: it never follows one), and is removed again if the write fails, so
 * the next run isn't refused for a file that holds half a result. With `overwrite` a symlink is
 * written through (the file it points at is replaced, or created when the link dangles; the link
 * stays) and an existing file's mode is kept. A signal during the write (SIGINT, SIGTERM, SIGHUP)
 * removes the claim and the temporary file, then exits 130, 143 or 129. Every failure is a
 * `NinaIOError`: `refuseOverwrite`, `isDirectoryMessage`, or `Could not write to "<path>": …`.
 */
export function nodeWriteFile(path: string, data: Buffer, overwrite: boolean): void {
  const state = nodeOutputState(path);
  if (state === "directory") throw new NinaIOError(isDirectoryMessage(path));
  try {
    if (state === "stream") return writeInPlace(path, data);
    if (overwrite) return replaceFile(linkTarget(path), data);
    writeClaimed(path, data);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST" && !overwrite) throw new NinaIOError(refuseOverwrite(path), { cause });
    throw new NinaIOError(`Could not write to "${cutForMessage(path)}": ${reasonOf(cause)}`, { cause });
  }
}

/** Paths to remove if a signal ends the run: the claim and the temporary file of a write under way. */
const pending = new Set<string>();

/** The exit codes of the signals that remove `pending` paths: 128 + the signal's number. */
const SIGNAL_EXITS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

let signalsHandled = false;

/**
 * From the first file write on, SIGINT, SIGTERM and SIGHUP remove the claim and the temporary
 * file of a write under way, then exit with 130, 143 or 129. Before, Node's default action
 * killed the process mid-write and left an empty claim (the next run refused it as an existing
 * file) and the whole temporary file. The write itself is synchronous, so a signal that arrives
 * during it is handled once it is done. Not installed for a stream: a handler restarts a blocked
 * `open()` of a FIFO without a reader, so Ctrl-C could not end the wait.
 */
function removeOnSignals(): void {
  if (signalsHandled) return;
  signalsHandled = true;
  for (const [signal, code] of Object.entries(SIGNAL_EXITS)) {
    process.once(signal, () => {
      for (const path of pending) rmSync(path, { force: true });
      pending.clear();
      process.exit(code);
    });
  }
}

/** Claim `path` (exclusive create), then replace the claim with `data`; the claim is removed on a failure. */
function writeClaimed(path: string, data: Buffer): void {
  removeOnSignals();
  closeSync(openSync(path, "wx"));
  pending.add(path);
  try {
    replaceFile(path, data);
  } catch (err) {
    // A write cut short (a full disk, a quota) leaves no file under the new name either, so
    // the next run isn't refused for a file that holds half a result.
    rmSync(path, { force: true });
    throw err;
  } finally {
    pending.delete(path);
  }
}

/**
 * Replace `target` with `data` atomically: a temporary file beside it, created exclusively,
 * renamed over it. An existing file's mode is kept.
 */
function replaceFile(target: string, data: Buffer): void {
  removeOnSignals();
  const temporary = join(dirname(target), temporaryName(basename(target)));
  pending.add(temporary);
  try {
    writeFileSync(temporary, data, { flag: "wx" });
    const mode = modeOf(target);
    if (mode !== undefined) chmodSync(temporary, mode);
    renameSync(temporary, target);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  } finally {
    pending.delete(temporary);
  }
}

/**
 * The temporary file's name for `base`: `.<base>.<pid>-<random>.tmp`, within NAME_MAX bytes. A
 * long base name is shortened (at a character boundary), the random part is kept, so a valid
 * name of up to 255 bytes can be written (`ENAMETOOLONG` named the hidden file before).
 */
function temporaryName(base: string): string {
  const suffix = `.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  const room = NAME_MAX - 1 - Buffer.byteLength(suffix);
  let kept = base;
  while (Buffer.byteLength(kept) > room) kept = kept.slice(0, kept.length - (/[\udc00-\udfff]$/.test(kept) ? 2 : 1));
  return `.${kept}${suffix}`;
}

function modeOf(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o7777;
  } catch {
    return undefined;
  }
}

/** Most links followed for one `-o` path, as the kernel's ELOOP limit. */
const MAX_LINKS = 40;

/**
 * The file a path names, through any symlinks, so `--force` writes where a link points: also
 * when the link dangles, where the file it names is created (the link stays). A loop throws
 * (ELOOP).
 */
function linkTarget(path: string): string {
  let current = resolve(path);
  for (let hops = 0; hops <= MAX_LINKS; hops++) {
    let link: string;
    try {
      if (!lstatSync(current).isSymbolicLink()) return current;
      link = readlinkSync(current);
    } catch {
      return current; // nothing there (yet): this is the file to create
    }
    current = resolve(dirname(current), link);
  }
  throw Object.assign(new Error("too many levels of symbolic links"), { code: "ELOOP" });
}

/** Write `data` to a stream target (a device, a FIFO, a descriptor path) in place, every byte. */
function writeInPlace(path: string, data: Buffer): void {
  // Append: on a descriptor path that leads to a file (`-o /dev/stdout >> log`), the shell's
  // own mode stands; on a device or a FIFO it makes no difference.
  let fd: number;
  try {
    fd = openSync(path, "a");
  } catch (err) {
    // Linux can't open a socket through its descriptor path (ENXIO), and a process started
    // with socket stdio (Node's child_process, a service manager) has one: `-o /dev/stdout` is
    // then written to the descriptor the process already holds, which stays open.
    const own = descriptorOf(path);
    if ((err as NodeJS.ErrnoException).code !== "ENXIO" || own === undefined) throw err;
    return writeAll(own, data);
  }
  try {
    writeAll(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** The descriptor a descriptor path names (`/dev/stdout` 1, `/dev/fd/63` 63), else undefined. */
function descriptorOf(path: string): number | undefined {
  if (path === "/dev/stdout") return 1;
  if (path === "/dev/stderr") return 2;
  const n = /^\/(?:dev|proc\/self)\/fd\/(\d+)$/.exec(path)?.[1];
  return n === undefined ? undefined : Number(n);
}

/** The deps' logger, or one that writes text records through `io.err`. */
export function logOf(deps: CliDeps): Logger {
  return deps.log ?? createLogger({ format: "text", write: (line) => deps.io.err(line), ...(deps.now === undefined ? {} : { now: deps.now }) });
}

/** The two process streams, as far as `handleOutputErrors` needs them. */
export interface OutputStreams {
  stdout: Pick<NodeJS.WriteStream, "on">;
  stderr: Pick<NodeJS.WriteStream, "on">;
}

/**
 * Handle write errors on stdout/stderr, which Node otherwise reports as an
 * unhandled 'error' event: a raw stack trace and exit 1.
 *
 * A reader that stops early — `| head`, `| jq` exiting on the first match, a closed
 * pager — closes the pipe while the CLI is still writing, and the next write fails
 * with EPIPE (ENOTCONN when stdout is a socket whose peer has gone, as when a Node
 * parent spawns the CLI with piped stdio on macOS). That is ordinary use, so the
 * process exits 0 at once, quietly. Any
 * other stdout error is an ERROR record of `nina.output` (`Could not write to stdout:
 * <message>`, through `log`, in the run's format) and exits 1. On stderr an EPIPE (or
 * ENOTCONN) is ignored, so a failed run keeps its exit code; any other stderr error
 * exits 1 silently (there is nowhere left to report it).
 * The bin shim installs this once, before `run()`, with a logger for the format argv
 * asks for (`processLogger`).
 */
export function handleOutputErrors(
  streams: OutputStreams = process,
  exit: (code: number) => void = (code) => process.exit(code),
  log: Pick<Logger, "error"> = createLogger({ format: "text", write: (line) => process.stderr.write(line + "\n") }),
): void {
  streams.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (readerGone(err)) return exit(0);
    log.error("output", `Could not write to stdout: ${err.message}`);
    exit(1);
  });
  // stderr's reader going away doesn't make a failed run a success: ignore EPIPE there and
  // let the run's own exit code stand (`2>&1 | true` must not turn a usage error into 0).
  streams.stderr.on("error", (err: NodeJS.ErrnoException) => {
    if (!readerGone(err)) exit(1);
  });
}

/** True for the write errors that mean the reader has gone: EPIPE, or ENOTCONN on a socket. */
function readerGone(err: NodeJS.ErrnoException): boolean {
  return err.code === "EPIPE" || err.code === "ENOTCONN";
}

/** What `stderrAfterStdout` needs of stdout: its backlog, and the events that end one. */
export interface StdoutBacklog {
  readonly writableLength: number;
  on(event: "drain" | "close" | "error", listener: () => void): unknown;
}

/** How often a held record checks whether stdout's backlog is gone (ms). */
const BACKLOG_POLL_MS = 10;

/**
 * A stderr writer that waits for stdout. With both streams on one pipe (`2>&1 |`) and a
 * slow reader, stdout's data is still queued in the process while a record is written
 * to stderr at once, so the record could land inside the JSON (at 64 KiB). Here a text is
 * held while `stdout.writableLength > 0` and written, in order, once the backlog is
 * gone: on stdout's `drain`, `close` or `error`, or at the latest when a short poll sees
 * it empty (`drain` only follows a write that returned false). The poll keeps the
 * process alive until then, so a held record is never lost at exit.
 */
export function stderrAfterStdout(stdout: StdoutBacklog, write: (text: string) => void): (text: string) => void {
  const held: string[] = [];
  let poll: ReturnType<typeof setInterval> | undefined;
  const flush = (): void => {
    if (poll !== undefined) clearInterval(poll);
    poll = undefined;
    for (const text of held.splice(0)) write(text);
  };
  let listening = false;
  return (text) => {
    if (held.length === 0 && stdout.writableLength === 0) return write(text);
    held.push(text);
    if (!listening) {
      listening = true;
      for (const event of ["drain", "close", "error"] as const) stdout.on(event, flush);
    }
    poll ??= setInterval(() => {
      if (stdout.writableLength === 0) flush();
    }, BACKLOG_POLL_MS);
  };
}

const stderrLine = stderrAfterStdout(process.stdout, (text) => process.stderr.write(text + "\n"));

/** A short pause for a non-blocking descriptor that is full (EAGAIN), without a busy loop. */
const pause = new Int32Array(new SharedArrayBuffer(4));

/**
 * Write all of `data` to `fd`, or throw. `writeSync` may write less than asked (a file-size
 * limit, a full disk): the rest is written in a loop, and the call that cannot write throws
 * (EFBIG, ENOSPC). A descriptor the shell made non-blocking answers EAGAIN while the reader is
 * behind: wait a moment and go on.
 */
function writeAll(fd: number, data: Buffer): void {
  for (let at = 0; at < data.length; ) {
    try {
      at += writeSync(fd, data, at);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
      Atomics.wait(pause, 0, 0, 5);
    }
  }
}

/** What `stdoutWriter` needs of stdout. */
interface Stdout {
  write(data: string | Buffer): unknown;
  emit(event: "error", err: Error): unknown;
  readonly fd?: number;
}

/**
 * A writer for stdout that never drops a byte silently. When stdout is a regular file
 * (`> out.json`), Node's stream wrote it with one `writeSync` and ignored a short count, so a
 * file-size limit or a full disk cut the output short with exit 0 and nothing on stderr. Here
 * the text (or a raw download's bytes) is written with `writeAll`, and a failure (EFBIG, ENOSPC)
 * is emitted as stdout's `error`, which `handleOutputErrors` turns into an ERROR record of
 * `nina.output` and exit 1. A pipe, a socket or a terminal goes through the stream as before
 * (EPIPE stays quiet).
 */
export function stdoutWriter(
  stdout: Stdout = process.stdout,
  write: (fd: number, data: Buffer) => void = writeAll,
): (data: string | Buffer) => void {
  let toFile: boolean | undefined;
  return (data) => {
    toFile ??= stdout.fd !== undefined && isRegularFile(stdout.fd);
    if (!toFile) {
      stdout.write(data);
      return;
    }
    try {
      write(stdout.fd as number, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    } catch (err) {
      stdout.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  };
}

function isRegularFile(fd: number): boolean {
  try {
    return fstatSync(fd).isFile();
  } catch {
    return false;
  }
}

const stdoutData = stdoutWriter();

export const defaultIO: CliIO = {
  out: (text) => stdoutData(text + "\n"),
  // A record never lands inside the data when both streams share a pipe.
  err: stderrLine,
  writeFile: nodeWriteFile,
  outputState: nodeOutputState,
  outputParentProblem: nodeOutputParentProblem,
  outBinary: (data) => stdoutData(data),
  isTerminal: () => process.stdout.isTTY === true,
};
