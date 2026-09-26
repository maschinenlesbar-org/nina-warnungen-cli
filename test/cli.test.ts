import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { NinaClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { NinaNetworkError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";

function makeCli(responder: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, Buffer>();
  const mt = makeMockTransport(responder);

  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: (p, d) => files.set(p, d),
      outBinary: (d) => out.push(d.toString("utf8")),
    },
    createClient: (opts) => new NinaClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, files, mt };
}

test("map-data hits the per-source path", async () => {
  const cli = makeCli(() => jsonResponse([{ id: "1" }]));
  const code = await run(["map-data", "mowas"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/api31/mowas/mapData.json");
});

test("map-data rejects an invalid source before any request", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const code = await run(["map-data", "bogus"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid source/);
});

test("sources lists the valid sources", async () => {
  const cli = makeCli(() => jsonResponse([]));
  await run(["sources"], cli.deps);
  assert.deepEqual(JSON.parse(cli.out.join("\n")), [
    "mowas",
    "katwarn",
    "biwapp",
    "dwd",
    "lhp",
    "police",
  ]);
});

test("warning geojson writes to a file with -o", async () => {
  const cli = makeCli(() => rawResponse('{"type":"FeatureCollection"}', "application/geo+json"));
  const code = await run(["-o", "out.geojson", "warning", "geojson", "abc"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.files.get("out.geojson")?.toString("utf8"), '{"type":"FeatureCollection"}');
  assert.match(cli.err.join("\n"), /Wrote \d+ bytes to out\.geojson/);
});

test("dashboard builds the right path", async () => {
  const cli = makeCli(() => jsonResponse([]));
  await run(["dashboard", "055150000000"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).pathname, "/api31/dashboard/055150000000.json");
});

test("a 404 from the API maps to exit code 4", async () => {
  const cli = makeCli(() => jsonResponse({ message: "missing" }, 404));
  const code = await run(["warning", "get", "nope"], cli.deps);
  assert.equal(code, 4);
});

test("a non-404 4xx from the API maps to exit code 1", async () => {
  const cli = makeCli(() => jsonResponse({ message: "bad request" }, 400));
  const code = await run(["warning", "get", "nope"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /HTTP 400/);
});

test("a 500 from the API maps to exit code 1", async () => {
  const cli = makeCli(() => jsonResponse({ message: "boom" }, 500));
  const code = await run(["map-data", "dwd"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /HTTP 500/);
});

test("a network error maps to exit code 1", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: () => {},
      outBinary: () => {},
    },
    createClient: (opts) =>
      new NinaClient({
        ...opts,
        transport: () => Promise.reject(new NinaNetworkError("connection reset")),
      }),
  };
  const code = await run(["map-data", "dwd"], deps);
  assert.equal(code, 1);
  assert.match(err.join("\n"), /connection reset/);
});

test("a malformed JSON body maps to exit code 1 (NinaParseError)", async () => {
  const cli = makeCli(() => rawResponse("not json", "application/json"));
  const code = await run(["map-data", "dwd"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /Failed to parse JSON/);
});

test("an --output write failure maps to exit code 1", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(() =>
    rawResponse('{"type":"FeatureCollection"}', "application/geo+json"),
  );
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: () => {
        const e = new Error("EACCES: permission denied");
        (e as NodeJS.ErrnoException).code = "EACCES";
        throw e;
      },
      outBinary: (d) => out.push(d.toString("utf8")),
    },
    createClient: (opts) => new NinaClient({ ...opts, transport: mt.transport }),
  };
  const code = await run(["-o", "/no/such/dir/out.geojson", "warning", "geojson", "abc"], deps);
  assert.equal(code, 1);
  assert.match(err.join("\n"), /EACCES/);
});

test("warning geojson warns when the content-type is not JSON", async () => {
  const cli = makeCli(() => rawResponse("<html>error</html>", "text/html"));
  const code = await run(["warning", "geojson", "abc"], cli.deps);
  assert.equal(code, 0);
  assert.match(cli.err.join("\n"), /Warning: expected a "json" response/);
});

test("warning get builds the warnings path", async () => {
  const cli = makeCli(() => jsonResponse({ identifier: "abc" }));
  const code = await run(["warning", "get", "abc.123"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/api31/warnings/abc.123.json");
});

test("archive get builds the archive path", async () => {
  const cli = makeCli(() => jsonResponse({ identifier: "x" }));
  const code = await run(["archive", "get", "DE-BW-X"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/api31/archive.mowas/DE-BW-X.json");
});

test("archive mapping builds the -mapping.json path", async () => {
  const cli = makeCli(() => jsonResponse({ history: [] }));
  const code = await run(["archive", "mapping", "DE-BW-X"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/api31/archive.mowas/DE-BW-X-mapping.json");
});

test("reference event-codes builds the eventCodes path", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["reference", "event-codes"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/api31/appdata/gsb/eventCodes/eventCodes.json");
});

test("reference data-version builds the dataVersion path", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["reference", "data-version"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/api31/dynamic/version/dataVersion.json");
});

test("reference notfalltipps builds the appdata path", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["reference", "notfalltipps"], cli.deps);
  assert.equal(code, 0);
  assert.equal(
    new URL(cli.mt.last().url).pathname,
    "/api31/appdata/gsb/notfalltipps/DE/notfalltipps.json",
  );
});

test("--compact prints JSON on a single line", async () => {
  const cli = makeCli(() => jsonResponse([{ id: "1" }]));
  const code = await run(["--compact", "map-data", "dwd"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.out.join("\n"), '[{"id":"1"}]');
});

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const served = [{ id: "1", headline: `Unwetter${controls}`, sender: String.fromCharCode(0x1b) + "[31m" }];
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "map-data", "dwd"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) => c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f);
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /Unwetter\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), served);
  }
});

