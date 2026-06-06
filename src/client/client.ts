// NinaClient — a typed client over the open (no-auth) endpoints of the NINA API
// (https://warnung.bund.de/api31), the federal civil-protection warning system
// run by the BBK (Bundesamt für Bevölkerungsschutz und Katastrophenhilfe).
//
//   client.mapData("mowas")        // current alerts from a source
//   client.warnings.get(id)        // full CAP warning
//   client.dashboard(ars)          // alerts for a region (Amtlicher Regionalschlüssel)

import { RequestEngine, type EngineOptions, type RawResponse } from "./engine.js";
import type { NinaSource } from "./enums.js";
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

/** Single-warning retrieval (full payload + geometry). */
class WarningsResource {
  constructor(private readonly engine: RequestEngine) {}

  /** The full CAP-derived warning for an identifier. */
  get(identifier: string): Promise<WarningDetail> {
    return this.engine.getJson(`${API}/warnings/${enc(identifier)}.json`);
  }

  /** The warning's geometry as GeoJSON (returned as raw bytes). */
  geojson(identifier: string): Promise<RawResponse> {
    return this.engine.getRaw(`${API}/warnings/${enc(identifier)}.geojson`, ACCEPT_GEOJSON);
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

  /** Current data version/hash (useful for change detection / polling). */
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

  /** Warnings affecting a region, keyed by Amtlicher Regionalschlüssel (ARS/AGS). */
  dashboard(ars: string): Promise<DashboardEntry[]> {
    return this.engine.getJson(`${API}/dashboard/${enc(ars)}.json`);
  }
}
