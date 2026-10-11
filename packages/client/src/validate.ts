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

import { NinaValidationError, cutForMessage } from "./errors.js";
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
 * What a copy-paste leaves around an identifier: whitespace (a space, a CR from a CRLF
 * file, a tab, a non-breaking space, a BOM), invisible format characters (a zero-width
 * space) and quotes (straight, curly, guillemets).
 */
const IDENTIFIER_EDGE = /^[\s\p{Cf}"'\u2018-\u201f\u00ab\u00bb\u2039\u203a]+|[\s\p{Cf}"'\u2018-\u201f\u00ab\u00bb\u2039\u203a]+$/gu;

/** The file suffixes the API appends to an identifier in its URLs (`/warnings/<id>.json`). */
const IDENTIFIER_SUFFIXES = [".json", ".geojson"];

/**
 * A warning or archive identifier as the API knows it, from the way people copy one:
 * Unicode NFC, with the whitespace, invisible characters and quotes around it removed
 * (see `IDENTIFIER_EDGE`), and a `.json` or `.geojson` suffix (any case) dropped, as
 * copied from an API URL such as `…/warnings/<id>.json`. No real identifier has any of
 * these, and the API answers each such variant of a live id with a redirect to its
 * archive, which used to read as "the warning has expired". Case is kept: the API's
 * identifiers are case-sensitive (`mow.DE-…`, DWD's lower-case hex parts), so no case
 * can be inferred. A non-string is returned unchanged for the rule to reject.
 */
export function normalizeIdentifier(value: string): string {
  if (typeof value !== "string") return value;
  let id = value.normalize("NFC").replace(IDENTIFIER_EDGE, "");
  const lower = id.toLowerCase();
  const suffix = IDENTIFIER_SUFFIXES.find((s) => lower.endsWith(s));
  if (suffix !== undefined) id = id.slice(0, -suffix.length).replace(IDENTIFIER_EDGE, "");
  return id;
}

/**
 * A warning or archive identifier (after {@link normalizeIdentifier}) is a single path
 * segment: a non-blank string without a path separator (`/` or `\`), whitespace, control
 * or invisible format characters. A blank one would address a different path
 * (`/warnings/.json`, `/archive.mowas/-mapping.json`); one with a separator is
 * percent-encoded and can never match a real id (a `../../etc/passwd` attempt included);
 * and no real id contains whitespace or an invisible character, which the API answers with
 * a redirect to its archive. All are refused before any request rather than ending in a
 * remote 404 or a "not a live warning" that reads like an expired id.
 */
export const identifierProblem: Problem<unknown> = (value) => {
  const blank = nonBlankProblem(value);
  if (blank !== undefined) return blank;
  const text = value as string;
  if (/[/\\]/.test(text)) {
    return `${cutForMessage(JSON.stringify(text))} must not contain a path separator (/ or \\).`;
  }
  const hidden = /[\s\p{Cc}\p{Cf}]/u.exec(text);
  if (hidden !== null) {
    const code = hidden[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
    return (
      `${cutForMessage(JSON.stringify(text))} contains whitespace or an invisible character ` +
      `(U+${code}); a warning identifier has none. Copy it again from map-data or dashboard.`
    );
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
  return `Invalid source ${cutForMessage(String(JSON.stringify(value)))}. Expected one of: ${NinaSourceValues.join(", ")}.`;
};
