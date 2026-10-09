// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { writeFileSync } from "node:fs";
import type { NinaClient } from "../client/client.js";
import type { EngineOptions } from "../client/engine.js";
import { NinaIOError } from "../client/errors.js";
import { createLogger, type Logger } from "./log.js";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /** Persist raw bytes to a file. */
  writeFile(path: string, data: Buffer): void;
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
 * other stdout error prints one `Output error: <message>` line to stderr and exits
 * 1. On stderr an EPIPE (or ENOTCONN) is ignored, so a failed run keeps its exit code; any other stderr
 * error exits 1 silently (there is nowhere left to report it).
 * The bin shim installs this once, before `run()`.
 */
export function handleOutputErrors(
  streams: OutputStreams = process,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  streams.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (readerGone(err)) return exit(0);
    process.stderr.write(`Output error: ${err.message}\n`);
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

export const defaultIO: CliIO = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
  writeFile: (path, data) => {
    // A failed file write (no such dir, EISDIR, EACCES) is a routine,
    // user-caused condition — classify it as a NinaError so run() prints a clean
    // "Error: ..." rather than the "Unexpected error:" wording for internal bugs.
    try {
      writeFileSync(path, data);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new NinaIOError(`Failed to write ${path}: ${reason}`, { cause });
    }
  },
  outBinary: (data) => process.stdout.write(data),
  isTerminal: () => process.stdout.isTTY === true,
};
