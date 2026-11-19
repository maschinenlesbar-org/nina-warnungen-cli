// The use cases of the skills as library functions, built on the resources: each composes the
// client's calls and carries the traps the skills document, so no caller (the CLI, the MCP
// server's use-case tools, a library user) has to know them.
//
// - getWarningBriefing (skill nina-warning-briefing): the six sources merged, cancellations
//   (Entwarnung) and expired entries dropped and counted, ranked by severity, then urgency, then
//   the newest; entries with the same German headline and severity are one item with count.
// - getRegionWarnings (skill nina-region-watch): a district's dashboard, the same triage, the
//   readable area and the advice of the top warnings, and what changed since a previous check.
// - getWarningArea (skill nina-warning-map): the GeoJSON of one or more warnings as one
//   FeatureCollection, checked, optionally labelled with headline and severity.
// - getWarningDetail and getWarningHistory: one warning (live or archived) in one language.
//
// Rules kept throughout: no bare "not found" (an empty answer says what was asked and what to do
// instead); the warnings' own texts are passed on unaltered (the BBK's terms allow reuse only
// so); only `<br/>` markup is turned into line breaks. Times are as the API sends them.

import type { NinaClient } from "./client.js";
import { NinaApiError, NinaError, NinaNotFoundError, NinaValidationError, cutText, quoteValue } from "./errors.js";
import { arsProblem } from "./ars.js";
import { NinaSourceValues, SeverityValues, type NinaSource } from "./enums.js";
import type { DashboardEntry, I18nText, JsonObject, JsonValue, MapWarning, WarningDetail } from "./types.js";

/** The language a caller asks for: `de` (default), `en`, `fr`, …, or a regional form (`de-LS`). */
const LANG = /^[a-z]{2}(-[A-Za-z]{2,3})?$/;

/** Ranks of the CAP severities, most serious first; anything else after Unknown. */
const SEVERITY_RANK: Record<string, number> = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };

/** The most warnings whose detail a region answer reads (one request each). */
export const MAX_REGION_DETAILS = 5;

/** The most ids listed per briefing item (`count` has them all). */
const MAX_IDS_PER_ITEM = 10;

/** The most cancellations listed by headline. */
const MAX_CLEARED = 10;

function langOf(lang: string | undefined): string {
  const value = (lang ?? "de").trim();
  if (!LANG.test(value)) throw new NinaValidationError(`Invalid language ${quoteValue(value)}: expected a language code such as de, en, fr or de-LS.`);
  return value;
}

function rank(severity: string | undefined): number {
  return SEVERITY_RANK[severity ?? ""] ?? 5;
}

/** True when `expires` is a time before `now` (an unparsable or missing one is never expired). */
function isExpired(expires: string | null | undefined, now: Date): boolean {
  if (typeof expires !== "string") return false;
  const at = Date.parse(expires);
  return Number.isFinite(at) && at < now.getTime();
}

