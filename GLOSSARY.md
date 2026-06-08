# Glossary

A reference for the domain concepts and project-specific terms used throughout
`nina-warnungen-cli`. The NINA domain is German civil protection; this glossary
gives the term used in the CLI/API alongside the original German where one
exists.

---

## NINA & the operator

**NINA — Notfall-Informations- und Nachrichten-App.** The German federal
emergency information and news app for the public. The same warning data that
powers the app is published through the open REST API this tool wraps.

**warnung.bund.de.** The public warning portal and the host of the open API
(base URL `https://warnung.bund.de`, path prefix `/api31`). No authentication or
API key is required; every endpoint is a read-only `GET`.

**BBK — Bundesamt für Bevölkerungsschutz und Katastrophenhilfe.** The Federal
Office of Civil Protection and Disaster Assistance, which operates NINA and the
warning infrastructure.

---

## Warning sources

NINA aggregates several independent warning "providers", each published as its
own `mapData.json` listing. The CLI exposes the valid set via `nina sources`,
and `nina map-data <source>` fetches the current warnings from one of them.

**Source (NinaSource).** One of the aggregated providers. The valid values are:

| Source | Meaning |
| --- | --- |
| `mowas` | **MoWaS — Modulares Warnsystem.** The Bund/Länder modular civil-protection alerting system. |
| `katwarn` | **KATWARN.** Municipal/regional alerting service. |
| `biwapp` | **BIWAPP — Bürger-Info- und Warn-App.** Municipal alerting service. |
| `dwd` | **DWD — Deutscher Wetterdienst.** Severe-weather warnings from the national meteorological service. |
| `lhp` | **LHP — Länderübergreifendes Hochwasser Portal.** Cross-state flood warnings. |
| `police` | Police incident reports. |

---

## Resources & endpoints

The CLI mirrors the API's resources. The endpoints the client surfaces:

**map-data (`/{source}/mapData.json`).** The current warnings from one source, as
a list of warning summaries (`MapWarning[]`). CLI: `nina map-data <source>`.

**warning get (`/warnings/{identifier}.json`).** The full, CAP-derived warning
payload for a single identifier. Deeply nested and standard-specific, so it is
returned as a faithful raw JSON object. CLI: `nina warning get <identifier>`.

**warning geojson (`/warnings/{identifier}.geojson`).** The warning's affected-area
geometry as GeoJSON (`application/geo+json`), returned as raw bytes. CLI:
`nina warning geojson <identifier>` (use `-o` to save to a file).

**dashboard (`/dashboard/{ARS}.json`).** All warnings currently affecting a
region, keyed by its regional key (see ARS/AGS below). CLI: `nina dashboard <ars>`.

**archive — MoWaS archive.** Historical MoWaS warnings and their revision
history:
- **mapping (`/archive.mowas/{identifier}-mapping.json`)** — the revision history
  (`ArchiveMapping`) for an archived identifier. CLI: `nina archive mapping <id>`.
- **get (`/archive.mowas/{identifier}.json`)** — a specific archived MoWaS
  warning, same shape as a live warning. CLI: `nina archive get <id>`.

**reference — static reference data** published alongside the warnings:
- **notfalltipps (`/appdata/gsb/notfalltipps/DE/notfalltipps.json`)** —
  **Notfalltipps**, the emergency-preparedness tips (German). CLI:
  `nina reference notfalltipps`.
- **event-codes (`/appdata/gsb/eventCodes/eventCodes.json`)** — the CAP
  event-code catalogue mapping event keys to icons/labels. CLI:
  `nina reference event-codes`.
- **data-version (`/dynamic/version/dataVersion.json`)** — the current data
  version/hash, useful for cheap change detection and polling. CLI:
  `nina reference data-version`.

---

## Identifiers & region keys

**identifier.** The opaque id of a single warning (e.g. a `mow.…` MoWaS id from a
`map-data` entry's `id`). Used as the path argument to `warning get`/`geojson` and
`archive mapping`/`get`. It is URL-encoded by the client before the request.

**ARS — Amtlicher Regionalschlüssel** ("official regional key"). The
12-digit key identifying a German administrative region (state → district →
municipality), used to address the `dashboard` endpoint
(e.g. `055150000000`).

**AGS — Amtlicher Gemeindeschlüssel** ("official municipality key"). The
shorter (8-digit) municipality key; the `dashboard` command accepts a regional
key in either form.

---

## Warning payload concepts (CAP)

NINA warnings are derived from **CAP — the Common Alerting Protocol**, the OASIS
standard for exchanging emergency alerts. The fields below appear on the typed
warning summary (`MapWarning`) or in the full payload.

**id / version.** The warning's identifier and its monotonically increasing
revision number.

**startDate / expiresDate.** When the warning takes effect and (for sources that
carry it) when it expires.

**type (msgType).** The CAP message type of an entry — `Alert` (new), `Update`
(supersedes a prior message) or `Cancel` (withdraws it).

**Severity.** The CAP severity level of a warning. The value set surfaced by the
client is `Minor`, `Moderate`, `Severe`, `Extreme`, `Unknown` (in increasing
order of severity, plus the catch-all `Unknown`).

**i18nTitle / I18nText.** A localised title map keyed by language code, e.g.
`{ "de": "Hochwasser" }`.

**transKeys / event.** Translation keys carried on a summary; `event` references
an entry in the event-code catalogue (see `reference event-codes`).

**headline / sent.** On archive history (`ArchiveMappingEntry`) and dashboard
(`DashboardEntry`) records: the human-readable headline and the time the message
was sent.

---

## API behaviour

**No authentication.** Every endpoint is an open, read-only `GET`; the client
never sends credentials.

**GeoJSON downloads.** `warning geojson` requests `application/geo+json` and
returns raw bytes (`RawResponse`) rather than parsing them, so the geometry is
delivered byte-for-byte.

**Rate limiting / transient errors.** The API may return **429** (too many
requests) or **503** (temporarily unavailable); the client treats both as
retryable and retries with linear backoff (`--max-retries`).

**No redirect following.** The transport issues exactly one request and does not
follow `3xx` redirects — a redirect is surfaced as an error like any other
non-2xx status, avoiding header replay to a redirect target.

---

## Project / technical terms

**API client.** [`NinaClient`](src/client/client.ts) — the typed,
resource-grouped wrapper over the API (`client.mapData`, `client.dashboard`,
`client.warnings`, `client.archive`, `client.reference`). Usable as a library
independently of the CLI.

**Resource group.** A cohesive set of client methods for one part of the API
(`client.warnings`, `client.archive`, `client.reference`), and the matching CLI
command group.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](src/client/http.ts)). The default uses Node's built-in
`http`/`https`; tests inject a mock. This is the only HTTP seam.

**Request engine.** [`RequestEngine`](src/client/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, decodes JSON/raw responses and maps
errors. Sits between the client's resource methods and the transport.

**RawResponse.** The result of a download method: `{ data: Buffer, contentType,
status }` — raw bytes, never lossily decoded.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object. Lets the whole
CLI run in tests with a mocked client and captured output — no subprocess.

**Error types.** [`errors.ts`](src/client/errors.ts): `NinaApiError` (non-2xx,
carries `status`/`detail`/`isRetryable`), `NinaNetworkError` (transport
failure/timeout), `NinaParseError` (bad JSON) and `NinaIOError` (local write
failure), all extending `NinaError`. The CLI maps a `404` to exit code `4`,
other errors to `1`.
