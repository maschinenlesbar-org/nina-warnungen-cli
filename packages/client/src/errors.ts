// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/** Base class for every error originating from this client. */
export class NinaError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The API responded with a non-2xx status code. `detail` holds a human-readable
 * message extracted from the response body when one is present. For a 3xx — the
 * client does not follow redirects — `location` holds the redirect target
 * (absolute, sanitised, userinfo redacted) and the message names it.
 */
export class NinaApiError extends NinaError {
  readonly status: number;
  readonly detail: string | undefined;
  /** The request URL, absolute, with any userinfo redacted (`https://***@host/…`). */
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly location: string | undefined;
  /**
   * For a 429/503 that was not retried because its `Retry-After` asked for longer than the
   * client waits (`MAX_RETRY_AFTER_MS`): the requested wait in milliseconds.
   */
  readonly retryAfterMs: number | undefined;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
    location?: string;
    retryAfterMs?: number;
  }) {
    const parts: string[] = [];
    if (args.detail) parts.push(args.detail);
    if (args.retryAfterMs !== undefined) {
      parts.push(
        `the server asks to retry after ${Math.ceil(args.retryAfterMs / 1000)} s, longer than ` +
          `the 30 s this client waits, so it was not retried (more retries won't help; try again later)`,
      );
    }
    if (args.status >= 300 && args.status < 400) {
      parts.push(
        args.location
          ? `redirect to ${args.location} not followed`
          : "redirect not followed (no Location header)",
      );
    }
    const detailPart = parts.length > 0 ? `: ${parts.join("; ")}` : "";
    // Surface only the request path in the message, not the full URL: the base
    // URL may carry credentials (userinfo) and is noisy. The `.url` property keeps the
    // absolute URL with its userinfo redacted, so logging the error can't leak it.
    super(`HTTP ${args.status} for ${args.method} ${cutForMessage(safeTarget(args.url))}${detailPart}`);
    this.status = args.status;
    this.url = redactUrl(args.url);
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
    this.location = args.location;
    this.retryAfterMs = args.retryAfterMs;
  }

  /** True for statuses the API documents as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

/**
 * Reduce a full request URL to a path (+ query) for user-facing messages,
 * dropping the origin and any embedded credentials. Falls back to the raw string
 * if it isn't a parseable absolute URL.
 */
function safeTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/**
 * A URL with any userinfo replaced by `***`, for messages: a credential in a base
 * URL or a redirect target must not be printed. Unparseable input is returned as is.
 */
export function redactUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // A value that doesn't parse (a port typo, an unencoded "#" in the password) can still
    // carry credentials: cut them out by text.
    return redactCredentials(url, credentialsIn(url));
  }
  // A URL without userinfo, or `user:pw@host` without a scheme (it parses as a URL with
  // the scheme "user:"), which is no URL with credentials at all.
  if (u.username === "" && u.password === "") return redactCredentials(url, credentialsIn(url));
  u.username = "***";
  u.password = "";
  return u.href;
}

/**
 * Longest echoed value or server text (in characters) an error message shows. A
 * 400 000-character region key or identifier would otherwise put the whole input on one
 * stderr line, and a server `detail` could flood a CI log. Properties such as
 * `NinaApiError.body` and `NinaNotFoundError.identifier` keep the full value.
 */
export const MAX_MESSAGE_VALUE_LENGTH = 500;

/**
 * `text` cut to MAX_MESSAGE_VALUE_LENGTH characters, ending in "…" when cut; never inside a
 * surrogate pair (`cutText`), so the message stays well-formed.
 */
export function cutForMessage(text: string): string {
  return text.length > MAX_MESSAGE_VALUE_LENGTH ? `${cutText(text, MAX_MESSAGE_VALUE_LENGTH)}…` : text;
}

/**
 * `text` cut to at most `max` UTF-16 units, never inside a surrogate pair: when the cut
 * would land after a high surrogate it is made one unit earlier, so a message that holds
 * the cut text is well-formed (a lone `\ud83d` makes jq reject a whole JSON stream).
 * Text no longer than `max` is returned as it is; the caller marks a cut.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

/**
 * `text` with every lone surrogate (half of a character) replaced by U+FFFD, like
 * `String.prototype.toWellFormed` (ES2024, so not in this package's `lib`).
 */
export function toWellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

/**
 * The userinfo a URL carries, exactly as written — `["alice:pa#ss"]` for
 * `https://alice:pa#ss@host` — or `[]` when it carries none. Only a value that starts
 * with a scheme (`^[A-Za-z][A-Za-z0-9+.-]*://`) counts: a bare `a:b@c` is a file name
 * (`-o run:2026-10-09@x.json`), a search text or a User-Agent as often as a credential,
 * and the base URL always has a scheme. It works on URLs that don't parse too: the
 * userinfo is everything between `://` and the last `@` before the host. Used to redact
 * those exact strings from text that echoes the value (usage errors, help), whatever
 * characters the password contains.
 */
