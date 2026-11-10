import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { TextDecoder, inspect } from "node:util";
import assert from "node:assert/strict";
import { RequestEngine, bigIntegerKeysOption, cleartextProblem, firstInexactNumber, parseRetryAfter, sanitizeServerText, scanNumbers } from "../src/engine.js";
import { NinaApiError, NinaNetworkError, NinaParseError, NinaValidationError, credentialsIn, cutForMessage, cutText, echoedCredentialForms, redactUrlUserinfo, TextBuilder, toWellFormed, typedUrlCredentials } from "../src/errors.js";
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
      // ...whole escape sequences with them (not `[31m` left behind), while the printable
      // characters are preserved.
      assert.equal(err.detail, "boomred");
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
  // The whole control string goes, not only its control bytes (`]0;pwned` was left).
  assert.equal(res.contentType, "application/json");
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

test("bigIntegerKeys: a declared member's number is its exact literal as a string; others keep the rule (D3)", async () => {
  const body = '{"_version_":1858054135406919680,"small":{"_version_":5},"neg":{"\\u005fversion_":-12345678901234567890},' +
    '"s":{"_version_":"text"},"n":{"_version_":null},"arr":{"_version_":[1]},"t":"\\"_version_\\":1","n2":42}';
  const e = new RequestEngine({
    bigIntegerKeys: new Set(["_version_"]),
    transport: makeMockTransport(() => rawResponse(body, "application/json")).transport,
  });
  assert.deepEqual(await e.getJson("/x"), {
    _version_: "1858054135406919680", small: { _version_: "5" }, neg: { _version_: "-12345678901234567890" },
    s: { _version_: "text" }, n: { _version_: null }, arr: { _version_: [1] }, t: '"_version_":1', n2: 42,
  });
  assert.deepEqual([...e.bigIntegerKeys], ["_version_"]);
  // An undeclared big number is still refused; a declared member doesn't make others exact.
  const other = new RequestEngine({
    bigIntegerKeys: ["_version_"] as unknown as ReadonlySet<string>,
    transport: makeMockTransport(() => rawResponse('{"_version_":1858054135406919680,"id":12345678901234567890}', "application/json")).transport,
  });
  await assert.rejects(other.getJson("/x"), /the number 12345678901234567890 cannot be represented exactly/);
  // Malformed stays malformed: a declared member with a leading zero still fails JSON.parse.
  const malformed = new RequestEngine({ bigIntegerKeys: new Set(["_version_"]), transport: makeMockTransport(() => rawResponse('{"_version_":01}', "application/json")).transport });
  await assert.rejects(malformed.getJson("/x"), /not valid JSON/);
  for (const bad of [new Set([""]), new Set([1]), "x", 5, null]) {
    assert.throws(() => new RequestEngine({ bigIntegerKeys: bad as unknown as ReadonlySet<string> }),
      (err: unknown) => err instanceof NinaValidationError && err.message === "Invalid option bigIntegerKeys: expected a set of non-empty member names.");
  }
  // The option reader copies a set or a list; undefined is none.
  const names = new Set(["a"]);
  const copy = bigIntegerKeysOption(names);
  names.add("b");
  assert.deepEqual([...copy], ["a"]);
  assert.deepEqual([...bigIntegerKeysOption(["x", "y"] as unknown as ReadonlySet<string>)], ["x", "y"]);
  assert.equal(bigIntegerKeysOption(undefined).size, 0);
  // Without declarations the scan is the plain number check.
  assert.equal(firstInexactNumber('{"a":"1e400","b":3e-324}'), "3e-324");
  assert.deepEqual(scanNumbers('{"a":1}'), { json: '{"a":1}', inexact: undefined });
});

