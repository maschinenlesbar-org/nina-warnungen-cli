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
npm run build        # compiles every workspace (tsc -b) to its dist/
```

Run the locally built CLI without a global install:

```bash
node apps/cli/dist/src/cli/index.js --help    # or: npm start -- --help
# or, after `npm link --workspace apps/cli`:
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

Every option may also be given as `undefined`, which means its default, as an omitted one
does; the types say so (`?: T | undefined`), so `{ baseUrl: process.env.NINA_BASE_URL }`
compiles under `exactOptionalPropertyTypes` too.

`cleartextProblem(baseUrl, secrets?)` (exported from the library) says what a remote plain
`http:` base URL exposes — `requests to <host> are sent unencrypted (http:, not https:)`, or
naming the base URL's credentials when it carries userinfo — and returns `undefined` for
`https:`, an unparseable URL and loopback hosts. It never contains the password. The CLI logs
it once per run as a `WARN` record of `nina.http` on stderr before the first request.

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
`dashboard` passes the key straight to this method, so it prints the same message. A
well-formed key NINA knows no district for gets a bare HTTP 404 (empty body); the method
rethrows it as a `NinaApiError` (still status 404, so CLI exit `4`) whose `detail` is
`no such district key "<ars>": …`.

## Architecture

The repository is an **npm workspace** with two folders: `apps/` holds the programs it
publishes, `packages/` the libraries they are built from.

```
package.json         # private workspace manifest: no version, never packed
apps/cli/            # @maschinenlesbar.org/nina-warnungen-cli — the published package
  package.json       # its version, bin, files (no workspace package in dependencies)
  src/index.ts       # library entry: re-exports @maschinenlesbar.org/nina-warnungen-client
  src/cli/           # the CLI (below)
  test/              # CLI tests and every conformance-*.test.ts
packages/client/     # @maschinenlesbar.org/nina-warnungen-client — private, shipped inside the CLI's tarball
  src/               # the API client (below)
  test/              # tests that only touch the client, + the transport helpers
tools/pack/          # prepack/postpack: ship the client (dist/node_modules) and commander in the tarball
tools/bump.mjs       # version bump + commit + tag (npm run bump)
tsconfig.docs.json   # TypeDoc only: the package entry, with the client read from its sources
```

- **The client is its own package** so a later MCP app can share it with the CLI. It is
  never published on its own: `apps/cli`'s `prepack` copies it into
  `apps/cli/dist/node_modules/`, where the CLI's imports find it, and the tarball ships it
  as plain files — so npm lists only commander (bundled) as a dependency, never the
  private client. `apps/cli/package.json` therefore doesn't name the client; prepack finds
  it through `apps/cli/tsconfig.json`'s project references. The library
  entry re-exports the client's `"."`, so `import { NinaClient } from
  "@maschinenlesbar.org/nina-warnungen-cli"` is unchanged.
- **The client's exports:** `"."` is the public library surface (`src/index.ts`);
  `"./internal/*"` maps to any module (`…/nina-warnungen-client/internal/engine`) for what the
  CLI needs beyond that; `"./test/*"` reaches the client's test helpers from the CLI's
  tests (not bundled). Only `"."` is part of the library.
- **Dependencies point one way:** the app depends on the client, the client on nothing
  in the workspace.
- **The version lives in `apps/cli/package.json`.** The root has none; a plain
  `npm version` at the root is refused. Release with `npm run bump -- <patch|minor|major>`,
  which bumps the app, commits (the bare version as the message) and tags `vX.Y.Z`.
- **TypeScript:** `tsconfig.base.json` holds the compiler options; every workspace has a
  `tsconfig.json` (`src/`) and a `tsconfig.test.json` (`test/`), and the root
  `tsconfig.json`/`tsconfig.test.json` reference them, built with `tsc -b`.

The client (`packages/client/src/`) and the CLI (`apps/cli/src/`):

```
packages/client/src/
    enums.ts     # NinaSource + severity value sets (runtime + type)
    types.ts     # response interfaces (typed summaries; full warnings as JsonObject)
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, JSON/raw decoding, error mapping
    errors.ts    # NinaError / NinaApiError / NinaNetworkError / NinaParseError / NinaValidationError
    validate.ts  # input rules (Problem functions) + assertValid, shared with the CLI
    client.ts    # NinaClient — resource groups over the engine
    index.ts     # the client's public surface (the library entry re-exports it)
