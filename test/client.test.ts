import { test } from "node:test";
import assert from "node:assert/strict";
import { NinaClient } from "../src/client/client.js";
import { NinaApiError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, constantJson, rawResponse } from "./helpers.js";

function clientWith(mt: ReturnType<typeof makeMockTransport>): NinaClient {
  return new NinaClient({ transport: mt.transport });
}

test("mapData builds the per-source path", async () => {
  const mt = constantJson([{ id: "1", version: 1, startDate: "x", severity: "Severe", i18nTitle: {} }]);
  const items = await clientWith(mt).mapData("dwd");
  assert.equal(items.length, 1);
  assert.equal(new URL(mt.last().url).pathname, "/api31/dwd/mapData.json");
});

test("warnings.get builds the warnings path with .json", async () => {
  const mt = constantJson({ identifier: "abc" });
  await clientWith(mt).warnings.get("abc.123");
  assert.equal(new URL(mt.last().url).pathname, "/api31/warnings/abc.123.json");
});

test("warnings.get url-encodes characters that need escaping", async () => {
  const mt = constantJson({ identifier: "x" });
  await clientWith(mt).warnings.get("a b/c");
  // The space becomes %20 and the slash becomes %2F; the .json suffix is intact.
  assert.equal(new URL(mt.last().url).pathname, "/api31/warnings/a%20b%2Fc.json");
});

test("warnings.geojson requests the .geojson path and returns raw bytes", async () => {
  const mt = makeMockTransport(() => rawResponse('{"type":"FeatureCollection"}', "application/geo+json"));
  const res = await clientWith(mt).warnings.geojson("abc");
  assert.equal(new URL(mt.last().url).pathname, "/api31/warnings/abc.geojson");
  assert.equal(res.data.toString("utf8"), '{"type":"FeatureCollection"}');
});

test("dashboard builds the dashboard path and url-encodes the ARS", async () => {
  const mt = constantJson([]);
  await clientWith(mt).dashboard("055150000000");
  assert.equal(new URL(mt.last().url).pathname, "/api31/dashboard/055150000000.json");
});

test("archive.mapping builds the -mapping.json path", async () => {
  const mt = constantJson({ history: [] });
  await clientWith(mt).archive.mapping("DE-BW-X");
  assert.equal(new URL(mt.last().url).pathname, "/api31/archive.mowas/DE-BW-X-mapping.json");
});

test("reference.notfalltipps builds the appdata path", async () => {
  const mt = constantJson({});
  await clientWith(mt).reference.notfalltipps();
  assert.equal(
    new URL(mt.last().url).pathname,
    "/api31/appdata/gsb/notfalltipps/DE/notfalltipps.json",
  );
});

test("a 404 raises NinaApiError with status 404", async () => {
  const mt = makeMockTransport(() => jsonResponse({ message: "not found" }, 404));
  await assert.rejects(
    () => clientWith(mt).warnings.get("nope"),
    (err) => err instanceof NinaApiError && err.status === 404,
  );
});
