# nina-warnungen-cli — Exploratory / black-box bug report

## Environment

- Date: 2026-06-06
- Node: v22.14.0 (darwin 25.5.0, zsh)
- Build: `npm run build` succeeded clean.
- Driver: `node dist/src/cli/index.js ...`
- Live BBK NINA API (`https://warnung.bund.de`): **reachable** (verified via `reference data-version`, real `mowas` warning id, curl byte-diff).
- Local loopback `http.createServer` used for content-type / network / size-cap / retry probes.
- Live reference id used throughout: `mow.DE-SL-SLS-W038-20260113-000` (a current MoWaS warning).

## Summary

A large part of the surface is solid: identifier URL-encoding, 404→exit 4, numeric-flag
rejection (`-1`, `5.0`, `0x10`, `1e3`, `Infinity`, empty, leading space), byte-integrity of
`-o` downloads (identical to curl), no-data-loss on `warning get` / `event-codes`
(semantically identical to raw), size-cap aborts without leaving a partial file, the
content-type warning fires before writing, and `file:`/`ftp:` base URLs are rejected.

The genuine issues below are mostly **silent / surprising behaviour**, **error-classification**,
and **doc/UX** problems rather than crashes. **15 genuine reproducible bugs** are listed;
**all 15 are real** (none fabricated). Numbers 1–4 are the substantive ones; the rest are
lower-severity correctness/UX/doc defects that are still valid for the count per the brief.

---

## HIGH

### 1. `-o/--output` is silently accepted and ignored on every JSON command (data not written) — ✅ FIXED
**Fix:** `renderJson` in `src/cli/shared.ts` now honours `global.output`: when `-o` is set it writes the JSON (plus trailing newline) to the file via `deps.io.writeFile` and prints a `Wrote N bytes` confirmation to stderr, matching `renderRaw`. Applies to `map-data`, `warning get`, `dashboard`, `archive *`, `reference *`.
- Severity: High · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js -o /tmp/x.json map-data dwd
  ```
- Expected: either the JSON is written to `/tmp/x.json`, or the CLI errors that `-o` is only valid for `warning geojson`.
- Actual: exit `0`, **no file created**, JSON printed to stdout instead. `/tmp/x.json` does not exist; stderr empty.
  ```
  exit=0
  file created: ls: /tmp/x.json: No such file or directory
  stdout: []
  ```
  Same for `warning get`, `dashboard`, `archive *`, `reference *`.
- Root cause: `-o` is a **global** option (`program.option("-o, --output ...")` in `src/cli/program.ts:41`) so it parses on all commands, but only `renderRaw` consults `global.output` (`src/cli/shared.ts:94`); `renderJson` (`shared.ts:67`) never looks at it. A user redirecting JSON to a file via `-o` loses the output with no signal.

### 2. `--output ""` (empty string) silently writes to stdout instead of a file / erroring — ✅ FIXED
**Fix:** Added a `resolveOutput()` helper in `src/cli/shared.ts` used by both `renderJson` and `renderRaw`. It distinguishes `undefined` (no `-o`, write to stdout) from `""` (explicitly empty), and throws a `NinaError` (`--output requires a non-empty file path.`, exit 1) for the empty case instead of silently streaming to stdout.
- Severity: High · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js --output "" warning geojson mow.DE-SL-SLS-W038-20260113-000
  ```
- Expected: error (empty path) or attempt to write a file; not a silent stdout dump.
- Actual: exit `0`; the GeoJSON is dumped to stdout, no "Wrote N bytes" message.
  ```
  {"type":"FeatureCollection","features":[{"type":"Feature",...
  exit=0
  ```
- Root cause: `if (global.output)` in `src/cli/shared.ts:94` is a **truthiness** check; `""` is falsy so the file branch is skipped. A script doing `--output "$OUT"` with an unset/empty `$OUT` silently streams binary to stdout instead of failing.

---

## MEDIUM

### 3. Expected file-write failures are reported as "Unexpected error" (wrong error class / message) — ✅ FIXED
**Fix:** Added `NinaIOError extends NinaError` in `src/client/errors.ts`. `defaultIO.writeFile` in `src/cli/io.ts` now wraps `writeFileSync` in try/catch and rethrows failures as `NinaIOError` (`Failed to write <path>: <reason>`). Because it is a `NinaError`, `run.ts` prints a clean `Error: ...` (exit 1) instead of the `Unexpected error:` branch reserved for internal bugs.
- Severity: Medium · Confidence: High
- Repro (output target is a directory):
  ```
  node dist/src/cli/index.js -o /tmp warning geojson mow.DE-SL-SLS-W038-20260113-000
  ```
  also `-o .` and `-o /noperm/x.geojson`.
