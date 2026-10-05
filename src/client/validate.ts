// Input validation shared by the library and the CLI. Every rule about what a
// request may contain lives here (or next to the option it guards) as a pure,
// exported function, so the CLI calls the very same rule instead of keeping a copy.
//
// - A `Problem` returns the reason a value is invalid ("Expected a non-empty
//   value."), or `undefined` when it is valid. The CLI's commander parsers turn
//   that reason into an `InvalidArgumentError` (a usage error, exit 1).
// - `assertValid` runs a `Problem` in the library and throws a
//   `NinaValidationError` ("Invalid <name>: <reason>") before any request is made.
//   Methods that return a promise call it inside the async body, so they reject
//   rather than throw synchronously; constructors throw.

import { NinaValidationError } from "./errors.js";
import { NinaSourceValues } from "./enums.js";

/** A validation rule: the reason `value` is invalid, or `undefined` when it is valid. */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Check `value` against `problem` and return it unchanged when it is valid.
 * Otherwise throw a {@link NinaValidationError} with the message
 * `Invalid <name>: <reason>`.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new NinaValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/** A value must be a string that is not blank (`""` or whitespace only). */
export const nonBlankProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  if (value.trim() === "") return "Expected a non-empty value.";
  return undefined;
};

/**
 * A warning or archive identifier is a single path segment: a non-blank string
 * without a path separator (`/` or `\`). A blank one would address a different
 * path (`/warnings/.json`, `/archive.mowas/-mapping.json`), and one with a separator
 * is percent-encoded and can never match a real id (a `../../etc/passwd` attempt
 * included), so both are refused before any request rather than ending in a remote
 * 404 or a "not a live warning" that reads like an expired id.
 */
export const identifierProblem: Problem<unknown> = (value) => {
  const blank = nonBlankProblem(value);
  if (blank !== undefined) return blank;
  if (/[/\\]/.test(value as string)) {
    return `${JSON.stringify(value)} must not contain a path separator (/ or \\).`;
  }
  return undefined;
};

/**
 * A value that ends up in an HTTP header (the User-Agent) must be a non-blank
 * string of Latin-1 characters without control characters (tab is allowed, as in
 * HTTP). Node's HTTP layer would otherwise throw an opaque "Invalid character in
 * header content" at request time, and a custom transport would get a CR/LF
 * through (header injection). Checked by char code so the source stays free of
 * control bytes.
 */
export const headerValueProblem: Problem<unknown> = (value) => {
  const blank = nonBlankProblem(value);
  if (blank !== undefined) return blank;
  const text = value as string;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

/**
 * A base URL must be an absolute `http:`/`https:` URL without a query or fragment,
 * and without whitespace or control characters. `new URL()` trims surrounding
 * whitespace and drops tab/CR/LF silently, so the raw string is checked rather
 * than the parsed one; request paths are appended to the base's path as text, so
 * a `?` or `#` would swallow them and every call would fetch the base URL itself.
 * Userinfo (`user:pw@`) is allowed, and redacted in messages; a `%` in it must start a
 * valid escape (`%25` for a literal one), as Node decodes it for the Authorization header.
 */
export const baseUrlProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  if (value.trim() === "") return "Expected an absolute http(s) URL.";
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return "A base URL cannot contain whitespace or control characters.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Expected an absolute http(s) URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Unsupported scheme "${url.protocol}". Expected an http(s) URL.`;
  }
  if (/[?#]/.test(value)) return "A base URL cannot have a query (?) or fragment (#).";
  // Node decodes the userinfo into the Authorization header and throws "URI malformed" for a
  // "%" that isn't an escape — at request time, as a network error. Reject it here.
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  return undefined;
};

/**
 * A `mapData` source must be one of `NinaSourceValues` (an array lookup, so an
 * inherited name such as `toString` is no source). The message quotes the value
 * with JSON.stringify, so a control character in it is escaped, never printed raw.
 */
export const sourceProblem: Problem<unknown> = (value) => {
  if ((NinaSourceValues as readonly unknown[]).includes(value)) return undefined;
  return `Invalid source ${JSON.stringify(value)}. Expected one of: ${NinaSourceValues.join(", ")}.`;
};
