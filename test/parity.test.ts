// CLI <-> library parity: the same input through run() and through the library,
// on one recording mock transport, must give the same outcome — both reject with
// no request sent, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { NinaClient } from "../src/client/client.js";
import { NinaValidationError } from "../src/client/errors.js";
import type { EngineOptions } from "../src/client/engine.js";
import * as lib from "../src/index.js";
import { parity, jsonResponse } from "./helpers.js";

/** Both sides rejected the input before any request, with the same message. */
function assertBothRejected(
  outcome: Awaited<ReturnType<typeof parity>>,
  label: string,
): NinaValidationError {
  const { cli, lib } = outcome;
  assert.equal(cli.code, 1, `${label}: CLI exit code`);
  assert.deepEqual(cli.requests, [], `${label}: CLI sent a request`);
  assert.equal(lib.ok, false, `${label}: library accepted the input`);
  assert.deepEqual(lib.requests, [], `${label}: library sent a request`);
  const error = (lib as { error: unknown }).error;
  assert.ok(error instanceof NinaValidationError, `${label}: ${String(error)}`);
  assert.equal(cli.err, `Error: ${error.message}`, label);
  return error;
}

/**
 * Both sides rejected the input before any request; the CLI as a usage error
 * (exit 1, from its option parser), the library with a NinaValidationError.
 */
function assertBothRejectedAtParse(outcome: Awaited<ReturnType<typeof parity>>, label: string): void {
  const { cli, lib: l } = outcome;
  assert.equal(cli.code, 1, `${label}: CLI exit code`);
  assert.deepEqual(cli.requests, [], `${label}: CLI sent a request`);
  assert.match(cli.err, /is invalid/, label);
  assert.equal(l.ok, false, `${label}: library accepted the input`);
  assert.deepEqual(l.requests, [], `${label}: library sent a request`);
  assert.ok((l as { error: unknown }).error instanceof NinaValidationError, label);
}

const mapData = (options: EngineOptions) => (transport: EngineOptions["transport"]) =>
  new NinaClient({ ...options, transport }).mapData("dwd");

// ---- Finding 1 (PAT-10): warning and archive identifiers ------------------------

const identifierCommands: Array<[string[], (c: NinaClient, id: string) => Promise<unknown>]> = [
  [["warning", "get"], (c, id) => c.warnings.get(id)],
  [["warning", "geojson"], (c, id) => c.warnings.geojson(id)],
  [["archive", "mapping"], (c, id) => c.archive.mapping(id)],
  [["archive", "get"], (c, id) => c.archive.get(id)],
];

test("parity: a blank or separator-bearing identifier is rejected by CLI and library alike", async () => {
  for (const [argv, call] of identifierCommands) {
    for (const id of ["", " ", "a/b", "a\\b", "../../etc/passwd", "/x.json"]) {
      const label = `${argv.join(" ")} ${JSON.stringify(id)}`;
      const error = assertBothRejected(
        await parity(["--compact", ...argv, "--", id], (transport) => call(new NinaClient({ transport }), id)),
        label,
      );
      assert.match(error.message, /^Invalid identifier: /, label);
    }
  }
});

test("parity: a valid identifier sends the identical request from CLI and library", async () => {
  for (const [argv, call] of identifierCommands) {
    const { cli, lib } = await parity(
      ["--compact", ...argv, "mow.DE-SL-SLS-W038-20260901-000"],
      (transport) => call(new NinaClient({ transport }), "mow.DE-SL-SLS-W038-20260901-000"),
      () => jsonResponse({ identifier: "x" }),
    );
    assert.equal(cli.code, 0, argv.join(" "));
    assert.equal(lib.ok, true, argv.join(" "));
    assert.equal(cli.requests.length, 1);
    assert.deepEqual(lib.requests.map((r) => r.url), cli.requests.map((r) => r.url));
  }
});

// ---- Finding 3 (PAT-8): timeoutMs and maxRetries ---------------------------------

test("parity: an out-of-range timeout or retry count is rejected by CLI and library alike", async () => {
  const cases: Array<[string[], EngineOptions]> = [
    [["--timeout", "-1"], { timeoutMs: -1 }],
    [["--timeout", "1.5"], { timeoutMs: 1.5 }],
    [["--timeout", "NaN"], { timeoutMs: Number.NaN }],
    [["--timeout", "Infinity"], { timeoutMs: Number.POSITIVE_INFINITY }],
    [["--timeout", "2147483648"], { timeoutMs: 2_147_483_648 }],
    [["--max-retries", "-1"], { maxRetries: -1 }],
    [["--max-retries", "1.5"], { maxRetries: 1.5 }],
    [["--max-retries", "NaN"], { maxRetries: Number.NaN }],
    [["--max-retries", "Infinity"], { maxRetries: Number.POSITIVE_INFINITY }],
    [["--max-retries", "11"], { maxRetries: 11 }],
  ];
  for (const [flags, options] of cases) {
    assertBothRejectedAtParse(
      await parity([...flags, "--compact", "map-data", "dwd"], mapData(options), () => jsonResponse([])),
      flags.join(" "),
    );
  }
});

