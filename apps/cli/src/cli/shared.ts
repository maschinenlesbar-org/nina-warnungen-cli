// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the two result-rendering paths (JSON and raw download).

import { constants } from "node:buffer";
import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { isDirectoryMessage, logOf, refuseOverwrite, type CliDeps } from "./io.js";
import { NinaError, NinaIOError, NinaValidationError, cutForMessage, quoteValue } from "@maschinenlesbar.org/nina-warnungen-client/internal/errors";
import { baseUrlProblem, headerValueProblem } from "@maschinenlesbar.org/nina-warnungen-client/internal/validate";
import { DEFAULT_BASE_URL, cleartextProblem, isBidiControl, type EngineOptions, type RawResponse } from "@maschinenlesbar.org/nina-warnungen-client/internal/engine";
import type { RetryEvent } from "@maschinenlesbar.org/nina-warnungen-client/internal/engine";

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

/**
 * Make every single-value option of `command` and its subcommands refuse a second value:
 * `--timeout 100 --timeout 200` is a usage error (`--timeout may be given only once.`, exit 1,
 * before any request), never "the last one wins", which silently dropped the first value. Flags
 * (no value) may repeat. A repeatable option is declared with an array default
 * (`.option("--tag <t>", …, collect, [])`): each value adds to the list. nina has none today.
 * Call it once on a finished program; it wraps each option's own value parser.
 */
export function forbidRepeatedOptions(command: Command): void {
  for (const option of command.options) {
    if ((!option.required && !option.optional) || option.variadic || Array.isArray(option.defaultValue)) continue;
    const parse = option.parseArg;
    let given = false;
    const guarded = (value: string, previous: unknown): unknown => {
      if (given) throw new InvalidArgumentError(`${option.long ?? option.short} may be given only once.`);
      given = true;
      return parse === undefined ? value : parse(value, previous);
    };
    option.parseArg = guarded as typeof option.parseArg;
  }
  for (const child of command.commands) forbidRepeatedOptions(child);
}

export interface GlobalOptions {
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
  output?: string;
  force?: boolean;
}

/**
 * commander value-parser for `-o, --output <file>`: a blank path is a usage error. `-` is stdout;
 * any other value starting with a dash is refused as the next option.
 */
export function parseOutputPath(value: string): string {
  if (value.trim() === "") throw new InvalidArgumentError("Expected a non-empty value.");
  // Any other dash-leading value is the next option, consumed because -o was left without a
  // value: `nina map-data dwd -o --compact` wrote a pretty-printed file named "--compact" with
  // exit 0. commander hands the parser the same string for `-o -x` and `--output=-x`, so a file
  // whose name starts with a dash is written as `./-x`.
  if (value !== "-" && value.startsWith("-")) {
    throw new InvalidArgumentError(
      `looks like a missing value — ${quoteValue(value)} is the next option, consumed because ` +
        "this one was left without a value. For a file whose name starts with a dash, write ./-name.",
    );
  }
  return value;
}

/**
 * Check `-o` before any request, so a refused target costs none: `--force` without `-o`, a
 * directory, an existing path (a dangling link too) without `--force`, and a file whose
 * directory is missing, not a directory or not writable are usage errors (a
 * NinaValidationError: exit 1, an ERROR record of nina.cli). A stream (`/dev/null`, a FIFO,
 * `/dev/stdout`, `>(…)`) needs no `--force`: it is written in place, and nothing in it can be
 * lost. `-o -` is stdout. The write checks again: a file that appears during the request is
 * not overwritten either (a NinaIOError then, of nina.output).
 */
