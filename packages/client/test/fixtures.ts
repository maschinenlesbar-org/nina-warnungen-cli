// Answers of the NINA API as recorded live on 2026-11-19 (warnung.bund.de/api31), cut to a few
// entries each, and a mock of the API over them. The client's operation tests, the MCP server's
// tests and its conformance blocks use them, so every layer sees the same shapes: map-data
// summaries (severity, urgency, type on top), dashboard entries (severity, urgency, msgType and
// provider under payload.data, a hash per entry), CAP warnings with one info block per language
// (de, de-LS, en for MoWaS; de-DE and en for DWD), GeoJSON with NINA's rendering hints, the MoWaS
// archive, and the redirect the API answers a stale id with.

import type { HttpRequest, HttpResponse } from "../src/http.js";
import { jsonResponse, rawResponse } from "./helpers.js";

export const HH_BOMB = "mow.DE-HH-HH-SE033-20261119-33-000";
export const RODING_WATER = "mow.DE-BY-R-SE084-20261118-84-000";
export const CANCELLED = "mow.DE-BY-R-SE084-20261119-84-001";
export const DWD_RAIN = "dwd.2.49.0.0.276.0.DWD.PVW.1795078860000.966e2e48-5bef-4c12-a665-298fb97a537f.MUL";
export const STALE = "mow.DE-XX-NOPE-000";

const TITLES_WATER = { en: "Contaminated drinking water", fr: "Pollution de l'eau potable" };

/** /api31/mowas/mapData.json: a Severe alert, a Minor alert, a cancellation (Entwarnung). */
export const mowasMap = [
  {
    id: RODING_WATER,
    version: 19,
    startDate: "2026-11-18T18:23:45+01:00",
    severity: "Severe",
    urgency: "Immediate",
    type: "Alert",
    i18nTitle: { de: "Trinkwasserverschmutzung Großraum Roding - Gemeindebereiche Roding,Michelsneukirchen,Falkenstein,Zell,Wald,Rettenbach", ...TITLES_WATER },
    transKeys: { event: "BBK-EVC-069" },
  },
  {
    id: HH_BOMB,
    version: 19,
    startDate: "2026-11-19T17:18:52+01:00",
    severity: "Minor",
    urgency: "Immediate",
    type: "Alert",
    i18nTitle: { de: "Weltkriegsbombe gefunden - Hamburg-Heimfeld", en: "Second World War bomb" },
    transKeys: { event: "BBK-EVC-079" },
  },
  {
    id: CANCELLED,
    version: 19,
    startDate: "2026-11-19T16:00:10+01:00",
    expiresDate: "2026-11-19T22:00:09+01:00",
    severity: "Minor",
    urgency: "Immediate",
    type: "Cancel",
    i18nTitle: { de: "Entwarnung: Gefährdung durch Brandgase - Unter- / Oberpfrauendorf", en: "All clear: fire gases" },
    transKeys: { event: "BBK-EVC-010" },
  },
];

const gusts = { de: "Amtliche WARNUNG vor STURMBÖEN", en: "Official WARNING of GALE-FORCE GUSTS" };

/** /api31/dwd/mapData.json: one entry per area (two gusts with the same title), a Severe one, an expired one. */
export const dwdMap = [
  { id: "dwdmap.2.49.0.0.276.0.DWD.PVW.1795026960000.a89bb20c.MUL", version: 21, startDate: "2026-11-18T19:36:00+01:00", expiresDate: "2026-11-19T21:00:00+01:00", severity: "Moderate", urgency: "Immediate", type: "Alert", i18nTitle: gusts },
  { id: "dwdmap.2.49.0.0.276.0.DWD.PVW.1795060020000.10f38652.MUL", version: 21, startDate: "2026-11-19T04:47:00+01:00", expiresDate: "2026-11-20T12:00:00+01:00", severity: "Moderate", urgency: "Immediate", type: "Update", i18nTitle: gusts },
  { id: "dwdmap.2.49.0.0.276.0.DWD.PVW.1795104600000.54276fb5.MUL", version: 21, startDate: "2026-11-19T17:10:00+01:00", expiresDate: "2026-11-20T16:00:00+01:00", severity: "Moderate", urgency: "Immediate", type: "Alert", i18nTitle: gusts },
  {
    id: "dwdmap.2.49.0.0.276.0.DWD.PVW.1795085040000.b27955c5.MUL",
    version: 21,
    startDate: "2026-11-19T11:44:00+01:00",
    expiresDate: "2026-11-20T22:00:00+01:00",
    severity: "Severe",
    urgency: "Immediate",
    type: "Alert",
    i18nTitle: { de: "Amtliche UNWETTERWARNUNG vor ERGIEBIGEM DAUERREGEN", en: "Official SEVERE WEATHER WARNING of HEAVY PERSISTENT RAIN" },
  },
];

