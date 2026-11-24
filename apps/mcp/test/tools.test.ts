// This server's tools against a mock of the NINA API (the client's recorded answers, moved to
// today), with the skills' traps as cases: cancellations never active, the BBK's licence in every
// result, a district key and not a place name, the readable area and advice from the warning, a
// watch that says what changed, the map as one FeatureCollection a page at a time, stale ids said
// rather than a bare not-found, a source's feed as sent. The rules every server follows are the
// conformance tests (M1–M10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { TOOLS } from "../src/mcp/tools.js";
import { connect } from "./harness.js";
import { CANCELLED, DWD_RAIN, HH_BOMB, RODING_WATER, STALE, makeMockTransport, ninaApiNow, rodingDetail } from "./helpers.js";

const BASE = "https://warnung.bund.de/api31";
const upstream = () => makeMockTransport(ninaApiNow());

async function call(name: string, args: Record<string, unknown>, transport = upstream()) {
  const connection = await connect({ transport });
  const result = await connection.call(name, args);
  await connection.close();
  return { result, answer: (result.structuredContent ?? {}) as Record<string, unknown>, text: result.content[0]?.text ?? "" };
}

test("six tools: the three use cases first, then the three generic ones", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["getWarningBriefing", "getRegionWarnings", "getWarningArea", "getWarningDetail", "listSourceWarnings", "getWarningHistory"]);
});

test("getWarningBriefing: ranked across the six sources, no cancellation among the warnings, the BBK's licence and the feeds as source", async () => {
  const { answer, text } = await call("getWarningBriefing", {});
  assert.equal(answer["status"], "ok", text);
  const warnings = answer["warnings"] as { severity: string; ids: string[] }[];
  assert.equal(warnings[0]?.severity, "Severe");
  assert.ok(warnings.every((w) => !w.ids.includes(CANCELLED)));
  assert.deepEqual((answer["cleared"] as { id: string }[]).map((c) => c.id), [CANCELLED]);
  assert.match(String(answer["verdict"]), /^7 active warning entries: 3 Severe, 2 Moderate, 1 Minor, 1 Unknown \(mowas 2, katwarn 0, biwapp 0, dwd 3, lhp 2, police 0\); 1 cancellation and 1 expired dropped\.$/);
  assert.equal(answer["source"], `${BASE}/{mowas,katwarn,biwapp,dwd,lhp,police}/mapData.json`);
  assert.match(String(answer["licence"]), /Bundesamt für Bevölkerungsschutz und Katastrophenhilfe \(BBK\).*unaltered/);
});

test("getWarningBriefing: one source narrows the reads and the source", async () => {
  const transport = upstream();
  const { answer } = await call("getWarningBriefing", { sources: ["lhp"], minSeverity: "Severe" }, transport);
  assert.equal(transport.calls.length, 1);
  assert.equal(answer["source"], `${BASE}/lhp/mapData.json`);
  assert.equal(answer["belowMinSeverity"], 1);
});

test("getRegionWarnings: a place name is a tool error saying what to give, before any request", async () => {
  const transport = upstream();
  const { result, text } = await call("getRegionWarnings", { ars: "Heidelberg" }, transport);
  assert.equal(result.isError, true);
  assert.match(text, /not a region key.*082210000000/);
  assert.equal(transport.calls.length, 0);
});

test("getRegionWarnings: the district of a code, ranked, with areas and advice; cancellation and expired out", async () => {
  const { answer, text } = await call("getRegionWarnings", { ars: "09372" });
  assert.equal(answer["status"], "ok", text);
  assert.deepEqual(answer["region"], { ars: "093720000000", from: "the district code 09372" });
  assert.equal(answer["source"], `${BASE}/dashboard/093720000000.json`);
  const warnings = answer["warnings"] as { id: string; areas?: string[]; description?: string; watch: string }[];
  assert.deepEqual(warnings.map((w) => w.id), [RODING_WATER, DWD_RAIN]);
  assert.deepEqual(warnings[0]?.areas, ["Stadt Roding", "Gemeinde Michelsneukirchen"]);
  assert.match(warnings[0]?.description ?? "", /Kochen Sie das Wasser/);
  assert.equal(answer["expired"], 1);
  // The watch: the tokens back as previous, with nothing changed.
  const again = await call("getRegionWarnings", { ars: "093720000000", details: false, previous: warnings.map((w) => w.watch) });
  assert.deepEqual(again.answer["changes"], { new: [], changed: [], cleared: [], unchanged: 2 });
});

test("getRegionWarnings: a district NINA doesn't know is empty with the reason", async () => {
  const { answer } = await call("getRegionWarnings", { ars: "051000000000" });
  assert.equal(answer["status"], "empty");
  assert.match(String(answer["reason"]), /no such district key/);
});

