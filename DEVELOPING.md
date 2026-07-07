# Developing & integrating

This document covers `nina-warnungen-cli` as a **TypeScript library**, plus its
architecture, testing and release setup. If you just want to use the
command-line tool, start with the **[README](README.md)** and
**[Usage.md](Usage.md)** instead.

The package ships both a CLI (`nina`) and a typed API client (`NinaClient`) for
the [open NINA civil-protection warning API](https://nina.api.bund.dev/)
(`warnung.bund.de`). The API is fully public — no key, no auth.

**Design goals**

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed client surface, warning summaries and the source enum.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.
- **Read-only, no auth** — the NINA API needs no key; this client only reads.

## Build from source

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the locally built CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link`:
nina --help
```

## Library usage

```ts
import { NinaClient, NinaApiError, type NinaSource } from "@maschinenlesbar.org/nina-warnungen-cli";

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
  maxResponseBytes: 50 << 20, // example: abort over 50 MiB; the default is 100 MiB (0 = unlimited)
  userAgent: "my-app/1.0",
  transport: customTransport, // inject your own HTTP transport
});
```

### Resource groups

`client.mapData(source)`, `client.dashboard(ars)`, `client.warnings` (`.get` /
`.geojson`), `client.archive` (`.mapping` / `.get`), `client.reference`
(`.notfalltipps` / `.eventCodes` / `.dataVersion`).

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

### Library / technical terms

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

**Query builder.** [`buildQueryString`](src/client/query.ts) — a dependency-free
serialiser: omits `undefined`/`null`, repeats keys for arrays, renders booleans
as `true`/`false`, dates as ISO-8601, and encodes spaces as `%20` (not `+`).

**Retry / backoff.** Transient `429` (rate limit) and `503` responses are
retried automatically with linear backoff, up to `--max-retries`. The engine
clamps the count to `10` as a safety bound for direct library callers; the CLI
goes further and *rejects* a `--max-retries` above `10` as a usage error.
`NinaApiError` exposes `isRetryable` (true for `429`/`503`).

**maxResponseBytes.** A cap on the response body size in bytes (`0` = unlimited;
default 100 MiB), guarding against unbounded responses. Setting
`--max-response-bytes 0` disables the guard entirely — including for
`warning geojson` downloads.

**No redirect following.** The transport issues exactly one request and does not
follow `3xx` redirects — a redirect is surfaced as an error like any other
non-2xx status, avoiding header replay to a redirect target.

**`--base-url` + `--output` note.** Because the base URL is trusted as given,
`nina --base-url <any-http(s)-host> -o <file> ...` is effectively a general
"fetch this URL and write it to a file" tool. Only `http`/`https` are allowed
(`file:`/`ftp:` are rejected) and redirects are never followed, but point it
only at hosts you trust. The `http:`/`https:` scheme is enforced in **two**
places — the default transport *and* `RequestEngine.buildUrl` — so the guarantee
holds transport-independently: a library user who injects a custom `Transport`
still cannot reach a `file:`/`ftp:` driver via the base URL.

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

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
