// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import { logOf, type CliDeps } from "./io.js";
import { createLogger, logFormatFromArgv } from "./log.js";
import {
  NinaApiError,
  NinaError,
  NinaIOError,
  NinaNetworkError,
  NinaNotFoundError,
  NinaValidationError,
  credentialsIn,
  redactCredentials,
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
 * Replace the userinfo of every URL in `text` with `***`, the form `redactUrl` gives
 * (`https://user:secret@host` becomes `https://***@host`). Text-based, so it also
 * covers a URL that does not parse; a backstop behind the exact-string redaction.
 */
export function redactUserinfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#']*@/gi, "$1***@");
}

/**
 * `deps` with an `io` that redacts the credentials of every argument from everything it
 * prints on stdout and stderr. Commander echoes rejected values in its errors
 * (`option '--base-url <url>' argument '…' is invalid`), and the CLI's own messages name
 * identifiers: whatever path a credential takes, the exact userinfo (as `credentialsIn`
 * finds it, plus its terminal-escaped and JSON-quoted forms) is replaced by `***`. A
 * pattern alone can't delimit a password with spaces, quotes, `#`, `?` or `/`; the exact
 * strings can. Raw downloads (`outBinary`) and files are server data and pass unchanged,
 * as does all output when no argument carries credentials.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const secrets = new Set<string>();
  for (const source of [...argv, ...values]) {
    for (const secret of credentialsIn(source)) {
      secrets.add(secret);
      secrets.add(escapeTerminalControls(secret));
      secrets.add(JSON.stringify(secret).slice(1, -1));
    }
  }
  if (secrets.size === 0) return deps;
  const list = [...secrets];
  const redact = (text: string): string => redactUserinfo(redactCredentials(text, list));
  return {
    ...deps,
    io: { ...deps.io, out: (text) => deps.io.out(redact(text)), err: (text) => deps.io.err(redact(text)) },
  };
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  deps = withRedactedOutput(deps, argv);
  // Every record goes through the redacted `io.err`, so a secret is kept out of the
  // log in either format.
  const redacted = deps;
  deps = {
    ...deps,
    log: createLogger({ format: logFormatFromArgv(argv), write: (line) => redacted.io.err(line), ...(deps.now === undefined ? {} : { now: deps.now }) }),
  };
  const program = buildProgram(deps);
  const sink: OutputSink = { out: [], err: [] };
  configureTree(program, sink);

  // Flush commander's buffered output. `helpToStdout` routes the buffered
  // writeErr lines to stdout: commander emits no-command help (a bare invocation
  // or a bare command group) via writeErr, and we want that to match an explicit
  // `--help` (stdout, exit 0) rather than landing on stderr.
  const flush = (helpToStdout: boolean): void => {
    for (const line of sink.out) deps.io.out(line);
    // commander's own messages are log records too: its "error: …" an ERROR, the help it
    // shows after one an INFO. Help for a bare invocation is stdout data, not a record.
    for (const line of sink.err) {
      if (helpToStdout) deps.io.out(line);
      // The blank line commander writes between an error and the help it shows after.
      else if (line === "") continue;
      else if (line.startsWith("error: ")) logOf(deps).error("cli", line.slice("error: ".length));
      else logOf(deps).info("cli", line);
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
