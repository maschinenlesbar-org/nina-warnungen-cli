// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the two result-rendering paths (JSON and raw download).

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import { NinaError } from "../client/errors.js";
import { baseUrlProblem, headerValueProblem } from "../client/validate.js";
import { DEFAULT_BASE_URL, cleartextProblem, type EngineOptions, type RawResponse } from "../client/engine.js";

/**
 * commander value-parser: a plain non-negative decimal integer.
 *
 * Only accepts an optional leading run of digits with no sign, decimal point,
 * whitespace, exponent or radix prefix. This deliberately rejects forms that
 * `Number()` would otherwise coerce (e.g. "", "  5", "0x10", "1e3", "5.0",
 * "Infinity"), so a typo never silently becomes a surprising value.
 */
export function parseIntArg(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("Value is too large.");
  }
  return n;
}

/** commander value-parser factory: a non-negative integer between `min` and `max`. */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value) => {
    const n = parseIntArg(value);
    if (n < min || n > max) {
      throw new InvalidArgumentError(`Expected a value between ${min} and ${max}.`);
    }
    return n;
  };
}

/**
 * commander value-parser for a value that ends up in an HTTP header (`--user-agent`).
 * The rule is the library's {@link headerValueProblem} — blank, control characters
 * other than tab, DEL and characters above U+00FF are rejected — so a bad value is a
 * usage error here, as it is a NinaValidationError in the client.
 */
export function parseHeaderValue(value: string): string {
  const problem = headerValueProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

/**
 * commander value-parser for `--base-url`. The rule is the library's
 * {@link baseUrlProblem}: an absolute `http:`/`https:` URL without a query,
 * fragment, whitespace or control characters. A bad value is a usage error here, as
 * it is a NinaValidationError from the client constructor; the CLI keeps no rules of
 * its own.
 */
export function parseBaseUrl(value: string): string {
  const problem = baseUrlProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

export interface GlobalOptions {
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
  output?: string;
}

/** Translate resolved global CLI options into client EngineOptions. */
export function toEngineOptions(global: GlobalOptions): EngineOptions {
  const options: EngineOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/**
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c >= 0x7f && c <= 0x9f) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * Escape the control characters in raw text bound for a terminal: C0 except tab,
 * newline and carriage return, DEL and C1 become `\uXXXX`. Keeps a server's
 * OSC/CSI sequences (window title, colours, worse) from reaching the terminal, and
 * a JSON body stays JSON (these characters are only legal escaped inside strings).
 */
export function escapeTerminalControls(text: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const control = (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || (c >= 0x7f && c <= 0x9f);
    if (control) {
      result += text.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? text : result + text.slice(from);
}

/**
 * JSON.stringify, with a clean error for a value nested too deeply to print.
 * `JSON.parse` reads any depth, but stringify recurses and overflows the stack on
 * a hostile body (200 000 levels), which would otherwise surface as an
 * "Unexpected error". Pretty-printing recurses deeper than compact output.
 */
export function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new NinaError(
        compact
          ? "The response is nested too deeply to print."
          : "The response is nested too deeply to pretty-print; try --compact.",
      );
    }
    throw err;
  }
}

/**
 * Render a JSON value, pretty by default, compact with --compact. Writes to the
 * file given by --output when present (so `-o` is honoured for JSON commands, not
 * only raw downloads), otherwise to stdout. When writing a file we print a short
 * confirmation to stderr so stdout stays clean for piping.
 */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  const output = resolveOutput(global.output);
  if (output !== undefined) {
    const data = Buffer.from(text + "\n", "utf8");
    deps.io.writeFile(output, data);
    deps.io.err(`Wrote ${data.length} bytes to ${output}`);
  } else {
    deps.io.out(text);
  }
}

/**
 * Resolve the --output target. `undefined` means "write to stdout": no -o given, or
 * `-o -`, the common convention for stdout (it used to write a file named "-").
 * An explicitly empty string is a user error (e.g. `--output "$OUT"` with an
 * unset variable) and must not silently fall through to stdout, so we reject it.
 */
export function resolveOutput(output: string | undefined): string | undefined {
  if (output === undefined || output === "-") return undefined;
  if (output === "") {
    throw new NinaError("--output requires a non-empty file path.");
  }
  return output;
}

/**
 * Render a raw (binary/text) download. Writes to the file given by --output, or
 * to stdout otherwise: byte-for-byte to a pipe or file, with control characters
 * escaped (`escapeTerminalControls`) to a terminal. Prints a short confirmation to stderr when writing a file
 * so stdout stays clean for piping.
 *
 * `expectContentType` is an optional substring sanity check. A misconfigured
 * gateway can return an HTML error page with a 200 status; without this the bytes
 * would be saved silently to e.g. `out.geojson`. We do not fail (the body may be
 * valid with an unusual type), but we warn to stderr so the surprise is visible.
 */
export function renderRaw(
  deps: CliDeps,
  global: GlobalOptions,
  response: RawResponse,
  expectContentType?: string,
): void {
  if (expectContentType && !response.contentType.toLowerCase().includes(expectContentType)) {
    deps.io.err(
      `Warning: expected a "${expectContentType}" response but got ` +
        `"${response.contentType || "(none)"}". The body may not be what you expect.`,
    );
  }
  const output = resolveOutput(global.output);
  if (output !== undefined) {
    deps.io.writeFile(output, response.data);
    deps.io.err(`Wrote ${response.data.length} bytes to ${output}`);
  } else if (deps.io.isTerminal?.() === false) {
    // A pipe or file: the bytes exactly as the server sent them.
    deps.io.outBinary(response.data);
  } else {
    // A terminal: escape control characters so the body cannot drive it.
    deps.io.outBinary(Buffer.from(escapeTerminalControls(response.data.toString("utf8")), "utf8"));
  }
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments. When the
 * effective base URL is remote plain `http:`, one `warning: …` line goes to stderr
 * first ({@link cleartextProblem}); help, version and usage errors never reach here.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    // One stderr line before any request when the base URL is remote plain http:.
    const cleartext = cleartextProblem(global.baseUrl ?? DEFAULT_BASE_URL);
    if (cleartext !== undefined) deps.io.err(`warning: ${cleartext}`);
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
