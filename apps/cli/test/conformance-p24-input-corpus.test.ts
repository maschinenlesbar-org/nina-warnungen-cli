// Conformance test P24 (trend analysis 2026-10-21): an input is canonicalised or refused, never
// sent raw. One corpus of tricky values goes through every text filter and every id the repo
// declares, on the CLI and in the library. Either both refuse it before any request (exit 2,
// the validation error), or both send the same request with the value in canonical form: a
// text without surrounding whitespace, in composed Unicode, never blank; an id as the adapter
// canonicalises it, never empty, a dot segment or with a "/". Each value here was once sent raw
// by some *-cli and matched nothing, or the wrong thing, with exit 0. Shared across the *-cli
// repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/nina-warnungen-client/internal/http";

// ---- adapter (per repo) -------------------------------------------------------------
/**
 * `parity(argv, call, responder)`: argv through run() and `call` through the library, each on a
 * recording mock transport; resolves to `{ cli: { code, out, err, requests }, lib: { ok, value?,
 * error?: { name, message }, requests } }`. Map the repo's own helper to this shape if it differs.
 */
import { jsonResponse, rawResponse, parity as repoParity } from "./helpers.js";
import type { Transport } from "@maschinenlesbar.org/nina-warnungen-client/internal/http";
/** nina's parity keeps the library's error as thrown; the kit shape names it. */
async function parity(argv: string[], call: (transport: Transport) => unknown, responder: (req: HttpRequest) => HttpResponse) {
  const { cli, lib } = await repoParity(argv, call, responder);
  const error = lib.ok ? undefined : lib.error instanceof Error ? { name: lib.error.name, message: lib.error.message } : { name: "", message: String(lib.error) };
  return { cli, lib: { ok: lib.ok, value: lib.ok ? lib.value : undefined, error, requests: lib.requests } };
}
/** The exit code of a usage error in this repo (commander's default is 1; most repos use 2). nina's is 1. */
const USAGE_EXIT = 1;
import { NinaClient as Client } from "@maschinenlesbar.org/nina-warnungen-client/internal/client";
import { normalizeIdentifier } from "@maschinenlesbar.org/nina-warnungen-client/internal/validate";
interface Input {
  name: string;
  /** CLI argv that sends `value`. */
  argv: (value: string) => string[];
  /** The same in the library. */
  lib: (client: Client, value: string) => Promise<unknown>;
  /** The value as it went out, read from the request URL (null when it wasn't sent). */
  sent: (url: URL) => string | null;
}
/** Every text filter (sent as a query parameter). nina has none: a source, a region key and ids only. */
const textInputs: Input[] = [];
/** The last path segment without the suffix the client appends to the id. */
const segment = (suffix: string) => (u: URL): string | null => {
  const last = decodeURIComponent(u.pathname.slice(u.pathname.lastIndexOf("/") + 1));
  return last.endsWith(suffix) ? last.slice(0, -suffix.length) : null;
};
/** Every id that goes into a request path (sent as its last segment, before the client's suffix). */
const idInputs: Input[] = [
  { name: "warning get", argv: (v) => ["warning", "get", "--", v], lib: (c, v) => c.warnings.get(v), sent: segment(".json") },
  { name: "warning geojson", argv: (v) => ["warning", "geojson", "--", v], lib: (c, v) => c.warnings.geojson(v), sent: segment(".geojson") },
  { name: "archive mapping", argv: (v) => ["archive", "mapping", "--", v], lib: (c, v) => c.archive.mapping(v), sent: segment("-mapping.json") },
  { name: "archive get", argv: (v) => ["archive", "get", "--", v], lib: (c, v) => c.archive.get(v), sent: segment(".json") },
  // A region key and a source are codes the library checks (every corpus value is refused).
  { name: "dashboard", argv: (v) => ["dashboard", "--", v], lib: (c, v) => c.dashboard(v), sent: segment(".json") },
  { name: "map-data", argv: (v) => ["map-data", "--", v], lib: (c, v) => c.mapData(v as never), sent: (u) => u.pathname.split("/").at(-2) ?? null },
];
/**
 * The id as the repo sends it: `normalizeIdentifier` (NFC; surrounding whitespace, invisible
 * characters and quotes dropped; a .json/.geojson suffix removed). Case is kept.
 */
