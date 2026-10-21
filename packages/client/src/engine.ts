// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { TextDecoder } from "node:util";
import {
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  sizeLimitMessage,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  NinaApiError,
  NinaError,
  NinaNetworkError,
  NinaParseError,
  NinaValidationError,
  credentialsIn,
  cutForMessage,
  cutText,
  echoedCredentialForms,
  redactCredentials,
  redactSecrets,
  redactUrl,
} from "./errors.js";
import { assertValid, baseUrlProblem, headerValueProblem } from "./validate.js";

export const DEFAULT_BASE_URL = "https://warnung.bund.de";
const DEFAULT_USER_AGENT = "nina-warnungen-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /**
   * Base URL of the API. Defaults to https://warnung.bund.de. A value that breaks a
   * rule of {@link validateBaseUrl} (blank, whitespace or control characters, not
   * http(s), a query or fragment) throws a `NinaValidationError` from the constructor.
   */
  baseUrl?: string | undefined;
  /**
   * Swappable transport. Defaults to the built-in node http/https transport. The engine
   * enforces `timeoutMs` and `maxResponseBytes` for any transport, reads its headers in
   * any case (a fetch `Headers` or a `Map` too) and its body as any ArrayBuffer view, and
   * turns whatever it throws into a `NinaNetworkError`.
   */
  transport?: Transport | undefined;
  /**
   * Value of the User-Agent header (default `nina-warnungen-cli`). A blank value, a
   * control character other than tab, or a character above U+00FF throws a
   * `NinaValidationError`.
   */
  userAgent?: string | undefined;
  /**
   * Per-request timeout in milliseconds (default 30 000; 0 disables), enforced by the
   * engine for every transport (the request's `signal` aborts then). Anything but
   * an integer from 0 to `MAX_TIMEOUT_MS` (2^31 - 1 ms) throws a
   * `NinaValidationError` — a negative or NaN value would otherwise mean no timeout.
   */
  timeoutMs?: number | undefined;
  /**
   * Number of automatic retries for transient (429/503) responses and reset connections
   * (`ECONNRESET`, `UND_ERR_SOCKET`, …) (default 2). A refused connection, a DNS failure
   * and a timeout are not retried. Each retry waits `retryDelayMs * attempt`, or the
   * response's `Retry-After` when that is longer (up to `MAX_RETRY_AFTER_MS`; a longer
   * one is not retried, and the error names the requested wait).
   * Anything but an integer from 0 to `MAX_RETRIES` (10) throws a `NinaValidationError`.
   */
  maxRetries?: number | undefined;
  /**
   * Base backoff between retries in milliseconds (grows linearly; default 200). A
   * `Retry-After` can make a wait longer, never shorter. Anything but an integer from 0
   * to `MAX_RETRY_AFTER_MS` (30 000) throws a `NinaValidationError`.
   */
  retryDelayMs?: number | undefined;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit. A
   * negative or non-integer value throws a `NinaValidationError`.
   */
  maxResponseBytes?: number | undefined;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Called once per retry, right before the backoff sleep, for each retried status
   * and reset connection; never when there is no retry. A throw is swallowed.
   */
  onRetry?: ((event: RetryEvent) => void) | undefined;
}

/** What `EngineOptions.onRetry` is told about one retry. */
export interface RetryEvent {
  /** Which retry this is, counting from 1. */
  retry: number;
  /** The most retries this request may make (`maxRetries`). */
  maxRetries: number;
  /** How long the engine waits before sending the request again. */
  delayMs: number;
  /** The HTTP status that caused the retry; absent for a reset connection. */
  status?: number;
  /** The URL being retried, userinfo redacted. */
  url: string;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once: retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), padded inside, any other date format — so the caller falls
 * back to its own backoff. The strict patterns matter: `Date.parse` alone would
 * read `"1.5"` as a date in 2001 and retry at once.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/**
 * Upper bound on retry attempts (`maxRetries`, `--max-retries`). Without a cap, a
 * host stuck on 429/503 combined with the linear backoff (`retryDelayMs * attempt`)
 * makes the total wait grow quadratically, so a large count would hang the process
 * for hours. 10 retries is well beyond any realistic transient blip. A larger value
 * is rejected, not clamped.
 */
