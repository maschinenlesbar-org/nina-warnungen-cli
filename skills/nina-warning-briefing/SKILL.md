---
name: nina-warning-briefing
description: >
  Produce a live civil-protection warning briefing for Germany using the
  nina-warnungen-cli. Trigger when the user asks "any warnings right now?",
  "what's the BBK / NINA warning situation?", "current severe-weather warnings",
  "are there any disasters/alerts in Germany?", "is there a flood/storm/fire
  warning?", or wants a cross-source alert summary. Merges warnings across MoWaS,
  KATWARN, BIWAPP, DWD, flood and police, drops cancellations and expired noise,
  and ranks by severity — instead of six separate raw feeds.
version: 1.0.0
userInvocable: true
---

# NINA Warning Briefing

Give the user one ranked briefing of what civil-protection authorities are warning
about **right now** — merging the six independent NINA sources, dropping all-clears
and expired entries, and leading with the most severe — instead of six raw JSON feeds.

## Tooling

This skill drives the `nina` command. **Before anything else, validate it is available** — run `command -v nina` (or `nina --version`). If it is not on your PATH, STOP and inform the user that the `nina` CLI (`@maschinenlesbar.org/nina-warnungen-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

All data comes from the `nina` CLI (the `@maschinenlesbar.org/nina-warnungen-cli`
package). It is read-only, needs **no API key**, and fetches **one source per call**.
The whole job of this skill is the cross-source merge and triage the CLI deliberately
doesn't do.

Always pass `--compact` so each result is one line, easy to pipe into `jq`. A source
with no active warnings prints `[]` and exits `0` — that is **not** an error, it means
"nothing from that source", which is a useful thing to report. Bump `--timeout 60000`
if a call times out; `--max-retries 5` for flaky networks (the API 429/503-throttles).

> **Shell trap.** This CLI's stdout pipe can come back empty when piped straight into
> another process under some Node builds. If `nina … | jq …` yields nothing, redirect to
> a file first (`nina --compact map-data dwd > out.json`) and read the file.

## Step 1 — Pick the sources

The valid sources come from `nina sources`: `mowas`, `katwarn`, `biwapp`, `dwd`, `lhp`,
`police`. Map the request:

- "weather / storm / rain / heat" → `dwd`; "flood / Hochwasser" → `lhp`;
  "police / incident" → `police`; general disaster/civil-protection → `mowas` (the
  Bund/Länder modular system) plus `katwarn` + `biwapp` (municipal).
- A broad "what's happening?" → query **all six** and merge.

## Step 2 — Pull each source

```bash
nina --compact map-data mowas > mowas.json
nina --compact map-data dwd   > dwd.json
# …one call per source, fan them out
```

Each returns an array of warning **summaries** (`MapWarning`). The fields that matter:

| Field | Meaning |
|---|---|
| `id` | The warning identifier (e.g. `mow.DE-…`, `dwd…`). Pass to `warning get`/`geojson`. |
| `severity` | `Minor` < `Moderate` < `Severe` < `Extreme`, plus `Unknown`. **Primary ranking key.** |
| `urgency` | `Immediate` / `Expected` / `Future` / `Past` — secondary ranking. |
| `type` | CAP **msgType**: `Alert` (new), `Update` (supersedes), **`Cancel` (all-clear / Entwarnung)**. |
| `startDate` | When it took effect (ISO, with offset). |
| `expiresDate` | When it expires — present on `dwd` and some others, **often absent on `mowas`**. |
| `i18nTitle` | Localised title map; **use `i18nTitle.de`** for the headline (also `.en` etc.). |
| `transKeys.event` | Event-code key (e.g. `BBK-EVC-010`); maps only to an icon, not a label — the title already carries the meaning. |

## Step 3 — Filter out the noise

Two filters, both important:

1. **Drop cancellations.** `type === "Cancel"` is an *Entwarnung* — the warning being
   withdrawn, not an active hazard. A `Cancel` headline literally reads `Entwarnung: …`.
   Never present these as live warnings; at most mention "N recently cleared".
2. **Drop expired.** If `expiresDate` is present and in the past relative to now, the
   warning is over — exclude it. Many `mowas` entries have **no** `expiresDate`; treat
   those as still active (don't guess an expiry).

A `Cancel` whose original is the only entry for an area means that area is now clear.

## Step 4 — Rank

Sort the surviving (active, non-cancelled) warnings, most serious first:

1. By `severity`: `Extreme` → `Severe` → `Moderate` → `Minor` → `Unknown`.
2. Within equal severity, `urgency === "Immediate"` outranks `Expected`/`Future`.
3. Then most recent `startDate` first.

De-duplicate where the same event appears via several sources (match on near-identical
`i18nTitle.de` + overlapping area) — MoWaS often mirrors DWD/police.

## Step 5 — Brief the user

Lead with a one-line verdict and counts, then enumerate only the warnings that matter.

```
Germany — ⚠ 1 Severe, 1 Moderate active (8 MoWaS / 0 KATWARN / 0 BIWAPP / 1 DWD / 0 flood / 0 police; 4 cancellations dropped)

 🔴 SEVERE   Brand mit Rauchwolke — Niestetal-Sandershausen (MoWaS)   started 19:20
 🟠 MODERATE Amtliche WARNUNG vor DAUERREGEN — Lkr. Rosenheim (DWD)    until 11.06 00:00
```

Rules:
- **Lead with the count line** showing each source's total and how many cancellations
  you dropped — that's the situational picture.
- **Enumerate only `Severe`/`Extreme`** in full; summarise `Minor`/`Moderate` as a count
  unless the user asked for everything or a source has only low-severity items.
- Use `i18nTitle.de` as the headline (offer `.en` if the user isn't German-speaking).
- Show the time window: `startDate` and, when present, `expiresDate`.
- An empty briefing is a valid, reassuring answer — "No active civil-protection warnings
  from any NINA source right now" — say it plainly when every source returned `[]`.
- For full detail on one warning (area descriptions, instructions, CAP fields), offer the
  follow-up `nina warning get <id>` — its `info[].instruction`, `info[].area[].areaDesc`,
  `info[].description` carry the actionable guidance. Don't dump the full CAP record
  unless asked.
- Don't invent severity the data doesn't support; `Unknown` severity means unknown.