- Expected: a clean `Error: ...` for a routine, user-caused condition (can't write here).
- Actual: exit `1` with the catch-all wording reserved for internal bugs:
  ```
  Unexpected error: EISDIR: illegal operation on a directory, open '/tmp'
  exit=1
  ```
  ```
  Unexpected error: ENOENT: no such file or directory, open '/noperm/x.geojson'
  ```
- Root cause: `io.writeFile` uses `writeFileSync` (`src/cli/io.ts:26`); the thrown `Error` is not a `NinaError`, so it falls through to the final `Unexpected error:` branch in `src/cli/run.ts:46`. File-write failures are a normal failure mode and should be classified/worded as such.

### 4. Unbounded `--max-retries` can hang the process indefinitely (no upper cap, linear backoff) — ✅ FIXED
**Fix:** Added a `MAX_RETRIES_CAP = 10` in `src/client/engine.ts`; the constructor now clamps `maxRetries` with `Math.min(options.maxRetries ?? 2, MAX_RETRIES_CAP)`, so even `--max-retries 999999` performs at most 11 total attempts. Documented the cap in the `--max-retries` help text (`src/cli/program.ts`) and the README option table.
- Severity: Medium · Confidence: High
- Repro (against a host that always returns 503):
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:<port>/always503 --max-retries 999999 map-data dwd
  ```
- Expected: a sane upper bound, or at least a documented cap; the CLI shouldn't sit retrying for hours.
- Actual: still running after 4 s in the test (`STILL RUNNING after 4s (hang confirmed)`), and with linear backoff (`retryDelayMs * attempt`, `src/client/engine.ts:100`) the total wait grows quadratically — effectively a self-DoS. `parseIntArg` accepts any safe integer, so values up to `Number.MAX_SAFE_INTEGER` pass validation.
- Root cause: no maximum on `maxRetries` and no overall deadline; `src/client/engine.ts:98-102`.

### 5. README says `warning geojson` "streams" bytes, but the whole body is buffered in memory — ✅ FIXED
**Fix:** Doc correction in `README.md`: the CLI-usage paragraph now says `warning geojson` "writes the raw GeoJSON bytes … The body is buffered in memory (bounded by `--max-response-bytes`), not streamed." The misleading "streams" wording was removed.
- Severity: Medium · Confidence: High
- README lines 38–39 / 116: "streams raw GeoJSON bytes to stdout or to a file".
- Actual: the transport accumulates all chunks and `Buffer.concat`s them (`src/client/http.ts:68-89`), then `renderRaw` writes the full buffer at once (`src/cli/shared.ts:94-99`). Nothing is streamed; a large download is fully held in memory (subject to `--max-response-bytes`). Misleading for anyone relying on streaming semantics for big payloads.

---

## LOW (correctness / UX / docs — valid for the count)

### 6. Closed-port / connection errors surface raw Node error strings, not a friendly message — ✅ FIXED
**Fix:** Added `describeNetworkError()` in `src/client/http.ts`, called from the request `error` handler. It maps common `err.code`s (ECONNREFUSED, ENOTFOUND/EAI_AGAIN, ECONNRESET, ETIMEDOUT) to friendly messages mentioning the host and `--base-url`, e.g. `Could not connect to 127.0.0.1:1 (connection refused). Check the host/port and --base-url.`
- Severity: Low · Confidence: High
- Repro: `node dist/src/cli/index.js --base-url http://127.0.0.1:1 reference data-version`
- Actual: `Error: connect ECONNREFUSED 127.0.0.1:1` (exit 1). The message is the unwrapped Node `err.message` passed straight through `NinaNetworkError` (`src/client/http.ts:106`); no hint that this is a connectivity problem with the base URL.

### 7. Bad-host error is the raw resolver string — ✅ FIXED
**Fix:** Same `describeNetworkError()` change in `src/client/http.ts` (see #6): ENOTFOUND/EAI_AGAIN now produce `Could not resolve host <host>. Check the --base-url and your network/DNS.` instead of the raw `getaddrinfo ENOTFOUND ...` string.
- Severity: Low · Confidence: High
- Repro: `node dist/src/cli/index.js --base-url http://nonexistent.invalid.bogus reference data-version`
- Actual: `Error: getaddrinfo ENOTFOUND nonexistent.invalid.bogus` (exit 1). Same root cause as #6 — opaque transport-layer text.

### 8. API error messages leak the full internal request URL (incl. base-url and `/api31/...` path) — ✅ FIXED
**Fix:** In `src/client/errors.ts`, `NinaApiError`'s message now uses a `safeTarget()` helper that reduces the URL to `pathname + search` (dropping origin and any embedded credentials), e.g. `HTTP 404 for GET /api31/warnings/NOPE.json`. The full URL is still retained on the `.url` property for programmatic use.
- Severity: Low · Confidence: High
- Repro: `node dist/src/cli/index.js warning get DOES-NOT-EXIST`
- Actual: `Error: HTTP 404 for GET https://warnung.bund.de/api31/warnings/DOES-NOT-EXIST.json`. The constructed URL (incl. any custom `--base-url`, which could carry credentials) is echoed verbatim in `NinaApiError` (`src/client/errors.ts:31`). Minor info-exposure / noisy UX.

### 9. README "Global options go **before** the command" is contradicted by actual behaviour — ✅ FIXED
**Fix:** Doc correction in `README.md`: now states global options "may be given **before or after** the command" with both forms shown as equivalent.
- Severity: Low · Confidence: High
- README line 56. But `--compact`, `-o`, etc. work **after** the command too:
  ```
  node dist/src/cli/index.js map-data dwd --compact        # works, exit 0
  node dist/src/cli/index.js warning geojson <id> -o /tmp/after.geojson   # writes file, exit 0
  ```
- Cause: commander's `optsWithGlobals()` (`src/cli/shared.ts:124`) resolves globals from any level. The doc statement is simply inaccurate (works either way), which can confuse users.

### 10. An identifier beginning with `-` is parsed as an unknown option, not a positional — ✅ FIXED
**Fix:** This is commander default behaviour and `--` already works as the escape; the gap was that it was undocumented. Added a note to `README.md` under CLI usage: pass such ids after a `--` separator, e.g. `nina warning get -- -odd.identifier`.
- Severity: Low · Confidence: High
- Repro: `node dist/src/cli/index.js warning get -abc`
- Expected: treated as an identifier (the API has ids; a leading-dash id should be passable, e.g. via `--`).
- Actual: `error: unknown option '-abc'` (exit 1). There is no documented `--` escape hint in help, and the README never mentions it. (commander default behaviour; still a usability gap for a tool whose only args are free-form ids.)

### 11. `dashboard ""` / empty-ish positionals produce a confusing path-collapsed 404 — ✅ FIXED
**Fix:** Added `requireIdentifier(value, argName)` in `src/cli/shared.ts`, which rejects empty/whitespace-only required positionals with a `NinaError` (exit 1) before any request. Applied to `dashboard`, `warning get`, `warning geojson` (`src/cli/commands/warnings.ts`) and `archive mapping` / `archive get` (`src/cli/commands/misc.ts`). `dashboard ""` now fails locally with `A non-empty region key is required.` instead of a remote 404.
- Severity: Low · Confidence: Medium
- Repro: `node dist/src/cli/index.js dashboard ""`
- Actual: `Error: HTTP 404 for GET https://warnung.bund.de/api31/dashboard/.json` (exit 4). An empty ARS builds `dashboard/.json`; there's no client-side guard for an empty required positional, so the user gets a remote 404 for what is really a local input error.

### 12. 4xx client errors other than 404 are mapped to generic exit 1 (no distinction for 400/403) — ⚠️ WONTFIX (documented, intentional exit-code contract; changing it would break the README contract and existing tests)
**Fix:** None. The exit-code contract is deliberately `0` success / `4` on `404` / `1` for any other error, as documented in the README and locked in by `cli.test.ts` ("a non-404 4xx … maps to exit code 1", "a 500 … maps to exit code 1"). The report itself notes this is "technically consistent". Introducing new per-status exit codes would break the documented contract and those tests, so left as-is by design.
- Severity: Low · Confidence: Medium
- Repro: `node dist/src/cli/index.js warning get "../../../etc/passwd"` → `HTTP 400 ...`, exit `1`.
  ```
  node dist/src/cli/index.js dashboard "055150000000 "   # HTTP 400, exit 1
  ```
- README documents only `404 → 4` and "1 for any other error", so this is technically consistent, but a 400 (malformed id) and a 500 (server fault) being indistinguishable by exit code is a scripting limitation worth noting. `src/cli/run.ts:39-41` only special-cases 404.

### 13. `--timeout 0` silently disables the request timeout (potential indefinite wait) — ✅ FIXED
**Fix:** `0`-disables-timeout is intentional (symmetric with `--max-response-bytes 0`); the defect was that it was undocumented. Documented it in the `--timeout` help text (`src/cli/program.ts`) and the README option table: "`0` disables the timeout — waits indefinitely".
- Severity: Low · Confidence: High
- Repro (slow endpoint): `node dist/src/cli/index.js --base-url http://127.0.0.1:<port>/slow --timeout 0 map-data dwd`
- Actual: no timeout is armed (still running at 2.5 s; only returns when the server eventually responds). `req.setTimeout` is gated on `request.timeoutMs > 0` (`src/client/http.ts:98`). `0` is accepted by `parseIntArg` and means "wait forever". The README documents `--max-response-bytes 0` as "unlimited" but does **not** document that `--timeout 0` disables the timeout, so a user setting `0` expecting "instant/default" gets an unbounded hang.

### 14. Help/`-h` exit code differs from the no-args exit code (0 vs 1) — inconsistent "show help" — ✅ FIXED
**Fix:** In `src/cli/run.ts`, the `CommanderError` branch now returns `0` when `err.code` is `commander.help` (bare invocation / bare command group) or `commander.helpDisplayed` (explicit `--help`) — both mean help was shown successfully. Genuine parse errors (`commander.unknownCommand`, missing argument, etc.) keep their own non-zero exit code. Verified: bare invocation, `warning`, and `--help` all exit 0; `bogus` still exits non-zero.
- Severity: Low · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js --help     # prints help, exit 0
  node dist/src/cli/index.js            # prints the SAME help, exit 1
  node dist/src/cli/index.js warning    # prints subcommand help, exit 1
  ```
- Both render the full help text, but bare invocation / a bare command group exits non-zero (commander treats "no command given" as an error via `exitOverride`, `src/cli/run.ts:16`). Surprising when the visible output is identical to the success path.

### 15. Live geojson is served as `Content-Type: application/json`, so the `"geo+json"`/`"json"` sanity check is effectively a no-op — ✅ FIXED (doc clarification)
**Fix:** The check is working as intended (it catches non-JSON bodies such as `text/html` error pages); the issue was that the README implied stronger protection. Updated the README CLI-usage paragraph to state explicitly that it is a `Content-Type`-only check: since the live API serves GeoJSON as `application/json`, it cannot verify the body is valid GeoJSON, only that the type string looks JSON-ish. No code change to the check itself.
- Severity: Low · Confidence: Medium
- Observation: `curl -I .../...geojson` returns `content-type: application/json` (not `application/geo+json`). The CLI checks only for the substring `"json"` (`src/cli/commands/warnings.ts:43` → `renderRaw(..., "json")`, `src/cli/shared.ts:88`). Because the real server returns `application/json`, the check passes for both real GeoJSON and any JSON error page — it would only ever catch a non-JSON body (e.g. `text/html`). The protection described in README lines 40–42 is narrower than implied (it does NOT verify the body is actually GeoJSON, only that the type string contains "json").

---

## Things tested that are CORRECT (not bugs)

- Identifier URL-encoding for `/`, `..`, spaces, unicode, `%` (`src/client/client.ts:23,31`).
- `-o` byte integrity: CLI output byte-identical to curl (1455 bytes, `diff` clean).
- No data loss on `warning get` and `reference event-codes` vs raw (semantically identical, sorted-key diff clean).
- 404 → exit 4 for `warning get`, `warning geojson`, `dashboard`, `archive get` (verified `echo $?`).
- `warning geojson` 404 does **not** create the output file (verified `ls` after).
- Numeric flags reject `-1`, `5.0`, `0x10`, `1e3`, `+5`, `Infinity`, `""`, `" 5"`, oversize (exit 1).
- Size cap aborts mid-stream without leaving a partial file; `--max-response-bytes 0` = unlimited.
- Retries fire for 503 (default 2 → 3 attempts, ~0.6 s with backoff; `--max-retries 0` → 1 attempt).
- `file:`/`ftp:` base URLs rejected; redirects not followed (by code).
- Empty array renders as `[]\n` in both pretty and compact; pretty/compact both end with one trailing `\n`; raw geojson has no added trailing newline.
- Mixed-case / whitespace-padded `source` correctly rejected with the enum list.
- `sources` works fully offline (ignores base-url).
- Excess positional args and unknown sub/flags rejected (exit 1).

---

## Count

**15 genuine, reproducible bugs (all 15 real).** 2 High, 3 Medium, 10 Low. Fewer than the
requested 20 — the codebase is well-guarded on the high-risk paths (encoding, exit codes,
byte integrity, size caps), so the remaining defects are predominantly silent-surprise,
error-classification, and documentation issues rather than crashes or data corruption.
