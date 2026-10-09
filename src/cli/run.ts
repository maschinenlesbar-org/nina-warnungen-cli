// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import { logOf, type CliDeps } from "./io.js";
import { DEFAULT_LOG_FORMAT, createLogger, logFormatFromArgv, type LogFormat, type Logger } from "./log.js";
import {
  NinaApiError,
  NinaError,
  NinaIOError,
  NinaNetworkError,
  NinaNotFoundError,
  NinaValidationError,
  credentialsIn,
  echoedCredentialForms,
  redactCredentials,
  redactSecrets,
} from "../client/errors.js";
import { escapeTerminalControls } from "./shared.js";

interface OutputSink {
  out: string[];
  err: string[];
}

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 *
 * Commander's own output (help, version, parse-error text) is buffered into
 * `sink` so run() can route it *after* it knows the outcome: a help display goes
 * to stdout (matching `--help`), genuine errors to stderr. Action output is
 * written through deps.io directly and never passes through here.
 */
function configureTree(command: Command, sink: OutputSink): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => sink.out.push(str.replace(/\n$/, "")),
    writeErr: (str) => sink.err.push(str.replace(/\n$/, "")),
  });
  for (const child of command.commands) configureTree(child, sink);
}

/**
 * The names (long and short) of the program's own options that require a value. Only the
 * program's: commander takes them out of argv before a subcommand parses, so after a
 * subcommand the next token is the subcommand's to read.
 */
function valueOptionsOf(program: Command): Set<string> {
  const names = new Set<string>();
  for (const option of program.options) {
    if (!option.required) continue;
    if (option.long !== undefined) names.add(option.long);
    if (option.short !== undefined) names.add(option.short);
  }
  return names;
}

/**
 * One chunk of commander's stderr output as log records, one per line. Its `error: …`
 * is an ERROR of `cli`, with a following `(Did you mean …?)` line appended to that same
 * record; anything else (the help it shows after an error) is one INFO record per
 * non-blank line. The blank line commander writes between an error and the help is
 * dropped.
 */
function commanderRecords(log: Logger, text: string): void {
  if (text.trim() === "") return;
  if (text.startsWith("error: ")) {
    log.error("cli", joinHint(text.slice("error: ".length)));
    return;
  }
  for (const line of text.split("\n")) if (line.trim() !== "") log.info("cli", line.trimEnd());
}

/** `message` with a final `\n(Did you mean …?)` line joined to it by a space: one record. */
function joinHint(message: string): string {
  return message.replace(/\n(\(Did you mean [^\n]*\?\))$/, " $1");
}

/**
 * Replace the userinfo of every URL in `text` with `***`, the form `redactUrl` gives
 * (`https://user:secret@host` becomes `https://***@host`). Text-based, so it also
 * covers a URL that does not parse; a backstop behind the exact-string redaction.
 */
export function redactUserinfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#']*@/gi, "$1***@");
}

/**
 * The options whose value is the base URL: a `user:password@host` given there without
 * its scheme is still a credential (anywhere else a bare `a:b@c` is not).
 */
const BASE_URL_FLAGS = ["--base-url"];

/** The values of the `flags` in `argv`, in both forms (`--flag value`, `--flag=value`). */
function flagValues(argv: readonly string[], flags: readonly string[]): string[] {
  const found: string[] = [];
  argv.forEach((token, i) => {
    const next = argv[i + 1];
    if (flags.includes(token) && next !== undefined) found.push(next);
    const eq = token.indexOf("=");
    if (eq > 0 && flags.includes(token.slice(0, eq))) found.push(token.slice(eq + 1));
  });
  return found;
}

/** The secrets of a run, and the two ways they are replaced. */
export interface Redaction {
  /**
   * stdout text: the userinfo of every URL-like argument replaced (`***@`), and the
   * forms a server echoes it back in (the Basic value, the decoded `user:password`).
   */
  out(text: string): string;
  /** stderr text, a record's message: that, and the password alone (`***`). */
  err(text: string): string;
}

/**
 * The secrets of the run in `argv`. Commander echoes rejected values in its errors
 * (`option '--base-url <url>' argument '…' is invalid`), and the CLI's own messages name
 * identifiers: whatever path a credential takes, the exact userinfo (as `credentialsIn`
 * finds it, plus its terminal-escaped and JSON-quoted forms) is replaced by `***`. Only a
 * URL with a scheme carries one (a bare `a:b@c` is an `-o` file name or a User-Agent as
 * often as a credential), except as the `--base-url` value, which is read as a URL. A
 * pattern alone can't delimit a password with spaces, quotes, `#`, `?` or `/`; the exact
 * strings can. Without secrets the text passes through unchanged.
 */
