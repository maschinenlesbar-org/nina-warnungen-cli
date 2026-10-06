import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine, cleartextProblem, parseRetryAfter } from "../src/client/engine.js";
import { NinaApiError, NinaNetworkError, NinaParseError, NinaValidationError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";
import type { HttpResponse } from "../src/client/http.js";

// Built via char codes so no raw control bytes ever appear in this source file.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const C1 = String.fromCharCode(0x9b); // a C1 control (CSI)

/** True if the string contains any C0/C1 control char except tab/newline. */
function hasControlChars(s: string): boolean {
  return [...s].some((c) => {
    const n = c.charCodeAt(0);
    return n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f);
  });
}

test("buildUrl normalises the path and appends the query", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/" });
  assert.equal(e.buildUrl("api31/"), "https://example.test/api31/");
  assert.equal(
    e.buildUrl("/x", { a: "1", b: ["2", "3"] }),
    "https://example.test/x?a=1&b=2&b=3",
  );
});

test("the constructor rejects a malformed base URL as NinaValidationError, not a network error", () => {
  assert.throws(
    () => new RequestEngine({ baseUrl: "notaurl" }),
    (err: unknown) =>
      err instanceof NinaValidationError &&
      !(err instanceof NinaNetworkError) &&
      err.message === "Invalid baseUrl: Expected an absolute http(s) URL.",
  );
});

test("the constructor rejects a non-http(s) base URL scheme transport-independently", () => {
  // The scheme guard lives in the engine (not only the default transport), so a
  // library user with a custom Transport still cannot reach a file:/ftp: driver.
  for (const bad of ["file:///etc/passwd", "ftp://example.test/x"]) {
    assert.throws(
      () => new RequestEngine({ baseUrl: bad }),
      (err: unknown) => err instanceof NinaValidationError && /Unsupported scheme/.test(err.message),
    );
  }
});

test("the constructor rejects every malformed base-URL shape, with no request", () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  for (const bad of ["", " https://h.example", "https://h.example/ ", "https://h.example/p\t", "ftp://h.example", "https://h.example#f"]) {
    assert.throws(() => new RequestEngine({ baseUrl: bad, transport: mt.transport }), NinaValidationError, JSON.stringify(bad));
  }
  assert.equal(mt.calls.length, 0);
});

test("getJson parses a JSON body", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ok: true }));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/x"), { ok: true });
});

test("getJson throws NinaParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), NinaParseError);
});

test("a 503 is retried up to maxRetries then surfaces as NinaApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return jsonResponse({ detail: "busy" }, 503);
  });
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 2,
    sleep: async () => {},
  });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof NinaApiError && err.status === 503,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test("a retried request that then succeeds resolves", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {} });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(calls, 2);
});

test("the User-Agent and Accept headers are sent", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.getJson("/x");
  assert.equal(mt.last().headers?.["User-Agent"], "ua/1");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
});

test("a 3xx redirect surfaces as NinaApiError and is never followed", async () => {
  // The engine treats a redirect like any other non-2xx status: it does NOT
  // follow the Location header (no SSRF / header replay to another host). This
  // test locks that security property in.
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return {
      status: 302,
      headers: { location: "http://evil.test/secret" },
      body: Buffer.from(""),
    };
  });
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof NinaApiError && err.status === 302,
  );
  assert.equal(calls, 1); // requested once; the Location was not followed
});

test("maxResponseBytes: 0 omits the size cap from the transport request", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ok: true }));
  const e = new RequestEngine({ transport: mt.transport, maxResponseBytes: 0 });
  await e.getJson("/x");
  assert.equal(mt.last().maxResponseBytes, undefined);
});

test("a positive maxResponseBytes is forwarded to the transport request", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ok: true }));
  const e = new RequestEngine({ transport: mt.transport, maxResponseBytes: 123 });
  await e.getJson("/x");
  assert.equal(mt.last().maxResponseBytes, 123);
});