/** /api31/lhp/mapData.json: an advance flood warning (severity Unknown, no expiry) and a Severe one. */
export const lhpMap = [
  { id: "lhp.LHP.TH.2201", version: 21, startDate: "2026-11-19T14:00:00+01:00", severity: "Unknown", urgency: "Future", type: "Alert", i18nTitle: { de: "Hochwasservorwarnung" } },
  { id: "lhp.LHP.BY.16641_478", version: 21, startDate: "2026-11-19T15:00:00+01:00", expiresDate: "2026-11-20T17:00:00+01:00", severity: "Severe", urgency: "Immediate", type: "Update", i18nTitle: { de: "Hochwasserwarnung vor Überschwemmungsgefahr für bebaute Gebiete" } },
];

/** "Now" for the fixtures: the evening of 2026-11-19, after the first gust warning expired (21:00). */
export const NOW = new Date("2026-11-19T21:30:00+01:00");

/** A dashboard entry as the API sends it. */
function dashboardEntry(id: string, hash: string, data: Record<string, unknown>, i18nTitle: Record<string, string>, times: Record<string, string | null>) {
  return { id, payload: { version: 21, type: "ALERT", id, hash, data: { ...data, transKeys: { event: "BBK-EVC-069" }, area: { type: "GRID", data: "359049+1,359661+3,500001" }, valid: true } }, i18nTitle, ...times };
}

/** /api31/dashboard/020000000000.json (Hamburg): the bomb. */
export const dashboardHamburg = [
  dashboardEntry(HH_BOMB, "f9afe3b3", { headline: "Weltkriegsbombe gefunden - Hamburg-Heimfeld", provider: "MOWAS", severity: "Minor", urgency: "Immediate", msgType: "Alert" }, { de: "Weltkriegsbombe gefunden - Hamburg-Heimfeld", en: "Second World War bomb" }, { sent: "2026-11-19T17:18:52+01:00" }),
];

/** /api31/dashboard/093720000000.json (Lkr. Cham): a Severe MoWaS alert without expiry, a DWD warning, a cancellation, an expired one. */
export const dashboardCham = [
  dashboardEntry(
    DWD_RAIN,
    "a7f4c5d6",
    { headline: "Amtliche WARNUNG vor DAUERREGEN", provider: "DWD", severity: "Moderate", urgency: "Immediate", msgType: "Alert" },
    { de: "Amtliche WARNUNG vor DAUERREGEN", en: "Official WARNING of PERSISTANT RAIN" },
    { sent: "2026-11-19T10:00:15+01:00", onset: "2026-11-19T10:01:00+01:00", expires: "2026-11-21T08:00:00+01:00", effective: "2026-11-19T10:01:00+01:00" },
  ),
  dashboardEntry(
    RODING_WATER,
    "e57084d8",
    { headline: "Trinkwasserverschmutzung Großraum Roding - Gemeindebereiche Roding,Michelsneukirchen,Falkenstein,Zell,Wald,Rettenbach", provider: "MOWAS", severity: "Severe", urgency: "Immediate", msgType: "Alert" },
    { de: "Trinkwasserverschmutzung Großraum Roding - Gemeindebereiche Roding,Michelsneukirchen,Falkenstein,Zell,Wald,Rettenbach", ...TITLES_WATER },
    { sent: "2026-11-18T18:23:45+01:00", onset: null, expires: null },
  ),
  dashboardEntry(CANCELLED, "0c0c0c0c", { headline: "Entwarnung: Gefährdung durch Brandgase", provider: "MOWAS", severity: "Minor", urgency: "Immediate", msgType: "Cancel" }, { de: "Entwarnung: Gefährdung durch Brandgase - Unter- / Oberpfrauendorf" }, { sent: "2026-11-19T16:00:10+01:00" }),
  dashboardEntry(
    "dwd.2.49.0.0.276.0.DWD.PVW.1795026960000.a89bb20c.MUL",
    "11111111",
    { headline: "Amtliche WARNUNG vor STURMBÖEN", provider: "DWD", severity: "Moderate", urgency: "Immediate", msgType: "Alert" },
    gusts,
    { sent: "2026-11-18T19:36:00+01:00", expires: "2026-11-19T21:00:00+01:00" },
  ),
];