/** The newest of two ISO times (by the instant), or whichever is set. */
function later(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/** Order: severity, then Immediate first, then the newest. */
function compareWarnings(a: { severity?: string; urgency?: string; time?: string }, b: { severity?: string; urgency?: string; time?: string }): number {
  return (
    rank(a.severity) - rank(b.severity) ||
    Number(b.urgency === "Immediate") - Number(a.urgency === "Immediate") ||
    (Date.parse(b.time ?? "") || 0) - (Date.parse(a.time ?? "") || 0)
  );
}

/** A title in the asked language, if the map has one (also its base: `de` for `de-DE`). */
function titleIn(i18n: I18nText | undefined, lang: string): string | undefined {
  if (i18n === undefined) return undefined;
  return i18n[lang] ?? i18n[lang.slice(0, 2)];
}

/** The German title (the specific one: other languages often name only the event type). */
function germanTitle(i18n: I18nText | undefined, fallback?: string): string {
  return i18n?.["de"] ?? fallback ?? Object.values(i18n ?? {})[0] ?? "";
}

/** The headline as published, and its translation when another language is asked for and given. */
function headlines(i18n: I18nText | undefined, lang: string, fallback?: string): { headline: string; translated?: string } {
  const headline = germanTitle(i18n, fallback);
  if (lang === "de" || lang.startsWith("de-")) return { headline };
  const translated = titleIn(i18n, lang);
  return translated === undefined || translated === headline ? { headline } : { headline, translated };
}

/** `<br/>` (any spelling) as a line break; nothing else of the text is changed. */
export function lineBreaks(text: string): string {
  return text.replace(/<br\s*\/?>/gi, "\n");
}

/** A note on MoWaS-style translations, said once when another language than German is asked for. */
const TRANSLATION_NOTE =
  "headline is the German title as published; translated is the API's own translation, which for MoWaS, KATWARN and BIWAPP often names only the kind of event, not the place.";

// ---------------------------------------------------------------------------------------------
// The briefing

/** The input of {@link getWarningBriefing}. */
export interface WarningBriefingInput {
  /** The sources to read (default all six). */
  sources?: readonly NinaSource[] | undefined;
  /** The language of `translated` (default de: none). */
  lang?: string | undefined;
  /** Only warnings at least this severe (Unknown is the lowest). */
  minSeverity?: string | undefined;
  /** The most items listed, most serious first (1–100, default 25); the rest are counted in `more`. */
  limit?: number | undefined;
  /** "Now", for what has expired (default the clock). */
  now?: Date | undefined;
}

/** Warnings with the same German headline and severity, from one or more sources. */
export interface BriefingItem {
  headline: string;
  translated?: string;
  severity: string;
  urgency?: string;
  /** The CAP message type of the newest entry: Alert or Update. */
  msgType?: string;
  sources: NinaSource[];
  /** How many entries (areas) carry this headline. */
  count: number;
  /** Their ids (the first ten), for getWarningDetail and getWarningArea. */
  ids: string[];
  /** The newest start. */
  startDate?: string;
  /** The latest expiry, or null when an entry gives none (then it is treated as active). */
  expiresDate: string | null;
  event?: string;
}

/** What one source gave. */
export interface SourceSummary {
  source: NinaSource;
  /** Active entries (not cancelled, not expired). */
  active: number;
  /** Cancellations (Entwarnung): withdrawn warnings, dropped. */
  cancelled: number;
  /** Entries whose expiry has passed, dropped. */
  expired: number;
  /** Why the source could not be read; the briefing then lacks it. */
  error?: string;
}

/** The answer of {@link getWarningBriefing}. */
export interface WarningBriefing {
  status: "ok";
  verdict: string;
  /** Active entries in all sources read (each area counts). */
  active: number;
  bySeverity: Record<string, number>;
  sources: SourceSummary[];
  warnings: BriefingItem[];
  /** Items not listed (over the limit). */
  more: number;
  /** The first cancellations, by headline. */
  cleared: { headline: string; source: NinaSource; id: string }[];
  /** Active entries below minSeverity, left out. */
  belowMinSeverity?: number;
  notes: string[];
}

/**
 * One ranked briefing across the NINA sources (default all six: MoWaS, KATWARN, BIWAPP, DWD,
 * LHP flood, police). Cancellations (`type` Cancel, "Entwarnung: …") are withdrawn warnings, not
 * hazards: counted and listed apart, never as active. An entry whose `expiresDate` has passed is
 * over: counted, dropped; an entry without one stays active (no expiry is guessed). Entries with the
 * same German headline and severity are one item with a count (DWD issues one entry per area;
 * MoWaS mirrors). A source that cannot be read is named in `sources[].error` and the verdict; when
 * none can be read, the first error is thrown.
 */
export async function getWarningBriefing(client: NinaClient, input: WarningBriefingInput = {}): Promise<WarningBriefing> {
  const sources = sourcesOf(input.sources);
  const lang = langOf(input.lang);
  const min = input.minSeverity === undefined ? undefined : severityOf(input.minSeverity);
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new NinaValidationError("Invalid limit: expected a whole number from 1 to 100.");
  const now = input.now ?? new Date();

  const settled = await Promise.allSettled(sources.map((source) => client.mapData(source)));
  if (settled.every((result) => result.status === "rejected")) throw (settled[0] as PromiseRejectedResult).reason;

  const summaries: SourceSummary[] = [];
  const cleared: WarningBriefing["cleared"] = [];
  const groups = new Map<string, BriefingItem & { time?: string; expiresAll: boolean }>();
  let below = 0;
  let clearedTotal = 0;
  settled.forEach((result, index) => {
    const source = sources[index] as NinaSource;
    if (result.status === "rejected") {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      summaries.push({ source, active: 0, cancelled: 0, expired: 0, error: cutText(reason, 300) });
      return;
    }
    const summary: SourceSummary = { source, active: 0, cancelled: 0, expired: 0 };
    summaries.push(summary);
    for (const entry of result.value as MapWarning[]) {
      if (entry.type === "Cancel") {
        summary.cancelled += 1;
        clearedTotal += 1;
        if (cleared.length < MAX_CLEARED) cleared.push({ headline: germanTitle(entry.i18nTitle), source, id: entry.id });
        continue;
      }
      if (isExpired(entry.expiresDate, now)) {
        summary.expired += 1;
        continue;
      }
      summary.active += 1;
      const severity = typeof entry.severity === "string" ? entry.severity : "Unknown";
      if (min !== undefined && rank(severity) > rank(min)) {
        below += 1;
        continue;
      }
      const titles = headlines(entry.i18nTitle, lang);
      const key = `${severity}\u0000${titles.headline.trim().replace(/\s+/g, " ").toLocaleLowerCase("de")}`;
      const urgency = (entry as { urgency?: unknown }).urgency;
      const group = groups.get(key);
      const expires = typeof entry.expiresDate === "string" ? entry.expiresDate : undefined;
      if (group === undefined) {
        groups.set(key, {
          ...titles,
          severity,
          ...(typeof urgency === "string" ? { urgency } : {}),
          ...(entry.type === undefined ? {} : { msgType: entry.type }),
          sources: [source],
          count: 1,
          ids: [entry.id],
          ...(entry.startDate === undefined ? {} : { startDate: entry.startDate, time: entry.startDate }),
          expiresDate: expires ?? null,
          expiresAll: expires !== undefined,
          ...(entry.transKeys?.event === undefined ? {} : { event: entry.transKeys.event }),
        });
        continue;
      }
      group.count += 1;
      if (group.ids.length < MAX_IDS_PER_ITEM) group.ids.push(entry.id);
      if (!group.sources.includes(source)) group.sources.push(source);
      if (urgency === "Immediate") group.urgency = "Immediate";
      const newest = later(group.startDate, entry.startDate);
      if (newest !== group.startDate && newest !== undefined) {
        group.startDate = newest;
        group.time = newest;
        if (entry.type !== undefined) group.msgType = entry.type;
      }
      group.expiresAll &&= expires !== undefined;
      group.expiresDate = group.expiresAll ? (later(group.expiresDate ?? undefined, expires) ?? null) : null;
    }
  });

  const ranked = [...groups.values()].sort(compareWarnings);
  const warnings: BriefingItem[] = ranked.slice(0, limit).map(({ time: _time, expiresAll: _all, ...item }) => item);
  const active = summaries.reduce((sum, s) => sum + s.active, 0);
  const bySeverity: Record<string, number> = {};
  for (const item of ranked) bySeverity[item.severity] = (bySeverity[item.severity] ?? 0) + item.count;
  const notes: string[] = [];
  if (lang !== "de" && !lang.startsWith("de-")) notes.push(TRANSLATION_NOTE);
  if (ranked.some((item) => item.expiresDate === null)) notes.push("expiresDate null: the source gives no expiry; the warning is treated as active (none is guessed). getWarningDetail may have one.");
  if (ranked.some((item) => item.count > 1)) notes.push("count > 1: the same headline and severity for several areas or sources (DWD issues one entry per area); ids lists the first ten.");
  return {
    status: "ok",
    verdict: briefingVerdict(summaries, bySeverity, active, clearedTotal, below, min),
    active,
    bySeverity,
    sources: summaries,
    warnings,
    more: Math.max(0, ranked.length - warnings.length),
    cleared,
    ...(min === undefined ? {} : { belowMinSeverity: below }),
    notes,
  };
}

function briefingVerdict(summaries: SourceSummary[], bySeverity: Record<string, number>, active: number, cancelled: number, below: number, min: string | undefined): string {
  const read = summaries.filter((s) => s.error === undefined);
  const perSource = summaries.map((s) => (s.error === undefined ? `${s.source} ${s.active}` : `${s.source} not read`)).join(", ");
  const expired = summaries.reduce((sum, s) => sum + s.expired, 0);
  const severities = [...new Set([...SeverityValues, ...Object.keys(bySeverity)])]
    .filter((k) => (bySeverity[k] ?? 0) > 0)
    .sort((x, y) => rank(x) - rank(y))
    .map((k) => `${bySeverity[k]} ${k}`)
    .join(", ");
  const head =
    active === 0
      ? `No active civil-protection warnings from the ${read.length} source${read.length === 1 ? "" : "s"} read right now`
      : `${active} active warning entr${active === 1 ? "y" : "ies"}${severities === "" ? "" : `: ${severities}`}${min === undefined ? "" : ` (${below} below ${min} left out)`}`;
  const failed = summaries.filter((s) => s.error !== undefined).map((s) => s.source);
  const missing = failed.length === 0 ? "" : ` ${failed.join(", ")} could not be read: warnings from ${failed.length === 1 ? "it" : "them"} may be missing.`;
  return `${head} (${perSource}); ${cancelled} cancellation${cancelled === 1 ? "" : "s"} and ${expired} expired dropped.${missing}`;
}

function sourcesOf(sources: readonly string[] | undefined): NinaSource[] {
  if (sources === undefined) return [...NinaSourceValues];
  if (sources.length === 0) throw new NinaValidationError(`Invalid sources: name at least one of ${NinaSourceValues.join(", ")}.`);
  const out: NinaSource[] = [];
  for (const raw of sources) {
    const source = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!(NinaSourceValues as readonly string[]).includes(source)) {
      throw new NinaValidationError(`Invalid source ${quoteValue(String(raw))}: expected one of ${NinaSourceValues.join(", ")}.`);
    }
    if (!out.includes(source as NinaSource)) out.push(source as NinaSource);
  }
  return out;
}

