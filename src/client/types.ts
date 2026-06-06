// Domain types for the NINA API (warnung.bund.de).
//
// The map-data listings have a stable, well-documented summary shape, typed
// precisely below. Full single-warning payloads are CAP-derived and deeply
// nested, so they are returned as faithful raw `JsonObject`s.

import type { Severity } from "./enums.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** A localised title map, e.g. `{ "de": "Hochwasser" }`. */
export type I18nText = { [languageCode: string]: string };

/** One entry of a `/{source}/mapData.json` listing — a warning summary. */
export interface MapWarning {
  id: string;
  version: number;
  startDate: string;
  /** Some sources also carry an expiry. */
  expiresDate?: string;
  severity: Severity | string;
  /** CAP message type, e.g. "Alert", "Update", "Cancel". */
  type?: string;
  i18nTitle: I18nText;
  transKeys?: { event?: string };
}

/** One entry of a `/dashboard/{ARS}.json` listing. */
export interface DashboardEntry {
  id: string;
  payload: JsonObject;
  i18nTitle?: I18nText;
  sent?: string;
}

/** One entry of an archive `…-mapping.json` history list. */
export interface ArchiveMappingEntry {
  identifier: string;
  msgType?: string;
  sent?: string;
  headline?: string;
}

export interface ArchiveMapping {
  history: ArchiveMappingEntry[];
}

// Full single-warning and reference payloads — kept as raw JSON objects.
export type WarningDetail = JsonObject;
export type Notfalltipps = JsonObject;
export type EventCodes = JsonObject;
export type DataVersion = JsonObject;