apps/cli/src/cli/
    io.ts        # injectable I/O seam (stdout/stderr/file), the logger and the clock
    log.ts       # the stderr log: records with ts, level, topic; --log-format text|jsonl
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

**API client.** [`NinaClient`](packages/client/src/client.ts) — the typed,
resource-grouped wrapper over the API (`client.mapData`, `client.dashboard`,
`client.warnings`, `client.archive`, `client.reference`). Usable as a library
independently of the CLI.

**Resource group.** A cohesive set of client methods for one part of the API
(`client.warnings`, `client.archive`, `client.reference`), and the matching CLI
command group.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](packages/client/src/http.ts)). The default uses Node's built-in
`http`/`https`; tests inject a mock. This is the only HTTP seam.

**Request engine.** [`RequestEngine`](packages/client/src/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, decodes JSON/raw responses and maps
errors. Sits between the client's resource methods and the transport.

**RawResponse.** The result of a download method: `{ data: Buffer, contentType,
status }` — raw bytes, never lossily decoded.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](apps/cli/src/cli/io.ts)): a client factory plus an I/O object. Lets the whole
CLI run in tests with a mocked client and captured output — no subprocess.
The bin shim installs `handleOutputErrors()` before `run()`: when stdout's reader stops
early (`| head`) the CLI exits 0 quietly instead of printing an `EPIPE` (or, on a socket,
`ENOTCONN`) stack trace, any other stdout write error is an ERROR record of `nina.output`
with exit 1, and when stderr's reader is gone a failed run keeps its own exit code.

**Error types.** [`errors.ts`](packages/client/src/errors.ts): `NinaApiError` (non-2xx,
carries `status`/`detail`/`isRetryable`), `NinaNetworkError` (transport
failure/timeout; its message names the request, `GET <url> failed: <reason>` with the
URL's userinfo redacted, for a timeout, the size cap, a refused connection, a DNS failure and
a reset alike, and the transport's own error is its `cause`), `NinaParseError` (bad JSON), `NinaIOError` (local write
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
library, in [`validate.ts`](packages/client/src/validate.ts) or next to the option it
guards, as an exported `…Problem(value)` function that returns the reason a value
is invalid (or `undefined`). The library enforces it with `assertValid(name,
value, problem)`, which throws `NinaValidationError` with the message
`Invalid <name>: <reason>` before any request (methods that return a promise
reject; constructors throw). The CLI's option parsers call the same functions and
turn the reason into a usage error, so the CLI keeps no rules of its own. Tests
check this with the `parity()` helper in `apps/cli/test/helpers.ts`, which sends one input
through `run()` and through the library on one recording mock transport.

**Charset.** JSON bodies are decoded by the charset their `Content-Type` names (UTF-8
when it names none) with `TextDecoder`, which also drops a leading byte order mark; an
unknown charset label is a `NinaParseError`. Raw downloads (`warning geojson`) stay bytes.
Every error about an answer names the request, `GET <url>: …` (the URL absolute, its userinfo
redacted, cut at 500 characters; `RequestEngine.describeUrl`): an unknown charset (`unsupported
response charset "…"`), an empty body (`empty response body`), a body that is not JSON (`the
answer is not valid JSON`, plus `(expected JSON, got Content-Type "text/html")` when the server
named another type), an inexact number and the wrong shape.

**Identifiers.** The four identifier methods (`warnings.get`/`geojson`,
`archive.get`/`mapping`) pass the id through the exported `normalizeIdentifier` first:
NFC, surrounding whitespace (CR, NBSP, BOM included), Unicode format characters and
quotes dropped, and a `.json`/`.geojson` suffix in any case removed. The API answers each
such variant of a live id with the archive redirect, which read as "the warning has
expired". Case is kept — the API's ids are case-sensitive and mixed-case. Then
`identifierProblem` refuses a blank id, a path separator, a dot segment (`.` or `..`), and
whitespace or an invisible character inside. `NinaNotFoundError`'s message says no live warning has
exactly this id, not that it ended: the API redirects ended and mistyped ids alike.

**Messages.** Every rejected input is a `NinaValidationError`, also for a wrong type
from JavaScript (`dashboard(12345678)`, `warnings.get(null)`), never a raw `TypeError`.
An echoed value (an identifier, a region key, a request path holding one) and server text
(an error `detail`, a redirect target) are cut at `MAX_MESSAGE_VALUE_LENGTH` (500) characters, ending in `…`,
never inside a surrogate pair (`cutText`), so the message stays well-formed; the error's
properties keep the full value.

**Response shapes.** Every client method checks the 2xx body against the shape its
endpoint documents before returning it: `mapData` and `dashboard` an array of objects
(`[]` is a real answer: no warnings), `warnings.get` and `archive.get` an object with a
string `identifier`, `archive.mapping` an object with a `history` array, the reference
files a JSON object or array, and `warnings.geojson` GeoJSON (UTF-8 JSON for an object
with a GeoJSON `type`; the bytes are still returned unchanged). Anything else — `null`, `{}`, a scalar, an error object a
gateway answers with HTTP 200 — is a `NinaParseError` (`GET <url>: unexpected response shape:
expected …, got …`, exit 1), never data: `jq 'length'` would read `null` and `{}` as 0, a
false all-clear.

**Numbers.** `JSON.parse` changes some numbers silently: one out of a double's range (`1e400`
becomes `Infinity`, printed as `null`), one past 2^53 that it rounds (`12345678901234567890`
prints as `12345678901234567000`), a non-zero one too small for a double (`1e-400` becomes
`0`), and a subnormal one (below 2.2250738585072014e-308, where a double has fewer digits) that
does not print as written (`3e-324` prints as `5e-324`; `5e-324` itself passes). A JSON answer holding such a number is a `NinaParseError` (`GET <url>: the number <N>
cannot be represented exactly.`, exit 1), never a changed value. Past
2^53 a number passes when it prints as written (`1e23`); below 2^53 a decimal fraction keeps a
double's usual precision. A scan of the text after `JSON.parse` (`firstInexactNumber`) skips
strings. Raw downloads (`warning geojson`) are bytes and are not checked.