function severityOf(value: string): string {
  const found = SeverityValues.find((s) => s.toLowerCase() === value.trim().toLowerCase());
  if (found === undefined) throw new NinaValidationError(`Invalid severity ${quoteValue(value)}: expected one of ${SeverityValues.join(", ")}.`);
  return found;
}

// ---------------------------------------------------------------------------------------------
// A region

/** The input of {@link getRegionWarnings}. */
export interface RegionWarningsInput {
  /**
   * The district's 12-digit ARS (first five digits, then 0000000). An 8-digit AGS, a 5-digit
   * district code or a municipality's 12-digit ARS is taken to its district (said in `region.from`).
   */
  ars: string;
  lang?: string | undefined;
  /** The `watch` tokens of an earlier answer: the answer then says what is new, changed and cleared. */
  previous?: readonly string[] | undefined;
  /** Read the readable area and the advice of the top five warnings (default true; one request each). */
  details?: boolean | undefined;
  now?: Date | undefined;
}

/** One active warning of a district. */
export interface RegionWarning {
  id: string;
  headline: string;
  translated?: string;
  severity: string;
  urgency?: string;
  msgType?: string;
  provider?: string;
  sent?: string;
  effective?: string | null;
  onset?: string | null;
  /** The expiry; null when none is given (then it is treated as active). */
  expires: string | null;
  /** `id@hash`: pass the tokens back as `previous` to learn what changed. */
  watch: string;
  /** The readable areas (areaDesc of the warning), with details. */
  areas?: string[];
  description?: string;
  instruction?: string;
  senderName?: string;
  web?: string;
  /** Why the details are missing. */
  detail?: string;
}

