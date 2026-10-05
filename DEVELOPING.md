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
  maxRetries: 3,              // 429 / 503 and resets are retried (linear backoff, or a longer Retry-After)
  maxResponseBytes: 50 << 20, // example: abort over 50 MiB; the default is 100 MiB (0 = unlimited)
  userAgent: "my-app/1.0",
  transport: customTransport, // inject your own HTTP transport
});
```

### Resource groups

`client.mapData(source)`, `client.dashboard(ars)`, `client.warnings` (`.get` /
`.geojson`), `client.archive` (`.mapping` / `.get`), `client.reference`
(`.notfalltipps` / `.eventCodes` / `.dataVersion`).

`client.mapData(source)` checks the source with the exported `sourceProblem(source)`
and rejects one outside `NinaSourceValues` (possible from plain JavaScript or a cast)
with a `NinaValidationError` before any request, and encodes it as a path segment.
The message quotes the value with `JSON.stringify`, so a control character in it is
escaped. The CLI's `map-data` passes the argument straight to this method.

`client.warnings.get` / `.geojson` and `client.archive.mapping` / `.get` check the
identifier first with the exported `identifierProblem(id)` and reject a blank one or
one with a path separator (`/` or `\`) with a `NinaValidationError` before any
request (`Invalid identifier: …`); `archive.get` also refuses an id that is blank
once its optional `.json` suffix is dropped. The CLI passes the argument straight
to these methods.

`client.dashboard(ars)` checks the key first with the exported `arsProblem(ars)` (a
message, or `undefined` for a usable key) and rejects with a `NinaValidationError`
carrying that message before any
request: anything but 12 digits with the last seven `0` (the API answers an AGS with an
opaque 400 and a municipality key with 404), and a state-level key (digits 3–5 `000`, other than `CITY_STATE_DISTRICT_KEYS`,
Hamburg and Berlin) would get `[]` from the API, a false all-clear. The CLI's
`dashboard` passes the key straight to this method, so it prints the same message.

## Architecture

```
src/
  client/
    enums.ts     # NinaSource + severity value sets (runtime + type)
    types.ts     # response interfaces (typed summaries; full warnings as JsonObject)
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, JSON/raw decoding, error mapping
    errors.ts    # NinaError / NinaApiError / NinaNetworkError / NinaParseError / NinaValidationError
    validate.ts  # input rules (Problem functions) + assertValid, shared with the CLI
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
The bin shim installs `handleOutputErrors()` before `run()`: when stdout's reader stops
early (`| head`) the CLI exits 0 quietly instead of printing an `EPIPE` stack trace, and
when stderr's reader is gone a failed run keeps its own exit code.

**Error types.** [`errors.ts`](src/client/errors.ts): `NinaApiError` (non-2xx,
carries `status`/`detail`/`isRetryable`), `NinaNetworkError` (transport
failure/timeout), `NinaParseError` (bad JSON), `NinaIOError` (local write
failure) and `NinaValidationError` (an input the library rejects before any
request), all extending `NinaError`, plus `NinaNotFoundError` (a warning id that is
no longer live: NINA answers it with a `302` to `/api31/archive/alerts/<id>`, which
`warnings.get`/`geojson` turn into this error, carrying `identifier`, `location` and
the `NinaApiError` as `cause`). For any other `3xx`, `NinaApiError.location` holds the
redirect target (resolved, userinfo redacted, sanitised). The CLI maps a `404` and a
`NinaNotFoundError` to exit code `4`,
other errors to `1` — a `NinaValidationError` included, which is the same exit code
commander gives a usage error.

**Input validation.** Every rule about what a request may contain lives in the
library, in [`validate.ts`](src/client/validate.ts) or next to the option it
guards, as an exported `…Problem(value)` function that returns the reason a value
is invalid (or `undefined`). The library enforces it with `assertValid(name,
value, problem)`, which throws `NinaValidationError` with the message
`Invalid <name>: <reason>` before any request (methods that return a promise
reject; constructors throw). The CLI's option parsers call the same functions and
turn the reason into a usage error, so the CLI keeps no rules of its own. Tests
check this with the `parity()` helper in `test/helpers.ts`, which sends one input
through `run()` and through the library on one recording mock transport.

