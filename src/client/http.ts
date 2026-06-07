// HTTP transport built on Node's built-in `http`/`https` modules — no axios,
// no fetch polyfill, no third-party HTTP client.
//
// The transport is a plain function so it can be trivially swapped out in tests
// (inject a `mock.fn()` returning a canned HttpResponse) without touching the
// network. The default implementation below is exercised against a real local
// `http.createServer` in the test-suite.

import http from "node:http";
import https from "node:https";
import { NinaNetworkError } from "./errors.js";

/**
 * Turn an opaque Node transport error into a message that points at the likely
 * cause (usually a wrong/unreachable --base-url) instead of just echoing the raw
 * resolver/socket string. Keeps the original text for context.
 */
function describeNetworkError(err: NodeJS.ErrnoException, host: string): string {
  switch (err.code) {
    case "ECONNREFUSED":
      return `Could not connect to ${host} (connection refused). Check the host/port and --base-url.`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `Could not resolve host ${host}. Check the --base-url and your network/DNS.`;
    case "ECONNRESET":
      return `Connection to ${host} was reset.`;
    case "ETIMEDOUT":
      return `Connection to ${host} timed out.`;
    default:
      return err.message;
  }
}

export interface HttpRequest {
  method: string;
  /** Fully-qualified absolute URL. */
  url: string;
  headers?: Record<string, string>;
  /** Optional request body (already serialised). */
  body?: string | Buffer;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Hard cap on the response body size in bytes; the request aborts if exceeded. */
  maxResponseBytes?: number;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/**
 * Default transport. Resolves with the raw response (including non-2xx) — status
 * interpretation is the client's job. Rejects only on transport-level failures
 * (connection errors, timeouts, malformed URLs).
 */
export const nodeHttpTransport: Transport = (request) =>
  new Promise<HttpResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      reject(new NinaNetworkError(`Invalid URL: ${request.url}`));
      return;
    }

    // Only http/https are supported. Reject anything else up front with a clear,
    // typed error instead of letting Node throw an opaque ERR_INVALID_PROTOCOL
    // (and so this never reaches the file:/ftp:/etc. drivers).
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new NinaNetworkError(`Unsupported protocol "${url.protocol}" in URL: ${request.url}`));
      return;
    }

    const isHttps = url.protocol === "https:";
    const driver = isHttps ? https : http;
    const maxBytes = request.maxResponseBytes;

    const req = driver.request(
      url,
      {
        method: request.method,
        headers: request.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let aborted = false;

        res.on("data", (chunk: Buffer) => {
          if (aborted) return;
          received += chunk.length;
          if (maxBytes !== undefined && received > maxBytes) {
            aborted = true;
            res.destroy();
            reject(new NinaNetworkError(`Response exceeded maxResponseBytes (${maxBytes})`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (aborted) return;
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", (err) => {
          if (aborted) return; // we already rejected with the size-cap error
          reject(new NinaNetworkError(`Response stream error: ${err.message}`, { cause: err }));
        });
      },
    );

    if (request.timeoutMs && request.timeoutMs > 0) {
      req.setTimeout(request.timeoutMs, () => {
        req.destroy(new NinaNetworkError(`Request timed out after ${request.timeoutMs}ms`));
      });
    }

    req.on("error", (err) => {
      // A timeout destroy already passes an NinaNetworkError; don't double-wrap.
      if (err instanceof NinaNetworkError) {
        reject(err);
        return;
      }
      const message = describeNetworkError(err as NodeJS.ErrnoException, url.host);
      reject(new NinaNetworkError(message, { cause: err }));
    });

    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