test("--timeout rejects a non-integer value with a usage error", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const code = await run(["--timeout", "abc", "map-data", "dwd"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /non-negative integer/);
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse([]));
  assert.equal(await run(["--timeout", "2147483647", "map-data", "dwd"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli(() => jsonResponse([]));
  assert.equal(await run(["--timeout", "2147483648", "map-data", "dwd"], over.deps), 1);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), /between 0 and 2147483647/);
});

test("a bare invocation prints help to stdout (not stderr) and exits 0", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const code = await run([], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.equal(cli.err.length, 0); // help went to stdout, not stderr
  assert.match(cli.out.join("\n"), /Usage: nina/);
});

test("a global flag with no command prints help to stdout, exit 0", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const code = await run(["--compact"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.err.length, 0);
  assert.match(cli.out.join("\n"), /Usage: nina/);
});

test("a bare command group prints its help to stdout, exit 0", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const code = await run(["warning"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.err.length, 0);
  assert.match(cli.out.join("\n"), /get|geojson/);
});

test("an unknown command still errors on stderr with exit 1", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const code = await run(["boguscmd"], cli.deps);
  assert.equal(code, 1);
  assert.equal(cli.out.length, 0);
  assert.match(cli.err.join("\n"), /unknown command 'boguscmd'/);
});

test("--version prints to stdout and exits 0", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const code = await run(["--version"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.err.length, 0);
  assert.match(cli.out.join("\n"), /\d+\.\d+\.\d+/);
});

test("--max-retries rejects a value above 10 as a usage error", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const code = await run(["--max-retries", "11", "map-data", "dwd"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /between 0 and 10/);
});

test("an identifier containing a path separator is rejected before any request", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["warning", "get", "--", "../../etc/passwd"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /must not contain a path separator/);
});

test("--base-url rejects a non-http(s) or malformed URL as a usage error", async () => {
  for (const bad of ["file:///etc/passwd", "ftp://example.org", "notaurl"]) {
    const cli = makeCli(() => jsonResponse([]));
    const code = await run(["--base-url", bad, "map-data", "dwd"], cli.deps);
    assert.notEqual(code, 0, bad);
    assert.equal(cli.mt.calls.length, 0, bad);
    assert.match(cli.err.join("\n"), /--base-url/, bad);
  }
});

function redirectResponse(status: number, location?: string): HttpResponse {
  return {
    status,
    headers: location === undefined ? {} : { location },
    body: Buffer.alloc(0),
  };
}

test("a warning id that is no longer live (302 to the archive) exits 4 with a hint", async () => {
  const archive = (req: HttpRequest) =>
    redirectResponse(
      302,
      `https://warnung.bund.de/api31/archive/alerts/${new URL(req.url).pathname.split("/").pop()!.replace(/\.(json|geojson)$/, "")}?contentType=json`,
    );
  for (const cmd of ["get", "geojson"]) {
    const cli = makeCli(archive);
    const code = await run(["warning", cmd, "mow.DE-SL-SLS-W038-20260901-000"], cli.deps);
    assert.equal(code, 4, cmd);
    assert.equal(cli.mt.calls.length, 1, cmd);
    const err = cli.err.join("\n");
    assert.match(err, /"mow\.DE-SL-SLS-W038-20260901-000" is not a live warning/, cmd);
    assert.match(
      err,
      /archive \(https:\/\/warnung\.bund\.de\/api31\/archive\/alerts\/mow\.DE-SL-SLS-W038-20260901-000\?contentType=json\)/,
      cmd,
    );
    assert.equal(cli.out.length, 0, cmd);
  }
});

test("any other 3xx stays exit 1 and names the redirect target", async () => {
  const cli = makeCli(() => redirectResponse(301, "https://elsewhere.test/x"));
  assert.equal(await run(["warning", "get", "abc"], cli.deps), 1);
  assert.match(cli.err.join("\n"), /HTTP 301 for GET \/api31\/warnings\/abc\.json: redirect to https:\/\/elsewhere\.test\/x not followed/);

  const bare = makeCli(() => redirectResponse(302));
  assert.equal(await run(["map-data", "dwd"], bare.deps), 1);
  assert.match(bare.err.join("\n"), /HTTP 302 for GET .*: redirect not followed \(no Location header\)/);
});

