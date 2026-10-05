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
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly location: string | undefined;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
    location?: string;
  }) {
    const parts: string[] = [];
    if (args.detail) parts.push(args.detail);
    if (args.status >= 300 && args.status < 400) {
      parts.push(
        args.location
          ? `redirect to ${args.location} not followed`
          : "redirect not followed (no Location header)",
      );
    }
    const detailPart = parts.length > 0 ? `: ${parts.join("; ")}` : "";
    // Surface only the request path in the message, not the full URL: the base
    // URL may carry credentials (userinfo) and is noisy. The complete URL stays
    // available on the `.url` property for programmatic inspection.
    super(`HTTP ${args.status} for ${args.method} ${safeTarget(args.url)}${detailPart}`);
    this.status = args.status;
    this.url = args.url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
    this.location = args.location;
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
  // `user:pw@host` without a scheme parses as a URL with the scheme "user:": no userinfo.
  if (u.username === "" && u.password === "") return redactCredentials(url, credentialsIn(url));
  u.username = "***";
  u.password = "";
  return u.href;
}

/**
 * The userinfo a URL-like value carries, exactly as written — `["alice:pa#ss"]` for
 * `https://alice:pa#ss@host` — or `[]` when it carries none. It works on values that don't
 * parse as a URL too, and on values with a prefix (`--base-url=https://u:p@h`): the userinfo
 * is everything between `://` and the last `@` before the host. A value without a scheme
 * counts when it reads `user:password@host`. Used to redact those exact strings from text
 * that echoes the value (usage errors, help), whatever characters the password contains.
 */
export function credentialsIn(value: string): string[] {
  const schemeAt = value.indexOf("://");
  const rest = schemeAt >= 0 ? value.slice(schemeAt + 3) : value;
  // Without a scheme only the unmistakable `user:password@host` form counts.
  if (schemeAt < 0 && !/^[^\s/@:]+:[^@]*@[^@\s/]/.test(rest)) return [];
  // The URL itself starts at its scheme (`--base-url=https://…` has a prefix).
  const scheme = schemeAt >= 0 ? /[a-z][a-z0-9+.-]*$/i.exec(value.slice(0, schemeAt)) : null;
  let parses = false;
  try {
    new URL(schemeAt >= 0 ? value.slice(scheme?.index ?? schemeAt) : `http://${rest}`);
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
 * cancelled or unknown warning identifier with a redirect to its archive
 * (`/api31/archive/alerts/<id>`) rather than a 404; the client does not follow it
 * and raises this instead. `location` is the archive URL the API pointed to (the
 * archive has a copy only for a warning that once existed); `cause` is the
 * underlying `NinaApiError`. The CLI maps it to exit code 4, like a 404.
 */
export class NinaNotFoundError extends NinaError {
  readonly identifier: string;
  readonly location: string | undefined;

  constructor(identifier: string, location: string | undefined, options?: { cause?: unknown }) {
    super(
      `Warning ${JSON.stringify(identifier)} is not a live warning: it has expired, been ` +
        `updated or cancelled, or never existed. The API redirects it to its archive` +
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