/** /api31/warnings/<HH_BOMB>.json: the CAP warning, German, easy German and English. */
export const hhBombDetail = {
  identifier: HH_BOMB,
  sender: "DE-HH-HH-W226",
  sent: "2026-11-19T17:18:52+01:00",
  status: "Actual",
  msgType: "Alert",
  scope: "Public",
  code: ["DVN:21"],
  info: [
    {
      language: "de",
      category: ["Safety"],
      event: "Gefahreninformation",
      urgency: "Immediate",
      severity: "Minor",
      certainty: "Observed",
      headline: "Weltkriegsbombe gefunden - Hamburg-Heimfeld",
      description: "Die Feuerwehr Hamburg informiert, dass im Bereich HH- Heimfeld ein 500 Pfund Bombenblindgänger gefunden wurde.<br/>Die Entschärfung ist für  ca. 19:00 Uhr geplant.",
      instruction: "Achten Sie auf Durchsagen von Polizei und Feuerwehr.<br/>Folgen Sie den Anweisungen der Einsatzkräfte.",
      web: "www.feuerwehr.hamburg.de",
      contact: "115",
      parameter: [{ valueName: "sender_langname", value: "Feuerwehr Hamburg" }, { valueName: "warnVerwaltungsbereiche", value: "020000000000" }],
      area: [{ areaDesc: "Hamburg-Heimfeld" }],
    },
    { language: "de-LS", event: "Gefahreninformation", severity: "Minor", headline: "Weltkriegsbombe", description: "Eine Bombe wurde gefunden.", area: [{ areaDesc: "Hamburg-Heimfeld" }] },
    { language: "en", event: "Hazard information", severity: "Minor", headline: "Second World War bomb", description: "A 500-pound bomb was found.<br/>Defusing is planned for 7 pm.", area: [{ areaDesc: "Hamburg-Heimfeld" }] },
  ],
};

/** /api31/warnings/<RODING_WATER>.json: a Severe MoWaS warning whose expiry is only in the CAP info, advice in the description. */
export const rodingDetail = {
  identifier: RODING_WATER,
  sender: "DE-BY-R-SE084",
  sent: "2026-11-18T18:23:45+01:00",
  status: "Actual",
  msgType: "Alert",
  scope: "Public",
  info: [
    {
      language: "de",
      event: "Trinkwasserverschmutzung",
      severity: "Severe",
      urgency: "Immediate",
      headline: "Trinkwasserverschmutzung Großraum Roding",
      description: "Das Trinkwasser ist verunreinigt.<br>Kochen Sie das Wasser vor dem Trinken ab.",
      instruction: null,
      expires: "2026-11-25T18:00:00+01:00",
      area: [{ areaDesc: "Stadt Roding" }, { areaDesc: "Gemeinde Michelsneukirchen" }],
    },
  ],
};

/** /api31/warnings/<DWD_RAIN>.json: languages de-DE and en. */
export const dwdRainDetail = {
  identifier: DWD_RAIN,
  sender: "opendata@dwd.de",
  sent: "2026-11-19T10:00:15+01:00",
  status: "Actual",
  msgType: "Alert",
  scope: "Public",
  info: [
    {
      language: "de-DE",
      event: "DAUERREGEN",
      severity: "Moderate",
      urgency: "Immediate",
      headline: "Amtliche WARNUNG vor DAUERREGEN",
      description: "Es tritt Dauerregen auf.",
      instruction: "Gefahr durch: vereinzelte Überflutungen von Straßen/Unterführungen.<br/>Handlungsempfehlungen:<br/>Überflutete Abschnitte meiden",
      senderName: "Deutscher Wetterdienst",
      expires: "2026-11-21T08:00:00+01:00",
      area: [{ areaDesc: "Stadt Cham, Gemeinde Roding" }],
    },
    { language: "en", event: "persistent rain", severity: "Moderate", headline: "Official WARNING of PERSISTANT RAIN", instruction: "Avoid flooded areas.", area: [{ areaDesc: "Stadt Cham, Gemeinde Roding" }] },
  ],
};

