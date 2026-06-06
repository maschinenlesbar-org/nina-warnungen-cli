// Enum-like value sets. These const arrays double as runtime CLI choice
// validators and as TS union types.

/**
 * The warning "providers" NINA aggregates, each exposed at `/{source}/mapData.json`:
 *   mowas   — Modulares Warnsystem (Bund/Länder civil-protection alerts)
 *   katwarn — KATWARN municipal alerting
 *   biwapp  — BIWAPP municipal alerting
 *   dwd     — Deutscher Wetterdienst severe-weather warnings
 *   lhp     — Länderübergreifendes Hochwasser Portal (flood warnings)
 *   police  — police incident reports
 */
export const NinaSourceValues = ["mowas", "katwarn", "biwapp", "dwd", "lhp", "police"] as const;
export type NinaSource = (typeof NinaSourceValues)[number];

/** Severity levels used in CAP-derived warning payloads. */
export const SeverityValues = ["Minor", "Moderate", "Severe", "Extreme", "Unknown"] as const;
export type Severity = (typeof SeverityValues)[number];