**Query builder.** [`buildQueryString`](src/client/query.ts) — a dependency-free
serialiser: omits `undefined`/`null`, repeats keys for arrays, renders booleans
as `true`/`false`, dates as ISO-8601, and encodes spaces as `%20` (not `+`).

**Retry / backoff.** Transient `429` (rate limit) and `503` responses, and reset
connections (see Custom transports), are retried automatically, up to `--max-retries`;
a refused connection, a DNS failure and a timeout are not. Each retry waits the linear
backoff (`retryDelayMs * attempt`), or the response's `Retry-After` (parsed strictly by
the exported `parseRetryAfter`: delay-seconds or an IMF-fixdate) when that is longer —
never less, so `Retry-After: 0` or a past date cannot make a burst. A `Retry-After`
above `MAX_RETRY_AFTER_MS` (30 s) is not retried: the `NinaApiError` surfaces at once,
carries the requested wait as `retryAfterMs` and says that more retries won't help. The count is bounded by the exported `MAX_RETRIES`
(`10`): the engine rejects a `maxRetries` that is not an integer from `0` to
`MAX_RETRIES` with a `NinaValidationError`, and the CLI's `--max-retries` parser
uses the same constant, so a value above `10` is a usage error there.
`NinaApiError` exposes `isRetryable` (true for `429`/`503`).