/** What changed since the tokens given as `previous`. */
export interface RegionChanges {
  new: string[];
  changed: string[];
  cleared: string[];
  unchanged: number;
}

/** The answer of {@link getRegionWarnings}. */
export type RegionWarnings =
  | {
      status: "ok";
      region: { ars: string; from?: string };
      verdict: string;
      active: number;
      warnings: RegionWarning[];
      cleared: { id: string; headline: string }[];
      expired: number;
      changes?: RegionChanges;
      notes: string[];
    }
  | { status: "empty"; region: { ars: string; from?: string }; searched: { ars: string }; reason: string };

/**
 * The district key for `value`: a 12-digit district ARS as is; an 8-digit AGS, a 5-digit district
 * code or a municipality's 12-digit ARS taken to its district (`from` says which). A place name,
 * a state key or a malformed key throws a `NinaValidationError` saying what to give instead.
 */
export function districtKey(value: string): { ars: string; from?: string } {
  const raw = typeof value === "string" ? value.trim() : "";
  if (/\p{L}/u.test(raw) && !/^\d+$/.test(raw)) {
    throw new NinaValidationError(
      `${quoteValue(raw)} is not a region key: the dashboard is addressed by a district's 12-digit ARS (Amtlicher Regionalschlüssel: the district's first five digits followed by 0000000, e.g. 082210000000 for Heidelberg, 055150000000 for Münster). Map the place to its Kreis or kreisfreie Stadt first.`,
    );
  }
  let ars = raw;
  let from: string | undefined;
  if (/^\d{8}$/.test(raw)) [ars, from] = [`${raw.slice(0, 5)}0000000`, `the AGS ${raw}`];
  else if (/^\d{5}$/.test(raw)) [ars, from] = [`${raw}0000000`, `the district code ${raw}`];
  else if (/^\d{12}$/.test(raw) && !/0{7}$/.test(raw)) [ars, from] = [`${raw.slice(0, 5)}0000000`, `the municipality key ${raw}`];
  const problem = arsProblem(ars);
  if (problem !== undefined) throw new NinaValidationError(from === undefined ? problem : `${problem} (taken from ${from})`);
  return from === undefined ? { ars } : { ars, from };
}

/** The `watch` token of a dashboard entry. */
function watchOf(entry: DashboardEntry): string {
  const hash = (entry.payload as { hash?: unknown }).hash;
  return typeof hash === "string" ? `${entry.id}@${hash}` : entry.id;
}

/** `payload.data` of a dashboard entry (severity, urgency, msgType, provider are there, not on top). */
function dataOf(entry: DashboardEntry): Record<string, JsonValue> {
  const data = (entry.payload as { data?: unknown }).data;
  return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, JsonValue>) : {};
}

const textOf = (value: JsonValue | undefined): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * The active warnings of one district (the per-region dashboard), ranked like the briefing.
 * Severity, urgency, msgType and provider are under `payload.data`, not on top. Cancellations are
 * dropped and listed apart; an entry whose top-level `expires` has passed is dropped; a null
 * `expires` (MoWaS) stays active and is filled from the warning when the details are read. The
 * readable area is the warning's `areaDesc`, never the encoded `payload.data.area`. A district NINA
 * doesn't know (HTTP 404) is `empty` with the reason; no warning at all is `ok`, a real all-clear
 * that depends on the key being the right district. With `previous`, what changed since.
 */