test("error detail is stripped of terminal control characters", async () => {
  // ESC + BEL + a C1 control interleaved with printable text, delivered as a
  // decoded ESC byte (JSON.parse turns an escaped ESC into a real ESC).
  const evil = `boom${ESC}[31mred${BEL}${C1}2J`;
  const body: HttpResponse = {
    status: 500,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ detail: evil })),
  };
  const mt = makeMockTransport(() => body);
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 0 });

  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) => {
      assert.ok(err instanceof NinaApiError);
      // The control bytes are gone from both the structured detail and the
      // human-readable message that run.ts prints to stderr...
      assert.ok(!hasControlChars(err.detail ?? ""));
      assert.ok(!hasControlChars(err.message));
      // ...while the printable characters are preserved.
      assert.equal(err.detail, "boom[31mred2J");
      return true;
    },
  );
});

test("an attacker-controlled Content-Type is stripped of control characters", async () => {
  const evilType = `application/json${ESC}]0;pwned${BEL}`;
  const mt = makeMockTransport(() => rawResponse("payload", evilType));
  const e = new RequestEngine({ transport: mt.transport });
  const res = await e.getRaw("/x", "application/json");
  assert.ok(!hasControlChars(res.contentType));
  assert.equal(res.contentType, "application/json]0;pwned");
});

test("a 3xx error names the resolved, redacted, sanitised redirect target", async () => {
  const mt = makeMockTransport(() => ({
    status: 302,
    headers: { location: `http://u:secret@other.test/a${ESC}]0;x${BEL}b` },
    body: Buffer.alloc(0),
  }));
  const e = new RequestEngine({ transport: mt.transport, baseUrl: "https://example.test" });
  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) =>
      err instanceof NinaApiError &&
      err.location !== undefined &&
      !err.message.includes("secret") &&
      !hasControlChars(err.message) &&
      /redirect to http:\/\/\*\*\*@other\.test\/a/.test(err.message),
  );

  const rel = makeMockTransport(() => ({ status: 302, headers: { location: "/y" }, body: Buffer.alloc(0) }));
  const e2 = new RequestEngine({ transport: rel.transport, baseUrl: "https://example.test" });
  await assert.rejects(
    () => e2.getJson("/x"),
    (err: unknown) => err instanceof NinaApiError && err.location === "https://example.test/y",
  );
});

function retryAfterEngine(retryAfter: string | undefined, maxRetries = 2) {
  const delays: number[] = [];
  const mt = makeMockTransport(() => ({
    status: 429,
    headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
    body: Buffer.from("{}"),
  }));
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { e, mt, delays };
}

test("a 429 waits the Retry-After seconds before each retry", async () => {
  const { e, mt, delays } = retryAfterEngine("1");
  await assert.rejects(() => e.getJson("/x"), (err: unknown) => err instanceof NinaApiError && err.status === 429);
  assert.equal(mt.calls.length, 3);
  assert.deepEqual(delays, [1000, 1000]);
});

test("a malformed Retry-After falls back to the linear backoff", async () => {
  for (const bad of ["-1", "+5", "1.5", "1e3", "0x10", "", "soon", "2026-09-26T10:00:00Z"]) {
    const { e, delays } = retryAfterEngine(bad);
    await assert.rejects(() => e.getJson("/x"));
    assert.deepEqual(delays, [200, 400], bad);
  }
  const { e, delays } = retryAfterEngine(undefined);
  await assert.rejects(() => e.getJson("/x"));
  assert.deepEqual(delays, [200, 400]);
});

test("a Retry-After beyond 30 s is not retried: the error surfaces at once", async () => {
  const far = new Date(Date.now() + 3_600_000).toUTCString();
  for (const long of ["31", "99999999999", far]) {
    const { e, mt, delays } = retryAfterEngine(long, 10);
    await assert.rejects(() => e.getJson("/x"), (err: unknown) => err instanceof NinaApiError && err.status === 429);
    assert.equal(mt.calls.length, 1, long);
    assert.deepEqual(delays, [], long);
  }
});

test("parseRetryAfter reads delay-seconds and IMF-fixdates only", () => {
  const now = Date.parse("Sat, 26 Sep 2026 10:00:00 GMT");
  assert.equal(parseRetryAfter("5", now), 5000);
  assert.equal(parseRetryAfter(" 7 ", now), 7000);
  assert.equal(parseRetryAfter(["2", "9"], now), 2000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 10:00:10 GMT", now), 10_000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 09:00:00 GMT", now), 0);
  for (const bad of [undefined, "", "-1", "1.5", "1e3", "Saturday, 26-Sep-26 10:00:10 GMT", "Sat Sep 26 10:00:10 2026"]) {
    assert.equal(parseRetryAfter(bad, now), undefined, String(bad));
  }
});