test("text that is not valid is replaced with U+FFFD and reported through onWarning, never silently (D2)", async () => {
  const cases: Array<[string, Buffer, string, unknown, number]> = [
    // A lone surrogate written as an escape (high alone, low alone); a real pair and an escaped backslash stay.
    ["lone escapes", Buffer.from('{"a":"x\\ud800y","b":"\\udc00","c":"\\ud83d\\ude00","d":"\\\\ud800"}'), "application/json", { a: "x\ufffdy", b: "\ufffd", c: "\u{1f600}", d: "\\ud800" }, 2],
    // A lone surrogate in a member name.
    ["lone in a key", Buffer.from('{"\\udbff":1}'), "application/json", { "\ufffd": 1 }, 1],
    // Invalid UTF-8 bytes; a U+FFFD the server sent is not counted.
    ["invalid bytes", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xc3]), Buffer.from('","b":"\ufffd"}')]), "application/json", { a: "\ufffd\ufffd", b: "\ufffd" }, 2],
    // A byte undefined in a single-byte charset.
    ["iso-8859-3", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xa5]), Buffer.from('"}')]), "application/json; charset=iso-8859-3", { a: "\ufffd" }, 1],
  ];
  for (const [label, body, type, expected, count] of cases) {
    const warnings: string[] = [];
    const e = new RequestEngine({ onWarning: (m) => warnings.push(m), transport: makeMockTransport(() => rawResponse(body, type)).transport });
    const value = await e.getJson("/items", { q: "x" });
    assert.deepEqual(value, expected, label);
    assert.ok(!/[\ud800-\udfff]/u.test(JSON.stringify(value)), `${label}: well-formed`);
    assert.deepEqual(warnings, [
      `GET https://warnung.bund.de/items?q=x: ${count} ${count === 1 ? "character" : "characters"} of the answer ${count === 1 ? "was" : "were"} not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.`,
    ], label);
  }
  // Valid text: no warning; a throwing hook never fails the request.
  const quiet: string[] = [];
  const ok = new RequestEngine({ onWarning: (m) => quiet.push(m), transport: makeMockTransport(() => rawResponse('{"a":"\\u00fc\ufffd"}', "application/json")).transport });
  assert.deepEqual(await ok.getJson("/x"), { a: "ü\ufffd" });
  assert.deepEqual(quiet, []);
  const throwing = new RequestEngine({ onWarning: () => { throw new Error("hook"); }, transport: makeMockTransport(() => rawResponse('"\\ud800"', "application/json")).transport });
  assert.equal(await throwing.getJson("/x"), "\ufffd");
  assert.throws(() => new RequestEngine({ onWarning: "log" as unknown as () => void }), NinaValidationError);
});

test("an answer longer than V8's longest string is a NinaParseError naming the request, not a plain Error (T14)", async (t) => {
  // A real one needs a body of 512 MB and more (possible with maxResponseBytes 0): V8's own
  // error is stood in for, for the body marked by its length.
  const huge = Buffer.from('[{"id":"a"}]                         ');
  const tooLong = Object.assign(new Error("Cannot create a string longer than 0x1fffffe8 characters"), { code: "ERR_STRING_TOO_LONG" });
  const decode = TextDecoder.prototype.decode;
  t.mock.method(TextDecoder.prototype, "decode", function (this: InstanceType<typeof TextDecoder>, input?: Uint8Array, options?: { stream?: boolean }) {
    if (input !== undefined && input.byteLength === huge.length) throw tooLong;
    return decode.call(this, input, options);
  });
  const toString = Buffer.prototype.toString;
  t.mock.method(Buffer.prototype, "toString", function (this: Buffer, ...args: Parameters<Buffer["toString"]>) {
    if (this.length === huge.length && args[0] === "utf8") throw tooLong;
    return toString.apply(this, args);
  });
  const e = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "application/json")).transport });
  await assert.rejects(e.getJson("/api31/dwd/mapData.json"), (err: unknown) => {
    assert.ok(err instanceof NinaParseError, String(err));
    assert.equal(
      err.message,
      `GET https://warnung.bund.de/api31/dwd/mapData.json: the answer is too large to read as text (${huge.length} bytes; the longest string is 536870888 characters).`,
    );
    return true;
  });
  // An error status with such a body is still the API error, without the unreadable body.
  const failing = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "text/plain", 500)).transport });
  await assert.rejects(failing.getJson("/x"), (err: unknown) => err instanceof NinaApiError && err.status === 500 && err.body === "");
});