test("parity: the timeout and retry bounds themselves are accepted on both sides", async () => {
  const cases: Array<[string[], EngineOptions]> = [
    [["--timeout", "0"], { timeoutMs: 0 }],
    [["--timeout", "2147483647"], { timeoutMs: 2_147_483_647 }],
    [["--max-retries", "0"], { maxRetries: 0 }],
    [["--max-retries", "10"], { maxRetries: 10 }],
  ];
  for (const [flags, options] of cases) {
    const { cli, lib: l } = await parity([...flags, "--compact", "map-data", "dwd"], mapData(options), () => jsonResponse([]));
    assert.equal(cli.code, 0, flags.join(" "));
    assert.equal(l.ok, true, flags.join(" "));
    assert.deepEqual(l.requests, cli.requests, flags.join(" "));
  }
});

test("the retry cap is one exported library constant", () => {
  assert.equal(lib.MAX_RETRIES, 10);
});

// ---- Finding 2 (PAT-5): the User-Agent ---------------------------------------------

test("parity: a blank or unsendable User-Agent is rejected by CLI and library alike", async () => {
  for (const ua of ["", "   ", "a\r\nX-Injected: 1", "x\u0000y", "a\u007fb", "agent€"]) {
    assertBothRejectedAtParse(
      await parity(["--user-agent", ua, "--compact", "map-data", "dwd"], mapData({ userAgent: ua }), () => jsonResponse([])),
      JSON.stringify(ua),
    );
  }
});

test("parity: a sendable User-Agent goes out unchanged from CLI and library", async () => {
  for (const ua of ["my-app/1.0", "a\tb", "café"]) {
    const { cli, lib: l } = await parity(["--user-agent", ua, "--compact", "map-data", "dwd"], mapData({ userAgent: ua }), () => jsonResponse([]));
    assert.equal(cli.code, 0, JSON.stringify(ua));
    assert.equal(l.ok, true, JSON.stringify(ua));
    assert.equal(cli.requests[0]!.headers?.["User-Agent"], ua);
    assert.deepEqual(l.requests, cli.requests);
  }
});

// ---- Finding 5 (PAT-2, PAT-1): the base URL ----------------------------------------

test("parity: a malformed --base-url / baseUrl is rejected by both, as a validation error", async () => {
  const cases: Array<[string, RegExp]> = [
    ["ftp://h.example", /Unsupported scheme "ftp:"\. Expected an http\(s\) URL\./],
    ["file:///etc", /Unsupported scheme "file:"\. Expected an http\(s\) URL\./],
    ["notaurl", /Expected an absolute http\(s\) URL\./],
    ["", /Expected an absolute http\(s\) URL\./],
    ["   ", /Expected an absolute http\(s\) URL\./],
    ["https://h.example/#f", /A base URL cannot have a query \(\?\) or fragment \(#\)\./],
    ["https://h.example/?q=1", /A base URL cannot have a query \(\?\) or fragment \(#\)\./],
    ["https://h.example/api?", /A base URL cannot have a query \(\?\) or fragment \(#\)\./],
    [" https://h.example", /A base URL cannot have surrounding whitespace\./],
    ["https://h.example/ ", /A base URL cannot have surrounding whitespace\./],
    ["https://h.example/p\tq", /A base URL cannot contain whitespace or control characters\./],
  ];
  for (const [bad, message] of cases) {
    const { cli, lib: l } = await parity(
      ["--base-url", bad, "--compact", "map-data", "dwd"],
      mapData({ baseUrl: bad }),
      () => jsonResponse([]),
    );
    const label = JSON.stringify(bad);
    assert.equal(cli.code, 1, label);
    assert.deepEqual(cli.requests, [], label);
    assert.match(cli.err, message, label);
    assert.equal(l.ok, false, label);
    assert.deepEqual(l.requests, [], label);
    const error = (l as { error: unknown }).error;
    assert.ok(error instanceof NinaValidationError, `${label}: ${String(error)}`);
    assert.ok(!(error instanceof lib.NinaNetworkError), label);
    assert.match(error.message, /^Invalid baseUrl: /, label);
    assert.match(error.message, message, label);
  }
});

test("parity: a base URL with a path prefix (a mirror) is used the same by both", async () => {
  const { cli, lib: l } = await parity(
    ["--base-url", "https://mirror.test/nina/", "--compact", "map-data", "dwd"],
    mapData({ baseUrl: "https://mirror.test/nina/" }),
    () => jsonResponse([]),
  );
  assert.equal(cli.code, 0);
  assert.equal(cli.requests[0]!.url, "https://mirror.test/nina/api31/dwd/mapData.json");
  assert.deepEqual(l.requests, cli.requests);
});

test("the NinaClient constructor rejects a bad baseUrl synchronously", () => {
  assert.throws(() => new NinaClient({ baseUrl: "ftp://h.example" }), NinaValidationError);
});

// ---- Finding 4 (PAT-23): dashboard region keys ------------------------------------

test("parity: dashboard rejects a bad region key with the library's arsProblem message on both sides", async () => {
  for (const ars of ["", "   ", "a/b", "05515/0000000", " 055150000000", "050000000000", "55150000000"]) {
    const error = assertBothRejected(
      await parity(["--compact", "dashboard", "--", ars], (transport) => new NinaClient({ transport }).dashboard(ars)),
      JSON.stringify(ars),
    );
    assert.equal(error.message, lib.arsProblem(ars), JSON.stringify(ars));
  }
});

test("parity: dashboard sends the identical request for a district key", async () => {
  const { cli, lib: l } = await parity(
    ["--compact", "dashboard", "055150000000"],
    (transport) => new NinaClient({ transport }).dashboard("055150000000"),
    () => jsonResponse([]),
  );
  assert.equal(cli.code, 0);
  assert.equal(l.ok, true);
  assert.equal(cli.requests.length, 1);
  assert.deepEqual(l.requests, cli.requests);
});