test("the constructor rejects a base URL with a query or fragment, without echoing userinfo", () => {
  for (const bad of ["https://u:secret@example.test/?x=1", "https://example.test/#f"]) {
    assert.throws(
      () => new RequestEngine({ baseUrl: bad }),
      (err: unknown) =>
        err instanceof NinaValidationError &&
        err.message === "Invalid baseUrl: A base URL cannot have a query (?) or fragment (#)." &&
        !err.message.includes("secret"),
    );
  }
});

test("retryDelayMs is bounded by MAX_RETRY_AFTER_MS, so no timer overflows to 1 ms", () => {
  for (const retryDelayMs of [30_001, 3_000_000_000, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => new RequestEngine({ retryDelayMs }), NinaValidationError, String(retryDelayMs));
  }
  assert.doesNotThrow(() => new RequestEngine({ retryDelayMs: 30_000 }));
});

test("a reset is retried, a refused connection is not", async () => {
  const sleeps: number[] = [];
  let n = 0;
  const reset = makeMockTransport(() => {
    if (n++ === 0) throw new NinaNetworkError("Connection to h was reset.", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
    return jsonResponse([]);
  });
  await new RequestEngine({ transport: reset.transport, maxRetries: 5, sleep: async (ms) => void sleeps.push(ms) }).getJson("/x");
  assert.equal(reset.calls.length, 2);
  assert.deepEqual(sleeps, [200]);
  const refused = makeMockTransport(() => {
    throw new NinaNetworkError("Could not connect to h (connection refused).", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
  });
  await assert.rejects(new RequestEngine({ transport: refused.transport, maxRetries: 5, sleep: async () => {} }).getJson("/x"), NinaNetworkError);
  assert.equal(refused.calls.length, 1);
});

test("getJson decodes by the declared charset, drops a BOM, and rejects an unknown charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const mt = makeMockTransport(() => rawResponse(Buffer.from(JSON.stringify([text]), encoding), `application/json; charset=${charset}`));
    assert.deepEqual(await new RequestEngine({ transport: mt.transport }).getJson("/x"), [text], charset);
  }
  const bom = makeMockTransport(() => rawResponse(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("[]")]), "application/json"));
  assert.deepEqual(await new RequestEngine({ transport: bom.transport }).getJson("/x"), []);
  const unknown = makeMockTransport(() => rawResponse("[]", "application/json; charset=x-bogus"));
  await assert.rejects(new RequestEngine({ transport: unknown.transport }).getJson("/x"), NinaParseError);
});

test("cleartextProblem names the host and each secret, exempts https, loopback and junk", () => {
  assert.equal(cleartextProblem("https://warnung.bund.de"), undefined);
  assert.equal(cleartextProblem("not a url"), undefined);
  for (const loopback of ["http://localhost:8080", "http://LOCALHOST", "http://127.8.9.10", "http://[::1]:9"]) {
    assert.equal(cleartextProblem(loopback, ["the API key"]), undefined, loopback);
  }
  assert.equal(
    cleartextProblem("http://mirror.example:8080/api"),
    "requests to mirror.example:8080 are sent unencrypted (http:, not https:)",
  );
  assert.equal(
    cleartextProblem("http://alice:s3cret@mirror.example"),
    "the base URL's credentials are sent unencrypted to mirror.example (http:, not https:)",
  );
  assert.equal(
    cleartextProblem("http://alice:s3cret@mirror.example", ["the API key"]),
    "the API key and the base URL's credentials are sent unencrypted to mirror.example (http:, not https:)",
  );
  assert.equal(
    cleartextProblem("http://mirror.example", ["the API key"]),
    "the API key is sent unencrypted to mirror.example (http:, not https:)",
  );
  // 127.0.0.1.example is a remote name, not loopback.
  assert.match(cleartextProblem("http://127.0.0.1.example") ?? "", /127\.0\.0\.1\.example/);
});