test("getWarningArea: one FeatureCollection of two warnings, a page at a time; stale ids in notLive", async () => {
  const { answer, text } = await call("getWarningArea", { ids: [HH_BOMB, DWD_RAIN, STALE], limit: 1 });
  assert.equal(answer["status"], "ok", text);
  assert.equal(answer["type"], "FeatureCollection");
  assert.equal((answer["features"] as unknown[]).length, 1);
  assert.equal(answer["featureCount"], 2);
  assert.equal(answer["polygonCount"], 3);
  assert.equal(answer["nextOffset"], 1);
  assert.deepEqual(answer["notLive"], [STALE]);
  assert.equal(answer["source"], `${BASE}/warnings/{${HH_BOMB},${DWD_RAIN},${STALE}}.geojson`);
});

test("getWarningDetail: German by default, the advice with line breaks; a stale id is empty with the archive", async () => {
  const { answer } = await call("getWarningDetail", { id: HH_BOMB });
  assert.equal(answer["language"], "de");
  assert.match(String((answer["warning"] as Record<string, unknown>)["instruction"]), /Feuerwehr\.\nFolgen/);
  assert.equal(answer["source"], `${BASE}/warnings/${HH_BOMB}.json`);
  const stale = await call("getWarningDetail", { id: STALE });
  assert.equal(stale.answer["status"], "empty");
  assert.match(String(stale.answer["archive"]), /archive\/alerts/);
});

test("listSourceWarnings: the feed as sent, cancellations included, titles in German and the asked language; an empty feed is an all-clear", async () => {
  const { answer } = await call("listSourceWarnings", { source: "mowas", lang: "en", limit: 2 });
  assert.equal(answer["total"], 3);
  assert.equal(answer["nextOffset"], 2);
  const first = (answer["warnings"] as { i18nTitle: Record<string, string> }[])[0];
  assert.deepEqual(Object.keys(first?.i18nTitle ?? {}), ["de", "en"]);
  const rest = await call("listSourceWarnings", { source: "mowas", offset: 2 });
  assert.equal((rest.answer["warnings"] as { type: string }[])[0]?.type, "Cancel");
  const police = await call("listSourceWarnings", { source: "police" });
  assert.equal(police.answer["status"], "empty");
  assert.match(String(police.answer["reason"]), /real all-clear/);
});

test("getWarningHistory: the revisions of a MoWaS id; another source's id is empty with the reason", async () => {
  const { answer } = await call("getWarningHistory", { id: HH_BOMB });
  assert.equal((answer["history"] as unknown[]).length, 1);
  assert.equal(answer["source"], `${BASE}/archive.mowas/${HH_BOMB}-mapping.json`);
  const other = await call("getWarningHistory", { id: DWD_RAIN });
  assert.match(String(other.answer["reason"]), /MoWaS warnings only/);
});

test("a warning's description is passed whole, not cut at the server's 2000 characters: detail, region and archive", async () => {
  // As the live Severe drinking-water warning of Lkr. Cham: the affected places, then the hotlines at the end.
  const description = `${"In der Gemeinde Zell sind betroffen die Ortschaften Oberpoign, Wirtswies, Unterpoign. ".repeat(30)}Hotlines: Kreiswerke Cham +49 9971 78-190, Gesundheitsamt Cham +49 9971 78-450.`;
  assert.ok(description.length > 2600);
  const detail = { ...rodingDetail, info: [{ ...rodingDetail.info[0], description }] };
  const revision = `${RODING_WATER}_20261118182345`;
  const transport = () => makeMockTransport(ninaApiNow(Date.now(), { [`/warnings/${RODING_WATER}.json`]: detail, [`/archive.mowas/${revision}.json`]: detail }));
  const one = await call("getWarningDetail", { id: RODING_WATER }, transport());
  assert.equal((one.answer["warning"] as { description: string }).description, description);
  assert.equal(one.answer["truncated"], undefined);
  const region = await call("getRegionWarnings", { ars: "093720000000" }, transport());
  assert.equal((region.answer["warnings"] as { description?: string }[])[0]?.description, description);
  assert.equal(region.answer["truncated"], undefined);
  const archived = await call("getWarningHistory", { revision }, transport());
  assert.equal((archived.answer["warning"] as { description: string }).description, description);
});

