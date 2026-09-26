// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the two result-rendering paths (JSON and raw download).

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import { NinaError } from "../client/errors.js";
import type { EngineOptions, RawResponse } from "../client/engine.js";

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
 * The most retries the engine will ever perform. Mirrors the engine's internal
 * `MAX_RETRIES_CAP` (which still clamps as a defence for direct library users);
 * surfacing it here lets the CLI *reject* an out-of-range value with a clear
 * message rather than silently clamping it, matching the rest of the CLI's
 * validate-and-reject style.
 */
export const MAX_RETRIES_LIMIT = 10;

/** commander value-parser for `--max-retries`: a non-negative integer, max 10. */
export function parseMaxRetries(value: string): number {
  const n = parseIntArg(value);
  if (n > MAX_RETRIES_LIMIT) {
    throw new InvalidArgumentError(`Expected a value between 0 and ${MAX_RETRIES_LIMIT}.`);
  }
  return n;
}

/**
 * commander value-parser for a value that ends up in an HTTP header (`--user-agent`).
 * A blank value is rejected like every free-text option. Node's HTTP layer throws an
 * opaque "Invalid character in header content" at request time for a CR/LF (or any
 * other C0 control or DEL) and for any character above U+00FF, which surfaced as
 * "Unexpected error"; reject those here as a usage error. Tab is allowed, as in HTTP.
 * Checked by char code so the source stays free of control bytes.
 */
export function parseHeaderValue(value: string): string {
  if (value.trim() === "") {
    throw new InvalidArgumentError("Expected a non-empty value.");
  }
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) {
      throw new InvalidArgumentError("Value contains control characters.");
    }
    if (c > 0xff) {
      throw new InvalidArgumentError("Value contains characters outside Latin-1 (above U+00FF).");
    }
  }
  return value;
}

/**
 * commander value-parser for `--base-url`: an absolute http(s) URL. A `file:`,
 * `ftp:` or malformed value is a usage error at parse time (the engine and the
 * default transport still enforce the scheme for direct library users).
 */
export function parseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidArgumentError("Expected an absolute http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidArgumentError(
      `Unsupported scheme "${url.protocol}". Expected an http(s) URL.`,
    );
  }
  // The request path is appended to the base URL as text, so a query or fragment
  // would swallow it: every command would fetch the base URL itself.
  if (/[?#]/.test(value)) {
    throw new InvalidArgumentError("A base URL cannot have a query (?) or fragment (#).");
  }
  return value;
}

/**
 * Validate a positional argument against an allowed set (commander does not
 * support .choices() on positional args). Throws a NinaError so run() prints a
 * clear message and exits 1.
 */
export function assertEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  argName: string,
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new NinaError(`Invalid ${argName} "${value}". Expected one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

/**
 * Validate a required free-form positional (an identifier or region key). Both
 * are single path segments, so two inputs can only ever produce a remote 404 (or
 * a confusing parse error) for what is really a local input mistake — reject them
 * up front with a clear message (exit 1) instead:
 *   - empty/whitespace-only (would build a path like `dashboard/.json`);
 *   - one containing a path separator (`/` or `\`), e.g. a `../../etc/passwd`
 *     traversal attempt — these are percent-encoded and can never match a real id.
 */
export function requireIdentifier(value: string, argName: string): string {
  if (value.trim() === "") {
    throw new NinaError(`A non-empty ${argName} is required.`);
  }
  if (/[/\\]/.test(value)) {
    throw new NinaError(`Invalid ${argName} "${value}": must not contain a path separator.`);
  }
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
 * Resolve the --output target. `undefined` means "no -o given" (write to stdout).
 * An explicitly empty string is a user error (e.g. `--output "$OUT"` with an
 * unset variable) and must not silently fall through to stdout, so we reject it.
 */
function resolveOutput(output: string | undefined): string | undefined {
  if (output === undefined) return undefined;
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
 * options + this command's options) and the command's positional arguments.
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
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