export const MAX_RETRIES = 10;

/**
 * Strip control characters (all C0/C1 except tab and newline, plus DEL) out of a
 * string that originates in an attacker-controlled response — the error `detail`
 * and the echoed Content-Type. `JSON.parse` decodes an escaped ESC in an error
 * body into a real ESC byte, so without this a hostile/MITM'd endpoint could
 * drive ANSI/OSC escape sequences into the user's terminal when the message is
 * printed to stderr. The CLI's JSON output is escaped separately
 * (`escapeControlChars` in cli/shared.ts): `JSON.stringify` alone leaves DEL and
 * the C1 range raw. So this only needs to cover text that flows into a message.
 *
 * The bidi controls (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069) are dropped
 * too: an override such as U+202E would show the rest of the message reversed ("Trojan
 * Source").
 *
 * Filtered by code point rather than a regex literal, so no raw control byte ever
 * appears in this source file.
 */
function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) continue;
    if (isBidiControl(n)) continue;
    out += ch;
  }
  return out;
}

/**
 * True for a bidi formatting character: U+061C, U+200E, U+200F, U+202A–U+202E and
 * U+2066–U+2069. An override such as U+202E shows the text after it reversed ("Trojan
 * Source"), so neither a message nor printed JSON carries one raw.
 */
export function isBidiControl(c: number): boolean {
  return c === 0x061c || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
}

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) return "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer";
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by internal
 * slot, not `instanceof`, so a value from another realm (a vm context, a Jest test) counts.
 * Undefined for anything else.
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return Buffer.from(value as ArrayBuffer);
  return undefined;
}

/**
 * The response headers as a plain record with lower-case names. A transport built on
 * `fetch` naturally returns its `Headers` object, which has no plain properties, and a
 * custom one may write `Retry-After` or `Location` in any case: the engine then saw no
 * Retry-After and no Location (so a not-live redirect read as "no Location header").
 * Such an object (anything with `get` and `forEach`, a `Headers` or a `Map`) is copied
 * into a record; a plain record gets its names lower-cased.
 */
function plainHeaders(headers: object): Record<string, string | string[] | undefined> {
  const h = headers as { get?: unknown; forEach?: unknown };
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record: Record<string, string> = {};
    (h.forEach as (cb: (value: unknown, name: unknown) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = String(value);
    });
    return record;
  }
  const record: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/**
 * Error codes of a connection that broke off mid-request: Node's (`socket hang up` is
 * ECONNRESET) and undici's (`fetch failed` with cause UND_ERR_SOCKET, "other side closed").
 */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