export async function getRegionWarnings(client: NinaClient, input: RegionWarningsInput): Promise<RegionWarnings> {
  const region = districtKey(input.ars);
  const lang = langOf(input.lang);
  const now = input.now ?? new Date();
  const previous = previousOf(input.previous);
  let entries: DashboardEntry[];
  try {
    entries = await client.dashboard(region.ars);
  } catch (err) {
    if (err instanceof NinaApiError && err.status === 404) {
      return { status: "empty", region, searched: { ars: region.ars }, reason: `${err.detail ?? "NINA has no dashboard for this key."} Check the district's key.` };
    }
    throw err;
  }

  const cleared: { id: string; headline: string }[] = [];
  let expired = 0;
  const active: (RegionWarning & { time?: string })[] = [];
  for (const entry of entries) {
    const data = dataOf(entry);
    const titles = headlines(entry.i18nTitle, lang, textOf(data["headline"]));
    if (data["msgType"] === "Cancel") {
      cleared.push({ id: entry.id, headline: titles.headline });
      continue;
    }
    if (isExpired(entry.expires, now)) {
      expired += 1;
      continue;
    }
    const pick = (key: string): Record<string, string> => (typeof data[key] === "string" ? { [key]: data[key] as string } : {});
    active.push({
      id: entry.id,
      ...titles,
      severity: textOf(data["severity"]) ?? "Unknown",
      ...pick("urgency"),
      ...pick("msgType"),
      ...pick("provider"),
      ...(entry.sent === undefined ? {} : { sent: entry.sent }),
      ...(entry.effective === undefined ? {} : { effective: entry.effective }),
      ...(entry.onset === undefined ? {} : { onset: entry.onset }),
      expires: typeof entry.expires === "string" ? entry.expires : null,
      watch: watchOf(entry),
      ...(entry.sent === undefined ? {} : { time: entry.sent }),
    });
  }
  active.sort(compareWarnings);
  const warnings: RegionWarning[] = active.map(({ time: _time, ...warning }) => warning);

  if (input.details !== false) {
    for (const warning of warnings.slice(0, MAX_REGION_DETAILS)) Object.assign(warning, await detailsOf(client, warning, lang));
  }

  const notes: string[] = [];
  if (lang !== "de" && !lang.startsWith("de-")) notes.push(TRANSLATION_NOTE);
  if (warnings.length > MAX_REGION_DETAILS && input.details !== false) notes.push(`Areas and advice are read for the first ${MAX_REGION_DETAILS} warnings; getWarningDetail has the others.`);
  if (warnings.some((w) => w.expires === null)) notes.push("expires null: no expiry is given (MoWaS); the warning is treated as active, none is guessed.");
  const verdict =
    warnings.length === 0
      ? `No active warnings for the district ${region.ars} right now: a real all-clear for this key${cleared.length > 0 ? ` (${cleared.length} cancellation${cleared.length === 1 ? "" : "s"})` : ""}. It is only as right as the key: name the district so the user can check it.`
      : `${warnings.length} active warning${warnings.length === 1 ? "" : "s"} for the district ${region.ars}, the most serious ${warnings[0]?.severity}.`;
  return {
    status: "ok",
    region,
    verdict,
    active: warnings.length,
    warnings,
    cleared,
    expired,
    ...(previous === undefined ? {} : { changes: changesSince(previous, warnings) }),
    notes,
  };
}

/** The ids and hashes of `previous` tokens (`id@hash`; a bare id has no hash). */
function previousOf(tokens: readonly string[] | undefined): Map<string, string | undefined> | undefined {
  if (tokens === undefined) return undefined;
  const map = new Map<string, string | undefined>();
  for (const token of tokens) {
    if (typeof token !== "string" || token.trim() === "") throw new NinaValidationError("Invalid previous: each token is a watch value of an earlier answer (id@hash).");
    const at = token.lastIndexOf("@");
    if (at < 0) map.set(token.trim(), undefined);
    else map.set(token.slice(0, at).trim(), token.slice(at + 1).trim() || undefined);
  }
  return map;
}

function changesSince(previous: Map<string, string | undefined>, warnings: RegionWarning[]): RegionChanges {
  const changes: RegionChanges = { new: [], changed: [], cleared: [], unchanged: 0 };
  const now = new Set<string>();
  for (const warning of warnings) {
    now.add(warning.id);
    if (!previous.has(warning.id)) changes.new.push(warning.id);
    else {
      const before = previous.get(warning.id);
      const hash = warning.watch.slice(warning.id.length + 1);
      if (before !== undefined && hash !== "" && before !== hash) changes.changed.push(warning.id);
      else changes.unchanged += 1;
    }
  }
  for (const id of previous.keys()) if (!now.has(id)) changes.cleared.push(id);
  return changes;
}