test("a number with a long run of zeros is checked in linear time (security audit 2026-10-27)", () => {
  // `/0+$/` tried a match at every zero of a run that doesn't end the literal: quadratic.
  // 1.<100 000 zeros>1e300 took about 15 s with the regex; the index loops take milliseconds.
  for (const literal of [`1.${"0".repeat(100_000)}1e300`, `1${"0".repeat(300)}.${"0".repeat(100_000)}1`, `0.${"0".repeat(400)}1${"0".repeat(100_000)}1`]) {
    const start = performance.now();
    const scan = scanNumbers(`{"a":${literal}}`);
    const ms = performance.now() - start;
    assert.ok(ms < 1000, `${Math.round(ms)} ms`);
    assert.equal(scan.inexact, literal);
  }
  // The same result as before: trailing and leading zeros don't make a literal inexact.
  assert.equal(firstInexactNumber(`{"a":1${"0".repeat(30)}.000,"b":0.000e5,"c":-1.7976931348623157E308,"d":5e-324}`), undefined);
  assert.equal(firstInexactNumber('{"a":12345678901234567890}'), "12345678901234567890");
  assert.equal(firstInexactNumber('{"a":0.0000e-400}'), undefined);
  assert.equal(firstInexactNumber('{"a":1e-400}'), "1e-400");
});

/** The base URL's credential, in the forms a server echoes it (security audit 2026-10-27, D2). */
const ECHO_PW = "pä\"s's-W0rd";
const ECHO_BASE = `https://alice:${encodeURIComponent(ECHO_PW)}@mirror.example`;
const ECHO_BASIC = Buffer.from(`alice:${ECHO_PW}`, "utf8").toString("base64");
const ECHO_SECRETS = [ECHO_PW, `alice:${ECHO_PW}`, ECHO_BASIC];