/** True when `err` or an error in its `cause` chain has a transient connection code. */
function hasTransientCode(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return hasTransientCode((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * A validated integer engine option: `undefined` gives the default; anything but a
 * safe integer from 0 to `max` throws a `NinaValidationError`. (A negative
 * `maxResponseBytes` used to switch the size cap off, and a negative or NaN
 * `timeoutMs` the timeout, although only 0 means "no limit".)
 */
function intOption(name: string, value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new NinaValidationError(
      // A string is quoted, so `"5000"` doesn't read like the number 5000.
      `Invalid option ${name}: expected an integer from 0 to ${max}, got ` +
        `${cutForMessage(typeof value === "string" ? JSON.stringify(value) : String(value))}.`,
    );
  }
  return value;
}

/**
 * Read a function option: `undefined` gives the default; anything else that is not a
 * function throws a `NinaValidationError`. A string `transport` used to fail only at the
 * first request, and a bad `sleep` as a raw TypeError on the first retry.
 */
function functionOption<F extends (...args: never[]) => unknown>(name: string, value: F | undefined, fallback: F): F {
  if (value === undefined) return fallback;
  if (typeof value !== "function") {
    throw new NinaValidationError(`Invalid option ${name}: expected a function, got ${value === null ? "null" : typeof value}.`);
  }
  return value;
}

/**
 * Check a value bound for an HTTP header (see {@link headerValueProblem}) and
 * return it unchanged; anything else throws a NinaValidationError naming `name`
 * ("Invalid userAgent: Value contains control characters.").
 */
export function assertHeaderValue(name: string, value: string): string {
  return assertValid(name, value, headerValueProblem);
}

/**
 * Check a base URL against every rule of {@link baseUrlProblem} — blank, whitespace
 * or control characters, unparseable, a scheme other than `http:`/`https:`, a query
 * or fragment — and return it with trailing slashes stripped. A bad value throws a
 * NinaValidationError ("Invalid <name>: <reason>"): it is a configuration error, not
 * a transport failure. The raw value is checked, before the slash strip, so
 * "https://h/ " cannot slip past it.
 */
export function validateBaseUrl(raw: string, name = "baseUrl"): string {
  return assertValid(name, raw, baseUrlProblem).replace(/\/+$/, "");
}

/** True for a loopback host: `localhost`, `127.0.0.0/8` or `::1` (as `URL.hostname` gives them). */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Describe what a plain-`http:` base URL exposes on the wire, or `undefined` when there is
 * nothing to warn about: an `https:` URL, an unparseable one, or a loopback host
 * (`localhost`, `127.0.0.0/8`, `::1`). Otherwise one sentence, without a `warning: ` prefix:
 *
 * - `requests to <host> are sent unencrypted (http:, not https:)`
 * - `the base URL's credentials are sent unencrypted to <host> (http:, not https:)` when
 *   the URL carries userinfo;
 * - other secrets the caller sends (noun phrases in `secrets`, e.g. `"the API key"`) are
 *   named first, joined with the userinfo phrase by "and".
 *
 * `<host>` is the URL's host and port, never its userinfo; the sentence never contains a
 * password or key. The CLI logs it once per run as a `WARN` record of `nina.http` on stderr.
 */
export function cleartextProblem(baseUrl: string, secrets: readonly string[] = []): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" || isLoopbackHost(url.hostname)) return undefined;
  const phrases = [...secrets];
  if (url.username !== "" || url.password !== "") phrases.push("the base URL's credentials");
  if (phrases.length === 0) return `requests to ${url.host} are sent unencrypted (http:, not https:)`;
  const named =
    phrases.length === 1 ? phrases[0]! : `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]!}`;
  const verb = phrases.length === 1 && secrets.length === 1 ? "is" : "are";
  return `${named} ${verb} sent unencrypted to ${url.host} (http:, not https:)`;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RequestEngine {
  // A real private field (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show it, so a password in the base URL can't be
  // logged by accident.
  readonly #baseUrl: string;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  /**
   * The forms a server echoes that userinfo back in (the Basic value, the decoded
   * `user:password`, the password alone; `echoedCredentialForms`), longest first.
   */
  readonly #echoed: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRetry: ((event: RetryEvent) => void) | undefined;

  constructor(options: EngineOptions = {}) {
    // A JavaScript caller may pass null for "no options"; treat it like undefined.
    options = options ?? {};
    // Only an omitted baseUrl selects the default; any given value must pass the
    // library's base-URL rules here, before any request.
    this.#baseUrl = validateBaseUrl(options.baseUrl === undefined ? DEFAULT_BASE_URL : options.baseUrl);
    this.#credentials = credentialsIn(this.#baseUrl).flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
    // Longest first, so a password never leaves half of the user:password around it.
    this.#echoed = credentialsIn(this.#baseUrl).flatMap(echoedCredentialForms).sort((a, b) => b.length - a.length);
    this.transport = functionOption("transport", options.transport, nodeHttpTransport);
    // Only an omitted userAgent selects the default: a blank one is an error, not
    // a blank header, and a malformed one fails here rather than at request time.
    this.userAgent =
      options.userAgent === undefined ? DEFAULT_USER_AGENT : assertHeaderValue("userAgent", options.userAgent);
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, 30_000, MAX_TIMEOUT_MS);
    this.maxRetries = intOption("maxRetries", options.maxRetries, 2, MAX_RETRIES);
    // Bounded like a Retry-After: a larger value (above 2^31 - 1 ms) used to overflow Node's
    // timers, which fire after 1 ms instead, so the retries went out back to back.
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, 200, MAX_RETRY_AFTER_MS);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      Number.MAX_SAFE_INTEGER,
    );
    this.sleep = functionOption("sleep", options.sleep, realSleep);
    this.onRetry =
      options.onRetry === undefined ? undefined : functionOption("onRetry", options.onRetry, () => {});
  }

  /** Tell `onRetry` about a retry, then wait. A throwing callback never breaks the request. */
  private async backOff(attempt: number, delayMs: number, url: string, status?: number): Promise<void> {
    try {
      this.onRetry?.({
        retry: attempt,
        maxRetries: this.maxRetries,
        delayMs,
        ...(status !== undefined ? { status } : {}),
        url: redactUrl(url),
      });
    } catch {
      // a logging hook is no reason to fail the request
    }
    await this.sleep(delayMs);
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL, or the Authorization header and the decoded `user:password`) and
   * transport text (fetch's "Failed to fetch <url>") can carry them.
   */
  private scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactSecrets(redactCredentials(text, this.#credentials), this.#echoed);
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original when its
   * text carries no credentials, otherwise a copy with them scrubbed (message, `code` and the
   * cause chain kept), so logging the error with its causes can't reveal the base URL's
   * password.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if (this.#credentials.length === 0 || depth > 5) return cause;
    if (typeof cause === "string") return this.scrub(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.scrub(cause.message);
    if (message === cause.message && inner === cause.cause && !this.scrub(cause.stack ?? "").includes("***@")) return cause;
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /**
   * What the transport threw, as the error the engine raises, naming the request:
   * `<METHOD> <url> failed: <reason>` (userinfo redacted), with the original as `cause`. The
   * default transport rejects with `NinaNetworkError` only (a timeout, the size cap, a refused
   * connection, a DNS failure, a reset) and the engine's own deadline does too; their messages
   * carry no URL, so a caller making several calls could not tell which one failed. An
   * injected transport may throw anything (a string, a `TypeError` from fetch), and that
   * becomes the same `NinaNetworkError` — a `NinaError` a caller and the CLI can rely on —
   * with the base URL's credentials scrubbed from its message and cause chain. A message that
   * already names the request is kept (scrubbed); any other `NinaError` passes through.
   */
  private transportError(method: string, url: string, cause: unknown): NinaError {
    if (cause instanceof NinaError && !(cause instanceof NinaNetworkError)) return cause;
    const prefix = `${method} ${redactUrl(url)} failed: `;
    const reason = cause instanceof Error ? cause.message : String(cause);
    const message = sanitizeServerText(this.scrub(reason));
    if (message.startsWith(prefix)) {
      const inner = cause instanceof Error ? this.scrubCause(cause.cause) : undefined;
      if (cause instanceof NinaNetworkError && message === cause.message && inner === cause.cause) return cause;
      return new NinaNetworkError(message, inner === undefined ? undefined : { cause: inner });
    }
    return new NinaNetworkError(`${prefix}${message}`, { cause: this.scrubCause(cause) });
  }

  /**
   * Call the transport under the overall deadline (`timeoutMs`): the request gets an
   * AbortSignal that fires at the deadline, and the call rejects then whether the transport
   * stops or not — a custom transport (fetch, a node:http wrapper) that ignores `timeoutMs`
   * can't hang the caller. A synchronous throw becomes a rejection.
   */
  private async callTransport(request: HttpRequest): Promise<HttpResponse> {
    const call = (signal?: AbortSignal): Promise<HttpResponse> =>
      Promise.resolve().then(() => this.transport(signal === undefined ? request : { ...request, signal }));
    if (this.timeoutMs === 0) return call();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new NinaNetworkError(`Request exceeded the ${this.timeoutMs}ms deadline`);
        controller.abort(err);
        reject(err);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Build a fully-qualified URL from a path and optional query parameters. The base
   * URL was checked by the constructor (validateBaseUrl): an http(s) URL without a
   * query or fragment, so the path is appended as text. Its scheme is enforced
   * there, transport-independently, so a library user who injects a custom
   * Transport still cannot reach a file:/ftp: driver.
   */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams | undefined; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Accept: options.accept,
      "User-Agent": this.userAgent,
    };

    // Only an idempotent request is sent again: request() is public, and a POST re-sent
    // after a reset or a 503 may be applied twice. The client itself sends GETs only.
    const idempotent = /^(GET|HEAD)$/i.test(method);
    let attempt = 0;
    // attempts = initial try + maxRetries
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.callTransport({
          method,
          url,
          headers,
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A connection the server (or a gateway) reset is retried like a 503, whichever
        // transport reported it (Node's ECONNRESET, fetch's UND_ERR_SOCKET, anywhere in the
        // cause chain). A refused connection, a DNS failure and a timeout are not: a slow
        // or absent upstream should not be asked again at once.
        if (idempotent && hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.backOff(attempt, this.retryDelayMs * attempt, url);
          continue;
        }
        throw this.transportError(method, url, cause);
      }

      // An injected transport may resolve with anything; a malformed HttpResponse would
      // otherwise surface below as a raw TypeError, outside the NinaError contract.
      const invalid = responseProblem(response);
      if (invalid !== undefined) {
        throw new NinaNetworkError(`${method} ${redactUrl(url)} failed: the transport returned an invalid response (${invalid}).`);
      }
      const status = response.status;
      const responseHeaders = plainHeaders(response.headers);
      // fetch gives a Uint8Array; view it as a Buffer (no copy), which the decoders expect.
      const body = bodyBytes(response.body) as Buffer;
      // The size cap holds whatever the transport did: the default one aborts early, a custom
      // one may have read everything.
      if (this.maxResponseBytes > 0 && body.byteLength > this.maxResponseBytes) {
        throw new NinaNetworkError(`${method} ${redactUrl(url)} failed: ${sizeLimitMessage(this.maxResponseBytes)}`);
      }
      const retryable = status === 429 || status === 503;
      const retryAfter = retryable ? parseRetryAfter(responseHeaders["retry-after"]) : undefined;
      if (idempotent && retryable && attempt < this.maxRetries) {
        // Back off linearly (retryDelayMs * attempt). A Retry-After can make the wait longer,
        // never shorter: `Retry-After: 0` or a date in the past turned the retries into a
        // zero-delay burst against a server that had just asked for less load. A Retry-After
        // beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at once and
        // names the wait the server asked for.
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          const backoff = this.retryDelayMs * attempt;
          await this.backOff(attempt, retryAfter === undefined ? backoff : Math.max(retryAfter, backoff), url, status);
          continue;
        }
      }

      // The Content-Type is echoed to stderr (raw-download type-mismatch warning),
      // so strip control characters at the source before it leaves the engine.
      const contentType = sanitizeServerText(String(responseHeaders["content-type"] ?? ""));
      if (status < 200 || status >= 300) {
        const tooLong = retryable && retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS;
        throw this.toApiError(method, url, status, body, responseHeaders["location"], tooLong ? retryAfter : undefined);
      }

      return { data: body, contentType, status };
    }
  }

  /** Perform a GET expecting JSON and parse it into `T`. */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const text = decodeBody(res.data, res.contentType, path);
    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch (cause) {
      throw new NinaParseError(`Failed to parse JSON response from ${cutForMessage(path)}`, { cause: this.scrubCause(cause) });
    }
    // JSON.parse rounds and overflows numbers silently: refuse the answer rather than print a
    // changed value.
    const inexact = firstInexactNumber(text);
    if (inexact !== undefined) {
      throw new NinaParseError(
        `Unexpected response from ${cutForMessage(path)}: the number ${cutForMessage(inexact)} cannot be represented exactly.`,
      );
    }
    return parsed;
  }

  /** Perform a GET returning the raw bytes (GeoJSON / RSS / image downloads). */
  async getRaw(path: string, accept: string, query?: QueryParams): Promise<RawResponse> {
    return this.request("GET", path, { query, accept });
  }

  private toApiError(
    method: string,
    url: string,
    status: number,
    body: Buffer,
    locationHeader?: string | string[],
    retryAfterMs?: number,
  ): NinaApiError {
    // The body is kept on the error (`body`) and may echo the request URL: scrub it.
    const text = this.scrub(body.toString("utf8"));
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown };
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      else if (parsed && typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // Non-JSON error body; leave detail undefined.
    }
    // `detail` came from the response body; strip control characters so a hostile
    // endpoint cannot inject terminal escape sequences via the stderr error message.
    if (detail !== undefined) detail = cutForMessage(sanitizeServerText(detail).replace(/\s+/g, " ").trim());
    // Redirects are not followed; name the target (NINA redirects a warning that is
    // no longer live to its archive copy).
    const rawLocation = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
    const location =
      status >= 300 && status < 400 && rawLocation ? redirectTarget(url, rawLocation) : undefined;
    return new NinaApiError({ status, url, method, body: text, detail, location, retryAfterMs });
  }
}

