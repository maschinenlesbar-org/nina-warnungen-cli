// Each retry is announced through the engine's onRetry and logged by the CLI as one WARN
// record of `nina.http`; stdout is the same as without the retry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine } from "../src/client/engine.js";
import { NinaApiError, NinaValidationError } from "../src/client/errors.js";
import { NinaClient } from "../src/client/client.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, untimed } from "./helpers.js";

const busy = (retryAfter?: string): HttpResponse => ({
  status: 503,
  headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
  body: Buffer.from("{}"),
});

const call = (e: RequestEngine) => e.request("GET", "/x");

test("onRetry is called once per retry, with the event fields, right before the sleep", async () => {
  const log: string[] = [];
  const events: unknown[] = [];
  let n = 0;
  const mt = makeMockTransport(() => (n++ < 2 ? busy(n === 1 ? "2" : undefined) : jsonResponse({ ok: 1 })));
  const e = new RequestEngine({
    transport: mt.transport,
    baseUrl: "https://user:pw@example.test",
    maxRetries: 3,
    sleep: async (ms) => void log.push(`sleep ${ms}`),
    onRetry: (ev) => {
      events.push(ev);
      log.push("retry");
    },
  });
  await call(e);
  assert.deepEqual(log, ["retry", "sleep 2000", "retry", "sleep 400"]);
  assert.deepEqual(events, [
    { retry: 1, maxRetries: 3, delayMs: 2000, status: 503, url: "https://***@example.test/x" },
    { retry: 2, maxRetries: 3, delayMs: 400, status: 503, url: "https://***@example.test/x" },
  ]);
});

test("onRetry reports a reset connection without a status", async () => {
  let n = 0;
  const events: unknown[] = [];
  const mt = makeMockTransport(() => {
    if (n++ === 0) throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {}, onRetry: (ev) => void events.push(ev) });
  await call(e);
  assert.equal(events.length, 1);
  assert.equal((events[0] as { status?: number }).status, undefined);
  assert.equal((events[0] as { retry: number }).retry, 1);
});

test("a throwing onRetry never breaks the request", async () => {
  let n = 0;
  const mt = makeMockTransport(() => (n++ === 0 ? busy() : jsonResponse({ ok: 1 })));
  const e = new RequestEngine({
    transport: mt.transport,
    sleep: async () => {},
    onRetry: () => {
      throw new Error("boom");
    },
  });
  await call(e);
  assert.equal(mt.calls.length, 2);
});

test("onRetry is never called without a retry", async () => {
  const events: unknown[] = [];
  const onRetry = (ev: unknown) => void events.push(ev);
  const engine = (responder: () => HttpResponse, extra: { maxRetries?: number } = {}) =>
    new RequestEngine({ transport: makeMockTransport(responder).transport, sleep: async () => {}, onRetry, ...extra });
  await call(engine(() => jsonResponse({})));
  await assert.rejects(call(engine(() => jsonResponse({ detail: "no" }, 404))), NinaApiError);
  // retries exhausted: the last 503 is an error, not a retry
  await assert.rejects(call(engine(() => busy(), { maxRetries: 1 })), NinaApiError);
  assert.equal(events.length, 1);
  // a Retry-After over the cap is not retried
  await assert.rejects(call(engine(() => busy("999999"))), NinaApiError);
  assert.equal(events.length, 1);
});

test("onRetry must be a function", () => {
  assert.throws(() => new RequestEngine({ onRetry: 5 as never }), NinaValidationError);
});

async function exercise(extra: string[], failures: number, retryAfter?: string) {
  const out: string[] = [];
  const err: string[] = [];
  let n = 0;
  const transport = async (_req: HttpRequest): Promise<HttpResponse> => (n++ < failures ? busy(retryAfter) : jsonResponse([{ id: "1" }]));
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), writeFile: () => {}, outBinary: () => {} },
    now: () => new Date("2026-01-02T03:04:05.678Z"),
    createClient: (opts) => new NinaClient({ ...opts, transport, sleep: async () => {} }),
  };
  const code = await run([...extra, ...["map-data", "mowas"]], deps);
  return { code, out: out.join("\n"), err };
}

test("a 503 then 200 exits 0, same stdout, and logs one WARN of nina.http", async () => {
  const plain = await exercise([], 0);
  const retried = await exercise(["--base-url", "https://mirror.test"], 1, "2");
  assert.equal(retried.code, 0);
  assert.equal(retried.out, plain.out);
  assert.equal(plain.err.length, 0);
  assert.deepEqual(untimed(retried.err.join("\n")).split("\n"), [
    "WARN  [nina.http] HTTP 503 from mirror.test: retry 1 of 2 in 2 s",
  ]);
});

test("the same record in jsonl, with the delay in ms under one second", async () => {
  const r = await exercise(["--log-format", "jsonl"], 1);
  assert.equal(r.code, 0);
  assert.equal(r.err.length, 1);
  const rec = JSON.parse(r.err[0] as string) as Record<string, unknown>;
  assert.equal(rec["level"], "WARN");
  assert.equal(rec["topic"], "nina.http");
  assert.equal(rec["msg"], "HTTP 503 from warnung.bund.de: retry 1 of 2 in 200 ms");
});
