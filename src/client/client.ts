// NinaClient — a typed client over the open (no-auth) endpoints of the NINA API
// (https://warnung.bund.de/api31), the federal civil-protection warning system
// run by the BBK (Bundesamt für Bevölkerungsschutz und Katastrophenhilfe).
//
//   client.mapData("mowas")        // current alerts from a source
//   client.warnings.get(id)        // full CAP warning
//   client.dashboard(ars)          // alerts for a region (Amtlicher Regionalschlüssel)

import { RequestEngine, type EngineOptions, type RawResponse } from "./engine.js";
import type { NinaSource } from "./enums.js";
import { NinaApiError, NinaNotFoundError } from "./errors.js";
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
   * The full CAP-derived warning for an identifier. A warning that is no longer
   * live (or never existed) rejects with `NinaNotFoundError`.
   */
  async get(identifier: string): Promise<WarningDetail> {
    try {
      return await this.engine.getJson(`${API}/warnings/${enc(identifier)}.json`);
    } catch (err) {
      throw notLive(identifier, err);
    }
  }

  /**
   * The warning's geometry as GeoJSON (returned as raw bytes). A warning that is no
   * longer live (or never existed) rejects with `NinaNotFoundError`.
   */
  async geojson(identifier: string): Promise<RawResponse> {
    try {
      return await this.engine.getRaw(`${API}/warnings/${enc(identifier)}.geojson`, ACCEPT_GEOJSON);
    } catch (err) {
      throw notLive(identifier, err);
    }
  }
}

/** The MoWaS archive (historical warnings + their revision history). */
class ArchiveResource {
  constructor(private readonly engine: RequestEngine) {}

  /** Revision history for an archived MoWaS identifier. */
  mapping(identifier: string): Promise<ArchiveMapping> {
    return this.engine.getJson(`${API}/archive.mowas/${enc(identifier)}-mapping.json`);
  }

  /** A specific archived MoWaS warning (same shape as a live warning). */
  get(identifier: string): Promise<WarningDetail> {
    return this.engine.getJson(`${API}/archive.mowas/${enc(identifier)}.json`);
  }
}

/** Static reference data published alongside the warnings. */
class ReferenceResource {
  constructor(private readonly engine: RequestEngine) {}

  /** Emergency-preparedness tips (Notfalltipps), German. */
  notfalltipps(): Promise<Notfalltipps> {
    return this.engine.getJson(`${API}/appdata/gsb/notfalltipps/DE/notfalltipps.json`);
  }

  /** The CAP event-code catalogue (maps event keys to icons/labels). */
  eventCodes(): Promise<EventCodes> {
    return this.engine.getJson(`${API}/appdata/gsb/eventCodes/eventCodes.json`);
  }

  /**
   * Version/hash of NINA's `labels` data (its only entry). It does not change
   * when warnings change, so it is no warnings change signal.
   */
  dataVersion(): Promise<DataVersion> {
    return this.engine.getJson(`${API}/dynamic/version/dataVersion.json`);
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

  /** Current warnings from one source, e.g. `mapData("dwd")`. */
  mapData(source: NinaSource): Promise<MapWarning[]> {
    return this.engine.getJson(`${API}/${source}/mapData.json`);
  }

  /**
   * Warnings affecting a district, keyed by its district-level Amtlicher
   * Regionalschlüssel: 12 digits, the last seven `0` (an 8-digit AGS gets HTTP 400,
   * a municipality-level ARS HTTP 404).
   */
  dashboard(ars: string): Promise<DashboardEntry[]> {
    return this.engine.getJson(`${API}/dashboard/${enc(ars)}.json`);
  }
}
