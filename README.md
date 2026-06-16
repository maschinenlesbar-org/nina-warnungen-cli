# nina-warnungen-cli

[![CI](https://github.com/maschinenlesbar-org/nina-warnungen-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/nina-warnungen-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/nina-warnungen-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/nina-warnungen-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/nina-warnungen-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/nina-warnungen-cli)

Query Germany's **federal civil-protection warning system** from your terminal.
`nina` is a command-line tool over the open
[NINA API](https://nina.api.bund.dev/) (`warnung.bund.de`): fetch current
warnings by source, look up the full detail or geometry of any alert, check a
region by its official key, and browse the MoWaS archive — as clean JSON you
can pipe straight into [`jq`](https://jqlang.github.io/jq/).

- **Works out of the box** — no account, no API key, no configuration. Install and query.
- **All sources in one tool** — MoWaS, KATWARN, BIWAPP, DWD severe-weather, flood (LHP) and police.
- **Clean JSON output** — pretty-printed by default, `--compact` for one-line/scripting.
- **GeoJSON support** — download a warning's affected-area geometry directly to a file.
- **Cheap polling** — a lightweight data-version endpoint tells you whether anything changed without pulling full feeds.

> Want to use this as a TypeScript library or understand how it's built?
> See **[DEVELOPING.md](DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/nina-warnungen-cli
```

This installs the **`nina`** command. Requires **Node.js 20+**.

Check it works:

```bash
nina --help
```

## Quickstart

No setup needed — the API is open and read-only. Your first query:

```bash
nina map-data dwd
```

Returns the current severe-weather warnings from the DWD (Deutscher
Wetterdienst). Pull out just the headlines and severity levels with `jq`:

```bash
nina map-data dwd | jq '.[] | {id, severity: .severity, headline: .i18nTitle.de}'
```

Take a warning `id` from those results and fetch its full CAP record:

```bash
nina warning get mow.DE-BY-A-W083-20240101
```

## Commands

```text
sources                                list the valid warning sources
map-data <source>                      current warnings from a source
                                       (mowas | katwarn | biwapp | dwd | lhp | police)
warning  get <id>                      full CAP warning by identifier
warning  geojson <id>                  warning geometry as GeoJSON (-o to save)
dashboard <ars>                        warnings for a region (ARS/AGS key)
archive  mapping <id>                  MoWaS revision history for an identifier
archive  get <id>                      a specific archived MoWaS warning
reference notfalltipps                 emergency-preparedness tips (German)
reference event-codes                  CAP event-code catalogue
reference data-version                 current data-version hash (for polling)
```

### `map-data` sources

| Value | Warning type |
| --- | --- |
| `mowas` | MoWaS — modular civil-protection alerts |
| `katwarn` | KATWARN — municipal/regional alerts |
| `biwapp` | BIWAPP — municipal alerts |
| `dwd` | DWD — severe-weather (national met service) |
| `lhp` | LHP — cross-state flood warnings |
| `police` | Police incident reports |

The canonical list is always available at runtime via `nina sources`.

## Common tasks

A few recipes to get going — see **[Usage.md](Usage.md)** for the full,
use-case-driven set.

```bash
# Current flood warnings
nina map-data lhp

# Filter to only Severe or Extreme warnings across a source
nina map-data mowas | jq '[.[] | select(.severity == "Severe" or .severity == "Extreme")]'

# Full detail for one warning (id from a map-data entry)
nina warning get mow.DE-SL-SLS-W038-20260113-000

# Save the affected-area geometry as a GeoJSON file
nina warning geojson mow.DE-SL-SLS-W038-20260113-000 -o warn.geojson

# All warnings currently affecting a district (regional key ARS/AGS)
nina dashboard 055150000000

# Cheap polling — only fetch full feeds when the version hash changes
nina --compact reference data-version
```

## Output & scripting

Every command prints **pretty JSON to stdout**. Errors and diagnostics go to
stderr, so piping stdout into `jq` stays clean.

```bash
# Count warnings for a region
nina dashboard 055150000000 | jq 'length'

# Extract severity + headline from all DWD entries
nina map-data dwd | jq '.[] | {severity, title: .i18nTitle.de}'
```

Use `--compact` for single-line JSON in pipelines and logs:

```bash
nina --compact map-data dwd | jq -c '.[]'
```

`--compact` (and every global option) works **before or after** the command —
both `nina --compact map-data dwd` and `nina map-data dwd --compact` do the same
thing.

An identifier that begins with `-` would be parsed as an option; pass it after a
`--` separator: `nina warning get -- -odd.identifier`.

**Exit codes** make the CLI easy to use in scripts:

| Code | Meaning |
| --- | --- |
| `0` | success (also `--help` / `--version`) |
| `1` | error — network failure, parse error, unexpected problem |
| `4` | warning not found (`404`) |
| non-zero | bad usage / invalid argument (commander parse error) |

## Troubleshooting

- **`command not found: nina`** — the global npm bin directory isn't on your
  `PATH`. Run `npm bin -g` to find it and add it, or run via
  `npx @maschinenlesbar.org/nina-warnungen-cli …`.
- **Exit `4` / "not found"** — the warning identifier doesn't exist or has
  expired. Re-fetch it from a fresh `map-data` or `dashboard` result; identifiers
  change as warnings are issued and cancelled.
- **Exit `1` / network error** — connectivity, DNS, or a timeout. Try again, or
  raise the limit with `--timeout 60000`. For flaky networks increase retries:
  `--max-retries 5`.
- **Empty result from `map-data`** — the source has no active warnings right now.
  Try a different source or come back later.
- **`warning geojson` prints non-JSON content-type warning** — the API returned
  an unexpected content-type (e.g. a gateway error page). The bytes are still
  written, but check whether the identifier is valid.

## Global options

These apply to every command and may be given before *or* after it:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `-o, --output <file>` | For downloads: write bytes to a file instead of stdout |
| `--base-url <url>` | API base URL (default `https://warnung.bund.de`) |
| `--timeout <ms>` | Per-request timeout (default `30000`; `0` waits indefinitely) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`, capped at `10`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

Numeric options accept only plain non-negative decimal integers — values like
`5.0`, `0x10`, `1e3`, or `-1` are rejected as usage errors.

## Learn more

- **[SKILLS.md](SKILLS.md)** — Claude Code Agent Skills that drive this CLI for live warning briefings, region watches and GeoJSON maps.
- **[Usage.md](Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](GLOSSARY.md)** — every command, source, domain term and exit code explained.
- **[DEVELOPING.md](DEVELOPING.md)** — TypeScript library usage, architecture, testing, CI.

## Data license

This CLI is a **client** — it accesses data it does not own or redistribute. The
upstream data is © its provider and licensed **separately from this tool's code**.
See **[DATA_LICENSE.md](DATA_LICENSE.md)**.

> **BBK** — official federal warnings are amtliche Werke (§ 5 Abs. 2 UrhG): may be
> redistributed **unaltered** with a source credit. Aggregates third-party sources
> (DWD, Länder flood portals) that carry their own terms.

## License

**Dual-licensed** — use it under **either**:

- **[AGPL-3.0-or-later](LICENSE)** (default, free). Note the AGPL's §13 network
  clause: if you run a modified version as a network service, you must offer that
  modified source to the service's users.
- **Commercial license** (paid), for closed-source / proprietary or SaaS use
  without the AGPL's obligations.

See **[LICENSING.md](LICENSING.md)** for details, and **[CONTRIBUTING.md](CONTRIBUTING.md)**
for the contribution policy (this project does not accept external code
contributions). Commercial enquiries: **sebs@2xs.org**.
