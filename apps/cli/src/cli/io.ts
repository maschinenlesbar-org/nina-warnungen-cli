// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fstatSync, lstatSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
   * request is not replaced either); with it the file is replaced. The default one writes
   * atomically (`nodeWriteFile`). A failure throws, its message naming the file.
   */
  writeFile(path: string, data: Buffer, overwrite: boolean): void;
  /**
   * What the `-o` path is now, checked before any request: `"absent"`, `"directory"` (one, or
   * a link to one) or `"exists"` (a file, a link to one, a dangling link). An I/O without it
   * skips the early check; the default write still refuses an existing file.
   */
  outputState?(path: string): OutputState;
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

/** What an `-o` path is before the write (`CliIO.outputState`). */
export type OutputState = "absent" | "directory" | "exists";

/** The message for an existing `-o` path without `--force`. */
export function refuseOverwrite(path: string): string {
  return `Refusing to overwrite existing file "${cutForMessage(path)}"; pass --force to overwrite.`;
}

/** The message for an `-o` path that is a directory, which `--force` can't fix. */
export function isDirectoryMessage(path: string): string {
  return `"${cutForMessage(path)}" is a directory; give a file path to --output.`;
}

/** What is at `path` on the real file system (`CliIO.outputState`). */
export function nodeOutputState(path: string): OutputState {
  try {
    return statSync(path).isDirectory() ? "directory" : "exists";
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
 * The real `-o` write (`CliIO.writeFile`). Atomic: the data goes to a temporary file beside
 * the target, renamed over it when complete, so a write cut short (a full disk, a quota)
 * leaves the old file as it was, never half of the new one. Without `overwrite` the name is
 * claimed first with an exclusive create, which fails for any existing path (a dangling link
 * too: it never follows one), and is removed again if the write fails, so the next run isn't
 * refused for a file that holds half a result. With `overwrite` a symlink is written through
 * (the file it points at is replaced) and an existing file's mode is kept. Every failure is a
 * `NinaIOError`: `refuseOverwrite`, `isDirectoryMessage`, or `Could not write to "<path>": …`.
 */
export function nodeWriteFile(path: string, data: Buffer, overwrite: boolean): void {
  if (nodeOutputState(path) === "directory") throw new NinaIOError(isDirectoryMessage(path));
  let claimed = false;
  try {
    if (!overwrite) {
      closeSync(openSync(path, "wx"));
      claimed = true;
    }
    replaceFile(overwrite ? throughLinks(path) : path, data);
  } catch (cause) {
    if (claimed) rmSync(path, { force: true });
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST" && !claimed) throw new NinaIOError(refuseOverwrite(path), { cause });
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new NinaIOError(`Could not write to "${cutForMessage(path)}": ${reason}`, { cause });
  }
}

/**
 * Replace `target` with `data` atomically: a temporary file beside it, created exclusively,
 * renamed over it. An existing file's mode is kept.
 */
function replaceFile(target: string, data: Buffer): void {
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, data, { flag: "wx" });
    const mode = modeOf(target);
    if (mode !== undefined) chmodSync(temporary, mode);
    renameSync(temporary, target);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
}

function modeOf(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o7777;
  } catch {
    return undefined;
  }
}

/** The file a path names, through any symlinks, so --force writes where a link points. A dangling link is replaced itself. */
function throughLinks(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
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
  outBinary: (data) => stdoutData(data),
  isTerminal: () => process.stdout.isTTY === true,
};