**Query builder.** [`buildQueryString`](packages/client/src/query.ts) — a dependency-free
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

Each retry is announced: the engine option `onRetry(event: RetryEvent)` (exported type:
`{ retry` (1-based), `maxRetries`, `delayMs`, `status?` (absent for a reset), `url` (userinfo
redacted) `}`) is called once per retry right before the sleep, never when there is none, and
a throw in it is swallowed. The CLI's `action()` sets it to log one `WARN` record of
`nina.http`, `HTTP 503 from <host>: retry 1 of 3 in 2 s` (`retryMessage`; host only, whole
seconds, ms under 1 s). Tests: `apps/cli/test/retry-log.test.ts`.

**Engine options.** A `null` options object counts as none; `transport` and `sleep`
must be functions (else `NinaValidationError`, `Invalid option transport: expected a
function, …`). The numeric options are checked in the `RequestEngine`
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
output: `run.ts` (`redactionFor` and `withRedactedOutput`) takes the exact userinfo of
every URL argument (`credentialsIn`, exported) and replaces it with `***` in everything it
prints — commander's usage errors, which echo a rejected `--base-url` value, and its own
messages. Only a value that starts with a scheme counts (a bare `a:b@c` is an `-o` file
name or a User-Agent as often as a credential), except as the `--base-url` value. The log replaces it in each record's *message*, before the record is cut and
escaped, and writes it to the raw stderr: the frame (time, level, topic) is never
touched, and a password with DEL, C1 or bidi characters is matched in its raw form. A password with spaces, quotes, `#`, `?` or `/` is caught as well as an
ordinary one. The forms a server echoes a userinfo back in are replaced too
(`echoedCredentialForms`): the `Basic` value (UTF-8, as Node sends it) and the decoded
`user:password` on stdout and stderr, the password alone (4 characters or more) on stderr
only, since it may well occur in the data. `redactUrl` (exported) falls back to the same text-based cut for a value
that doesn't parse as a URL. The library keeps the base URL in a real `#private` field,
so `console.log(client)`, `util.inspect` and `JSON.stringify` never show it;
`NinaApiError.url` holds the request URL with its userinfo redacted; and the engine scrubs
the userinfo (raw and percent-decoded) and the forms a server echoes it back in (the
`Basic` value, the decoded `user:password`, the password alone from 4 characters) from
error bodies and details, transport error text
and the `cause` chain. Whatever a custom transport throws (a string, fetch's `TypeError`)
reaches the caller as a `NinaNetworkError`, never raw.

## Testing

```bash
npm test          # builds, then runs `node --test` over each workspace's dist/test
npm run coverage  # the same tests in one run, with a coverage report
node --test apps/cli/dist/test/cli.test.js   # one file, after a build
```

The client's tests are in `packages/client/test/` (`query`, `http`, `engine`, `client`),
everything that drives the CLI is in `apps/cli/test/`.

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer` (GET, unsupported protocol, size cap, timeout, no-redirect-follow).
- **`engine.test.ts`** — URL building, JSON/raw decoding, error mapping, 429/503 retry, redirect-as-error, size-cap forwarding — mocked transport.
- **`types.test.ts`** — a consumer compiled by `tsc` with `exactOptionalPropertyTypes` (it starts a process: 30 s) can pass `undefined` for every option, and at run time `undefined` means the default.
- **`client.test.ts`** — every endpoint's method/URL mapping, including identifier URL-encoding — mocked transport.
- **`cli.test.ts`** — end-to-end command parsing, rendering, file output and exit codes, plus negative paths (network/parse/API errors, write failures, content-type warning) — mocked client.
- **`output.test.ts`** — the output path: `-o` and `--force` on real files in a temp directory (refusals before any request, the atomic write, mode and symlinks, a file that appears during the request, printed JSON's escapes), and which `JSON.stringify` path `--compact` takes (the fast one, or the gap path for an answer holding a string of 64 Mi characters or more, on which Node 26's fast path aborts the process).
- **`shared.test.ts`** — the `parseIntArg` value parser (accepts plain decimals, rejects everything else).
- **`validate.test.ts`** — `assertValid`, the `NinaValidationError` exit-code mapping and the `parity()` helper.
- **`log.test.ts`** — the record helpers of `apps/cli/src/cli/log.ts` on their own
  (`escapeForRecord`, `formatLogRecord`); the CLI-level checks are P23's.
- **`conformance-p*.test.ts`** — the workspace's shared conformance checks from the 2026-10-05 review
  (P1 credential redaction in CLI output, P2 in library objects, P4 base-URL validation, P5 transport contract, P6 retry policy, P7 closed pipes, P8/P9/P13 charsets, response shapes and error classes, and from the 2026-10-06 follow-up P20 the cleartext `http:` warning and P21 README links: a relative link in `README.md` must point at a file the npm package ships — link any other document by its `https://github.com/maschinenlesbar-org/nina-warnungen-cli/blob/main/…` URL; from the 2026-10-21 kit rollout P24 the input corpus (every id in a path is sent canonical or refused; nina has no text filter), P25 the response corpus (a number JSON can't carry exactly, an empty answer) and P26 `-o` integrity (a write cut short under `ulimit -f` leaves the old file and nothing else; it starts the built bin: 30 s)); copied across the `*-cli` repos, only the adapter
  block at the top differs.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 22/24/26 for every push and PR; then pack the
  real tarball, check the pack left nothing behind, install it globally with the registry out
  of reach and run the bin.
- **release.yml** — on a `v*` tag (made by `npm run bump`): verify the tag matches
  `apps/cli/package.json`, test, write the SBOMs (scoped to the `apps/cli` workspace), then
  `npm pack --workspace apps/cli`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch from the release tag (`gh workflow run publish.yml --ref vX.Y.Z`; the version is the tag's): `npm publish --workspace apps/cli` via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar.org/nina-warnungen-cli/> in English
and <https://maschinenlesbar.org/nina-warnungen-cli/de/> in German — is built from
`site/` with [Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web
components and [Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the
TypeDoc API reference under `/api/`. Its content comes from this repository: the README intro
and quick start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`),
`Usage.md`, `GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill
examples in `EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are
`site/_config.yml` (which also says where the published manifest and the built program are:
`manifest: apps/cli/package.json`, `program: apps/cli/dist/src/cli/program.js`) and
`site/_data/project.yml` (the German intro and the access requirements);
the rest of `site/` is identical in every maschinenlesbar.org CLI, so change it in all of them
together. When the README intro changes, update the German intro in `site/_data/project.yml`.

The build also writes `sitemap.xml`: every page in both languages, and `/api/`. Crawlers
find it through `robots.txt` at the root of maschinenlesbar.org, which only the
organisation website can serve; its `site/_data/sites.yml` lists every site's sitemap, so a
new CLI gets a line there.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/nina-warnungen-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## The log on stderr

Every diagnostic line on stderr is a log record (`apps/cli/src/cli/log.ts`): a timestamp, a level
(`ERROR`, `WARN`, `INFO`) and a topic, `nina.<area>`. `--log-format text` (the default)
writes it log4j style, `<ISO 8601 UTC> <LEVEL padded to 5> [<topic>] <message>`;
`--log-format jsonl` writes one JSON object per line with exactly `ts`, `level`, `topic`
and `msg`. A record is always one line: `formatLogRecord` runs `escapeForRecord` over
the message (text) or the whole JSON object (jsonl), which writes CR and LF as `\r`/`\n`,
every other C0 control but TAB, DEL and C1 as `\u00XX`, and U+2028, U+2029 and the bidi
controls as `\uXXXX`, so no text that reaches a record, by whatever path, can split it,
forge another one or steer the terminal. Before that a lone surrogate (half a
character, which jq rejects, stopping the whole stream) becomes U+FFFD (`toWellFormed`),
and a message longer than `MAX_RECORD_MESSAGE` (4000 characters, exported) is cut at a
code point and ends in `… (N more characters)`. The areas are `cli` (usage errors, commander's messages, unexpected errors),
`api` (the API's answers: HTTP errors, a warning id that is no longer live, the
content-type warning of a download, and a malformed answer, a `NinaParseError`: bad JSON,
the wrong shape, an unknown charset), `http` (the connection: network errors, the
cleartext warning) and `output` (`-o`: "Wrote N bytes", or any failure to write the file,
a `NinaIOError` whatever the `CliIO` threw; and a stdout write error).

**`-o` and `--force`.** `action()` runs `checkOutputTarget` before any request: `--force`
without `-o`, a directory, and an existing path (a dangling link too, `CliIO.outputState`)
without `--force` are usage errors (`NinaValidationError`, exit 1, `nina.cli`); `-o -` is
stdout. The write (`CliIO.writeFile(path, data, overwrite)`; the real one is `nodeWriteFile`
in `io.ts`) is atomic: without `--force` it claims the name with an exclusive create (so a
file that appeared during the request is refused too, `nina.output`), writes a temporary file
beside the target and renames it over it; on failure neither the temporary file nor the
claimed name is left. `--force` keeps the old file's mode and writes through a symlink.
Messages: `Refusing to overwrite existing file "<p>"; pass --force to overwrite.`,
`"<p>" is a directory; give a file path to --output.`, `Could not write to "<p>": <reason>`.
Code logs through `logOf(deps)` and never writes diagnostics with `io.err` directly.
`run()` builds the logger from argv before commander parses it (`logFormatFromArgv`,
which skips the value of the program's own value options and is used only for the records
of a parse error; a `preAction` hook then sets the format commander parsed, so
`--user-agent --log-format=jsonl` logs text), and turns commander's
buffered stderr into records when it flushes it, one per line (`commanderRecords`): its
`error: …` an ERROR of `cli`, with a `(Did you mean …?)` line joined to it, and the help it
shows after an error an INFO record per non-blank line. Help for a bare `nina` with no arguments goes to stdout, exit 0. A command group or global
options without a command log an ERROR "missing command: `nina warning <subcommand>`" first,
then the help as INFO records, and exit 1 (nina's usage-error code, like every other usage error).
`run.ts` replaces commander's built-in `help [command]` with its own `help [command...]`
(`addHelpCommand`, in `configureTree`, so the tree the website documents is unchanged): it
walks every name, and an unknown one is reported like `nina nope` (`error: unknown command
'nope'`) and exits 1 as well. So there is no failed run without an ERROR record; the logger carries the run's redaction (`withRedactedOutput`), which
replaces a secret in the message only, before it is escaped: the frame is never touched,
and a secret is kept out of the log in either format. `CliDeps.now` makes the timestamps testable. stdout carries
data only. Conformance test P23 checks all of this, and its body is shared across the
*-cli repos (here with the `USAGE_EXIT` switch: a usage error exits 1). A stdout write
error other than a closed pipe (EBADF, EIO; `handleOutputErrors` in the bin shim, outside
`run()`) is an ERROR record of `nina.output` too, `Could not write to stdout: …`, in the
format argv asks for and with argv's credentials replaced (`processLogger`), and exits 1.
Node's own process warnings (`NODE_TLS_REJECT_UNAUTHORIZED=0`) are WARN records of
`nina.cli` too: the bin shim installs `installWarningLog`, which removes Node's default
`warning` listener and logs `(node) <name>: <message>` through `processLogger(argv)`.
In `defaultIO` a record waits for stdout (`stderrAfterStdout`): it is held while stdout
has a backlog and written, in order, once it is gone, so with `2>&1 |` and a slow reader
it never lands inside the data.