/** The readable area and the advice of a warning, or why they are missing. */
async function detailsOf(client: NinaClient, warning: RegionWarning, lang: string): Promise<Partial<RegionWarning>> {
  let detail: WarningDetail;
  try {
    detail = await client.warnings.get(warning.id);
  } catch (err) {
    if (err instanceof NinaNotFoundError) return { detail: "No longer live: it ended or was replaced since the dashboard was published." };
    if (err instanceof NinaError && !(err instanceof NinaValidationError)) return { detail: `Could not be read: ${cutText(err.message, 200)}` };
    throw err;
  }
  const info = pickInfo(detail, lang).info;
  if (info === undefined) return { detail: "The warning has no info block." };
  const out: Partial<RegionWarning> = {};
  const areas = areaDescs(info);
  if (areas.length > 0) out.areas = areas;
  for (const key of ["description", "instruction"] as const) {
    const value = info[key];
    if (typeof value === "string" && value.trim() !== "") out[key] = lineBreaks(value);
  }
  if (typeof info["senderName"] === "string") out.senderName = info["senderName"];
  if (typeof info["web"] === "string") out.web = info["web"];
  if (warning.expires === null && typeof info["expires"] === "string") out.expires = info["expires"];
  return out;
}

/** The `info` block in `lang` (exact, then its base or regional form, plain forms before `-LS`), else German, else the first. */
function pickInfo(detail: WarningDetail, lang: string): { info?: JsonObject; languages: string[] } {
  const infos = (Array.isArray(detail["info"]) ? detail["info"] : []).filter((i): i is JsonObject => typeof i === "object" && i !== null && !Array.isArray(i));
  const languages = infos.map((i) => (typeof i["language"] === "string" ? i["language"] : "")).filter((l) => l !== "");
  const code = (i: JsonObject): string => (typeof i["language"] === "string" ? i["language"].toLowerCase() : "");
  const want = lang.toLowerCase();
  const base = want.slice(0, 2);
  const find = (test: (c: string) => boolean): JsonObject | undefined => infos.find((i) => test(code(i)));
  const info =
    find((c) => c === want) ??
    find((c) => c === base || c === `${base}-${base}`) ??
    find((c) => c.startsWith(`${base}-`) && !c.endsWith("-ls")) ??
    find((c) => c === "de" || c === "de-de") ??
    infos[0];
  return { ...(info === undefined ? {} : { info }), languages };
}

function areaDescs(info: JsonObject): string[] {
  const areas = Array.isArray(info["area"]) ? info["area"] : [];
  return areas.flatMap((a) => (typeof a === "object" && a !== null && !Array.isArray(a) && typeof a["areaDesc"] === "string" ? [a["areaDesc"]] : []));
}

// ---------------------------------------------------------------------------------------------
// One warning, live or archived

/** One warning in one language: the envelope, that language's info block, the readable areas. */
export interface ShapedWarning {
  identifier: string;
  /** The language of the info block given. */
  language?: string;
  /** Every language the warning has. */
  languages: string[];
  /** The envelope (sender, sent, status, msgType, scope, references, …) and the info block's fields as sent; description and instruction with `<br/>` as line breaks. */
  warning: JsonObject;
  /** The readable areas (areaDesc). The geometry is in getWarningArea. */
  areas: string[];
  /** Said when the warning has no version in the asked language. */
  notes?: string[];
}

/** The answer of {@link getWarningDetail}. */
export type WarningDetailAnswer =
  | ({ status: "ok" } & ShapedWarning)
  | { status: "empty"; searched: { id: string }; reason: string; archive?: string };

/** A CAP warning reduced to one language: the envelope, that info block (its area as areaDesc only). */
export function shapeWarning(detail: WarningDetail, lang: string): ShapedWarning {
  const { info: _all, ...envelope } = detail;
  const { info, languages } = pickInfo(detail, langOf(lang));
  const warning: JsonObject = { ...envelope };
  let areas: string[] = [];
  if (info !== undefined) {
    const { area: _area, ...fields } = info;
    for (const [key, value] of Object.entries(fields)) warning[key] = (key === "description" || key === "instruction") && typeof value === "string" ? lineBreaks(value) : value;
    areas = areaDescs(info);
  }
  const language = typeof info?.["language"] === "string" ? info["language"] : undefined;
  const asked = lang.toLowerCase();
  const got = (language ?? "").toLowerCase();
  const other = language !== undefined && (got.slice(0, 2) !== asked.slice(0, 2) || (asked.endsWith("-ls") && !got.endsWith("-ls")));
  return {
    identifier: typeof detail["identifier"] === "string" ? detail["identifier"] : "",
    ...(language === undefined ? {} : { language }),
    languages,
    warning,
    areas,
    ...(other ? { notes: [`The warning has no ${lang} version: it is given in ${language} (languages lists those it has).`] } : {}),
  };
}