export function checkOutputTarget(deps: CliDeps, global: GlobalOptions): void {
  if (global.force === true && global.output === undefined) {
    throw new NinaValidationError("--force needs --output (it only allows overwriting the -o file).");
  }
  const path = resolveOutput(global.output);
  if (path === undefined) return;
  const state = deps.io.outputState?.(path);
  if (state === "directory") throw new NinaValidationError(isDirectoryMessage(path));
  if (state === "stream") return;
  if (state === "exists" && global.force !== true) throw new NinaValidationError(refuseOverwrite(path));
  const problem = deps.io.outputParentProblem?.(path, global.force === true);
  if (problem !== undefined) throw new NinaValidationError(problem);
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

/** True for a UTF-16 unit `escapeControlChars` writes as `\uXXXX`. */
function escaped(c: number): boolean {
  return (c >= 0x7f && c <= 0x9f) || isBidiControl(c);
}

/** How many input characters `escapeControlChars` turns into one piece of output at a time. */
const ESCAPE_CHUNK = 1 << 16;

/**
 * Escape the characters JSON.stringify leaves raw although a terminal acts on them. It
 * escapes C0 (including ESC) but not DEL, the C1 range U+0080–U+009F (U+009B is the 8-bit
 * form of CSI) or the bidi formatting characters (isBidiControl), which reorder the text that
 * follows. The output is server data, so escape them; the result is equivalent, valid JSON
 * (these characters only occur inside strings). Checked by char code so the source stays
 * free of control bytes.
 *
 * Each such character becomes six, so the output is measured first: one longer than V8's
 * longest string is a NinaIOError ("too large to print"), before anything is built. Then the
 * output is built in chunks of ESCAPE_CHUNK characters, each made flat at once, and joined
 * once: one `+=` per character made a rope of 100 M pieces on an answer of DEL characters, and
 * the process died of a heap out-of-memory crash.
 */
export function escapeControlChars(json: string): string {
  let count = 0;
  for (let i = 0; i < json.length; i++) if (escaped(json.charCodeAt(i))) count++;
  if (count === 0) return json;
  const length = json.length + 5 * count;
  if (length > MAX_TEXT_LENGTH) {
    throw new NinaIOError(`The answer is too large to print (${length} characters once its control characters are escaped).`);
  }
  const chunks: string[] = [];
  for (let start = 0; start < json.length; start += ESCAPE_CHUNK) {
    const end = Math.min(start + ESCAPE_CHUNK, json.length);
    const parts: string[] = [];
    let from = start;
    for (let i = start; i < end; i++) {
      const c = json.charCodeAt(i);
      if (!escaped(c)) continue;
      parts.push(json.slice(from, i), "\\u" + c.toString(16).padStart(4, "0"));
      from = i + 1;
    }
    parts.push(json.slice(from, end));
    chunks.push(parts.join(""));
  }
  return chunks.join("");
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

/** The longest string V8 makes (2^29 - 24 characters on 64-bit): a longer JSON text can't be printed at once. */
const MAX_TEXT_LENGTH = constants.MAX_STRING_LENGTH;

/**
 * JSON.stringify, pretty or compact. Printing can fail two ways, both a NinaIOError (exit 1, an
 * ERROR record of `nina.output`) that names the cause, never "Unexpected error":
 * - an answer nested too deeply (hostile or broken) overflows the stack: "nested too deeply";
 * - a text longer than V8's longest string ("Invalid string length"): "too large to print".
 * "try --compact" is added only when the compact form of this very answer prints: it is probed,
 * not assumed, because whether compact output survives deep nesting depends on the Node version
 * (on Node 26 only the fast path is iterative) and on the machine's stack. On Node 22 and 24 the
 * hint was wrong advice: --compact failed at the same depth.
 *
 * Compact output takes V8's fast path (no gap) unless the answer holds a huge string: on Node 26
 * the fast path aborts the process ("Zone Allocation failed", exit 134, a native dump on stderr)
 * on a string of some 250 MB that JSON.parse made, while the gap path (an empty gap, the same
 * text) prints it. The fast path stays the default because on Node 26 only it is iterative and
 * prints nesting the gap path refuses (~7,000 levels).
 */
export function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? stringifyCompact(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    const deep = /call stack/i.test(err.message);
    const cause = deep ? "nested too deeply" : `too large (more than ${MAX_TEXT_LENGTH} characters of JSON)`;
    const hint = !compact && compactPrints(value) ? "; try --compact" : "";
    throw new NinaIOError(`The answer is ${cause} to ${compact ? "print" : "pretty-print"}${hint}.`, { cause: err });
  }
}

/** Compact JSON: the fast path, or the gap path for an answer holding a huge string. */
function stringifyCompact(value: unknown): string {
  return holdsHugeString(value) ? JSON.stringify(value, null, "") : JSON.stringify(value);
}

/** Whether `--compact` prints this answer on this runtime (the hint after a failed pretty-print). */
function compactPrints(value: unknown): boolean {
  try {
    return stringifyCompact(value).length <= MAX_TEXT_LENGTH;
  } catch {
    return false;
  }
}

/** A string or key this long sends --compact through the gap path: a quarter of where Node 26's fast path aborts. */
const HUGE_STRING_LENGTH = 64 * 1024 * 1024;

/**
 * Whether `value` holds a string or key of HUGE_STRING_LENGTH or more. Iterative, so nesting
 * costs no stack, linear, and without an allocation per value: an array is walked by index, an
 * object by `for…in` (own keys only: an answer's objects have none inherited), and only nested
 * objects and arrays are kept for later. (`Object.entries` made a pair per element: on an array
 * of 48M numbers that took 7 GB and crashed.)
 */
function holdsHugeString(value: unknown): boolean {
  if (typeof value === "string") return value.length >= HUGE_STRING_LENGTH;
  const pending: object[] = [];
  if (typeof value === "object" && value !== null) pending.push(value);
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        const element: unknown = item[i];
        if (typeof element === "string") {
          if (element.length >= HUGE_STRING_LENGTH) return true;
        } else if (typeof element === "object" && element !== null) pending.push(element);
      }
      continue;
    }
    const record = item as Record<string, unknown>;
    for (const key in record) {
      if (key.length >= HUGE_STRING_LENGTH) return true;
      const element = record[key];
      if (typeof element === "string") {
        if (element.length >= HUGE_STRING_LENGTH) return true;
      } else if (typeof element === "object" && element !== null) pending.push(element);
    }
  }
  return false;
}