/**
 * Decode a response body by the charset its Content-Type names (UTF-8 when it names
 * none). TextDecoder drops a leading byte order mark, which Buffer#toString keeps and
 * JSON.parse then rejects, so a BOM added by a proxy cannot turn a valid answer into a
 * parse error; a Latin-1 body is no longer misread as UTF-8. An unknown charset label
 * is a NinaParseError.
 */
function decodeBody(body: Buffer, contentType: string, path: string): string {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    throw new NinaParseError(`Unsupported response charset "${cutText(sanitizeServerText(charset), 100)}" from ${cutForMessage(path)}.`);
  }
  return decoder.decode(body);
}

/**
 * The absolute, printable form of a `Location` header: resolved against the request
 * URL, userinfo redacted, control characters stripped (it is server text bound for
 * stderr). An unparseable value is shown sanitised as it came.
 */
function redirectTarget(requestUrl: string, location: string): string | undefined {
  let target: string;
  try {
    target = redactUrl(new URL(location, requestUrl).href);
  } catch {
    target = location;
  }
  const clean = cutForMessage(sanitizeServerText(target).replace(/\s+/g, " ").trim());
  return clean === "" ? undefined : clean;
}

/** A JSON number token, matched at a given position (sticky). */
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * Whether the double `value` (finite) prints as the number `literal` wrote, checked where a
 * double can be off by a whole number or more: past 2^53, where every double is an integer, and
 * at 0, which a literal too small for a double becomes. Past 2^53 the CLI prints `String(value)`,
 * the shortest decimal that reads back as the same double: `12345678901234567890` prints as
 * `12345678901234567000`, a changed value, while `1E23` or `1.7976931348623157E308` (a double a
 * server printed in its own shortest form) print as the same number.
 */