/**
 * One live warning in full, in one language (default German). An id that is not a live warning's
 * (ended, replaced, mistyped: the API redirects it to its archive) is `empty` with the reason and
 * the archive's address, never a bare not-found.
 */
export async function getWarningDetail(client: NinaClient, input: { id: string; lang?: string | undefined }): Promise<WarningDetailAnswer> {
  const lang = langOf(input.lang);
  try {
    return { status: "ok", ...shapeWarning(await client.warnings.get(input.id), lang) };
  } catch (err) {
    if (!(err instanceof NinaNotFoundError)) throw err;
    return {
      status: "empty",
      searched: { id: err.identifier },
      reason: `No live warning has this id (ids are case-sensitive): it ended, was updated or cancelled, or is mistyped. Take a current id from getWarningBriefing, getRegionWarnings or listSourceWarnings${err.identifier.startsWith("mow.") ? "; for an ended MoWaS warning, getWarningHistory has its archived versions" : ""}.`,
      ...(err.location === undefined ? {} : { archive: err.location }),
    };
  }
}

/** The answer of {@link getWarningHistory}. */
export type WarningHistory =
  | { status: "ok"; id: string; history: JsonObject[] }
  | ({ status: "ok"; revision: string } & ShapedWarning)
  | { status: "empty"; searched: { id?: string; revision?: string }; reason: string };

/**
 * The MoWaS archive: an id's revisions (alert, updates, cancel) with their revision ids, or, given
 * a revision id from that list, that archived version in one language. Only MoWaS warnings
 * (`mow.…`) are archived; another id, or one the archive doesn't have (HTTP 404), is `empty` with
 * the reason.
 */