export function credentialsIn(value: string): string[] {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(value);
  if (scheme === null) return [];
  const rest = value.slice(scheme[0].length);
  let parses = false;
  try {
    new URL(value);
    parses = true;
  } catch {
    // Doesn't parse: the password may hold "/", "?", "#" or spaces.
  }
  // In a URL that parses, the userinfo ends at the last "@" of the authority (before the
  // first "/", "?" or "#"); in one that doesn't, at the last "@" of the value.
  const authority = parses ? rest.slice(0, rest.search(/[/?#]|$/)) : rest;
  const end = authority.lastIndexOf("@");
  return end > 0 ? [rest.slice(0, end)] : [];
}

/**
 * The forms in which a server may echo the credentials of a userinfo (`user:password`,
 * as `credentialsIn` returns it) back in an error body: the `Authorization: Basic` value
 * (base64 of the decoded `user:password`, UTF-8 as Node's http sends it for a URL's
 * userinfo), the decoded `user:password` itself, and the password alone when it is at
 * least 4 characters long. `[]` for a userinfo without a password. None of them has an
 * `@` to anchor on, so they are replaced as exact strings (`redactSecrets`).
 */
export function echoedCredentialForms(userinfo: string): string[] {
  const colon = userinfo.indexOf(":");
  if (colon < 0) return [];
  const decode = (part: string): string => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const user = decode(userinfo.slice(0, colon));
  const password = decode(userinfo.slice(colon + 1));
  if (password === "") return [];
  const pair = `${user}:${password}`;
  const forms = [Buffer.from(pair, "utf8").toString("base64"), pair];
  if (password.length >= 4) forms.push(password);
  return forms;
}

/**
 * `text` with every occurrence of each of `secrets` replaced by `***`, wherever it stands
 * (no `@` needed). Pass them longest first, so a secret is never left half-replaced by
 * one of its own substrings.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === "") continue;
    out = out.split(secret).join("***");
  }
  return out;
}

/**
 * `text` with every occurrence of each credential (as `credentialsIn` returns them) that is
 * followed by `@` replaced by `***`. Matching the exact strings, not a pattern, covers
 * passwords with spaces, quotes, `#`, `?` or `/` that no URL pattern can delimit. The CLI also
 * passes the escaped forms of each credential, as its messages escape values.
 */
export function redactCredentials(text: string, credentials: readonly string[]): string {
  let out = text;
  for (const secret of credentials) {
    if (secret === "") continue;
    out = out.split(`${secret}@`).join("***@");
  }
  return out;
}

/**
 * The requested warning is not a live one. The API answers an expired, updated,
 * cancelled, mistyped or unknown warning identifier alike with a redirect to its archive
 * (`/api31/archive/alerts/<id>`) rather than a 404; the client does not follow it
 * and raises this instead. `location` is the archive URL the API pointed to (the
 * archive has a copy only for a warning that once existed); `cause` is the
 * underlying `NinaApiError`. The CLI maps it to exit code 4, like a 404.
 */
export class NinaNotFoundError extends NinaError {
  readonly identifier: string;
  readonly location: string | undefined;

  constructor(identifier: string, location: string | undefined, options?: { cause?: unknown }) {
    // The API redirects *every* id it has no live warning for — an ended warning, a
    // mistyped one, one in the wrong case — so the message must not claim the warning ended.
    super(
      `Warning ${cutForMessage(JSON.stringify(identifier))} is not a live warning: no live ` +
        `warning has exactly this id (ids are case-sensitive). It may have expired, been updated ` +
        `or cancelled, or be mistyped. The API redirects it to its archive` +
        `${location ? ` (${location})` : ""}, which is not followed. Take a current id ` +
        `from map-data or dashboard.`,
      options,
    );
    this.identifier = identifier;
    this.location = location;
  }
}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class NinaNetworkError extends NinaError {}

/** The response body could not be parsed as the expected JSON shape. */
export class NinaParseError extends NinaError {}

/** A local I/O failure, e.g. writing the --output file (no such dir, EISDIR). */
export class NinaIOError extends NinaError {}

/**
 * A rejected input — a client option or a method argument that breaks one of the
 * library's rules (see validate.ts). Thrown before any request is made; the CLI
 * maps it to its usage exit code (1).
 */
export class NinaValidationError extends NinaError {}
