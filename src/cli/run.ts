// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import type { CliDeps } from "./io.js";
import { NinaApiError, NinaError } from "../client/errors.js";

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

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  const program = buildProgram(deps);
  const sink: OutputSink = { out: [], err: [] };
  configureTree(program, sink);

  // Flush commander's buffered output. `helpToStdout` routes the buffered
  // writeErr lines to stdout: commander emits no-command help (a bare invocation
  // or a bare command group) via writeErr, and we want that to match an explicit
  // `--help` (stdout, exit 0) rather than landing on stderr.
  const flush = (helpToStdout: boolean): void => {
    for (const line of sink.out) deps.io.out(line);
    const errSink = helpToStdout ? deps.io.out : deps.io.err;
    for (const line of sink.err) errSink(line);
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
    if (err instanceof NinaApiError) {
      deps.io.err(`Error: ${err.message}`);
      // Map a few notable statuses to distinct exit codes for scripting.
      if (err.status === 404) return 4;
      return 1;
    }
    if (err instanceof NinaError) {
      deps.io.err(`Error: ${err.message}`);
      return 1;
    }
    deps.io.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
