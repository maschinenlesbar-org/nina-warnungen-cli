import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { NinaClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { NinaNetworkError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";

function makeCli(responder: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, Buffer>();
  const mt = makeMockTransport(responder);

  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: (p, d) => files.set(p, d),
      outBinary: (d) => out.push(d.toString("utf8")),
    },
    createClient: (opts) => new NinaClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, files, mt };
}

test("map-data hits the per-source path", async () => {
  const cli = makeCli(() => jsonResponse([{ id: "1" }]));
  const code = await run(["map-data", "mowas"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/api31/mowas/mapData.json");
});

test("map-data rejects an invalid source before any request", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const code = await run(["map-data", "bogus"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid source/);
});

test("sources lists the valid sources", async () => {
  const cli = makeCli(() => jsonResponse([]));
  await run(["sources"], cli.deps);
  assert.deepEqual(JSON.parse(cli.out.join("\n")), [
    "mowas",
    "katwarn",
    "biwapp",
    "dwd",
    "lhp",
    "police",
  ]);
});

test("warning geojson writes to a file with -o", async () => {
  const cli = makeCli(() => rawResponse('{"type":"FeatureCollection"}', "application/geo+json"));
  const code = await run(["-o", "out.geojson", "warning", "geojson", "abc"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.files.get("out.geojson")?.toString("utf8"), '{"type":"FeatureCollection"}');
  assert.match(cli.err.join("\n"), /Wrote \d+ bytes to out\.geojson/);
});

test("dashboard builds the right path", async () => {
  const cli = makeCli(() => jsonResponse([]));
  await run(["dashboard", "055150000000"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).pathname, "/api31/dashboard/055150000000.json");
});

test("a 404 from the API maps to exit code 4", async () => {
  const cli = makeCli(() => jsonResponse({ message: "missing" }, 404));
  const code = await run(["warning", "get", "nope"], cli.deps);
  assert.equal(code, 4);
});

test("a non-404 4xx from the API maps to exit code 1", async () => {
  const cli = makeCli(() => jsonResponse({ message: "bad request" }, 400));
  const code = await run(["warning", "get", "nope"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /HTTP 400/);
});

test("a 500 from the API maps to exit code 1", async () => {
  const cli = makeCli(() => jsonResponse({ message: "boom" }, 500));
  const code = await run(["map-data", "dwd"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /HTTP 500/);
});

test("a network error maps to exit code 1", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: () => {},
      outBinary: () => {},
    },
    createClient: (opts) =>
      new NinaClient({
        ...opts,
        transport: () => Promise.reject(new NinaNetworkError("connection reset")),
      }),
  };
  const code = await run(["map-data", "dwd"], deps);
  assert.equal(code, 1);
  assert.match(err.join("\n"), /connection reset/);
});

test("a malformed JSON body maps to exit code 1 (NinaParseError)", async () => {
  const cli = makeCli(() => rawResponse("not json", "application/json"));
  const code = await run(["map-data", "dwd"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /Failed to parse JSON/);
});

test("an --output write failure maps to exit code 1", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(() =>
    rawResponse('{"type":"FeatureCollection"}', "application/geo+json"),
  );
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: () => {
        const e = new Error("EACCES: permission denied");
        (e as NodeJS.ErrnoException).code = "EACCES";
        throw e;
      },
      outBinary: (d) => out.push(d.toString("utf8")),
    },
    createClient: (opts) => new NinaClient({ ...opts, transport: mt.transport }),
  };
  const code = await run(["-o", "/no/such/dir/out.geojson", "warning", "geojson", "abc"], deps);
  assert.equal(code, 1);
  assert.match(err.join("\n"), /EACCES/);
});

test("warning geojson warns when the content-type is not JSON", async () => {
  const cli = makeCli(() => rawResponse("<html>error</html>", "text/html"));
  const code = await run(["warning", "geojson", "abc"], cli.deps);
  assert.equal(code, 0);
  assert.match(cli.err.join("\n"), /Warning: expected a "json" response/);
});

test("warning get builds the warnings path", async () => {
  const cli = makeCli(() => jsonResponse({ identifier: "abc" }));
  const code = await run(["warning", "get", "abc.123"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/api31/warnings/abc.123.json");
});

test("archive get builds the archive path", async () => {
  const cli = makeCli(() => jsonResponse({ identifier: "x" }));
  const code = await run(["archive", "get", "DE-BW-X"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/api31/archive.mowas/DE-BW-X.json");
});

test("archive mapping builds the -mapping.json path", async () => {
  const cli = makeCli(() => jsonResponse({ history: [] }));
  const code = await run(["archive", "mapping", "DE-BW-X"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/api31/archive.mowas/DE-BW-X-mapping.json");
});

test("reference event-codes builds the eventCodes path", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["reference", "event-codes"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/api31/appdata/gsb/eventCodes/eventCodes.json");
});

test("reference data-version builds the dataVersion path", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["reference", "data-version"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/api31/dynamic/version/dataVersion.json");
});

test("reference notfalltipps builds the appdata path", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["reference", "notfalltipps"], cli.deps);
  assert.equal(code, 0);
  assert.equal(
    new URL(cli.mt.last().url).pathname,
    "/api31/appdata/gsb/notfalltipps/DE/notfalltipps.json",
  );
});

test("--compact prints JSON on a single line", async () => {
  const cli = makeCli(() => jsonResponse([{ id: "1" }]));
  const code = await run(["--compact", "map-data", "dwd"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.out.join("\n"), '[{"id":"1"}]');
});

test("--timeout rejects a non-integer value with a usage error", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const code = await run(["--timeout", "abc", "map-data", "dwd"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /non-negative integer/);
});