**Engine options.** The numeric options are checked in the `RequestEngine`
constructor, which throws a `NinaValidationError` (`Invalid option <name>: expected
an integer from 0 to <max>, got <value>.`) before any request: `timeoutMs` must be
an integer from `0` (no timeout) to `MAX_TIMEOUT_MS` (2^31 − 1 ms), `maxRetries`
from `0` to `MAX_RETRIES`, `retryDelayMs` from `0` to `MAX_RETRY_AFTER_MS` (30 000; a
larger one used to overflow Node's timers into a 1 ms delay), and `maxResponseBytes` a
non-negative safe integer. A negative or NaN `timeoutMs` used to mean no timeout at all. The
CLI's `--timeout` and `--max-retries` parsers use the same exported bounds.

**userAgent.** The `User-Agent` header value (default `nina-warnungen-cli`). The
`RequestEngine` constructor checks a given value with the exported
`headerValueProblem` (via `assertHeaderValue`) and throws a `NinaValidationError`
(`Invalid userAgent: …`) for a blank value, a control character other than tab, DEL
or a character above U+00FF; only an omitted value selects the default. The CLI's
`--user-agent` parser calls the same rule. As defence in depth, the default
transport rejects a header Node refuses as a `NinaNetworkError`, never a raw
`TypeError`.

**maxResponseBytes.** A cap on the response body size in bytes (`0` = unlimited;
default 100 MiB), guarding against unbounded responses. A negative or non-integer
value is rejected (`NinaValidationError`, `Invalid option maxResponseBytes: …`)
rather than switching the cap off. Setting
`--max-response-bytes 0` disables the guard entirely — including for
`warning geojson` downloads. The default transport aborts as soon as the cap is
passed; the engine also checks the body any transport returns, so the cap holds for
custom transports too.

**timeoutMs.** Bounds a request (default 30 s; `0` disables) with a socket-inactivity
timeout and a wall-clock deadline in the default transport, and the engine enforces the
deadline itself for every transport: the transport gets an `AbortSignal`
(`HttpRequest.signal`) that fires at the deadline, and the call rejects then with a
`NinaNetworkError` whether the transport stops or not, so a `fetch` or `node:http`
transport can't hang a caller.

**Custom transports.** A transport may return the body as a Buffer, any `ArrayBuffer`
view (fetch's `Uint8Array`, from any realm) or an `ArrayBuffer`, and the headers as a
plain record in any case, a `Headers` object or a `Map` (`Retry-After` and the archive
`Location` are read either way). Whatever it throws becomes a `NinaNetworkError`, and a
malformed response (no status, NaN) too; a reset reported as Node's
`ECONNRESET`/`EPIPE`/`ECONNABORTED` or undici's `UND_ERR_SOCKET` anywhere in the
`cause` chain is retried like a 503.

**No redirect following.** The transport issues exactly one request and does not
follow `3xx` redirects — a redirect is surfaced as an error like any other
non-2xx status, avoiding header replay to a redirect target.

**`--base-url` + `--output` note.** Because the base URL is trusted as given,
`nina --base-url <any-http(s)-host> -o <file> ...` is effectively a general
"fetch this URL and write it to a file" tool. Only `http`/`https` are allowed
(`file:`/`ftp:` are rejected) and redirects are never followed, but point it
only at hosts you trust. The `RequestEngine` constructor checks the base URL with
the exported `validateBaseUrl` / `baseUrlProblem` and throws a `NinaValidationError`
(`Invalid baseUrl: …`) — a configuration error, not a `NinaNetworkError` — before
any request: a blank value, surrounding or inner whitespace and control characters,
an unparseable value, a scheme other than `http:`/`https:`, a query (`?`) or
fragment (`#`), which would swallow the appended request path, and a `%` in the user
name or password that doesn't start an escape (write a literal `%` as `%25`; Node would
fail to decode it for the Authorization header at request time). The CLI's
`--base-url` parser (`parseBaseUrl`) calls the same rule, so a bad value is a usage
error there. The `http:`/`https:` scheme is enforced again, per request, by the
default transport (as a `NinaNetworkError`); the constructor check alone already
holds transport-independently, so a library user who injects a custom `Transport`
still cannot reach a `file:`/`ftp:` driver via the base URL.

**Credentials in the base URL.** A base URL may carry `user:password@` (sent as Basic
auth). The library's reasons never repeat the value, and the CLI also redacts on
output: `run.ts` (`withRedactedOutput`) takes the exact userinfo of every argument
(`credentialsIn`, exported) and replaces it with `***` in everything it prints —
commander's usage errors, which echo a rejected `--base-url` value, and its own
messages — so a password with spaces, quotes, `#`, `?` or `/` is caught as well as an
ordinary one. `redactUrl` (exported) falls back to the same text-based cut for a value
that doesn't parse as a URL. The library keeps the base URL in a real `#private` field,
so `console.log(client)`, `util.inspect` and `JSON.stringify` never show it;
`NinaApiError.url` holds the request URL with its userinfo redacted; and the engine scrubs
the userinfo (raw and percent-decoded) from error bodies and details, transport error text
and the `cause` chain. Whatever a custom transport throws (a string, fetch's `TypeError`)
reaches the caller as a `NinaNetworkError`, never raw.

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
- **`validate.test.ts`** — `assertValid`, the `NinaValidationError` exit-code mapping and the `parity()` helper.
- **`conformance-p*.test.ts`** — the workspace's shared conformance checks from the 2026-10-05 review
  (P1 credential redaction in CLI output, P2 in library objects, P4 base-URL validation, P5 transport contract, P6 retry policy, P7 closed pipes, …); copied across the `*-cli` repos, only the adapter
  block at the top differs.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar-org.github.io/nina-warnungen-cli/> in English
and <https://maschinenlesbar-org.github.io/nina-warnungen-cli/de/> in German — is built from
`site/` with [Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web
components and [Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the
TypeDoc API reference under `/api/`. Its content comes from this repository: the README intro
and quick start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`),
`Usage.md`, `GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill
examples in `EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are
`site/_config.yml` and `site/_data/project.yml` (the German intro and the access requirements);
the rest of `site/` is identical in every maschinenlesbar.org CLI, so change it in all of them
together. When the README intro changes, update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/nina-warnungen-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