export async function getWarningHistory(client: NinaClient, input: { id?: string | undefined; revision?: string | undefined; lang?: string | undefined }): Promise<WarningHistory> {
  const lang = langOf(input.lang);
  const notMowas = (value: string) =>
    `The archive holds MoWaS warnings only (ids starting mow.); ${quoteValue(value)} is not one. For a live warning of another source use getWarningDetail.`;
  try {
    if (input.revision !== undefined) {
      const revision = input.revision.trim();
      if (!revision.startsWith("mow.")) return { status: "empty", searched: { revision }, reason: notMowas(revision) };
      return { status: "ok", revision, ...shapeWarning(await client.archive.get(revision), lang) };
    }
    const id = (input.id ?? "").trim();
    if (id === "") throw new NinaValidationError("Give id (a MoWaS warning id) or revision (a revision id from its history).");
    if (!id.startsWith("mow.")) return { status: "empty", searched: { id }, reason: notMowas(id) };
    const mapping = await client.archive.mapping(id);
    const history = mapping.history.filter((h) => typeof h === "object" && h !== null) as unknown as JsonObject[];
    if (history.length === 0) return { status: "empty", searched: { id }, reason: "The archive lists no revisions for this id." };
    return { status: "ok", id, history };
  } catch (err) {
    if (err instanceof NinaApiError && err.status === 404) {
      const searched = input.revision !== undefined ? { revision: input.revision.trim() } : { id: (input.id ?? "").trim() };
      return { status: "empty", searched, reason: "The MoWaS archive has no such id (HTTP 404). Ids are case-sensitive; take one from a briefing or region answer, and a revision id from the id's history." };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// The area of warnings, as GeoJSON

/** The input of {@link getWarningArea}. */
export interface WarningAreaInput {
  /** One to five warning ids (live ones). */
  ids: readonly string[];
  /** Add headline, severity, event and areaDesc from each warning to its features' properties (one request more per id). */
  labels?: boolean | undefined;
  lang?: string | undefined;
}

/** The answer of {@link getWarningArea}: itself a GeoJSON FeatureCollection (with foreign members). */
export type WarningArea =
  | {
      status: "ok";
      type: "FeatureCollection";
      features: JsonObject[];
      featureCount: number;
      polygonCount: number;
      /** Ids whose geometry is in `features`. */
      found: string[];
      /** Ids that are no live warning: re-take a fresh id. */
      notLive: string[];
      /** What is wrong with the geometry, if anything. */
      problems: string[];
    }
  | { status: "empty"; searched: { ids: string[] }; reason: string; notLive: string[] };

/**
 * The affected areas of one to five warnings as one FeatureCollection, as NINA delivers them
 * ([lon, lat], no fix-up needed). The features' properties are NINA's rendering hints (warnId,
 * colours, zIndex); with `labels`, headline, severity, event and areaDesc from the warning are
 * added. A stale id (redirected to the archive) is listed in `notLive`; when every id is, the
 * answer is `empty` with what to do. Positions that are not numbers in range are named in
 * `problems`, never silently passed.
 */
export async function getWarningArea(client: NinaClient, input: WarningAreaInput): Promise<WarningArea> {
  const ids = [...new Set((input.ids ?? []).map((id) => (typeof id === "string" ? id.trim() : "")))];
  if (ids.length < 1 || ids.length > 5 || ids.includes("")) throw new NinaValidationError("Invalid ids: give one to five warning ids.");
  const lang = langOf(input.lang);
  const features: JsonObject[] = [];
  const found: string[] = [];
  const notLive: string[] = [];
  const problems: string[] = [];
  for (const id of ids) {
    let collection: unknown;
    try {
      const raw = await client.warnings.geojson(id);
      collection = JSON.parse(new TextDecoder().decode(raw.data));
    } catch (err) {
      if (err instanceof NinaNotFoundError) {
        notLive.push(id);
        continue;
      }
      throw err;
    }
    const own = featuresOf(collection);
    if (own.length === 0) problems.push(`${id}: the GeoJSON has no features.`);
    let labels: JsonObject | undefined;
    if (input.labels === true) {
      try {
        const shaped = shapeWarning(await client.warnings.get(id), lang);
        const w = shaped.warning;
        labels = {
          ...(typeof w["headline"] === "string" ? { headline: w["headline"] } : {}),
          ...(typeof w["severity"] === "string" ? { severity: w["severity"] } : {}),
          ...(typeof w["event"] === "string" ? { event: w["event"] } : {}),
          ...(shaped.areas.length === 0 ? {} : { areaDesc: shaped.areas.join("; ") }),
        };
      } catch (err) {
        if (!(err instanceof NinaNotFoundError)) throw err;
        problems.push(`${id}: no labels, the warning ended between the two requests.`);
      }
    }
    for (const feature of own) {
      const props = feature["properties"];
      const properties: JsonObject = { ...(typeof props === "object" && props !== null && !Array.isArray(props) ? props : {}), ...(labels ?? {}) };
      if (properties["warnId"] === undefined) properties["warnId"] = id;
      features.push({ ...feature, properties });
      problems.push(...positionProblems(id, feature["geometry"]));
    }
    found.push(id);
  }
  if (found.length === 0) {
    return {
      status: "empty",
      searched: { ids },
      notLive,
      reason: "None of these ids is a live warning (ids churn as warnings are issued, updated and cancelled). Take a fresh id from getWarningBriefing, getRegionWarnings or listSourceWarnings.",
    };
  }
  return {
    status: "ok",
    type: "FeatureCollection",
    features,
    featureCount: features.length,
    polygonCount: features.reduce((sum, f) => sum + polygonsIn(f["geometry"]), 0),
    found,
    notLive,
    problems: [...new Set(problems)],
  };
}

/** The features of a GeoJSON value: a collection's, a feature itself, or a bare geometry wrapped. */
function featuresOf(value: unknown): JsonObject[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const object = value as JsonObject;
  if (object["type"] === "FeatureCollection") {
    return (Array.isArray(object["features"]) ? object["features"] : []).filter((f): f is JsonObject => typeof f === "object" && f !== null && !Array.isArray(f));
  }
  if (object["type"] === "Feature") return [object];
  return [{ type: "Feature", geometry: object, properties: {} }];
}

function polygonsIn(geometry: JsonValue | undefined): number {
  if (typeof geometry !== "object" || geometry === null || Array.isArray(geometry)) return 0;
  if (geometry["type"] === "Polygon") return 1;
  if (geometry["type"] === "MultiPolygon") return Array.isArray(geometry["coordinates"]) ? geometry["coordinates"].length : 0;
  if (geometry["type"] === "GeometryCollection" && Array.isArray(geometry["geometries"])) return geometry["geometries"].reduce<number>((sum, g) => sum + polygonsIn(g), 0);
  return 0;
}

/** Positions that are not [lon, lat] numbers in range, said once per kind and id. */
function positionProblems(id: string, geometry: JsonValue | undefined): string[] {
  if (geometry === null || geometry === undefined) return [`${id}: a feature has no geometry.`];
  const problems = new Set<string>();
  const walk = (value: JsonValue | undefined): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && value.every((v) => !Array.isArray(v))) {
      const [lon, lat] = value;
      if (typeof lon !== "number" || typeof lat !== "number") problems.add(`${id}: a position that is not two numbers.`);
      else if (Math.abs(lon) > 180 || Math.abs(lat) > 90) problems.add(`${id}: a position out of range ([lon, lat] expected).`);
      return;
    }
    for (const item of value) walk(item);
  };
  if (typeof geometry === "object" && !Array.isArray(geometry)) {
    walk(geometry["coordinates"]);
    if (Array.isArray(geometry["geometries"])) for (const g of geometry["geometries"]) for (const p of positionProblems(id, g)) problems.add(p);
  }
  return [...problems];
}