/** /api31/warnings/<HH_BOMB>.geojson: one polygon (a circle of 500 m), NINA's rendering hints. */
export const hhBombGeojson = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[[9.9527, 53.4742], [9.967, 53.4767], [9.9609, 53.4701], [9.9527, 53.4742]]] },
      properties: { warnId: HH_BOMB, strokeColor: "#FB8C00", strokeOpacity: 1.0, strokeWeight: 1, fillColor: "#FB8C00", fillOpacity: 0.5, zIndex: 20 },
      id: "0",
    },
  ],
};

/** /api31/warnings/<DWD_RAIN>.geojson: a MultiPolygon of two parts. */
export const dwdRainGeojson = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "MultiPolygon", coordinates: [[[[12.37, 49.1], [12.5, 49.2], [12.6, 49.1], [12.37, 49.1]]], [[[12.8, 49.3], [12.9, 49.35], [12.95, 49.3], [12.8, 49.3]]]] },
      properties: { warnId: DWD_RAIN, fillColor: "#FB8C00", fillOpacity: 0.8, zIndex: 30 },
      id: "0",
    },
  ],
};

/** /api31/archive.mowas/<HH_BOMB>-mapping.json. */
export const hhBombMapping = { history: [{ identifier: `${HH_BOMB}_20261119171852.json`, msgType: "ALERT", sent: "2026-11-19T17:18:52+01:00", headline: "Weltkriegsbombe gefunden - Hamburg-Heimfeld" }] };

/** Paths the mock answers, under /api31. */
export const ROUTES: Record<string, unknown> = {
  "/mowas/mapData.json": mowasMap,
  "/katwarn/mapData.json": [],
  "/biwapp/mapData.json": [],
  "/dwd/mapData.json": dwdMap,
  "/lhp/mapData.json": lhpMap,
  "/police/mapData.json": [],
  "/dashboard/020000000000.json": dashboardHamburg,
  "/dashboard/093720000000.json": dashboardCham,
  [`/warnings/${HH_BOMB}.json`]: hhBombDetail,
  [`/warnings/${RODING_WATER}.json`]: rodingDetail,
  [`/warnings/${DWD_RAIN}.json`]: dwdRainDetail,
  [`/warnings/${HH_BOMB}.geojson`]: hhBombGeojson,
  [`/warnings/${DWD_RAIN}.geojson`]: dwdRainGeojson,
  [`/archive.mowas/${HH_BOMB}-mapping.json`]: hhBombMapping,
  [`/archive.mowas/${HH_BOMB}_20261119171852.json`]: hhBombDetail,
};

/**
 * The NINA API over the fixtures, by path (`overrides` replace or add answers; a function gets
 * the request). A warning or GeoJSON that isn't there is answered as NINA does: a 302 to the
 * archive. An unknown dashboard or archive path is a bare 404, as NINA sends it.
 */
export function ninaApi(overrides: Record<string, unknown> = {}): (request: HttpRequest) => HttpResponse {
  const routes = { ...ROUTES, ...overrides };
  return (request) => {
    const path = new URL(request.url).pathname.replace(/^\/api31/, "");
    const answer = routes[decodeURIComponent(path)];
    if (typeof answer === "function") return (answer as (r: HttpRequest) => HttpResponse)(request);
    if (answer !== undefined) {
      return path.endsWith(".geojson") ? rawResponse(JSON.stringify(answer), "application/json") : jsonResponse(answer);
    }
    const warning = /^\/warnings\/(.+)\.(json|geojson)$/.exec(decodeURIComponent(path));
    if (warning !== null) {
      return { status: 302, headers: { location: `https://warnung.bund.de/api31/archive/alerts/${warning[1]}?contentType=json` }, body: Buffer.alloc(0) };
    }
    return { status: 404, headers: {}, body: Buffer.alloc(0) };
  };
}

/**
 * The fixtures' answers with every time moved so that NOW falls on `now` (default the clock): for
 * code that reads the real clock (the MCP server's tools), so the expired stay expired and the
 * active stay active on any day. Shifted times are written in UTC.
 */
export function ninaApiNow(now: number = Date.now(), overrides: Record<string, unknown> = {}): (request: HttpRequest) => HttpResponse {
  const shift = now - NOW.getTime();
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  const moved = JSON.parse(JSON.stringify(ROUTES), (_key, value) => (typeof value === "string" && ISO.test(value) ? new Date(Date.parse(value) + shift).toISOString() : value)) as Record<string, unknown>;
  return ninaApi({ ...moved, ...overrides });
}
