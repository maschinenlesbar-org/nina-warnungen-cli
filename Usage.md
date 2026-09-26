# Usage

Real, use-case-driven examples for the `nina` CLI — a command-line client for the
open NINA civil-protection warning API (`warnung.bund.de`), the BBK's federal
alerting system aggregating MoWaS, KATWARN, BIWAPP, DWD severe weather, flood (LHP)
and police warnings.

## Install

```bash
npm i -g @maschinenlesbar.org/nina-warnungen-cli
```

This installs a single bin named **`nina`**. (Without a global install you can run
the same commands via `node dist/src/cli/index.js …`.)

All read commands print pretty JSON to stdout, so they pipe cleanly into
[`jq`](https://stedolan.github.io/jq/). The API needs no key and is read-only.

## Use cases

### 1. See what warning sources exist

Before querying, confirm the exact source identifiers the API accepts.

```bash
nina sources
```

Prints the valid source list (`mowas`, `katwarn`, `biwapp`, `dwd`, `lhp`,
`police`) — the values you pass to `map-data`.

### 2. Current severe-weather warnings from the DWD

The single most common check: is the national weather service warning about
anything right now?

```bash
nina map-data dwd
```

Returns the array of current warnings for that source. Pipe to `jq` to pull just
the headlines and severities:

```bash
nina map-data dwd | jq '.[] | {id, severity: .severity, headline: .i18nTitle.de}'
```

### 3. Surface only the most serious alerts across a source

During an event you often only care about `Severe`/`Extreme` warnings, filtering
out `Minor`/`Moderate` noise.

```bash
nina map-data mowas | jq '[.[] | select(.severity == "Severe" or .severity == "Extreme")]'
```

`map-data` works the same for any source — swap `mowas` for `katwarn`, `biwapp`,
`lhp` or `police`.

### 4. Pull the full CAP detail for one warning

Once you have an `id` from a `map-data` entry, fetch the complete CAP payload
(area descriptions, instructions, effective/expires times, web links).

```bash
nina warning get mow.DE-SL-SLS-W038-20260113-000
```

Prints the full warning object. The identifier comes straight from a `map-data`
entry's `id` field.

### 5. Save a warning's geometry as GeoJSON for mapping

To draw the affected area on a map (Leaflet, QGIS, etc.), download the raw
geometry instead of the metadata.

```bash
nina warning geojson mow.DE-SL-SLS-W038-20260113-000 -o warn.geojson
```

`geojson` writes the raw bytes — use `-o/--output <file>` to save them, or omit it
to stream the GeoJSON to stdout (e.g. for piping into another tool).

### 6. Region dashboard: everything affecting a district

For a regional operations view, list all warnings currently affecting one district
by its Amtlicher Regionalschlüssel (ARS). The API only accepts district-level keys:
12 digits with the last seven set to `0`. An 8-digit Gemeindeschlüssel (AGS) gets
HTTP 400 and a municipality-level ARS HTTP 404 — take the first five digits and
append `0000000`. A **state-level** key (digits 3–5 `000`, e.g. `050000000000` for NRW, or
`000000000000`) is refused before any request: the API answers it with `[]` even while a
district in that state has warnings, which would read as an all-clear. Hamburg
(`020000000000`) and Berlin (`110000000000`) are their own district and are accepted.

```bash
nina dashboard 055150000000
```

`055150000000` is the regional key for Münster (a kreisfreie Stadt). The
result aggregates warnings from every source for that area; combine with `jq` to
count or group them:

```bash
nina dashboard 055150000000 | jq 'length'
```

### 7. Inspect the history of an archived MoWaS warning

For after-action review, look at how a past MoWaS warning was revised over time,
then fetch a specific archived revision.

```bash
nina archive mapping mow.DE-SL-SLS-W038-20260113-000
nina archive get     mow.DE-SL-SLS-W038-20250814-000_20250814172229
```

`archive mapping` returns the revision history — a `history` array whose entries
each carry an `identifier` for one archived revision (the `…_<timestamp>` form).
Pass one of those revision identifiers (without the `.json` suffix) to
`archive get` to fetch that specific archived warning.

### 8. Watching a district for changes

To keep an eye on one district, re-run its dashboard a few minutes apart and compare
the results: new `id`s are new warnings, missing ones have been cleared, and a changed
`payload.hash` for the same `id` marks an updated entry.

```bash
nina --compact dashboard 055150000000 > dash.json
```

`reference data-version` is not a shortcut for this. Its only entry is `labels`, and it
does not change when warnings change (checked on 2026-09-15: its file was last modified
on 12 September, while the warning feeds had changed that day):

```bash
nina --compact reference data-version
```

The other reference datasets are also static:

```bash
nina reference notfalltipps   # emergency-preparedness tips (German)
nina reference event-codes    # the CAP event-code catalogue
```

### 9. Query a non-default host or tune timeouts/retries

For testing against a mirror, or for flaky-network resilience, override the base
URL and transport behaviour.

```bash
nina --base-url https://warnung.bund.de --timeout 15000 --max-retries 3 map-data dwd
```

Global options may be placed before or after the command, so
`nina --compact map-data dwd` and `nina map-data dwd --compact` are equivalent.

## Global options

These flags apply to every command (real flags only):

| Option | Description |
| --- | --- |
| `-V, --version` | Output the version number |
| `--base-url <url>` | API base URL (default `https://warnung.bund.de`) |
| `--timeout <ms>` | Per-request timeout in ms (`0` disables; waits indefinitely) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`, max `10` — higher is rejected). Each retry waits the server's `Retry-After` (seconds or an HTTP date); a `Retry-After` above 30 s is not retried, the error is reported at once. Without one, the wait grows linearly (200 ms, 400 ms, …) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `-o, --output <file>` | Write the command's output to a file instead of stdout (JSON commands and downloads alike). An existing file at that path is **overwritten silently** — there is no prompt or `--force`, so point `-o` at a fresh path or one you intend to replace |
| `-h, --help` | Display help for a command |

Notes: numeric options accept only plain non-negative decimal integers. An
identifier that starts with `-` must be passed after a `--` separator, e.g.
`nina warning get -- -odd.identifier`. Exit codes: `0` success, `4` on a `404`
from the API or for a warning id that is no longer live (the API redirects it to its archive
instead of answering `404`), `1` for any other error, non-zero for usage errors.
