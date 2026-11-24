// This server's tools against a mock of the NINA API (the client's recorded answers, moved to
// today), with the skills' traps as cases: cancellations never active, the BBK's licence in every
// result, a district key and not a place name, the readable area and advice from the warning, a
// watch that says what changed, the map as one FeatureCollection a page at a time, stale ids said
// rather than a bare not-found, a source's feed as sent. The rules every server follows are the
// conformance tests (M1–M10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
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