/**
 * `deps.io.writeFile`, with any failure a `NinaIOError` (message and cause kept), so
 * every `-o` failure is logged under `nina.output`, whatever the `CliIO` threw. Without
 * `--force` an existing file is refused.
 */
function writeOutputFile(deps: CliDeps, global: GlobalOptions, path: string, data: Buffer): void {
  try {
    deps.io.writeFile(path, data, global.force === true);
  } catch (cause) {
    if (cause instanceof NinaIOError) throw cause;
    throw new NinaIOError(cause instanceof Error ? cause.message : String(cause), { cause });
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
    writeOutputFile(deps, global, output, data);
    logOf(deps).info("output", `Wrote ${data.length} bytes to ${output}`);
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
 * valid with an unusual type), but we warn to stderr so the surprise is visible. The
 * warning quotes the server's Content-Type cut at `MAX_MESSAGE_VALUE_LENGTH` (500).
 */
export function renderRaw(
  deps: CliDeps,
  global: GlobalOptions,
  response: RawResponse,
  expectContentType?: string,
): void {
  if (expectContentType && !response.contentType.toLowerCase().includes(expectContentType)) {
    logOf(deps).warn(
      "api",
      `expected a "${expectContentType}" response but got ` +
        `"${cutForMessage(response.contentType) || "(none)"}". The body may not be what you expect.`,
    );
  }
  const output = resolveOutput(global.output);
  if (output !== undefined) {
    writeOutputFile(deps, global, output, response.data);
    logOf(deps).info("output", `Wrote ${response.data.length} bytes to ${output}`);
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

/** `HTTP 503 from host: retry 1 of 3 in 2 s` (host only; whole seconds, ms under 1 s). */
export function retryMessage(event: RetryEvent): string {
  let host: string;
  try {
    host = new URL(event.url).host;
  } catch {
    host = "the server";
  }
  const why = event.status === undefined ? "connection reset" : `HTTP ${event.status}`;
  const wait = event.delayMs < 1000 ? `${event.delayMs} ms` : `${Math.round(event.delayMs / 1000)} s`;
  return `${why} from ${host}: retry ${event.retry} of ${event.maxRetries} in ${wait}`;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments. When the
 * effective base URL is remote plain `http:`, one WARN record of `nina.http` goes to
 * stderr first ({@link cleartextProblem}); help, version and usage errors never reach here.
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
    // A refused -o target costs no request.
    checkOutputTarget(deps, global);
    // One stderr record before any request when the base URL is remote plain http:.
    const cleartext = cleartextProblem(global.baseUrl ?? DEFAULT_BASE_URL);
    if (cleartext !== undefined) logOf(deps).warn("http", cleartext);
    const options = toEngineOptions(global);
    options.onRetry = (event) => logOf(deps).warn("http", retryMessage(event));
    // Text in an answer replaced with U+FFFD is said, never silent (D2).
    options.onWarning = (message) => logOf(deps).warn("api", message);
    const client = deps.createClient(options);
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
