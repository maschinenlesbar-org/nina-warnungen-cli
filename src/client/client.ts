// NinaClient — a typed client over the open (no-auth) endpoints of the NINA API
// (https://warnung.bund.de/api31), the federal civil-protection warning system
// run by the BBK (Bundesamt für Bevölkerungsschutz und Katastrophenhilfe).
//
//   client.mapData("mowas")        // current alerts from a source
//   client.warnings.get(id)        // full CAP warning
//   client.dashboard(ars)          // alerts for a region (Amtlicher Regionalschlüssel)

import { RequestEngine, type EngineOptions, type RawResponse } from "./engine.js";
import type { NinaSource } from "./enums.js";
import { NinaApiError, NinaNotFoundError, NinaParseError, NinaValidationError } from "./errors.js";
import { arsProblem } from "./ars.js";
import { assertValid, identifierProblem, normalizeIdentifier, sourceProblem } from "./validate.js";
import type {
  MapWarning,
  WarningDetail,
  DashboardEntry,
  ArchiveMapping,
  Notfalltipps,
  EventCodes,
  DataVersion,
} from "./types.js";

const API = "/api31";
const ACCEPT_GEOJSON = "application/geo+json";
const enc = encodeURIComponent;

/** A JSON object: not null, not an array. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What a value is, for a shape error: its JSON type, and the `message` an error object
 * carries (control characters dropped, cut at 200 characters).
 */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (isObject(value)) {
    if (Object.keys(value).length === 0) return "an empty object";
    const message = typeof value["message"] === "string" ? value["message"] : typeof value["error"] === "string" ? value["error"] : undefined;
    if (message === undefined) return "an object";
    const clean = message.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 200);
    return `an object with the message ${JSON.stringify(clean)}`;
  }
  return `a ${typeof value}`;
}

/**
 * Check a 2xx body against the shape the endpoint documents and return it; anything else
 * throws a `NinaParseError` (exit 1 in the CLI), never data. A gateway or CDN answering
 * HTTP 200 with `null`, `{}` or an error object would otherwise pass as success: for a
 * list, `jq 'length'` reads `null` and `{}` as 0 — a false all-clear.
 */
function expectShape<T>(path: string, value: unknown, problem: (value: unknown) => string | undefined): T {
  const reason = problem(value);
  if (reason !== undefined) {
    throw new NinaParseError(`Unexpected response from ${path}: expected ${reason}, got ${describeValue(value)}.`);
  }
  return value as T;
}

/** A list of warnings (`mapData`, `dashboard`): an array of objects; `[]` means none. */
const warningList = (value: unknown): string | undefined =>
  Array.isArray(value) && value.every(isObject) ? undefined : "a JSON array of warning objects";

/** One CAP warning (live or archived): an object with a string `identifier`. */
const capWarning = (value: unknown): string | undefined =>
  isObject(value) && typeof value["identifier"] === "string" ? undefined : "a warning object with an identifier";

/** An archive revision history: an object with a `history` array. */
const archiveMapping = (value: unknown): string | undefined =>
  isObject(value) && Array.isArray(value["history"]) ? undefined : "an object with a history array";

/** A reference file: a JSON object or array, not null or a scalar. */
const referenceData = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null ? undefined : "a JSON object";

/** The `type` values of a GeoJSON object (RFC 7946). */
const GEOJSON_TYPES = [
  "FeatureCollection",
  "Feature",
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
];

/**
 * Check that a GeoJSON download is GeoJSON: UTF-8 JSON (RFC 7946) for an object with a
 * GeoJSON `type`. A gateway's HTML page or a JSON error body answered with HTTP 200 used
 * to be saved as the `.geojson` file with exit 0. The bytes themselves are returned
 * unchanged.
 */
function expectGeoJson(path: string, response: RawResponse): RawResponse {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(response.data));
  } catch {
    const type = response.contentType.split(";")[0]?.trim() || "no Content-Type";
    throw new NinaParseError(`Unexpected response from ${path}: expected GeoJSON, got a body that is not JSON (${type.slice(0, 100)}).`);
  }
  expectShape(path, value, (v) =>
    isObject(v) && typeof v["type"] === "string" && GEOJSON_TYPES.includes(v["type"]) ? undefined : "a GeoJSON object",
  );
  return response;
}

/**
 * NINA answers a warning id that is not live (expired, updated, cancelled, or
 * never issued) with a redirect to `/api31/archive/alerts/<id>`, not a 404. Turn
 * exactly that redirect into a `NinaNotFoundError`; any other error passes through.
 */
function notLive(identifier: string, err: unknown): unknown {
  if (!(err instanceof NinaApiError) || err.status < 300 || err.status >= 400) return err;
  let path = "";
  try {
    path = new URL(err.location ?? "").pathname;
  } catch {
    return err;
  }
  if (!path.includes("/archive/alerts/")) return err;
  return new NinaNotFoundError(identifier, err.location, { cause: err });
}

/** Single-warning retrieval (full payload + geometry). */
class WarningsResource {
  constructor(private readonly engine: RequestEngine) {}

  /**
   * The full CAP-derived warning for an identifier. The identifier is normalised first
   * (`normalizeIdentifier`: surrounding whitespace, invisible characters and quotes, and a
   * `.json`/`.geojson` suffix are dropped), so a copied id with such an artefact still
   * finds a live warning. A blank identifier, or one with a path separator, whitespace or
   * an invisible character inside, rejects with `NinaValidationError` before any request
   * (see `identifierProblem`); an id that is not a live warning's rejects with
   * `NinaNotFoundError`.
   */
  async get(identifier: string): Promise<WarningDetail> {
    const id = assertValid("identifier", normalizeIdentifier(identifier), identifierProblem);
    try {
      const path = `${API}/warnings/${enc(id)}.json`;
      return expectShape(path, await this.engine.getJson(path), capWarning);
    } catch (err) {
      throw notLive(id, err);
    }
  }

