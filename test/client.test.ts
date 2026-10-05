import { test } from "node:test";
import assert from "node:assert/strict";
import { NinaClient } from "../src/client/client.js";
import { NinaApiError, NinaError, NinaNotFoundError, NinaParseError, NinaValidationError } from "../src/client/errors.js";
import type { NinaSource } from "../src/client/enums.js";
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
  await clientWith(mt).warnings.get("a%b?c#d");
  // %, ? and # are escaped; the .json suffix is intact.
  assert.equal(new URL(mt.last().url).pathname, "/api31/warnings/a%25b%3Fc%23d.json");
});

test("identifier methods reject a blank or separator-bearing id with NinaValidationError, no request", async () => {
  const mt = constantJson({ identifier: "x" });
  const client = clientWith(mt);
  const calls: Array<[string, (id: string) => Promise<unknown>]> = [
    ["warnings.get", (id) => client.warnings.get(id)],
    ["warnings.geojson", (id) => client.warnings.geojson(id)],
    ["archive.mapping", (id) => client.archive.mapping(id)],
    ["archive.get", (id) => client.archive.get(id)],
  ];
  for (const [name, call] of calls) {
    for (const id of ["", "  ", "a/b", "a\\b"]) {
      await assert.rejects(call(id), NinaValidationError, `${name} ${JSON.stringify(id)}`);
    }
  }
  await assert.rejects(client.archive.get(".json"), /Invalid identifier: Expected a non-empty value\./);
  assert.equal(mt.calls.length, 0);
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

test("warnings.get/geojson turn the archive redirect into NinaNotFoundError", async () => {
  const mt = makeMockTransport(() => ({
    status: 302,
    headers: { location: "https://warnung.bund.de/api31/archive/alerts/x?contentType=json" },
    body: Buffer.alloc(0),
  }));
  for (const call of [() => clientWith(mt).warnings.get("x"), () => clientWith(mt).warnings.geojson("x")]) {
    await assert.rejects(
      call,
      (err) =>
        err instanceof NinaNotFoundError &&
        err.identifier === "x" &&
        err.location === "https://warnung.bund.de/api31/archive/alerts/x?contentType=json" &&
        err.cause instanceof NinaApiError,
    );
  }
  // A redirect elsewhere is not a "not live" answer: it stays a NinaApiError.
  const other = makeMockTransport(() => ({ status: 302, headers: { location: "/login" }, body: Buffer.alloc(0) }));
  await assert.rejects(
    () => clientWith(other).warnings.get("x"),
    (err) => err instanceof NinaApiError && err.status === 302,
  );
});

test("dashboard rejects a state-level key for library callers too", async () => {
  const mt = constantJson([]);
  await assert.rejects(() => clientWith(mt).dashboard("050000000000"), /not a district key/);
  assert.equal(mt.calls.length, 0);
});

test("mapData rejects a source outside the set before any request (no path escape)", async () => {
  const mt = constantJson([]);
  for (const bad of ["../../ok/x?", "DWD", "", "__proto__"]) {
    await assert.rejects(
      () => clientWith(mt).mapData(bad as NinaSource),
      (err) => err instanceof NinaError && /Invalid source/.test(err.message),
      bad,
    );
  }
  assert.equal(mt.calls.length, 0);
});

test("a negative or non-integer maxResponseBytes is rejected; 0 means no limit", async () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new NinaClient({ maxResponseBytes: bad }),
      (err) => err instanceof NinaError && /Invalid option maxResponseBytes/.test(err.message),
      String(bad),
    );
  }
  const mt = constantJson([]);
  await new NinaClient({ transport: mt.transport, maxResponseBytes: 0 }).mapData("dwd");
  assert.equal(mt.last().maxResponseBytes, undefined);
});

test("the archive redirect is recognised whatever case or shape the Location header has", async () => {
  const target = "https://warnung.bund.de/api31/archive/alerts/x?contentType=json";
  const shapes: unknown[] = [{ Location: target }, { LOCATION: target }, new Headers({ Location: target }), new Map([["Location", target]])];
  for (const headers of shapes) {
    const mt = makeMockTransport(() => ({ status: 302, headers: headers as Record<string, string>, body: Buffer.alloc(0) }));
    await assert.rejects(
      clientWith(mt).warnings.get("x"),
      (err: unknown) => err instanceof NinaNotFoundError && err.location === target,
      `headers ${(headers as object).constructor.name}`,
    );
  }
});