/** Everything a library user may log of an error, percent-decoded where it decodes. */
function everythingOf(err: unknown): string {
  const e = err as { message?: unknown; location?: unknown; cause?: unknown };
  const text = [inspect(err, { depth: 10, showHidden: true }), e.message, e.location].map(String).join("\n");
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

test("a credential in a redirect's Location is scrubbed, in its path and its query (security audit 2026-10-27)", async () => {
  const locations = [
    `https://elsewhere.example/login?user=alice&pw=${encodeURIComponent(ECHO_PW)}`,
    `https://elsewhere.example/login?pw=${ECHO_PW}`,
    `https://elsewhere.example/${encodeURIComponent(`alice:${ECHO_PW}`)}/x`,
    `https://elsewhere.example/auth?basic=${ECHO_BASIC}`,
    `/relative/${ECHO_PW}`,
    `/api31/archive/alerts/alice:${encodeURIComponent(ECHO_PW)}@x`,
  ];
  for (const location of locations) {
    const mt = makeMockTransport(() => ({ status: 302, headers: { location }, body: Buffer.alloc(0) }));
    const e = new RequestEngine({ transport: mt.transport, baseUrl: ECHO_BASE, maxRetries: 0 });
    const err = await e.getJson("/x").then(() => assert.fail("should fail"), (caught: unknown) => caught);
    assert.ok(err instanceof NinaApiError && /^HTTP 302 /.test(err.message), String(err));
    assert.ok(err.location !== undefined && /\*\*\*/.test(err.location), `${location}: ${err.location}`);
    const seen = everythingOf(err);
    for (const secret of ECHO_SECRETS) assert.ok(!seen.includes(secret), `${location}: ${seen.slice(0, 2000)}`);
  }
});

/** Milliseconds `work` takes. */
function elapsed(work: () => unknown): number {
  const start = performance.now();
  work();
  return performance.now() - start;
}

test("redactUrlUserinfo hides every URL's userinfo in one linear pass, however many URLs (T15b)", () => {
  // The URL regex this replaces (a scheme tried at every word start) takes about 3 s on this.
  assert.ok(elapsed(() => redactUrlUserinfo("a.".repeat(30_000))) < 1000);
  assert.equal(redactUrlUserinfo("a -https://u:p@h/x and x-ftp://v@w?q, mail@example.org"), "a -https://***@h/x and x-ftp://***@w?q, mail@example.org");
  assert.equal(redactUrlUserinfo("1://u:p@h ://u:p@h"), "1://u:p@h ://u:p@h");
  assert.equal(redactUrlUserinfo("https://h/p?u=a@b"), "https://h/p?u=a@b");
  for (const text of ["a".repeat(1_000_000), "a.".repeat(500_000), "://".repeat(100_000), `https://${"u".repeat(1_000_000)}`]) {
    assert.equal(redactUrlUserinfo(text), text);
  }
  const many = redactUrlUserinfo("https://u:p@h ".repeat(100_000));
  assert.equal(many, "https://***@h ".repeat(100_000));
});

test("redactUrlUserinfo hides the userinfo of a URL glued onto the one before it, still linear (B2)", () => {
  // The authority read for the first `://` ends at the `/` of the second; the second URL starts
  // inside it (its scheme is the first one's host, or follows a redacted `@`), so the search goes
  // on after each `://`, not after the authority. The regex this replaces redacted both; the
  // first linear pass missed them.
  assert.equal(redactUrlUserinfo("https://host://u:p@h"), "https://host://***@h");
  assert.equal(redactUrlUserinfo("https://u:p@x://v:q@w"), "https://***@x://***@w");
  assert.equal(redactUrlUserinfo("see https://h.example:/x://u:p@h"), "see https://h.example:/x://***@h");
  assert.equal(redactUrlUserinfo("https://u:p@1://v:q@w"), "https://***@1://v:q@w");
  // Many glued URLs, unredacted and redacted, and long scheme-character runs: one pass each.
  const n = 100_000;
  for (const [text, want] of [
    [`${"a://".repeat(n)}u:p@h`, `${"a://".repeat(n)}***@h`],
    ["x://u:p@".repeat(n), "x://***@".repeat(n)],
    [`${"a.".repeat(500_000)}://u:p@h`, `${"a.".repeat(500_000)}://***@h`],
    [`https://${"a.".repeat(500_000)}://u:p@h`, `https://${"a.".repeat(500_000)}://***@h`],
    ["a:".repeat(500_000), "a:".repeat(500_000)],
  ] as const) {
    let got = "";
    const ms = elapsed(() => (got = redactUrlUserinfo(text)));
    assert.ok(got === want, `${text.slice(0, 40)}…`);
    assert.ok(ms < 1000, `${Math.round(ms)} ms on ${text.slice(0, 40)}…`);
  }
});

test("sanitizeServerText drops whole escape sequences, not just their control bytes", () => {
  const CSI8 = String.fromCharCode(0x9b);
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  for (const [input, expected] of [
    [`line1 ${ESC}]0;title${BEL}rest`, "line1 rest"],
    [`${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`, "click"],
    [`${ESC}[31mred${ESC}[0m plain`, "red plain"],
    [`${ESC}[1;31;4mbold`, "bold"],
    [`${CSI8}2Jcleared`, "cleared"],
    [`${OSC8}0;t${ST8}ok`, "ok"],
    [`a${ESC}7b${ESC}(Bc`, "abc"],
    // Unterminated: only ESC and its introducer go, the text stays.
    [`keep ${ESC}]0;no terminator here`, "keep 0;no terminator here"],
  ] as const) {
    assert.equal(sanitizeServerText(input), expected, JSON.stringify(input));
  }
});

test("sanitizeServerText drops invisible format characters and keeps one line", () => {
  const text = "real\u200b error\u2028Error: forged\u2066x\u2069 \ufeffend\u00ad\u200d\u2060!";
  assert.equal(sanitizeServerText(text), "real error Error: forgedx end!");
  assert.equal(sanitizeServerText("  Warnung  nicht\n gefunden  Größe  "), "Warnung nicht gefunden Größe");
});

test("sanitizeServerText reads a bounded prefix and drops what the per-character filter dropped", () => {
  // The filter it replaces, one character at a time: C0 but TAB to CR, DEL, C1 and Cf go.
  const perCharacter = (text: string): string =>
    [...text]
      .filter((ch) => {
        const n = ch.codePointAt(0) ?? 0;
        return (n >= 0x09 && n <= 0x0d) || !(n <= 0x1f || (n >= 0x7f && n <= 0x9f) || /\p{Cf}/u.test(ch));
      })
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  const every = Array.from({ length: 0x3000 }, (_, i) => String.fromCharCode(i)).join("") + "\u{1f600}\u{e0001}\ud800x";
  for (let at = 0; at < every.length; at += 512) {
    const piece = every.slice(at, at + 512).replace(/[\u001b\u0090\u0098\u009b-\u009f]/g, "");
    assert.equal(sanitizeServerText(piece), perCharacter(piece), `from U+${at.toString(16)}`);
  }
  // At most 16 384 units of the text are read, never half a surrogate pair.
  assert.equal(sanitizeServerText("x".repeat(100_000)).length, 16_384);
  assert.equal(sanitizeServerText(`${"x".repeat(16_383)}\u{1f600}`), "x".repeat(16_383));
  // A control string ends at another introducer: the first is dropped by the filter, the second
  // string as a whole.
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  assert.equal(sanitizeServerText(`a${OSC8}0;x${OSC8}0;t${ST8}b`), "a0;xb");
  assert.equal(sanitizeServerText(`a${ESC}]0;x${ESC}]0;t${BEL}b`), "a0;xb");
  // An unterminated run of introducers is cleaned in linear time (16 s for 100 000 before).
  for (const intro of ["\u009d", "\u0090", "\u0098", "\u009e", "\u009f", `${ESC}]`]) {
    const ms = elapsed(() => sanitizeServerText(intro.repeat(100_000)));
    assert.ok(ms < 1000, `${Math.round(ms)} ms`);
  }
});

test("a message keeps 500 characters of the cleaned server text, cut after cleaning", async () => {
  const e = new RequestEngine({ maxRetries: 0, transport: async () => jsonResponse({ message: `${"\u200b".repeat(600)}${"y".repeat(600)}` }, 500) });
  const err = await e.getJson("/x").catch((caught: unknown) => caught);
  assert.ok(err instanceof NinaApiError, String(err));
  assert.equal(err.detail, `${"y".repeat(500)}…`);
});

test("a TextBuilder joins its pieces in order across batches", () => {
  const b = new TextBuilder();
  const expected: string[] = [];
  for (let i = 0; i < 40_000; i++) {
    b.push(String(i), ",");
    expected.push(String(i), ",");
  }
  assert.equal(b.toString(), expected.join(""));
  assert.equal(new TextBuilder().toString(), "");
});

// These tests start a process with a small heap: 30 s instead of the suite's 5 s.
const STARTS_A_PROCESS = { timeout: 30_000 };

test("scanNumbers quotes millions of declared members within a small heap", STARTS_A_PROCESS, () => {
  // One `+=` per quoted member made a rope node each: 3 million of them exhausted a 128 MB heap.
  const engine = new URL("../src/engine.js", import.meta.url).href;
  const n = 3_000_000;
  const script =
    `const { scanNumbers } = await import(${JSON.stringify(engine)});` +
    `const json = "[" + '{"k":1},'.repeat(${n - 1}) + '{"k":1}]';` +
    `process.stdout.write(String(scanNumbers(json, new Set(["k"])).json.length));`;
  const out = execFileSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(out, String(n * 10 + 1));
});

test("a 16 MB error detail is cleaned within a small heap", STARTS_A_PROCESS, () => {
  // One `+=` per character over the whole detail aborted a 128 MB heap; the cut came only after.
  const engine = new URL("../src/engine.js", import.meta.url).href;
  const script =
    `const { sanitizeServerText } = await import(${JSON.stringify(engine)});` +
    `process.stdout.write(String(sanitizeServerText("\\u00e4".repeat(16 * 1024 * 1024)).length));`;
  const out = execFileSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(out, "16384");
});

test("millions of lone surrogate escapes are repaired within a small heap", STARTS_A_PROCESS, () => {
  // One `+=` per repair: 6 million repairs aborted a 128 MB heap.
  const engine = new URL("../src/engine.js", import.meta.url).href;
  const script =
    `const { RequestEngine } = await import(${JSON.stringify(engine)});` +
    `const body = Buffer.from('["' + "\\\\ud800".repeat(6_000_000) + '"]');` +
    `const e = new RequestEngine({ transport: async () => ({ status: 200, headers: { "content-type": "application/json" }, body }) });` +
    `const got = await e.getJson("/x");` +
    `process.stdout.write(String(got[0].length));`;
  const out = execFileSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(out, "6000000");
});

test("a credential a server echoes with JSON escapes is scrubbed from the message, the detail and the body", async () => {
  const pw = "s3cret-Pw";
  const base = `https://alice:${pw}@mirror.example`;
  const basic = Buffer.from(`alice:${pw}`).toString("base64");
  const ascii = (text: string): string => JSON.stringify(text).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const everyChar = (text: string): string => `"${[...text].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"`;
  for (const status of [401, 500]) {
    for (const echo of [pw, `alice:${pw}`, basic]) {
      for (const body of [
        `{"message":${ascii(`denied: ${echo}`)}}`,
        `{"detail":${everyChar(echo)}}`,
        `{"message":"denied \\"${echo.slice(0, 3)}\\u${echo.charCodeAt(3).toString(16).padStart(4, "0")}${echo.slice(4)}\\""}`,
      ]) {
        const e = new RequestEngine({ baseUrl: base, maxRetries: 0, transport: async () => rawResponse(body, "application/json", status) });
        const err = await e.getJson("/x").catch((caught: unknown) => caught);
        assert.ok(err instanceof NinaApiError, String(err));
        const decodedBody = JSON.stringify(JSON.parse(err.body === "" ? "null" : err.body));
        for (const text of [err.message, err.detail ?? "", decodedBody]) {
          assert.ok(!text.includes(pw) && !text.includes(basic), `${status} ${body}: ${text}`);
        }
      }
    }
  }
});

test("a credential with an inner space is scrubbed whole, never word by word", async () => {
  // A password typed percent-encoded (`pa%20ss%20word`) is sent decoded as `pa ss word`; the
  // scrub replaces it as one string, so no word of it stays behind.
  const base = "https://alice:pa%20ss%20word@mirror.example";
  for (const body of [
    JSON.stringify({ message: "wrong password pa ss word for alice" }),
    '{"message":"wrong password pa\\u0020ss word for alice"}',
    JSON.stringify({ message: `bad Basic ${Buffer.from("alice:pa ss word").toString("base64")}` }),
  ]) {
    const e = new RequestEngine({ baseUrl: base, maxRetries: 0, transport: async () => rawResponse(body, "application/json", 401) });
    const err = await e.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof NinaApiError, String(err));
    for (const text of [err.message, err.detail ?? "", JSON.stringify(JSON.parse(err.body))]) {
      assert.ok(!/pa ss|ss word|pa\\u0020ss/.test(text), `${body}: ${text}`);
    }
  }
});