  /**
   * The warning's geometry as GeoJSON (returned as raw bytes). The identifier is
   * normalised and checked as for `get`; an id that is not a live warning's rejects with
   * `NinaNotFoundError`. A 2xx body that is not GeoJSON (an HTML page, a JSON error
   * object) rejects with `NinaParseError` rather than being returned as the file.
   */
  async geojson(identifier: string): Promise<RawResponse> {
    const id = assertValid("identifier", normalizeIdentifier(identifier), identifierProblem);
    try {
      const path = `${API}/warnings/${enc(id)}.geojson`;
      return expectGeoJson(path, await this.engine.getRaw(path, ACCEPT_GEOJSON));
    } catch (err) {
      throw notLive(id, err);
    }
  }
}

/** The MoWaS archive (historical warnings + their revision history). */
class ArchiveResource {
  constructor(private readonly engine: RequestEngine) {}

  /**
   * Revision history for an archived MoWaS identifier, normalised and checked as for
   * `warnings.get`.
   */
  async mapping(identifier: string): Promise<ArchiveMapping> {
    const id = assertValid("identifier", normalizeIdentifier(identifier), identifierProblem);
    const path = `${API}/archive.mowas/${enc(id)}-mapping.json`;
    return expectShape(path, await this.engine.getJson(path), archiveMapping);
  }

  /**
   * A specific archived MoWaS warning (same shape as a live warning). Takes a
   * revision identifier as `mapping()` lists it: its trailing `.json` is optional
   * (the path adds one, so it is dropped rather than doubled). Normalised and checked
   * as for `warnings.get` (a blank identifier, also once the suffix is dropped, rejects).
   */
  async get(identifier: string): Promise<WarningDetail> {
    const id = assertValid("identifier", normalizeIdentifier(identifier), identifierProblem);
    const path = `${API}/archive.mowas/${enc(id)}.json`;
    return expectShape(path, await this.engine.getJson(path), capWarning);
  }
}

/** Static reference data published alongside the warnings. */
class ReferenceResource {
  constructor(private readonly engine: RequestEngine) {}

  /** Emergency-preparedness tips (Notfalltipps), German. */
  async notfalltipps(): Promise<Notfalltipps> {
    const path = `${API}/appdata/gsb/notfalltipps/DE/notfalltipps.json`;
    return expectShape(path, await this.engine.getJson(path), referenceData);
  }

  /** The CAP event-code catalogue (maps event keys to icons/labels). */
  async eventCodes(): Promise<EventCodes> {
    const path = `${API}/appdata/gsb/eventCodes/eventCodes.json`;
    return expectShape(path, await this.engine.getJson(path), referenceData);
  }

  /**
   * Version/hash of NINA's `labels` data (its only entry). It does not change
   * when warnings change, so it is no warnings change signal.
   */
  async dataVersion(): Promise<DataVersion> {
    const path = `${API}/dynamic/version/dataVersion.json`;
    return expectShape(path, await this.engine.getJson(path), referenceData);
  }
}

export class NinaClient {
  private readonly engine: RequestEngine;

  readonly warnings: WarningsResource;
  readonly archive: ArchiveResource;
  readonly reference: ReferenceResource;

  constructor(options: EngineOptions = {}) {
    this.engine = new RequestEngine(options);
    this.warnings = new WarningsResource(this.engine);
    this.archive = new ArchiveResource(this.engine);
    this.reference = new ReferenceResource(this.engine);
  }

  /**
   * Current warnings from one source, e.g. `mapData("dwd")`; `[]` when there are none.
   * A 2xx body that is not an array of objects (`null`, `{}`, an error object) rejects
   * with `NinaParseError`, never as an empty list. A value outside
   * `NinaSourceValues` (possible from plain JavaScript or a cast) is rejected with a
   * `NinaValidationError` before any request (see `sourceProblem`).
   */
  async mapData(source: NinaSource): Promise<MapWarning[]> {
    const problem = sourceProblem(source);
    if (problem !== undefined) throw new NinaValidationError(problem);
    const path = `${API}/${enc(source)}/mapData.json`;
    return expectShape(path, await this.engine.getJson(path), warningList);
  }

  /**
   * Warnings affecting a district, keyed by its district-level Amtlicher
   * Regionalschlüssel; `[]` when there are none. A 2xx body that is not an array of
   * objects (`null`, `{}`, an error object) rejects with `NinaParseError`, never as an
   * empty list (a false all-clear). The key is the district-level ARS: 12 digits, the last seven `0`. Any other shape (an 8-digit
   * AGS, a municipality-level ARS, a lost leading zero) and a state-level key
   * (digits 3-5 `000`, other than Hamburg's and Berlin's, which the API would answer
   * with `[]`, a false all-clear) are rejected with a `NinaValidationError` (whose
   * message is `arsProblem`'s) before any request.
   */
  async dashboard(ars: string): Promise<DashboardEntry[]> {
    const problem = arsProblem(ars);
    if (problem !== undefined) throw new NinaValidationError(problem);
    const path = `${API}/dashboard/${enc(ars)}.json`;
    return expectShape(path, await this.engine.getJson(path), warningList);
  }
}
