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
 * message extracted from the response body when one is present.
 */
export class NinaApiError extends NinaError {
  readonly status: number;
  readonly detail: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
  }) {
    const detailPart = args.detail ? `: ${args.detail}` : "";
    // Surface only the request path in the message, not the full URL: the base
    // URL may carry credentials (userinfo) and is noisy. The complete URL stays
    // available on the `.url` property for programmatic inspection.
    super(`HTTP ${args.status} for ${args.method} ${safeTarget(args.url)}${detailPart}`);
    this.status = args.status;
    this.url = args.url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
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

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class NinaNetworkError extends NinaError {}

/** The response body could not be parsed as the expected JSON shape. */
export class NinaParseError extends NinaError {}

/** A local I/O failure, e.g. writing the --output file (no such dir, EISDIR). */
export class NinaIOError extends NinaError {}