/** Each option a hint names comes with the tools that take it (`limit (a, b)`), checked against their input schemas. */
function assertHintFits(text: string, options: readonly string[]): void {
  const schemas = new Map(TOOLS.map((tool) => [tool.name, Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)]));
  const pairs = [...text.matchAll(/(\w+(?: or \w+)*) \((\w+(?:, \w+)*)\)/g)];
  assert.ok(pairs.length >= 2, text);
  for (const [, named, tools] of pairs) {
    for (const tool of (tools as string).split(", ")) {
      assert.ok(schemas.has(tool), `no tool ${tool}: ${text}`);
      for (const option of (named as string).split(" or ")) assert.ok(schemas.get(tool)?.includes(option), `${tool} takes no ${option}: ${text}`);
    }
  }
  const said = new Set(pairs.flatMap(([, named]) => (named as string).split(" or ")));
  for (const option of options) assert.ok(!new RegExp(`\\b${option}\\b`).test(text) || said.has(option), `${option} named without its tools: ${text}`);
}

const OPTIONS = ["limit", "offset", "sources", "details", "ids", "labels", "lang"];

test("the deadline's advice fits every tool: each option it names is named with the tools that take it", async () => {
  const hanging = { transport: (): Promise<never> => new Promise<never>(() => {}) };
  const connection = await connect({ transport: hanging, config: { callTimeoutMs: 30 } });
  const result = await connection.call("getWarningDetail", { id: HH_BOMB });
  await connection.close();
  const text = result.content[0]?.text ?? "";
  assert.equal(result.isError, true);
  assert.match(text, /took longer than .* and was stopped/);
  assert.match(text, /try again/);
  assertHintFits(text, OPTIONS);
});

test("an answer over the size cap says what this tool can ask for less: the region's details, not a limit it doesn't have", async () => {
  const connection = await connect({ transport: upstream(), config: { maxResultChars: 400 } });
  const result = await connection.call("getRegionWarnings", { ars: "093720000000" });
  await connection.close();
  const text = result.content[0]?.text ?? "";
  assert.equal(result.isError, true, text);
  assert.match(text, /larger than this server's size cap/);
  assert.match(text, /details \(getRegionWarnings\)/);
  assertHintFits(text, OPTIONS);
});

test("a feed over the server's download size is not met with advice to lower a limit, which reads the same feed", async () => {
  const big = makeMockTransport(() => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.alloc(17 * 1024 * 1024, 0x20) }));
  const connection = await connect({ transport: big });
  const result = await connection.call("listSourceWarnings", { source: "mowas", limit: 1 });
  await connection.close();
  const text = result.content[0]?.text ?? "";
  assert.equal(result.isError, true, text);
  assert.match(text, /larger than this server accepts/);
  assert.match(text, /read whole whatever the limit/);
  assertHintFits(text, OPTIONS);
});

test("getWarningBriefing under the size cap keeps every source: its counts, and a failed one's error whole", async () => {
  const down = (name: string) => () => ({ status: 500, headers: { "content-type": "text/plain" }, body: Buffer.from(`${name} upstream fault: ${"x".repeat(60)} end`) });
  const transport = makeMockTransport(ninaApiNow(Date.now(), { "/katwarn/mapData.json": down("katwarn"), "/biwapp/mapData.json": down("biwapp"), "/police/mapData.json": down("police") }));
  const connection = await connect({ transport, config: { maxResultChars: 2700 } });
  const result = await connection.call("getWarningBriefing", { limit: 3 });
  await connection.close();
  const answer = (result.structuredContent ?? {}) as Record<string, unknown>;
  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(answer["truncated"], true, "the cap did cut");
  const sources = answer["sources"] as Record<string, { active?: number; read?: boolean }>;
  assert.deepEqual(Object.keys(sources), ["mowas", "katwarn", "biwapp", "dwd", "lhp", "police"]);
  assert.equal(sources["dwd"]?.active, 3);
  assert.equal(sources["katwarn"]?.read, false);
  for (const name of ["katwarn", "biwapp", "police"]) {
    assert.ok((answer["notes"] as string[]).includes(`${name} could not be read: HTTP 500 for GET /api31/${name}/mapData.json`), `${name}: ${JSON.stringify(answer["notes"])}`);
  }
});

test("an offset past the end is empty with the reason, never an ok empty list that reads as an all-clear", async () => {
  const feed = await call("listSourceWarnings", { source: "mowas", offset: 3 });
  assert.equal(feed.answer["status"], "empty");
  assert.equal(feed.answer["total"], 3);
  assert.match(String(feed.answer["reason"]), /offset 3 is past the end: the mowas feed has 3 entries.*offset 0/);
  const area = await call("getWarningArea", { ids: [HH_BOMB], offset: 5 });
  assert.equal(area.answer["status"], "empty");
  assert.equal(area.answer["featureCount"], 1);
  assert.match(String(area.answer["reason"]), /offset 5 is past the end: there is 1 feature.*offset 0/);
});