test("a 2xx body without the documented shape is a NinaParseError, never an empty list", async () => {
  const lists: Array<[string, (c: NinaClient) => Promise<unknown>]> = [
    ["mapData", (c) => c.mapData("mowas")],
    ["dashboard", (c) => c.dashboard("055150000000")],
  ];
  const bad: unknown[] = [null, {}, "text", 42, true, { error: "Internal", message: "backend down", status: 500 }, { message: "Not available" }, [null], [42], [[]]];
  for (const [label, call] of lists) {
    for (const body of bad) {
      await assert.rejects(call(clientWith(constantJson(body))), NinaParseError, `${label} ${JSON.stringify(body)}`);
    }
    // An empty list is a real answer: no warnings.
    assert.deepEqual(await call(clientWith(constantJson([]))), []);
  }
  await assert.rejects(
    clientWith(constantJson({ message: "backend down" })).dashboard("055150000000"),
    (err: unknown) => err instanceof NinaParseError && /expected a JSON array of warning objects, got an object with the message "backend down"/.test(err.message),
  );
  for (const body of [null, {}, [], { message: "x" }]) {
    await assert.rejects(clientWith(constantJson(body)).warnings.get("x"), NinaParseError, `get ${JSON.stringify(body)}`);
    await assert.rejects(clientWith(constantJson(body)).archive.get("x"), NinaParseError, `archive.get ${JSON.stringify(body)}`);
    await assert.rejects(clientWith(constantJson(body)).archive.mapping("x"), NinaParseError, `mapping ${JSON.stringify(body)}`);
  }
  for (const body of [null, "x", 1]) {
    await assert.rejects(clientWith(constantJson(body)).reference.eventCodes(), NinaParseError, `eventCodes ${JSON.stringify(body)}`);
  }
});

test("copy-paste artefacts around a warning id are dropped before the request", async () => {
  const id = "mow.DE-NW-KLE-SE058-20261005-58-000";
  const variants = [
    `${id} `, ` ${id}`, `${id}\r`, `${id}\n`, `${id}\t`, `${id} `, `​${id}`, `${id}﻿`,
    `“${id}”`, `"${id}"`, `'${id}'`, `${id}.json`, `${id}.JSON`, `${id}.geojson`, `${id}.json `, `${id.normalize("NFD")}`,
  ];
  const calls: Array<[string, (c: NinaClient, v: string) => Promise<unknown>, string]> = [
    ["warnings.get", (c, v) => c.warnings.get(v), `/api31/warnings/${id}.json`],
    ["warnings.geojson", (c, v) => c.warnings.geojson(v), `/api31/warnings/${id}.geojson`],
    ["archive.get", (c, v) => c.archive.get(v), `/api31/archive.mowas/${id}.json`],
    ["archive.mapping", (c, v) => c.archive.mapping(v), `/api31/archive.mowas/${id}-mapping.json`],
  ];
  for (const [label, call, path] of calls) {
    for (const v of variants) {
      const mt = makeMockTransport(() => jsonResponse({ identifier: id, history: [] }));
      await call(clientWith(mt), v);
      assert.equal(new URL(mt.last().url).pathname, path, `${label} ${JSON.stringify(v)}`);
    }
  }
  // Whitespace or an invisible character inside an id is refused before any request.
  for (const v of [`mow.DE NW`, `mow.DE NW`, `mow.DE​NW`, `mow.DE\tNW`]) {
    const mt = constantJson({ identifier: "x" });
    await assert.rejects(clientWith(mt).warnings.get(v), NinaValidationError, JSON.stringify(v));
    assert.equal(mt.calls.length, 0);
  }
  // Case is kept: the API's ids are case-sensitive.
  const mt = constantJson({ identifier: "x" });
  await clientWith(mt).warnings.get(id.toLowerCase());
  assert.equal(new URL(mt.last().url).pathname, `/api31/warnings/${id.toLowerCase()}.json`);
});
