// The use cases (operations.ts) against a mock of the NINA API (fixtures.ts, recorded shapes),
// with the skills' traps as cases: cancellations are never active warnings, an expiry in the past
// drops a warning and a missing one never does, severity sits under payload.data on the
// dashboard, a district key is the district's (AGS and municipality keys are taken to it, state
// keys and names are refused), the readable area comes from the warning, stale ids are said, not
// a bare not-found, and translations of MoWaS titles lose the place.

import { test } from "node:test";
import assert from "node:assert/strict";
import { NinaClient } from "../src/client.js";
import { NinaError, NinaValidationError } from "../src/errors.js";
import { districtKey, getRegionWarnings, getWarningArea, getWarningBriefing, getWarningDetail, getWarningHistory, lineBreaks } from "../src/operations.js";
import { makeMockTransport } from "./helpers.js";
import { CANCELLED, DWD_RAIN, HH_BOMB, NOW, RODING_WATER, STALE, dashboardCham, ninaApi } from "./fixtures.js";

function client(overrides: Record<string, unknown> = {}) {
  const mock = makeMockTransport(ninaApi(overrides));
  return { client: new NinaClient({ transport: mock.transport, maxRetries: 0 }), mock };
}

const paths = (mock: ReturnType<typeof makeMockTransport>) => mock.calls.map((c) => new URL(c.url).pathname);

// ---- the briefing

test("briefing: all six sources read, one request each; ranked Severe first, then Immediate, then newest", async () => {
  const { client: c, mock } = client();
  const b = await getWarningBriefing(c, { now: NOW });
  assert.equal(mock.calls.length, 6);
  assert.deepEqual(new Set(paths(mock)), new Set(["mowas", "katwarn", "biwapp", "dwd", "lhp", "police"].map((s) => `/api31/${s}/mapData.json`)));
  assert.deepEqual(b.warnings.map((w) => w.severity), ["Severe", "Severe", "Severe", "Moderate", "Minor", "Unknown"]);
  // Among the Severe ones: the newest first (LHP 15:00, DWD 11:44, MoWaS yesterday).
  assert.deepEqual(b.warnings.slice(0, 3).map((w) => w.sources[0]), ["lhp", "dwd", "mowas"]);
  assert.equal(b.status, "ok");
});

test("briefing: a cancellation (Entwarnung) is never an active warning; it is counted and listed apart", async () => {
  const { client: c } = client();
  const b = await getWarningBriefing(c, { now: NOW });
  assert.ok(b.warnings.every((w) => !w.headline.startsWith("Entwarnung")));
  assert.equal(b.sources.find((s) => s.source === "mowas")?.cancelled, 1);
  assert.deepEqual(b.cleared, [{ headline: "Entwarnung: Gefährdung durch Brandgase - Unter- / Oberpfrauendorf", source: "mowas", id: CANCELLED }]);
  assert.match(b.verdict, /1 cancellation and 1 expired dropped/);
});

test("briefing: an expiry in the past drops the entry; no expiry keeps it active as null, never a guessed one", async () => {
  const { client: c } = client();
  const b = await getWarningBriefing(c, { now: NOW });
  assert.equal(b.sources.find((s) => s.source === "dwd")?.expired, 1);
  const gusts = b.warnings.find((w) => w.headline === "Amtliche WARNUNG vor STURMBÖEN");
  assert.equal(gusts?.count, 2, "the 21:00 one expired before NOW");
  const vorwarnung = b.warnings.find((w) => w.headline === "Hochwasservorwarnung");
  assert.equal(vorwarnung?.expiresDate, null);
  const bomb = b.warnings.find((w) => w.ids.includes(HH_BOMB));
  assert.equal(bomb?.expiresDate, null);
  assert.ok(b.notes.some((n) => n.includes("expiresDate null")));
});