function exactAtTheEdges(literal: string, value: number): boolean {
  if (value !== 0 && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return true;
  const written = decimalOf(literal);
  if (value === 0) return written.digits === "";
  const printed = decimalOf(String(value));
  return written.negative === printed.negative && written.digits === printed.digits && written.exponent === printed.exponent;
}

/** A decimal literal as sign, significant digits (no leading or trailing zeros) and exponent: digits × 10^exponent. */
function decimalOf(text: string): { negative: boolean; digits: string; exponent: number } {
  const [, sign = "", whole = "", fraction = "", exp = "0"] = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text) ?? [];
  const all = (whole + fraction).replace(/^0+/, "");
  const digits = all.replace(/0+$/, "");
  return { negative: sign === "-", digits, exponent: Number(exp) - fraction.length + (all.length - digits.length) };
}

/**
 * The first number literal in `json` (JSON that parsed) that JSON.parse cannot carry exactly, or
 * undefined: one out of a double's range (`1e400` became Infinity, printed as `null`), one past
 * 2^53 that it rounds, in any form (`12345678901234567890`, `12345678901234567890.0`,
 * `9007199254740993e0`, `9007199254740992.5`), and a non-zero one too small for a double
 * (`1e-400` became 0). Below 2^53 a decimal fraction keeps a double's usual precision, as JSON
 * means it. A linear scan that skips strings; a reviver would recurse per nesting level.
 */
function firstInexactNumber(json: string): string | undefined {
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c === 0x22) {
      // a string: skip to its closing quote, past escapes
      for (i++; i < json.length; i++) {
        const d = json.charCodeAt(i);
        if (d === 0x5c) i++;
        else if (d === 0x22) break;
      }
    } else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      JSON_NUMBER.lastIndex = i;
      const literal = JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      const value = Number(literal);
      if (!Number.isFinite(value) || !exactAtTheEdges(literal, value)) return literal;
      i += literal.length - 1;
    }
  }
  return undefined;
}