test("an error body keeps its spelling unless a credential hides behind an escape", async () => {
  const base = "https://alice:s3cret-pw@mirror.example";
  const bodyOf = async (body: string): Promise<string> => {
    const e = new RequestEngine({ baseUrl: base, maxRetries: 0, transport: async () => rawResponse(body, "application/json", 500) });
    const err = await e.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof NinaApiError, String(err));
    return err.body;
  };
  // No credential, or one spelled as sent: the body as sent (scrubbed), escapes kept.
  assert.equal(await bodyOf('{"m":"caf\\u00e9 \\"x\\""}'), '{"m":"caf\\u00e9 \\"x\\""}');
  assert.equal(await bodyOf('{"m":"pw s3cret-pw \\u00e9"}'), '{"m":"pw *** \\u00e9"}');
  // Escaped: written again decoded, scrubbed in that spelling.
  assert.equal(await bodyOf('{"m":"pw s3cret\\u002dpw \\u00e9"}'), '{"m":"pw *** é"}');
  // Not JSON: nobody decodes it, it stays as sent.
  assert.equal(await bodyOf("pw s3cret\\u002dpw"), "pw s3cret\\u002dpw");
  // Deeply nested: written again where this runtime can, else left out (probed, not assumed:
  // whether JSON.stringify recurses depends on the Node version).
  const deep = `${"[".repeat(200_000)}"s3cret\\u002dpw"${"]".repeat(200_000)}`;
  let parses = true;
  let writes = true;
  try {
    const value: unknown = JSON.parse(deep);
    try {
      JSON.stringify(value);
    } catch {
      writes = false;
    }
  } catch {
    parses = false;
  }
  if (parses) {
    const body = await bodyOf(deep);
    assert.ok(!body.includes("s3cret"), body.slice(199_990, 200_030));
    assert.equal(body === "", !writes);
  }
});

