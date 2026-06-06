# nina-warnungen-cli

A TypeScript **API client** and **command-line interface** for the open
[NINA API](https://nina.api.bund.dev/) (`warnung.bund.de`) — the federal
civil-protection warning system run by the **BBK** (Bundesamt für Bevölkerungsschutz
und Katastrophenhilfe). It aggregates **MoWaS**, **KATWARN**, **BIWAPP**,
**DWD severe-weather**, **flood (LHP)** and **police** alerts.

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed client surface, warning summaries and the source enum.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.
- **Read-only, no auth** — the NINA API needs no key; this client only reads.

## Requirements

- Node.js **>= 20** (uses the stable built-in test runner, ESM and top-level `await`).

## Install

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link` / global install:
nina --help
```

---

## CLI usage

Search/list commands print pretty JSON to stdout; `warning geojson` streams raw
GeoJSON bytes to stdout or to a file via `-o/--output`. If the server returns a
body whose `Content-Type` is not JSON (e.g. an HTML error page with a `200`
status), the CLI prints a warning to stderr before writing it, so a gateway error
page is not silently saved as `.geojson`.

### Global options

| Option | Description |
| --- | --- |
| `--base-url <url>` | API base URL (default `https://warnung.bund.de`) |
| `--timeout <ms>` | Per-request timeout (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line |
| `-o, --output <file>` | For downloads: write bytes to a file instead of stdout |

Global options go **before** the command, e.g. `nina --compact map-data dwd`.

Numeric options (`--timeout`, `--max-retries`, `--max-response-bytes`) accept only
plain non-negative decimal integers; values like `5.0`, `0x10`, `1e3`, `-1` or a
leading/trailing space are rejected as usage errors.

> **Note on `--base-url` + `--output`:** the base URL is trusted as given, so
> `nina --base-url <any-http(s)-host> -o <file> ...` is effectively a general
> "fetch this URL and write it to a file" tool. Only `http`/`https` are allowed
> (`file:`/`ftp:` are rejected) and redirects are **never followed**, but point it
> only at hosts you trust. Setting `--max-response-bytes 0` disables the in-memory
> response-size guard entirely (including the 100 MiB default).

### Commands

```text
sources                          list the valid warning sources
map-data <source>                current warnings from a source
                                 (mowas | katwarn | biwapp | dwd | lhp | police)
warning   get <id>               full CAP warning by identifier
warning   geojson <id>           warning geometry as GeoJSON (-o to save)
dashboard <ars>                  warnings for a region (Amtlicher Regionalschlüssel / AGS)
archive   mapping <id> | get <id>   MoWaS archive (history + a past warning)
reference notfalltipps | event-codes | data-version
```

### Examples

```bash
# Current severe-weather warnings from the DWD
nina map-data dwd

# A specific warning (identifier from a map-data entry's `id`)
nina warning get mow.DE-BY-A-W083-20240101

# Its geometry, saved to a file
nina -o warn.geojson warning geojson mow.DE-BY-A-W083-20240101

# All warnings affecting a district by its regional key
nina dashboard 055150000000

# Poll for changes cheaply
nina --compact reference data-version
```

Exit codes: `0` success, `4` on a `404` from the API, `1` for any other error, non-zero for usage errors.

---

## Library usage

```ts
import { NinaClient, NinaApiError, type NinaSource } from "nina-warnungen-cli";

const client = new NinaClient(); // defaults to https://warnung.bund.de

const alerts = await client.mapData("dwd");          // MapWarning[]
const full = await client.warnings.get(alerts[0]!.id);
const region = await client.dashboard("055150000000");

const geo = await client.warnings.geojson(alerts[0]!.id); // raw bytes
await import("node:fs/promises").then((fs) => fs.writeFile("warn.geojson", geo.data));

try {
  await client.warnings.get("DOES-NOT-EXIST");
} catch (err) {
  if (err instanceof NinaApiError) console.error(err.status, err.detail);
}
```

### Client options

```ts
new NinaClient({
  baseUrl: "https://warnung.bund.de",
  timeoutMs: 15_000,
  maxRetries: 3,              // 429 / 503 are retried with linear backoff
  maxResponseBytes: 50 << 20, // abort responses larger than 50 MiB (0 = unlimited)
  userAgent: "my-app/1.0",
  transport: customTransport, // inject your own HTTP transport
});
```

### Resource groups

`client.mapData(source)`, `client.dashboard(ars)`, `client.warnings` (`.get` / `.geojson`),
`client.archive` (`.mapping` / `.get`), `client.reference` (`.notfalltipps` / `.eventCodes` / `.dataVersion`).

---

## Architecture

```
src/
  client/
    enums.ts     # NinaSource + severity value sets (runtime + type)
    types.ts     # response interfaces (typed summaries; full warnings as JsonObject)
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, JSON/raw decoding, error mapping
    errors.ts    # NinaError / NinaApiError / NinaNetworkError / NinaParseError
    client.ts    # NinaClient — resource groups over the engine
  cli/
    io.ts        # injectable I/O seam (stdout/stderr/file)
    shared.ts    # option parsers, global-option resolver, JSON/raw renderers
    commands/    # warnings + archive/reference (misc) command groups
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
```

**Design notes**

- The HTTP layer is a single `Transport` function (`(req) => Promise<HttpResponse>`). The default
  uses `node:http`/`node:https`; tests inject a mock. This keeps the client free of any HTTP framework.
- The CLI is built around injectable `CliDeps` (client factory + I/O), so the whole program can be
  driven in-process by tests with a mocked client and captured output — no subprocesses.
- Full CAP warning payloads are deeply nested and standard-specific, so they are returned as
  faithful raw `JsonObject`s rather than partially-guessed types.
- The transport issues exactly one request and **does not follow 3xx redirects** — a redirect is
  surfaced as a `NinaApiError` like any other non-2xx status. This avoids replaying headers to a
  redirect target (no cross-host header leak / SSRF via `Location`).

---

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer` (GET, unsupported protocol, size cap, timeout, no-redirect-follow).
- **`engine.test.ts`** — URL building, JSON/raw decoding, error mapping, 429/503 retry, redirect-as-error, size-cap forwarding — mocked transport.
- **`client.test.ts`** — every endpoint's method/URL mapping, including identifier URL-encoding — mocked transport.
- **`cli.test.ts`** — end-to-end command parsing, rendering, file output and exit codes, plus negative paths (network/parse/API errors, write failures, content-type warning) — mocked client.
- **`shared.test.ts`** — the `parseIntArg` value parser (accepts plain decimals, rejects everything else).

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build TypeDoc API docs and deploy to GitHub Pages on each `v*` tag.

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
