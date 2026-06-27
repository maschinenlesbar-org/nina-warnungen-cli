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
 * Render a JSON value, pretty by default, compact with --compact. Writes to the
 * file given by --output when present (so `-o` is honoured for JSON commands, not
 * only raw downloads), otherwise to stdout. When writing a file we print a short
 * confirmation to stderr so stdout stays clean for piping.
 */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
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
 * to stdout otherwise. Prints a short confirmation to stderr when writing a file
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
  } else {
    deps.io.outBinary(response.data);
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