test("a value quoted from an answer is scrubbed before it is cut, so no part of a credential stays", async () => {
  const pw = "s3cret-Pw-long";
  const e = new RequestEngine({ baseUrl: `https://alice:${pw}@mirror.example` });
  for (const at of [0, 490, 495, 499]) {
    const quoted = e.quoteServerValue(`${"x".repeat(at)}${pw}${"y".repeat(600)}`);
    assert.ok(!quoted.includes("s3cret"), `${at}: ${quoted}`);
  }
  assert.equal(new RequestEngine().quoteServerValue('a"b'), '"a\\"b"');
});

test("an echo of the request URL as sent is scrubbed, a short password too", async () => {
  // Typed raw; WHATWG sends `p%22%C3%A4` in the URL (as the default transport parses it), which
  // a server echoes.
  const e = new RequestEngine({
    baseUrl: 'https://alice:p"ä@mirror.example',
    maxRetries: 0,
    transport: async (req) => rawResponse(JSON.stringify({ message: `no access: ${new URL(req.url).href}` }), "application/json", 403),
  });
  const err = await e.getJson("/x").catch((caught: unknown) => caught);
  assert.ok(err instanceof NinaApiError, String(err));
  for (const text of [err.message, err.detail ?? "", err.body]) {
    assert.ok(!text.includes("p%22%C3%A4@") && !text.includes('p"ä@'), text);
  }
});

