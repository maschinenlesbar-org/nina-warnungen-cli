import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine, parseRetryAfter } from "../src/client/engine.js";
import { NinaApiError, NinaNetworkError, NinaParseError } from "../src/client/errors.js";
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

test("buildUrl rejects a malformed base URL with a clear, base-only message", () => {
  const e = new RequestEngine({ baseUrl: "notaurl" });
  assert.throws(
    () => e.buildUrl("/api31/dwd/mapData.json"),
    (err: unknown) =>
      err instanceof NinaNetworkError &&
      /Invalid base URL: "notaurl"/.test(err.message) &&
      // the diagnostic must NOT carry the request path (which read as if at fault)
      !/mapData/.test(err.message),
  );
});

test("buildUrl rejects a non-http(s) base URL scheme transport-independently", () => {
  // The scheme guard lives in the engine (not only the default transport), so a
  // library user with a custom Transport still cannot reach a file:/ftp: driver.
  for (const bad of ["file:///etc/passwd", "ftp://example.test/x"]) {
    const e = new RequestEngine({ baseUrl: bad });
    assert.throws(
      () => e.buildUrl("/x"),
      (err: unknown) =>
        err instanceof NinaNetworkError && /Unsupported base URL scheme/.test(err.message),
    );
  }
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

test("buildUrl rejects a base URL with a query or fragment, userinfo redacted", () => {
  for (const bad of ["https://u:secret@example.test/?x=1", "https://example.test/#f"]) {
    const e = new RequestEngine({ baseUrl: bad });
    assert.throws(
      () => e.buildUrl("/x"),
      (err: unknown) =>
        err instanceof NinaNetworkError &&
        /Base URL must not contain a query or fragment/.test(err.message) &&
        !err.message.includes("secret"),
    );
  }
});
