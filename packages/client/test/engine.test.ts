import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine, cleartextProblem, parseRetryAfter } from "../src/engine.js";
import { NinaApiError, NinaNetworkError, NinaParseError, NinaValidationError, cutForMessage, cutText, toWellFormed } from "../src/errors.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";
import type { HttpResponse } from "../src/http.js";

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

test("a number the JSON cannot carry exactly is a parse error, never a changed value", async () => {
  // JSON.parse rounds 12345678901234567890 (in any form: .0, e0, E-1) and 9007199254740992.5 to the
  // nearest double, turns 1e400 into Infinity (printed as null) and 1e-400 into 0, silently.
  const body = (n: string) => `{"id":"a","n":${n},"text":"12345678901234567890 in a string"}`;
  for (const n of [
    "12345678901234567890", "-9007199254740993", "1e400", "-1E400", "12345678901234567890.0", "9007199254740993e0",
    "90071992547409930E-1", "9007199254740992.5", "-9007199254740992.5", "1e-400", "-0.0001e-399",
    "123456789012345678901234567890",
  ]) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    await assert.rejects(e.getJson("/api31/warnings/a.json"), (err: unknown) => {
      assert.ok(err instanceof NinaParseError, n);
      assert.equal(err.message, `GET https://warnung.bund.de/api31/warnings/a.json: the number ${n} cannot be represented exactly.`);
      return true;
    });
  }
  // What a double carries exactly, or as JSON means it (a decimal fraction below 2^53), passes.
  const exact: Array<[string, number]> = [
    ["9007199254740991", 9007199254740991], ["9007199254740992.0", 2 ** 53], ["9007199254740992e0", 2 ** 53],
    ["90071992547409920E-1", 2 ** 53], ["1e21", 1e21], ["1.2e21", 1.2e21], ["0", 0], ["-0", -0], ["0.0e-500", 0],
    ["1.10", 1.1], ["0.1", 0.1], ["1.00000000000000001", 1], ["5e-324", 5e-324],
    // A double a server printed in its shortest form reads back as that double and prints as the
    // same number: not a changed value, though the decimal is not the double's exact binary value.
    ["1e23", 1e23], ["100000000000000000000000", 1e23], ["1E23", 1e23], ["1.7976931348623157E308", Number.MAX_VALUE], ["-1.7976931348623157e308", -Number.MAX_VALUE],
    ["4.35e30", 4.35e30],
  ];
  for (const [n, value] of exact) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    assert.equal((await e.getJson<{ n: number }>("/x")).n, value, n);
  }
});

test("the number check skips strings and costs one pass over the text", async () => {
  // Escaped quotes and backslashes must not end a string early and expose its digits.
  const tricky = `{"id":"a","s":"\\\\\\"12345678901234567890\\\\","t":"1e400","n":[1,2.5,-3e2]}`;
  const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(tricky, "application/json")).transport });
  assert.deepEqual(await e.getJson("/x"), JSON.parse(tricky));
  // 1 MB of numbers: the scan is linear.
  const big = `[${Array.from({ length: 200_000 }, (_, i) => i * 7).join(",")}]`;
  const f = new RequestEngine({ transport: makeMockTransport(() => rawResponse(big, "application/json")).transport });
  assert.equal((await f.getJson<number[]>("/x")).length, 200_000);
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

test("cutText never cuts inside a surrogate pair; toWellFormed replaces half a character", () => {
  assert.equal(cutText("ab\u{1f600}cd", 3), "ab");
  assert.equal(cutText("ab\u{1f600}cd", 4), "ab\u{1f600}");
  assert.equal(cutText("short", 10), "short");
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a\ufffd b\ufffd \u{1f600}");
  // cutForMessage (500) too: "a" + emoji puts a high surrogate at unit 500.
  const cut = cutForMessage("a" + "\u{1f600}".repeat(400));
  assert.equal(toWellFormed(cut), cut);
  assert.match(cut, /…$/);
});

test("a server detail cut at 500 characters keeps the message well-formed", async () => {
  const detail = "a" + "\u{1f600}".repeat(400);
  const engine = new RequestEngine({ transport: async () => ({ status: 500, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ detail })) }) });
  await assert.rejects(engine.getJson("/api31/mowas/mapData.json"), (err: Error) => {
    assert.equal(toWellFormed(err.message), err.message);
    assert.match(err.message, /…$/);
    return true;
  });
});