test("dashboard rejects a state-level key (a false all-clear) before any request", async () => {
  for (const ars of ["050000000000", "100000000000", "040000000000", "000000000000"]) {
    const cli = makeCli(() => jsonResponse([]));
    const code = await run(["dashboard", ars], cli.deps);
    assert.equal(code, 1, ars);
    assert.equal(cli.mt.calls.length, 0, ars);
    assert.match(cli.err.join("\n"), new RegExp(`Region key "${ars}" is not a district key`), ars);
  }
  // Hamburg and Berlin are their own district.
  for (const ars of ["020000000000", "110000000000"]) {
    const cli = makeCli(() => jsonResponse([]));
    assert.equal(await run(["dashboard", ars], cli.deps), 0, ars);
    assert.equal(cli.mt.calls.length, 1, ars);
  }
});

test("dashboard checks the ARS shape locally and suggests the district key", async () => {
  const cases: Array<[string, RegExp]> = [
    ["55150000000", /Invalid region key "55150000000": expected a 12-digit district-level ARS.*try "055150000000"/],
    [" 055150000000", /Invalid region key " 055150000000": expected a 12-digit/],
    ["10042", /use "100420000000"/],
    ["10044000000a", /Invalid region key "10044000000a"/],
    ["06535011", /AGS .* district "065350000000"/],
    ["100420111000", /Region key "100420111000" is not a district key: the last seven digits must be 0.*"100420000000"/],
  ];
  for (const [ars, message] of cases) {
    const cli = makeCli(() => jsonResponse([]));
    const code = await run(["dashboard", ars], cli.deps);
    assert.equal(code, 1, ars);
    assert.equal(cli.mt.calls.length, 0, ars);
    assert.match(cli.err.join("\n"), message, ars);
  }
});

test("archive get accepts a revision identifier with the .json suffix archive mapping prints", async () => {
  const cli = makeCli(() => jsonResponse({ identifier: "x" }));
  const code = await run(["archive", "get", "mow.DE-SL-SLS-W038-20260904-000_20260904130528.json"], cli.deps);
  assert.equal(code, 0);
  assert.equal(
    new URL(cli.mt.last().url).pathname,
    "/api31/archive.mowas/mow.DE-SL-SLS-W038-20260904-000_20260904130528.json",
  );
});

test("--base-url with a query or fragment is a usage error", async () => {
  for (const bad of ["http://127.0.0.1:1/ok#frag", "http://127.0.0.1:1/ok?x=1", "https://warnung.bund.de/?"]) {
    const cli = makeCli(() => jsonResponse([]));
    const code = await run(["--base-url", bad, "map-data", "dwd"], cli.deps);
    assert.equal(code, 1, bad);
    assert.equal(cli.mt.calls.length, 0, bad);
    assert.match(cli.err.join("\n"), /A base URL cannot have a query \(\?\) or fragment \(#\)\./, bad);
  }
  // A path prefix (a mirror) still works.
  const ok = makeCli(() => jsonResponse([]));
  assert.equal(await run(["--base-url", "https://mirror.test/nina/", "map-data", "dwd"], ok.deps), 0);
  assert.equal(ok.mt.last().url, "https://mirror.test/nina/api31/dwd/mapData.json");
});

test("warning geojson to a terminal escapes control characters; to a pipe it is byte-exact", async () => {
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const body = Buffer.from(`{"type":"FeatureCollection","n":"${ESC}]0;TITLE${BEL}${ESC}[31mred${String.fromCharCode(0x9b)}2J"}`, "utf8");

  // Terminal (and the safe default of an I/O without isTerminal): escaped.
  for (const terminal of [true, undefined]) {
    const cli = makeCli(() => rawResponse(body, "application/geo+json"));
    if (terminal !== undefined) cli.deps.io.isTerminal = () => terminal;
    assert.equal(await run(["warning", "geojson", "x"], cli.deps), 0);
    const text = cli.out.join("");
    assert.ok(![...text].some((c) => c.charCodeAt(0) === 0x1b || c.charCodeAt(0) === 0x07 || c.charCodeAt(0) === 0x9b), String(terminal));
    assert.match(text, /\\u001b\]0;TITLE\\u0007\\u001b\[31mred\\u009b2J/);
    // Still valid JSON carrying the same value.
    assert.equal(JSON.parse(text).n, `${ESC}]0;TITLE${BEL}${ESC}[31mred${String.fromCharCode(0x9b)}2J`);
  }

  // A pipe: the exact bytes.
  const written: Buffer[] = [];
  const cli = makeCli(() => rawResponse(body, "application/geo+json"));
  cli.deps.io.isTerminal = () => false;
  cli.deps.io.outBinary = (d) => written.push(d);
  assert.equal(await run(["warning", "geojson", "x"], cli.deps), 0);
  assert.equal(written.length, 1);
  assert.ok(written[0]!.equals(body));
});