test("echoedCredentialForms treats a userinfo without a password as a token (Basic `TOKEN:`)", () => {
  const basic = (pair: string): string => Buffer.from(pair, "utf8").toString("base64");
  assert.deepEqual(echoedCredentialForms("alice:s3cret"), [basic("alice:s3cret"), "alice:s3cret", "s3cret"]);
  assert.deepEqual(echoedCredentialForms("T0ken"), [basic("T0ken:"), "T0ken:", "T0ken"]);
  assert.deepEqual(echoedCredentialForms("T0ken:"), [basic("T0ken:"), "T0ken:", "T0ken"]);
  assert.deepEqual(echoedCredentialForms("T%C3%B6k"), [basic("Tök:"), "Tök:"]); // short: not alone
  assert.deepEqual(echoedCredentialForms(":pw12"), [basic(":pw12"), ":pw12", "pw12"]);
  assert.deepEqual(echoedCredentialForms(""), []);
  assert.deepEqual(echoedCredentialForms(":"), []);
});

test("a token in the base URL's userinfo is scrubbed from library errors in every echoed form", async () => {
  // Node sends `https://T0kenS3cret@host` as Basic `T0kenS3cret:`; neither that nor the token was
  // scrubbed, since only a userinfo with a password counted.
  const token = "T0kenS3cret";
  const basic = Buffer.from(`${token}:`).toString("base64");
  for (const base of [`https://${token}@mirror.example`, `https://${token}:@mirror.example`]) {
    for (const echo of [token, `${token}:`, basic]) {
      const e = new RequestEngine({ baseUrl: base, maxRetries: 0, transport: async () => jsonResponse({ message: `denied ${echo}` }, 401) });
      const err = await e.getJson("/x").catch((caught: unknown) => caught);
      assert.ok(err instanceof NinaApiError, String(err));
      for (const text of [err.message, err.detail ?? "", err.body]) assert.ok(!text.includes(token) && !text.includes(basic), `${base} ${echo}: ${text}`);
    }
  }
});