test("credentials a server echoes are scrubbed from the error: Basic, user:password, password (L13)", async () => {
  // Node sends the userinfo's Basic value in UTF-8: "\u00fc" is two bytes there.
  const basic = Buffer.from("alice:pa ss-pw\u00fc", "utf8").toString("base64");
  const body = JSON.stringify({ detail: `no: Basic ${basic} / alice:pa ss-pw\u00fc / pa ss-pw\u00fc` });
  const engine = new RequestEngine({
    baseUrl: "https://alice:pa%20ss-pw%C3%BC@mirror.example",
    transport: async () => ({ status: 401, headers: { "content-type": "application/json" }, body: Buffer.from(body) }),
  });
  await assert.rejects(engine.getJson("/api31/mowas/mapData.json"), (err: NinaApiError) => {
    for (const form of [basic, "alice:pa ss-pw\u00fc", "pa ss-pw\u00fc"]) {
      assert.ok(!err.message.includes(form), err.message);
      assert.ok(!err.body.includes(form), err.body);
    }
    assert.match(err.message, /no: Basic \*\*\* \/ \*\*\* \/ \*\*\*/);
    return true;
  });
});

test("a timeout, the size cap, a refused connection and a DNS failure name the request (K3)", async () => {
  const { createServer } = await import("node:http");
  const sockets = new Set<import("node:net").Socket>();
  // One loopback server: /slow never answers, /big sends 64 bytes.
  const server = createServer((req, res) => {
    if (req.url === "/big") res.end("x".repeat(64));
  });
  server.on("connection", (s) => sockets.add(s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  // A port nothing listens on: listen, note it, close.
  const closed = createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
  const closedPort = (closed.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((r) => closed.close(() => r()));
  try {
    const base = `http://user:secret@127.0.0.1:${port}`;
    const cases: Array<[EngineArgs, string, RegExp]> = [
      [{ baseUrl: base, timeoutMs: 50 }, "/slow", /^GET http:\/\/\*\*\*@127\.0\.0\.1:\d+\/slow failed: Request (timed out after 50ms|exceeded the 50ms deadline)$/],
      [{ baseUrl: base, maxResponseBytes: 10 }, "/big", /^GET http:\/\/\*\*\*@127\.0\.0\.1:\d+\/big failed: Response exceeded the size limit of 10 bytes/],
      [{ baseUrl: `http://127.0.0.1:${closedPort}`, maxRetries: 0 }, "/x", /^GET http:\/\/127\.0\.0\.1:\d+\/x failed: Could not connect to 127\.0\.0\.1:\d+ \(connection refused\)/],
    ];
    for (const [options, path, message] of cases) {
      const e = new RequestEngine(options);
      await assert.rejects(e.getJson(path), (err: unknown) => {
        assert.ok(err instanceof NinaNetworkError, String(err));
        assert.match(err.message, message);
        assert.doesNotMatch(err.message, /secret/);
        assert.ok(err.cause instanceof NinaNetworkError, "the original is the cause");
        return true;
      });
    }
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  }
  // A DNS failure as the default transport reports it (no lookup here), and the engine's own
  // size check of a body a custom transport returned.
  const dns = new NinaNetworkError("Could not resolve host nowhere.example. Check the --base-url and your network/DNS.", {
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND nowhere.example"), { code: "ENOTFOUND" }),
  });
  const e = new RequestEngine({ baseUrl: "https://nowhere.example", transport: () => Promise.reject(dns) });
  await assert.rejects(e.getJson("/x"), (err: unknown) =>
    err instanceof NinaNetworkError && err.cause === dns &&
    err.message === "GET https://nowhere.example/x failed: Could not resolve host nowhere.example. Check the --base-url and your network/DNS.",
  );
  const big = new RequestEngine({ maxResponseBytes: 3, transport: makeMockTransport(() => rawResponse("[1,2,3]", "application/json")).transport });
  await assert.rejects(big.getJson("/x"), (err: unknown) =>
    err instanceof NinaNetworkError && err.message.startsWith("GET https://warnung.bund.de/x failed: Response exceeded the size limit of 3 bytes"),
  );
  // Anything a custom transport throws names the request too.
  const odd = new RequestEngine({ transport: () => Promise.reject("plain string") });
  await assert.rejects(odd.getJson("/x"), (err: unknown) => err instanceof NinaNetworkError && err.message === "GET https://warnung.bund.de/x failed: plain string");
});

type EngineArgs = ConstructorParameters<typeof RequestEngine>[0];

test("a header named __proto__ is an ordinary header, never the prototype of the headers read (T12)", async () => {
  // A JavaScript transport may return any object; JSON.parse makes "__proto__" an own key.
  const headers = JSON.parse('{"__proto__":{"content-type":"application/json; charset=bogus"}}') as Record<string, string>;
  const e = new RequestEngine({ transport: async () => ({ status: 200, headers, body: Buffer.from('{"a":1}') }) });
  // With the prototype set, "charset=bogus" was read as the Content-Type: a parse error.
  assert.deepEqual(await e.getJson("/x"), { a: 1 });
  const fetchLike = new Headers([["__proto__", "x"], ["content-type", "application/json"]]);
  const f = new RequestEngine({ transport: async () => ({ status: 200, headers: fetchLike as unknown as Record<string, string>, body: Buffer.from('{"a":1}') }) });
  assert.deepEqual(await f.getJson("/x"), { a: 1 });
});

test("a subnormal number that does not print as written is a parse error; one that does passes (D4)", async () => {
  // Below the smallest normal double a double has fewer significant digits: 3e-324 became 5e-324.
  const body = (n: string) => `{"identifier":"a","n":${n}}`;
  for (const n of ["3e-324", "4e-324", "-4.9e-324", "7e-324", "1.23456789e-320", "1.2345678901234567e-310", "2.225073858507201e-309"]) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    await assert.rejects(e.getJson("/x"), (err) => err instanceof NinaParseError && err.message.endsWith(`the number ${n} cannot be represented exactly.`), n);
  }
  for (const [n, value] of [["5e-324", 5e-324], ["-5e-324", -5e-324], ["1e-310", 1e-310], ["2.2250738585072014e-308", 2.2250738585072014e-308]] as const) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    assert.equal((await e.getJson<{ n: number }>("/x")).n, value, n);
  }
});

test("an answer error names the request: method and URL, userinfo redacted (D9)", async () => {
  const cases: Array<[HttpResponse, RegExp]> = [
    [rawResponse("<html>down</html>", "text/html"), /^GET https:\/\/\*\*\*@h\.test\/api31\/x\.json: the answer is not valid JSON \(expected JSON, got Content-Type "text\/html"\)\.$/],
    [rawResponse("{", "application/json"), /^GET https:\/\/\*\*\*@h\.test\/api31\/x\.json: the answer is not valid JSON\.$/],
    [rawResponse(" \n", "application/json"), /^GET https:\/\/\*\*\*@h\.test\/api31\/x\.json: empty response body\.$/],
    [rawResponse("[]", "application/json; charset=x-evil"), /^GET https:\/\/\*\*\*@h\.test\/api31\/x\.json: unsupported response charset "x-evil"\.$/],
    [rawResponse("[1e400]", "application/json"), /^GET https:\/\/\*\*\*@h\.test\/api31\/x\.json: the number 1e400 cannot be represented exactly\.$/],
  ];
  for (const [response, message] of cases) {
    const e = new RequestEngine({ baseUrl: "https://alice:s3cret@h.test", transport: makeMockTransport(() => response).transport });
    await assert.rejects(e.getJson("/api31/x.json"), (err: unknown) => err instanceof NinaParseError && message.test(err.message) && !err.message.includes("s3cret"), String(message));
  }
});

test("a network error for a very long URL keeps its reason: the URL is cut at 500 characters (bug 2 of 2026-10-21)", async () => {
  // A 100 000-character id made a record of 4 000 characters of URL; the reason was cut off.
  const path = `/api31/warnings/${"a".repeat(100_000)}.json`;
  const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const failures: Array<[EngineArgs, RegExp]> = [
    [{ maxRetries: 0, transport: () => Promise.reject(reset) }, /failed: socket hang up$/],
    [{ maxResponseBytes: 3, transport: makeMockTransport(() => rawResponse("[1,2,3]", "application/json")).transport }, /failed: Response exceeded the size limit of 3 bytes/],
    [{ transport: (() => Promise.resolve(null)) as unknown as EngineArgs extends { transport?: infer T } ? T : never }, /failed: the transport returned an invalid response \(not an object\)\.$/],
  ];
  for (const [options, reason] of failures) {
    const e = new RequestEngine(options);
    await assert.rejects(e.getJson(path), (err: unknown) => {
      assert.ok(err instanceof NinaNetworkError, String(err));
      assert.match(err.message, /^GET https:\/\/warnung\.bund\.de\/api31\/warnings\/a+…/);
      assert.match(err.message, reason);
      assert.ok(err.message.length < 700, `${err.message.length} characters`);
      return true;
    });
  }
});