const canonicalId = (value: string): string => normalizeIdentifier(value);
/** A valid answer to any of these requests (a detail echoes the id it was asked for). */
const respond = (req: HttpRequest): HttpResponse => {
  const path = new URL(req.url).pathname;
  if (path.endsWith(".geojson")) return rawResponse('{"type":"FeatureCollection","features":[]}', "application/geo+json");
  if (path.endsWith("-mapping.json")) return jsonResponse({ history: [] });
  if (path.includes("/dashboard/") || path.endsWith("/mapData.json")) return jsonResponse([]);
  const id = decodeURIComponent(path.split("/").pop() ?? "").replace(/\.json$/, "");
  return jsonResponse({ identifier: id });
};
// --------------------------------------------------------------------------------------

const TEXT_CORPUS = [
  "Müller", "Müller", "  Müller  ", " Müller ", "Müller\n", "\tMüller", "a  b", "Å",
  "ﬁ", "x".repeat(5000), "", " ", " ", "\n\t", "　",
];
const ID_CORPUS = ["a1", " a1 ", "a1\n", " a1", ".", "..", " .. ", "a1/../a2", "a1/", "/a1", "", "  ", "%2e%2e", "a b"];

type Outcome = Awaited<ReturnType<typeof parity>>;

/** Both sides refused before any request, or both sent the same requests. Returns the one sent URL, if any. */
function sameOutcome(o: Outcome, label: string): URL | undefined {
  if (o.cli.code === USAGE_EXIT) {
    assert.deepEqual(o.cli.requests, [], `${label}: the CLI refused but sent a request`);
    assert.equal(o.lib.ok, false, `${label}: the CLI refused, the library resolved`);
    assert.deepEqual(o.lib.requests, [], `${label}: the library sent a request`);
    assert.match(o.lib.error?.name ?? "", /ValidationError$/, `${label}: ${String(o.lib.error)}`);
    return undefined;
  }
  assert.equal(o.cli.code, 0, `${label}: CLI exit ${o.cli.code}: ${o.cli.err}`);
  assert.equal(o.lib.ok, true, `${label}: the library rejected: ${String(o.lib.error)}`);
  assert.deepEqual(o.lib.requests.map((r) => r.url), o.cli.requests.map((r) => r.url), `${label}: different requests`);
  assert.equal(o.cli.requests.length, 1, label);
  return new URL(o.cli.requests[0]!.url);
}

test("P24: a text filter is sent trimmed and in composed Unicode, or refused; never blank", async () => {
  for (const input of textInputs) {
    for (const value of TEXT_CORPUS) {
      const label = `${input.name} ${JSON.stringify(value.length > 20 ? `${value.slice(0, 20)}…` : value)}`;
      const url = sameOutcome(await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond), label);
      if (value.trim() === "") {
        assert.equal(url, undefined, `${label}: a blank value was sent (it reads as "no filter")`);
        continue;
      }
      if (url === undefined) continue;
      const sent = input.sent(url);
      assert.ok(sent !== null && sent !== "", `${label}: not sent`);
      const canonical = [value.trim().normalize("NFC"), value.trim().normalize("NFKC")];
      assert.ok(canonical.includes(sent), `${label}: sent ${JSON.stringify(sent)}`);
    }
  }
});

test("P24: an id is sent in its canonical form, or refused; never empty, a dot segment or with a slash", async () => {
  for (const input of idInputs) {
    for (const value of ID_CORPUS) {
      const label = `${input.name} ${JSON.stringify(value)}`;
      const url = sameOutcome(await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond), label);
      const id = canonicalId(value);
      if (id === "" || id === "." || id === ".." || id.includes("/")) {
        assert.equal(url, undefined, `${label}: sent although it would re-target the request`);
        continue;
      }
      if (url === undefined) continue;
      assert.equal(input.sent(url), id, label);
    }
  }
});