test("credentialsIn ends the authority of a special scheme at a backslash, as WHATWG does", () => {
  for (const scheme of ["http", "https", "HTTPS", "ws", "wss", "ftp"]) {
    assert.deepEqual(credentialsIn(`${scheme}://u:p@a.example\\@b.example/x`), ["u:p"], scheme);
    assert.equal(new URL(`${scheme}://u:p@a.example\\@b.example/x`).password, "p", scheme);
  }
  // Another scheme's authority runs on to "/", "?" or "#".
  assert.deepEqual(credentialsIn("foo://u:p@a.example\\@b.example/x"), ["u:p@a.example\\"]);
  assert.deepEqual(credentialsIn("https://u:p@a.example/x\\@y"), ["u:p"]);
});

test("credentialsIn skips the slashes and backslashes WHATWG skips after a special scheme (F3)", () => {
  // `http:///u:pw@h`, `https:\\u:pw@h` and `http:u:pw@h` all carry `u:pw` for WHATWG; read
  // after "://", the userinfo was missed, so a refused --base-url echoed the password in clear.
  for (const value of [
    "http:alice:pw@h.example",
    "http:/alice:pw@h.example",
    "http:///alice:pw@h.example/x",
    "https:////alice:pw@h.example",
    "HTTPS:\\\\alice:pw@h.example",
    "wss:\\/alice:pw@h.example",
    "ftp:alice:pw@h.example",
  ]) {
    assert.deepEqual(credentialsIn(value), ["alice:pw"], value);
    assert.equal(new URL(value).password, "pw", value);
  }
  // Another scheme needs "//" before an authority: `foo:u:p@h` and `foo:///u:p@h` carry none.
  assert.deepEqual(credentialsIn("foo:u:p@h.example"), []);
  assert.deepEqual(credentialsIn("foo:///u:p@h.example"), []);
  assert.equal(new URL("foo:///u:p@h.example").password, "");
});

test("a base URL with a backslash or a repaired scheme is rejected at construction, never echoing the password (F, F4)", () => {
  const pw = "s3cret-Pw";
  for (const base of [
    `https://alice:${pw}@api.example\\@evil.example`,
    `http:alice:${pw}@127.0.0.1:9`,
    `http:/alice:${pw}@127.0.0.1:9`,
    `http:///alice:${pw}@127.0.0.1:9`,
    `HTTPS:alice:${pw}@mirror.example`,
    `https:\\\\alice:${pw}@mirror.example`,
  ]) {
    assert.throws(
      () => new RequestEngine({ baseUrl: base }),
      (err: unknown) => err instanceof NinaValidationError && !err.message.includes(pw) && !inspect(err).includes(pw),
      base,
    );
  }
});

test("requests go to the base URL as WHATWG parses it, spelled as it parses", async () => {
  const urls: string[] = [];
  const e = new RequestEngine({
    baseUrl: "https://API.Example:443/v1/",
    transport: async (req) => {
      urls.push(req.url);
      return jsonResponse([]);
    },
  });
  await e.getJson("/x");
  assert.deepEqual(urls, ["https://api.example/v1/x"]);
  assert.equal(e.buildUrl("/y"), "https://api.example/v1/y");
});

test("typedUrlCredentials reads a value meant as a URL whatever its scheme: missing, special without //, mistyped (F7)", () => {
  for (const [value, userinfo] of [
    ["https://alice:pw@h.example/x", "alice:pw"],
    ["http:///alice:pw@h.example", "alice:pw"],
    ["alice:pw@h.example/x", "alice:pw"],
    ["my_user:pw@h.example", "my_user:pw"],
    ["T0ken:@h.example", "T0ken:"],
    ["http//alice:pw@h.example", "alice:pw"],
    ["https//alice:pw@h.example/v1", "alice:pw"],
    ["http/alice:pw@h.example", "alice:pw"],
    ["htp:/alice:pw@h.example", "alice:pw"],
    ["http\\\\alice:pw@h.example", "alice:pw"],
    ["http//alice:p/w@h.example", "alice:p/w"],
  ] as const) {
    assert.deepEqual(typedUrlCredentials(value), [userinfo], value);
  }
  // No "@" after the slashes, or a scheme spelled with "//" and no userinfo: none.
  for (const value of ["", "h.example/x", "http//h.example/x", "@h.example/x", "http//@h.example", "https://h.example/a@b"]) {
    assert.deepEqual(typedUrlCredentials(value), [], value);
  }
});