test("briefing: the same headline and severity over several areas is one item with count, ids, the latest expiry", async () => {
  const { client: c } = client();
  const b = await getWarningBriefing(c, { now: NOW });
  const gusts = b.warnings.find((w) => w.headline === "Amtliche WARNUNG vor STURMBÖEN");
  assert.deepEqual(gusts?.ids.length, 2);
  assert.equal(gusts?.expiresDate, "2026-11-20T16:00:00+01:00");
  assert.equal(gusts?.startDate, "2026-11-19T17:10:00+01:00");
  assert.equal(b.active, 7, "every active entry counts, grouped or not");
  assert.deepEqual(b.bySeverity, { Severe: 3, Moderate: 2, Minor: 1, Unknown: 1 });
});

test("briefing: an empty source is a valid all-clear, said in the verdict; all empty is a plain no-warnings verdict", async () => {
  const { client: c } = client({ "/mowas/mapData.json": [], "/dwd/mapData.json": [], "/lhp/mapData.json": [] });
  const b = await getWarningBriefing(c, { now: NOW });
  assert.equal(b.status, "ok");
  assert.equal(b.active, 0);
  assert.match(b.verdict, /^No active civil-protection warnings from the 6 sources read right now \(mowas 0, katwarn 0/);
});

test("briefing: a source that fails is named, the others still answer; when all fail the error is thrown", async () => {
  const { client: c } = client({ "/katwarn/mapData.json": () => ({ status: 500, headers: {}, body: Buffer.from("boom") }) });
  const b = await getWarningBriefing(c, { now: NOW });
  assert.match(b.sources.find((s) => s.source === "katwarn")?.error ?? "", /500/);
  assert.match(b.verdict, /katwarn not read/);
  assert.match(b.verdict, /katwarn could not be read: warnings from it may be missing\./);
  const { client: down } = client({ "/dwd/mapData.json": () => ({ status: 500, headers: {}, body: Buffer.alloc(0) }) });
  await assert.rejects(getWarningBriefing(down, { sources: ["dwd"], now: NOW }), /500/);
});

test("briefing: when every source fails, the error says none could be read and names each source's failure", async () => {
  const down = () => ({ status: 503, headers: {}, body: Buffer.alloc(0) });
  const all = Object.fromEntries(["mowas", "katwarn", "biwapp", "dwd", "lhp", "police"].map((s) => [`/${s}/mapData.json`, down]));
  const { client: c } = client(all);
  await assert.rejects(getWarningBriefing(c, { now: NOW }), (err: Error) => {
    assert.ok(err instanceof NinaError);
    assert.match(err.message, /^None of the 6 sources could be read \(NINA may be down: try again later rather than source by source\): mowas: HTTP 503/);
    for (const s of ["katwarn", "biwapp", "dwd", "lhp", "police"]) assert.match(err.message, new RegExp(`${s}: HTTP 503 for GET /api31/${s}/mapData\\.json`));
    return true;
  });
  const { client: two } = client(all);
  await assert.rejects(getWarningBriefing(two, { sources: ["dwd", "lhp"], now: NOW }), /^NinaError|None of the 2 sources could be read/);
});

test("briefing: sources narrow the reads; minSeverity counts the rest; limit leaves more", async () => {
  const { client: c, mock } = client();
  const b = await getWarningBriefing(c, { sources: ["mowas", " DWD " as never], minSeverity: "severe", limit: 1, now: NOW });
  assert.equal(mock.calls.length, 2);
  assert.equal(b.warnings.length, 1);
  assert.equal(b.more, 1);
  assert.equal(b.belowMinSeverity, 3);
  await assert.rejects(getWarningBriefing(c, { sources: ["weather" as never] }), NinaValidationError);
  await assert.rejects(getWarningBriefing(c, { minSeverity: "high" }), NinaValidationError);
  await assert.rejects(getWarningBriefing(c, { limit: 0 }), NinaValidationError);
});

test("briefing in English: headline stays the German title (it names the place), translated is the API's, with a note", async () => {
  const { client: c } = client();
  const b = await getWarningBriefing(c, { lang: "en", now: NOW });
  const water = b.warnings.find((w) => w.ids.includes(RODING_WATER));
  assert.match(water?.headline ?? "", /Roding/);
  assert.equal(water?.translated, "Contaminated drinking water");
  assert.ok(b.notes.some((n) => n.includes("names only the kind of event")));
  const flood = b.warnings.find((w) => w.headline === "Hochwasservorwarnung");
  assert.equal(flood?.translated, undefined, "no translation given: none made up");
});

test("briefing: the message type and the severity are read in any case: a CANCEL is a cancellation, a severe ranks as Severe", async () => {
  const feed = [
    { id: "mow.cancel-upper", startDate: "2026-11-19T18:00:00+01:00", severity: "Minor", type: "CANCEL", i18nTitle: { de: "Entwarnung: Gasaustritt - Musterstadt" } },
    { id: "mow.severe-lower", startDate: "2026-11-19T18:00:00+01:00", severity: "severe", type: "alert", i18nTitle: { de: "Gasaustritt - Beispieldorf" } },
  ];
  const { client: c } = client({ "/mowas/mapData.json": feed });
  const b = await getWarningBriefing(c, { sources: ["mowas"], minSeverity: "Severe", now: NOW });
  assert.deepEqual(b.cleared.map((x) => x.id), ["mow.cancel-upper"]);
  assert.deepEqual(b.warnings.map((w) => [w.ids[0], w.severity]), [["mow.severe-lower", "Severe"]]);
  assert.deepEqual(b.bySeverity, { Severe: 1 });
  assert.equal(b.belowMinSeverity, 0);
});

test("region: a msgType CANCEL is a cancellation and a severity in lower case ranks as its CAP value", async () => {
  const upper = dashboardCham.map((e) => (e.id === RODING_WATER ? { ...e, payload: { ...e.payload, data: { ...e.payload.data, msgType: "CANCEL" } } } : e.id === DWD_RAIN ? { ...e, payload: { ...e.payload, data: { ...e.payload.data, severity: "SEVERE" } } } : e));
  const { client: c } = client({ "/dashboard/093720000000.json": upper });
  const r = await getRegionWarnings(c, { ars: "093720000000", details: false, now: NOW });
  assert.ok(r.status === "ok");
  if (r.status !== "ok") return;
  assert.deepEqual(r.cleared.map((x) => x.id), [RODING_WATER, CANCELLED]);
  assert.deepEqual(r.warnings.map((w) => [w.id, w.severity]), [[DWD_RAIN, "Severe"]]);
});

test("briefing in a language no entry has: said in a note, not the translation note that reads as if there were some", async () => {
  const { client: c } = client();
  const b = await getWarningBriefing(c, { lang: "xx", now: NOW });
  assert.ok(b.warnings.every((w) => w.translated === undefined));
  assert.ok(!b.notes.some((n) => n.includes("names only the kind of event")), JSON.stringify(b.notes));
  assert.ok(b.notes.some((n) => n === "No entry has a title in xx: the headlines are the German ones as published."), JSON.stringify(b.notes));
});

test("region in another language: the warnings without a version in it are named, as getWarningDetail says for one", async () => {
  const { client: c } = client();
  const r = await getRegionWarnings(c, { ars: "093720000000", lang: "en", now: NOW });
  assert.ok(r.status === "ok");
  if (r.status !== "ok") return;
  assert.ok(r.notes.includes(`No en version, given in de: ${RODING_WATER}.`), JSON.stringify(r.notes));
  const fr = await getRegionWarnings(c, { ars: "093720000000", lang: "fr", now: NOW });
  assert.ok(fr.status === "ok" && fr.notes.includes(`No fr version, given in de: ${RODING_WATER}.`), JSON.stringify(fr.status === "ok" ? fr.notes : []));
  assert.ok(fr.status === "ok" && fr.notes.includes(`No fr version, given in de-DE: ${DWD_RAIN}.`));
});

// ---- a district

test("district key: 12-digit district as is; AGS, 5-digit code and municipality key taken to the district", () => {
  assert.deepEqual(districtKey("093720000000"), { ars: "093720000000" });
  assert.deepEqual(districtKey("06535011"), { ars: "065350000000", from: "the AGS 06535011" });
  assert.deepEqual(districtKey("09372"), { ars: "093720000000", from: "the district code 09372" });
  assert.deepEqual(districtKey("093720147147"), { ars: "093720000000", from: "the municipality key 093720147147" });
});

test("district key: a state key (an [] answer that reads as all clear) and a place name are refused before any request", () => {
  assert.throws(() => districtKey("050000000000"), (err: Error) => err instanceof NinaValidationError && /not a district key/.test(err.message));
  assert.throws(() => districtKey("05000"), NinaValidationError);
  assert.throws(() => districtKey("Heidelberg"), (err: Error) => err instanceof NinaValidationError && /not a region key.*082210000000/.test(err.message));
  assert.deepEqual(districtKey("020000000000"), { ars: "020000000000" }, "Hamburg is its own district");
});

test("region: severity and msgType from payload.data; cancellation and expired dropped; null expiry filled from the warning", async () => {
  const { client: c, mock } = client();
  const r = await getRegionWarnings(c, { ars: "09372", now: NOW });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.deepEqual(r.region, { ars: "093720000000", from: "the district code 09372" });
  assert.deepEqual(r.warnings.map((w) => [w.id, w.severity, w.provider]), [[RODING_WATER, "Severe", "MOWAS"], [DWD_RAIN, "Moderate", "DWD"]]);
  assert.deepEqual(r.cleared.map((x) => x.id), [CANCELLED]);
  assert.equal(r.expired, 1);
  const water = r.warnings[0];
  assert.equal(water?.expires, "2026-11-25T18:00:00+01:00", "from the CAP info, the dashboard had null");
  assert.deepEqual(water?.areas, ["Stadt Roding", "Gemeinde Michelsneukirchen"]);
  assert.equal(water?.instruction, undefined, "null instruction: the advice is in the description");
  assert.equal(water?.description, "Das Trinkwasser ist verunreinigt.\nKochen Sie das Wasser vor dem Trinken ab.");
  assert.equal(r.warnings[1]?.instruction, "Gefahr durch: vereinzelte Überflutungen von Straßen/Unterführungen.\nHandlungsempfehlungen:\nÜberflutete Abschnitte meiden");
  assert.deepEqual(paths(mock), ["/api31/dashboard/093720000000.json", `/api31/warnings/${RODING_WATER}.json`, `/api31/warnings/${DWD_RAIN}.json`]);
});

test("region: details false reads the dashboard only; the readable area is never the encoded payload area", async () => {
  const { client: c, mock } = client();
  const r = await getRegionWarnings(c, { ars: "093720000000", details: false, now: NOW });
  assert.equal(mock.calls.length, 1);
  assert.ok(r.status === "ok" && r.warnings.every((w) => w.areas === undefined && !JSON.stringify(w).includes("GRID")));
});

test("region: no warning is ok with a plain all-clear verdict that names the key; an unknown district (404) is empty with the reason", async () => {
  const { client: c } = client({ "/dashboard/020000000000.json": [] });
  const r = await getRegionWarnings(c, { ars: "020000000000", now: NOW });
  assert.equal(r.status, "ok");
  assert.match(r.status === "ok" ? r.verdict : "", /^No active warnings for the district 020000000000 right now: a real all-clear for this key/);
  const unknown = await getRegionWarnings(c, { ars: "051000000000", now: NOW });
  assert.equal(unknown.status, "empty");
  assert.match(unknown.status === "empty" ? unknown.reason : "", /no such district key "051000000000"/);
});

test("region: a warning that ended between dashboard and detail is said, not an error", async () => {
  const { client: c } = client({ [`/warnings/${RODING_WATER}.json`]: undefined });
  const r = await getRegionWarnings(c, { ars: "093720000000", now: NOW });
  assert.ok(r.status === "ok");
  assert.match(r.status === "ok" ? (r.warnings[0]?.detail ?? "") : "", /No longer live/);
});

test("region watch: previous tokens give new, changed and cleared", async () => {
  const { client: c } = client();
  const first = await getRegionWarnings(c, { ars: "093720000000", details: false, now: NOW });
  assert.ok(first.status === "ok");
  if (first.status !== "ok") return;
  assert.deepEqual(first.warnings.map((w) => w.watch), [`${RODING_WATER}@e57084d8`, `${DWD_RAIN}@a7f4c5d6`]);
  const changed = dashboardCham.map((e) => (e.id === DWD_RAIN ? { ...e, payload: { ...e.payload, hash: "beefbeef" } } : e)).filter((e) => e.id !== RODING_WATER);
  const { client: later } = client({ "/dashboard/093720000000.json": [...changed, { ...dashboardCham[0], id: "dwd.new", payload: { ...dashboardCham[0]?.payload, hash: "n" } }] });
  const second = await getRegionWarnings(later, { ars: "093720000000", details: false, previous: first.warnings.map((w) => w.watch), now: NOW });
  assert.deepEqual(second.status === "ok" ? second.changes : undefined, { new: ["dwd.new"], changed: [DWD_RAIN], cleared: [RODING_WATER], unchanged: 0 });
});

// ---- one warning, the archive

test("detail: one language, German by default; de-LS (easy German) only when asked; <br/> as line breaks", async () => {
  const { client: c } = client();
  const de = await getWarningDetail(c, { id: HH_BOMB });
  assert.ok(de.status === "ok");
  if (de.status !== "ok") return;
  assert.equal(de.language, "de");
  assert.deepEqual(de.languages, ["de", "de-LS", "en"]);
  assert.equal(de.warning["instruction"], "Achten Sie auf Durchsagen von Polizei und Feuerwehr.\nFolgen Sie den Anweisungen der Einsatzkräfte.");
  assert.equal(de.warning["sender"], "DE-HH-HH-W226");
  assert.deepEqual(de.areas, ["Hamburg-Heimfeld"]);
  const ls = await getWarningDetail(c, { id: HH_BOMB, lang: "de-LS" });
  assert.equal(ls.status === "ok" ? ls.language : "", "de-LS");
  const dwd = await getWarningDetail(c, { id: DWD_RAIN, lang: "de" });
  assert.equal(dwd.status === "ok" ? dwd.language : "", "de-DE", "DWD's German is de-DE");
  assert.equal(dwd.status === "ok" ? dwd.notes : "", undefined);
  const fr = await getWarningDetail(c, { id: DWD_RAIN, lang: "fr" });
  assert.deepEqual(fr.status === "ok" ? [fr.language, fr.notes] : [], ["de-DE", ["The warning has no fr version: it is given in de-DE (languages lists those it has)."]]);
  await assert.rejects(getWarningDetail(c, { id: HH_BOMB, lang: "german" }), NinaValidationError);
});

test("detail: a stale id (NINA redirects it to its archive) is empty with the reason and the archive URL", async () => {
  const { client: c } = client();
  const d = await getWarningDetail(c, { id: STALE });
  assert.equal(d.status, "empty");
  if (d.status !== "empty") return;
  assert.match(d.reason, /No live warning has this id.*getWarningHistory/);
  assert.equal(d.archive, `https://warnung.bund.de/api31/archive/alerts/${STALE}?contentType=json`);
});

test("history: a MoWaS id's revisions, a revision's warning; other sources and unknown ids are empty with the reason", async () => {
  const { client: c, mock } = client();
  const h = await getWarningHistory(c, { id: HH_BOMB });
  assert.equal(h.status === "ok" && "history" in h ? h.history.length : 0, 1);
  const rev = await getWarningHistory(c, { revision: `${HH_BOMB}_20261119171852.json` });
  assert.equal(rev.status === "ok" && "warning" in rev ? rev.warning["headline"] : "", "Weltkriegsbombe gefunden - Hamburg-Heimfeld");
  const before = mock.calls.length;
  const dwd = await getWarningHistory(c, { id: DWD_RAIN });
  assert.equal(mock.calls.length, before, "no request for a non-MoWaS id");
  assert.match(dwd.status === "empty" ? dwd.reason : "", /MoWaS warnings only/);
  const unknown = await getWarningHistory(c, { id: "mow.DE-NOPE" });
  assert.match(unknown.status === "empty" ? unknown.reason : "", /HTTP 404/);
  await assert.rejects(getWarningHistory(c, {}), NinaValidationError);
});

// ---- the map

test("map: one FeatureCollection of several warnings, counted; NINA's properties kept; [lon, lat] as delivered", async () => {
  const { client: c } = client();
  const a = await getWarningArea(c, { ids: [HH_BOMB, DWD_RAIN] });
  assert.equal(a.status, "ok");
  if (a.status !== "ok") return;
  assert.equal(a.type, "FeatureCollection");
  assert.equal(a.featureCount, 2);
  assert.equal(a.polygonCount, 3, "one Polygon and a MultiPolygon of two");
  assert.deepEqual(a.problems, []);
  assert.equal(a.features[0]?.["properties"] && (a.features[0]["properties"] as Record<string, unknown>)["fillColor"], "#FB8C00");
  assert.deepEqual((a.features[0]?.["geometry"] as { coordinates: number[][][] }).coordinates[0]?.[0], [9.9527, 53.4742]);
});

test("map: labels add headline, severity and areaDesc from the warning (the GeoJSON has none)", async () => {
  const { client: c, mock } = client();
  const a = await getWarningArea(c, { ids: [HH_BOMB], labels: true });
  assert.equal(mock.calls.length, 2);
  const props = a.status === "ok" ? (a.features[0]?.["properties"] as Record<string, unknown>) : {};
  assert.equal(props["headline"], "Weltkriegsbombe gefunden - Hamburg-Heimfeld");
  assert.equal(props["severity"], "Minor");
  assert.equal(props["areaDesc"], "Hamburg-Heimfeld");
  assert.equal(props["warnId"], HH_BOMB);
});

test("map: stale ids are listed in notLive; all stale is empty with what to do; bad positions are named", async () => {
  const { client: c } = client({ [`/warnings/${DWD_RAIN}.geojson`]: { type: "Polygon", coordinates: [[["9.9", 53.4], [190, 53.4]]] } });
  const a = await getWarningArea(c, { ids: [STALE, DWD_RAIN] });
  assert.equal(a.status, "ok");
  if (a.status !== "ok") return;
  assert.deepEqual(a.notLive, [STALE]);
  assert.deepEqual(a.found, [DWD_RAIN]);
  assert.deepEqual(a.problems.sort(), [`${DWD_RAIN}: a position out of range ([lon, lat] expected).`, `${DWD_RAIN}: a position that is not two numbers.`]);
  const none = await getWarningArea(c, { ids: [STALE] });
  assert.equal(none.status, "empty");
  assert.match(none.status === "empty" ? none.reason : "", /fresh id/);
  await assert.rejects(getWarningArea(c, { ids: [] }), NinaValidationError);
  await assert.rejects(getWarningArea(c, { ids: ["a", "b", "c", "d", "e", "f"] }), NinaValidationError);
});

test("lineBreaks turns only <br/> spellings into line breaks", () => {
  assert.equal(lineBreaks("a<br/>b<BR>c<br />d <b>e</b>"), "a\nb\nc\nd <b>e</b>");
});