export function redactionFor(argv: readonly string[]): Redaction {
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const secrets = new Set<string>();
  const echoed = new Set<string>();
  const passwords = new Set<string>();
  // A base URL typed without its scheme is read as if it had one.
  const baseUrls = flagValues(argv, BASE_URL_FLAGS).map((value) => (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`));
  for (const source of [...values, ...baseUrls]) {
    for (const secret of credentialsIn(source)) {
      secrets.add(secret);
      secrets.add(escapeTerminalControls(secret));
      secrets.add(JSON.stringify(secret).slice(1, -1));
      // What a server echoes back: the Basic value and the decoded user:password on
      // stdout and stderr, the password alone (it may well occur in the data) on stderr.
      const [basic, pair, password] = echoedCredentialForms(secret);
      if (basic !== undefined) echoed.add(basic);
      if (pair !== undefined) echoed.add(pair);
      if (password !== undefined) passwords.add(password);
    }
  }
  if (secrets.size === 0) return { out: (text) => text, err: (text) => text };
  const list = [...secrets];
  // Longest first, so a secret is never left half-replaced by one of its own substrings.
  const echoedList = [...echoed].sort((a, b) => b.length - a.length);
  const passwordList = [...passwords].sort((a, b) => b.length - a.length);
  const out = (text: string): string => redactSecrets(redactUserinfo(redactCredentials(text, list)), echoedList);
  return { out, err: (text) => redactSecrets(out(text), passwordList) };
}

/**
 * `deps` that keep the secrets of this run (`redactionFor`) out of everything they
 * print: `io.out` is redacted, and the log (`deps.log`) replaces them in each record's
 * message before formatting it, then writes to the raw `io.err`, so the frame is never
 * touched. `io.err` itself is redacted too, for anything that writes to stderr without
 * the log. Raw downloads (`outBinary`) and files are server data and pass unchanged.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  const redaction = redactionFor(argv);
  const { out, err } = deps.io;
  return {
    ...deps,
    io: { ...deps.io, out: (text) => out(redaction.out(text)), err: (text) => err(redaction.err(text)) },
    log: createLogger({
      format: logFormatFromArgv(argv),
      write: err,
      redact: redaction.err,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  };
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  // The log replaces the secrets of the run in every message, in either format.
  deps = withRedactedOutput(deps, argv);
  const program = buildProgram(deps);
  const sink: OutputSink = { out: [], err: [] };
  configureTree(program, sink);
  // For the records of a parse error: the scan of argv, now knowing which of the
  // program's options take a value, as commander reads them.
  const log = deps.log;
  if (log !== undefined) log.format = logFormatFromArgv(argv, valueOptionsOf(program));
  // One source for the format once commander has parsed argv: its value, not the scan
  // of argv (an option's value can look like --log-format; `--` ends the scan, not
  // commander's parse of a value). Ancestors' hooks run first, so this precedes every
  // other preAction check.
  program.hook("preAction", (_program, actionCommand) => {
    const format = (actionCommand.optsWithGlobals() as { logFormat?: LogFormat }).logFormat;
    if (log !== undefined) log.format = format ?? DEFAULT_LOG_FORMAT;
  });

  // Flush commander's buffered output. `helpToStdout` routes the buffered
  // writeErr lines to stdout: commander emits no-command help (a bare invocation
  // or a bare command group) via writeErr, and we want that to match an explicit
  // `--help` (stdout, exit 0) rather than landing on stderr.
  const flush = (helpToStdout: boolean): void => {
    for (const line of sink.out) deps.io.out(line);
    // commander's own messages are log records too, one per line (`commanderRecords`).
    // Help for a bare invocation is stdout data, not a record.
    for (const text of sink.err) {
      if (helpToStdout) deps.io.out(text);
      else commanderRecords(logOf(deps), text);
    }
  };

  try {
    await program.parseAsync(argv, { from: "user" });
    flush(false);
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // A help/version display is a success: commander shows the requested text —
      // help from an explicit `--help` ("commander.helpDisplayed") or from a bare
      // invocation / bare command group ("commander.help"), or the version from
      // `--version` — so we exit 0. Help written for a bare invocation lands on
      // writeErr, so route it to stdout to match `--help`. Genuine parse errors
      // (unknown command/option, missing argument) keep their own non-zero exit
      // code and stay on stderr.
      const isHelp =
        err.code === "commander.help" || err.code === "commander.helpDisplayed";
      flush(isHelp);
      return isHelp ? 0 : err.exitCode;
    }
    flush(false);
    const log = logOf(deps);
    if (err instanceof NinaValidationError) {
      // The library rejected an input before any request: a usage error, with the
      // exit code commander gives a value its parsers reject (1).
      log.error("cli", err.message);
      return 1;
    }
    if (err instanceof NinaNotFoundError) {
      // A warning id that is no longer live: NINA redirects it to its archive
      // instead of answering 404, so it gets the not-found exit code too.
      log.error("api", err.message);
      return 4;
    }
    if (err instanceof NinaApiError) {
      log.error("api", err.message);
      // Map a few notable statuses to distinct exit codes for scripting.
      if (err.status === 404) return 4;
      return 1;
    }
    if (err instanceof NinaError) {
      log.error(err instanceof NinaNetworkError ? "http" : err instanceof NinaIOError ? "output" : "cli", err.message);
      return 1;
    }
    log.error("cli", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
