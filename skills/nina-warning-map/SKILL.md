---
name: nina-warning-map
description: >
  Export a NINA civil-protection warning's affected area as GeoJSON for mapping,
  using the nina-warnungen-cli. Trigger when the user asks to "map this warning",
  "show the affected area on a map", "export the warning area as GeoJSON", "what
  area does this alert cover?", or wants the warning geometry for Leaflet /
  geojson.io / QGIS. Resolves a warning (by id, or by finding one first), pulls
  its geometry, and hands back a ready-to-open FeatureCollection.
version: 1.0.0
userInvocable: true
---

# NINA Warning → GeoJSON Map

Turn a single civil-protection warning into a **valid GeoJSON `FeatureCollection`** of its
affected area, ready for geojson.io, Leaflet, or QGIS.

## Tooling

This skill drives the `nina` command. **Before anything else, validate it is available** — run `command -v nina` (or `nina --version`). If it is not on your PATH, STOP and inform the user that the `nina` CLI (`@maschinenlesbar.org/nina-warnungen-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

## Step 1 — Get a warning identifier

`warning geojson` needs a warning `id`. If the user already has one (a `mow.…`, `dwd…`,
etc.), use it. Otherwise find one first via the briefing/region flow:

```bash
nina --compact map-data dwd > feed.json        # or map-data <source> / dashboard <ars>
```

and take the `id` of the warning they mean (match on `i18nTitle.de`).

> **404 / 302 trap.** A *valid, current* identifier resolves. A **stale or wrong**
> identifier doesn't 404 cleanly — the API often answers a non-existent warning with an
> HTTP `302` redirect, which the CLI surfaces as **exit 1** (generic error), while a true
> `404` is exit `4`. Either way it means "no such live warning" — re-fetch a fresh id from
> `map-data`/`dashboard` rather than retrying the same one. Identifiers churn as warnings
> are issued and cancelled.

## Step 2 — Download the geometry

The geojson subcommand writes **raw bytes** of the warning's geometry. Save it to a file
with `-o` (don't pipe — see the shell trap below):

```bash
nina warning geojson mow.DE-HE-KS-SE106-20260610-106-000 -o warn.geojson
```

`-o` is the global output flag; omit it to stream to stdout. **Prefer `-o`** — this CLI's
stdout pipe can come back empty when piped straight into another process under some Node
builds, and the geojson bytes are binary-faithful, so a file is the reliable path.

> If the CLI prints a "non-JSON content-type" diagnostic to stderr, the API returned an
> unexpected content-type (often a gateway/error page). The bytes are still written, but
> the identifier is probably bad — re-resolve it (Step 1).

## Step 3 — Validate and hand it over

The result is already a GeoJSON `FeatureCollection`; you don't have to rebuild it. As
observed live, a warning's geometry comes back as:

- `type: "FeatureCollection"` with one or more `features`;
- each feature's `geometry` is typically a `Polygon` (the affected area), in correct
  `[lon, lat]` order — **no coordinate fix-up needed** (unlike some other bund.dev APIs);
- feature `properties` carry NINA *rendering* hints, not metadata:
  `warnId`, `fillColor`, `fillOpacity`, `strokeColor`, `strokeOpacity`, `strokeWeight`,
  `zIndex`. The human-readable headline/severity are **not** in the GeoJSON — pull them
  from `nina warning get <id>` (`info[].headline`, `info[].severity`,
  `info[].area[].areaDesc`) if the user wants them as map labels.

Quick validity check before handing over: it parses as JSON, is a single
`FeatureCollection`, and `features[].geometry.coordinates` are numbers in `[lon, lat]`
order.

## Step 4 — Output

Report the saved path and feature/polygon count. If the `-o` name the user supplied already
exists, confirm before overwriting it (re-running with the default name to refresh is fine).
Offer to:
- open it at https://geojson.io (drag the file in), or
- enrich it: merge in `headline`/`severity` from `warning get` as feature properties so the
  map has readable labels (do this only if asked — the raw export is otherwise complete).

If the user wants several warnings on one map, fetch each `geojson`, then concatenate their
`features` arrays into a single `FeatureCollection` and report the combined count.
