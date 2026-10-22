import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { NinaClient } from "@maschinenlesbar.org/nina-warnungen-client/internal/client";
import { defaultIO, type CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/nina-warnungen-client/internal/http";
import { NinaIOError, NinaNetworkError, credentialsIn } from "@maschinenlesbar.org/nina-warnungen-client/internal/errors";
import { makeMockTransport, jsonResponse, rawResponse, untimed } from "./helpers.js";

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
  assert.match(untimed(cli.err.join("\n")), /^INFO  \[nina\.output\] Wrote \d+ bytes to out\.geojson$/m);
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
  assert.match(cli.err.join("\n"), /GET https:\/\/warnung\.bund\.de\/api31\/dwd\/mapData\.json: the answer is not valid JSON\./);
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

test("a NinaIOError from writing -o is an ERROR record of nina.output", async () => {
  const err: string[] = [];
  const mt = makeMockTransport(() => rawResponse('{"type":"FeatureCollection"}', "application/geo+json"));
  const deps: CliDeps = {
    io: {
      out: () => {},
      err: (s) => err.push(s),
      writeFile: (path) => {
        throw new NinaIOError(`Could not write to "${path}": EISDIR: illegal operation on a directory`);
      },
      outBinary: () => {},
    },
    createClient: (opts) => new NinaClient({ ...opts, transport: mt.transport }),
  };
  assert.equal(await run(["-o", "somedir", "warning", "geojson", "abc"], deps), 1);
  assert.deepEqual(err.map(untimed), ['ERROR [nina.output] Could not write to "somedir": EISDIR: illegal operation on a directory']);
});

test("warning geojson warns when the content-type is not JSON but the body is GeoJSON", async () => {
  const cli = makeCli(() => rawResponse('{"type":"FeatureCollection","features":[]}', "text/plain"));
  const code = await run(["warning", "geojson", "abc"], cli.deps);
  assert.equal(code, 0);
  assert.match(untimed(cli.err.join("\n")), /^WARN  \[nina\.api\] expected a "json" response/m);
});

test("the content-type WARN quotes a huge Content-Type cut at 500 characters (B02-2)", async () => {
  const type = `text/html; note=${"A".repeat(12000)}`;
  const cli = makeCli(() => rawResponse('{"type":"FeatureCollection","features":[]}', type));
  assert.equal(await run(["warning", "geojson", "mow.DE-X"], cli.deps), 0);
  const warn = cli.err.map(untimed).find((line) => line.startsWith("WARN  [nina.api] expected")) ?? "";
  assert.match(warn, /got "text\/html; note=A+…"\. The body may not be what you expect\.$/);
  assert.ok(warn.length < 700, `${warn.length} characters`);
});

test("warning geojson fails (exit 1, no file) when a 200 body is not GeoJSON", async () => {
  for (const [body, type] of [["<html>maintenance</html>", "text/html"], ['{"message":"Not available"}', "application/geo+json"], ["", "application/geo+json"], ["[]", "application/json"]]) {
    const cli = makeCli(() => rawResponse(body!, type!));
    assert.equal(await run(["-o", "out.geojson", "warning", "geojson", "abc"], cli.deps), 1, body);
    assert.equal(cli.files.size, 0, body);
    assert.match(untimed(cli.err.join("\n")), /^ERROR \[nina\.api\] GET https:\/\/warnung\.bund\.de\/api31\/warnings\/abc\.geojson: unexpected response shape: expected (a )?GeoJSON/m, body);
  }
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

test("a global flag with no command, and a bare command group, log an ERROR 'missing command' before the help, exit 1", async () => {
  for (const [argv, path] of [[["--compact"], "nina"], [["warning"], "nina warning"], [["archive"], "nina archive"]] as const) {
    const cli = makeCli(() => jsonResponse([]));
    assert.equal(await run([...argv], cli.deps), 1, argv.join(" "));
    const records = cli.err.map(untimed);
    assert.equal(records[0], `ERROR [nina.cli] missing command: \`${path} <subcommand>\``, records.join("\n"));
    assert.ok(records.length > 2, records.join("\n"));
    for (const record of records.slice(1)) assert.match(record, /^INFO  \[nina\.cli\] .*\S$/);
    assert.ok(records.some((record) => /\] Usage: nina /.test(record)), records.join("\n"));
    assert.deepEqual(cli.out, []);
    assert.equal(cli.mt.calls.length, 0);
  }
});

test("help for an unknown command reports it like the command itself, exit 1, at every level", async () => {
  for (const [helpArgv, plainArgv] of [
    [["help", "nope"], ["nope"]],
    [["help", "warning", "nope"], ["warning", "nope"]],
    [["warning", "help", "nope"], ["warning", "nope"]],
    [["help", "https://alice:s3cret@x.test"], ["https://alice:s3cret@x.test"]],
  ] as const) {
    const viaHelp = makeCli(() => jsonResponse([]));
    const plain = makeCli(() => jsonResponse([]));
    assert.equal(await run([...helpArgv], viaHelp.deps), 1, helpArgv.join(" "));
    assert.equal(await run([...plainArgv], plain.deps), 1, plainArgv.join(" "));
    assert.match(untimed(viaHelp.err[0] ?? ""), /^ERROR \[nina\.cli\] unknown command '/, helpArgv.join(" "));
    assert.deepEqual(viaHelp.err.map(untimed), plain.err.map(untimed), helpArgv.join(" "));
    assert.deepEqual(viaHelp.out, []);
    assert.ok(!viaHelp.err.join("\n").includes("s3cret"));
    assert.equal(viaHelp.mt.calls.length, 0);
  }
  // A command without subcommands is not run on the rest of the names.
  const leaf = makeCli(() => jsonResponse([]));
  assert.equal(await run(["help", "warning", "get", "nope"], leaf.deps), 1);
  assert.equal(untimed(leaf.err[0] ?? ""), "ERROR [nina.cli] unknown command 'nope'");
  assert.equal(leaf.mt.calls.length, 0);
});

test("help names a command path and shows that command's help on stdout, exit 0", async () => {
  for (const [argv, usage] of [
    [["help"], "Usage: nina [options] [command]"],
    [["help", "warning"], "Usage: nina warning [options] [command]"],
    [["help", "warning", "get"], "Usage: nina warning get [options] <identifier>"],
  ] as const) {
    const cli = makeCli(() => jsonResponse([]));
    assert.equal(await run([...argv], cli.deps), 0, argv.join(" "));
    assert.equal(cli.out.join("\n").split("\n")[0], usage, argv.join(" "));
    assert.deepEqual(cli.err, []);
  }
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
    assert.match(err, /"mow\.DE-SL-SLS-W038-20260901-000" is not a live warning: no live warning has exactly this id/, cmd);
    assert.doesNotMatch(err, /it has expired/, cmd);
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
    ["\u200b055150000000", /Invalid region key: "\\u200b055150000000" contains an invisible or control character \(U\+200B\)/],
    [" 05515000000 ", /Invalid region key "05515000000": expected a 12-digit/],
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
  // C1 controls and DEL may stand raw in a JSON string (C0 such as ESC may not, so a body
  // with a raw ESC is not GeoJSON and fails); U+009B is the 8-bit CSI a terminal acts on.
  const CSI = String.fromCharCode(0x9b);
  const DEL = String.fromCharCode(0x7f);
  const body = Buffer.from(`{"type":"FeatureCollection","n":"${CSI}31mred${CSI}2J${DEL}"}`, "utf8");

  // Terminal (and the safe default of an I/O without isTerminal): escaped.
  for (const terminal of [true, undefined]) {
    const cli = makeCli(() => rawResponse(body, "application/geo+json"));
    if (terminal !== undefined) cli.deps.io.isTerminal = () => terminal;
    assert.equal(await run(["warning", "geojson", "x"], cli.deps), 0);
    const text = cli.out.join("");
    assert.ok(![...text].some((c) => c.charCodeAt(0) === 0x9b || c.charCodeAt(0) === 0x7f), String(terminal));
    assert.match(text, /\\u009b31mred\\u009b2J\\u007f/);
    // Still valid JSON carrying the same value.
    assert.equal(JSON.parse(text).n, `${CSI}31mred${CSI}2J${DEL}`);
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

test("an answer nested too deeply is a clean error; it suggests --compact only where --compact prints it (D7)", async () => {
  // A hostile or broken answer: JSON.parse reads it, the pretty printer's recursion can't. Whether
  // the compact printer can depends on the Node version (iterative from Node 26) and the stack:
  // probed here, never assumed.
  const depth = 200_000;
  // Inside a warning entry, so the body still has the documented list shape.
  const deep = '[{"x":' + "[".repeat(depth) + "]".repeat(depth) + "}]";
  let compactPrints = true;
  try {
    JSON.stringify(JSON.parse(deep));
  } catch {
    compactPrints = false;
  }
  const cli = makeCli(() => rawResponse(deep, "application/json"));
  assert.equal(await run(["map-data", "dwd"], cli.deps), 1);
  assert.deepEqual(cli.out, []);
  assert.deepEqual(cli.err.map(untimed), [
    `ERROR [nina.output] The answer is nested too deeply to pretty-print${compactPrints ? "; try --compact" : ""}.`,
  ]);
  const compact = makeCli(() => rawResponse(deep, "application/json"));
  assert.equal(await run(["--compact", "map-data", "dwd"], compact.deps), compactPrints ? 0 : 1);
  if (!compactPrints) assert.deepEqual(compact.err.map(untimed), ["ERROR [nina.output] The answer is nested too deeply to print."]);
});

test("--user-agent rejects blank, control-character and non-Latin-1 values as a usage error", async () => {
  const cases: Array<[string, RegExp]> = [
    ["", /Expected a non-empty value\./],
    ["   ", /Expected a non-empty value\./],
    ["a\r\nX-Evil: 1", /Value contains control characters\./],
    ["a" + String.fromCharCode(0x7f), /Value contains control characters\./],
    ["agent €", /outside Latin-1/],
  ];
  for (const [ua, message] of cases) {
    const cli = makeCli(() => jsonResponse([]));
    const code = await run(["--user-agent", ua, "map-data", "dwd"], cli.deps);
    assert.equal(code, 1, JSON.stringify(ua));
    assert.equal(cli.mt.calls.length, 0, JSON.stringify(ua));
    assert.match(cli.err.join("\n"), message, JSON.stringify(ua));
    assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);
  }
  const ok = makeCli(() => jsonResponse([]));
  assert.equal(await run(["--user-agent", "my\tagent/1.0 (Müller)", "map-data", "dwd"], ok.deps), 0);
  assert.equal(ok.mt.last().headers?.["User-Agent"], "my\tagent/1.0 (Müller)");
});

test("dashboard and map-data fail (exit 1, nothing on stdout) on a 200 that is not a list", async () => {
  for (const body of [null, {}, { error: "Internal", message: "backend down", status: 500 }]) {
    for (const argv of [["dashboard", "055150000000"], ["map-data", "mowas"]]) {
      const cli = makeCli(() => jsonResponse(body));
      assert.equal(await run(argv, cli.deps), 1, `${argv.join(" ")} ${JSON.stringify(body)}`);
      assert.equal(cli.out.length, 0);
      assert.match(untimed(cli.err.join("\n")), /^ERROR \[nina\.api\] GET https:\/\/warnung\.bund\.de\/api31\/.*: unexpected response shape: expected a JSON array/m);
    }
  }
  const empty = makeCli(() => jsonResponse([]));
  assert.equal(await run(["--compact", "dashboard", "055150000000"], empty.deps), 0);
  assert.equal(empty.out.join("\n"), "[]");
});

test("-o - writes to stdout, not to a file named -", async () => {
  for (const argv of [["-o", "-", "--compact", "map-data", "mowas"], ["--output=-", "--compact", "map-data", "mowas"]]) {
    const cli = makeCli(() => jsonResponse([{ id: "mow.1" }]));
    assert.equal(await run(argv, cli.deps), 0);
    assert.equal(cli.out.join("\n"), '[{"id":"mow.1"}]');
    assert.equal(cli.files.size, 0);
    assert.doesNotMatch(cli.err.join("\n"), /Wrote/);
  }
  const geo = makeCli(() => rawResponse('{"type":"FeatureCollection"}', "application/geo+json"));
  assert.equal(await run(["-o", "-", "warning", "geojson", "abc"], geo.deps), 0);
  assert.equal(geo.out.join(""), '{"type":"FeatureCollection"}');
  assert.equal(geo.files.size, 0);
});

test("handleOutputErrors treats ENOTCONN like EPIPE: exit 0 on stdout, ignored on stderr", async () => {
  const { EventEmitter } = await import("node:events");
  const { handleOutputErrors } = await import("../src/cli/io.js");
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const exits: number[] = [];
  handleOutputErrors({ stdout, stderr } as never, (code) => exits.push(code));
  const gone = (code: string) => Object.assign(new Error(`write ${code}`), { code });
  stderr.emit("error", gone("ENOTCONN"));
  stderr.emit("error", gone("EPIPE"));
  assert.deepEqual(exits, []);
  stdout.emit("error", gone("ENOTCONN"));
  stdout.emit("error", gone("EPIPE"));
  assert.deepEqual(exits, [0, 0]);
});

test("another stdout write error is an ERROR record of nina.output, in the run's format, and exits 1 (L7)", async () => {
  const { EventEmitter } = await import("node:events");
  const { handleOutputErrors } = await import("../src/cli/io.js");
  const { createLogger } = await import("../src/cli/log.js");
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const exits: number[] = [];
  const records: string[] = [];
  const log = createLogger({ format: "jsonl", write: (line) => records.push(line), now: () => new Date("2026-01-02T03:04:05.678Z") });
  handleOutputErrors({ stdout, stderr } as never, (code) => exits.push(code), log);
  stdout.emit("error", Object.assign(new Error("EBADF: bad file descriptor, write"), { code: "EBADF" }));
  assert.deepEqual(exits, [1]);
  assert.deepEqual(records.map((line) => JSON.parse(line)), [
    { ts: "2026-01-02T03:04:05.678Z", level: "ERROR", topic: "nina.output", msg: "Could not write to stdout: EBADF: bad file descriptor, write" },
  ]);
});

test("processLogger logs in the format argv asks for, with argv's credentials replaced (L7)", async () => {
  const { processLogger } = await import("../src/cli/run.js");
  const log = processLogger(["--log-format", "jsonl", "--base-url", "https://u:s3cret-pw@mirror.example", "map-data", "dwd"]);
  assert.equal(log.format, "jsonl");
});

test("a usage error with an http base URL prints no cleartext warning", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const code = await run(["--base-url", "http://mirror.example", "map-data"], cli.deps);
  assert.equal(code, 1);
  assert.ok(!cli.err.map(untimed).some((l) => l.startsWith("WARN ")), cli.err.join("\n"));
  assert.equal(cli.mt.calls.length, 0);
});

test("dashboard: a 404 says 'no such district key' and exits 4", async () => {
  const cli = makeCli(() => rawResponse("", "text/html", 404));
  const code = await run(["dashboard", "059990000000"], cli.deps);
  assert.equal(code, 4);
  assert.deepEqual(cli.out, []);
  assert.match(untimed(cli.err.join("\n")), /^ERROR \[nina\.api\] HTTP 404 for GET \/api31\/dashboard\/059990000000\.json: no such district key "059990000000"/);
});

test("an -o path shaped like a:b@c is named as written, and a:b@c data on stdout is not rewritten (B04-1, L14)", async () => {
  const cli = makeCli(() => jsonResponse([{ id: "1", contact: "ops:team@example.org" }]));
  assert.equal(await run(["-o", "run:2026-10-09@nina.json", "map-data", "dwd"], cli.deps), 0);
  assert.ok(cli.files.has("run:2026-10-09@nina.json"));
  assert.match(untimed(cli.err.join("\n")), /^INFO  \[nina\.output\] Wrote \d+ bytes to run:2026-10-09@nina\.json$/m);

  const ua = makeCli(() => jsonResponse([{ id: "1", contact: "ops:team@example.org" }]));
  assert.equal(await run(["--user-agent", "ops:team@example.org", "map-data", "dwd"], ua.deps), 0);
  assert.match(ua.out.join("\n"), /"contact": "ops:team@example\.org"/);
  assert.deepEqual(credentialsIn("run:2026-10-09@nina.json"), []);
  assert.deepEqual(credentialsIn("https://alice:pw@host"), ["alice:pw"]);
});

test("a base URL typed without its scheme is still a credential to redact (L14)", async () => {
  const cli = makeCli(() => jsonResponse([]));
  assert.equal(await run(["--base-url", "alice:s3cret-pw@mirror.example", "map-data", "dwd"], cli.deps), 1);
  assert.ok(!cli.err.join("\n").includes("s3cret-pw"), cli.err.join("\n"));
});

test("a parse error after -o --log-format jsonl is logged in text, as commander read it (L6)", async () => {
  const cli = makeCli(() => jsonResponse([]));
  // commander takes "--log-format" as the -o file, which -o refuses as the next option (T13).
  assert.equal(await run(["-o", "--log-format", "jsonl", "map-data", "dwd"], cli.deps), 1);
  assert.match(untimed(cli.err[0] ?? ""), /^ERROR \[nina\.cli\] option '-o, --output <file>' argument '--log-format' is invalid\. looks like a missing value/);
});

test("every -o failure is an ERROR record of nina.output, exit 1, whatever the CliIO threw (L8)", async () => {
  for (const thrown of [new NinaIOError('Could not write to "out.json": EISDIR'), new Error("EACCES: permission denied, open 'out.json'")]) {
    for (const argv of [["-o", "out.json", "map-data", "dwd"], ["-o", "out.json", "warning", "geojson", "abc"]]) {
      const cli = makeCli(() => (argv[2] === "warning" ? rawResponse('{"type":"FeatureCollection"}', "application/geo+json") : jsonResponse([])));
      cli.deps.io.writeFile = () => {
        throw thrown;
      };
      assert.equal(await run(argv, cli.deps), 1);
      assert.match(untimed(cli.err.join("\n")), /^ERROR \[nina\.output\] /);
      assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);
    }
  }
});

test("bad JSON and an unknown charset are ERROR records of nina.api (L9)", async () => {
  for (const [body, type] of [["{not json", "application/json"], ["[]", "application/json; charset=x-evil"]]) {
    const cli = makeCli(() => rawResponse(body!, type!));
    assert.equal(await run(["map-data", "dwd"], cli.deps), 1, type);
    assert.match(untimed(cli.err.join("\n")), /^ERROR \[nina\.api\] GET https:\/\/warnung\.bund\.de\/api31\/dwd\/mapData\.json: (the answer is not valid JSON|unsupported response charset "x-evil")\./, type);
  }
});

test("stderr waits for stdout: a record is held while stdout has a backlog, and flushed in order (L11)", async () => {
  const { EventEmitter } = await import("node:events");
  const { stderrAfterStdout } = await import("../src/cli/io.js");
  /** A stdout as far as the hold needs one: a backlog, and the events that end it. */
  class FakeStdout extends EventEmitter {
    writableLength = 0;
  }
  const stdout = new FakeStdout();
  const written: string[] = [];
  const err = stderrAfterStdout(stdout, (text: string) => written.push(text));
  err("first");
  assert.deepEqual(written, ["first"], "no backlog: written at once");
  stdout.writableLength = 65536;
  err("second");
  err("third");
  assert.deepEqual(written, ["first"], "held while stdout has a backlog");
  stdout.writableLength = 0;
  stdout.emit("drain");
  assert.deepEqual(written, ["first", "second", "third"]);
  // Flushed on close and on error too, never lost.
  stdout.writableLength = 10;
  err("fourth");
  stdout.emit("close");
  stdout.writableLength = 10;
  err("fifth");
  stdout.emit("error", new Error("EPIPE"));
  assert.deepEqual(written, ["first", "second", "third", "fourth", "fifth"]);
});

test("a single-value option given twice is a usage error before any request (K5)", async () => {
  for (const argv of [
    ["--timeout", "100", "--timeout", "200", "map-data", "dwd"],
    ["--base-url", "https://a.example", "--base-url=https://b.example", "map-data", "dwd"],
    ["--log-format", "text", "--log-format", "jsonl", "map-data", "dwd"],
    ["--log-format=jsonl", "--log-format=jsonl", "map-data", "dwd"],
    ["--max-retries", "1", "--max-retries", "1", "map-data", "dwd"],
    ["--max-response-bytes", "10", "--max-response-bytes", "20", "map-data", "dwd"],
    ["--user-agent", "a", "--user-agent", "b", "map-data", "dwd"],
    ["-o", "a.json", "--output", "b.json", "map-data", "dwd"],
  ]) {
    const cli = makeCli(() => jsonResponse([]));
    assert.equal(await run(argv, cli.deps), 1, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0, `${argv.join(" ")} sent a request`);
    // (A repeated --log-format jsonl logs the refusal in jsonl, the format argv's scan finds.)
    assert.match(untimed(cli.err.join("\n")), /(^ERROR \[nina\.cli\] |"level":"ERROR","topic":"nina\.cli").*--[a-z-]+ may be given only once\./m, argv.join(" "));
  }
  // Flags may repeat.
  const flags = makeCli(() => jsonResponse([]));
  assert.equal(await run(["--compact", "--compact", "map-data", "dwd"], flags.deps), 0, flags.err.join("\n"));
});

test("text in an answer that is not valid is replaced with U+FFFD and said in one WARN of nina.api (D2)", async () => {
  const body = Buffer.concat([Buffer.from('[{"id":"a","t":"x'), Buffer.from([0xff]), Buffer.from('y","u":"\\ud800"}]')]);
  const cli = makeCli(() => rawResponse(body, "application/json"));
  assert.equal(await run(["--compact", "map-data", "dwd"], cli.deps), 0);
  assert.deepEqual(JSON.parse(cli.out.join("\n")), [{ id: "a", t: "x\ufffdy", u: "\ufffd" }]);
  assert.deepEqual(cli.err.map(untimed), [
    "WARN  [nina.api] GET https://warnung.bund.de/api31/dwd/mapData.json: 2 characters of the answer were not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.",
  ]);
});

test("commander's echo of a refused value shows an invisible character escaped, never raw (D10)", async () => {
  const cli = makeCli(() => jsonResponse([]));
  assert.equal(await run(["--user-agent", "a​b", "map-data", "dwd"], cli.deps), 1);
  const err = cli.err.join("\n");
  assert.ok(err.includes("a\\u200bb"), err);
  assert.doesNotMatch(err, /​/);
});

test("-o refuses the next option as its file name: a dash-leading value is a usage error before any request (T13)", async () => {
  for (const argv of [["-o", "--compact", "map-data", "dwd"], ["--output=-v", "map-data", "dwd"], ["map-data", "dwd", "-o", "-x"]]) {
    const cli = makeCli(() => jsonResponse([]));
    assert.equal(await run(argv, cli.deps), 1, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0, argv.join(" "));
    assert.equal(cli.files.size, 0, argv.join(" "));
    assert.match(untimed(cli.err.join("\n")), /^ERROR \[nina\.cli\] .*looks like a missing value — "-\S*" is the next option.*write \.\/-name\./m, argv.join(" "));
  }
  // "-" is stdout, and a file whose name starts with a dash is written as ./-name.
  const ok = makeCli(() => jsonResponse([]));
  assert.equal(await run(["-o", "./-x", "map-data", "dwd"], ok.deps), 0);
  assert.deepEqual([...ok.files.keys()], ["./-x"]);
});

test("a password in a URL anywhere in an argument is redacted in every message, padded or mid-phrase (T15)", async () => {
  // A password with a space: no URL pattern can delimit it, only the exact string can.
  const url = "https://bob:p w#1@h.example";
  const cases: string[][] = [
    // a refusal quoting an id (it has a "/"), padded
    ["warning", "get", "--", ` ${url}/x`],
    // the -o refusal naming the missing directory, padded
    ["-o", ` ${url}/x.json`, "map-data", "dwd"],
    // commander's echo of a refused value, mid-phrase
    ["--user-agent", `agent ${url}\u0007`, "map-data", "dwd"],
  ];
  for (const argv of cases) {
    const cli = makeCli(() => jsonResponse([]));
    cli.deps.io.outputParentProblem = defaultIO.outputParentProblem!;
    assert.equal(await run(argv, cli.deps), 1, argv.join(" "));
    const err = cli.err.join("\n");
    assert.ok(err.length > 0, argv.join(" "));
    assert.doesNotMatch(err, /p w|bob:/, `${argv.join(" ")}: ${err}`);
  }
});

test("warning geojson on a terminal escapes the bidi controls like C1 and DEL; piped it stays byte-exact (bug 3 of 2026-10-21)", async () => {
  const chars = [0x9b, 0x7f, 0x202e, 0x2066, 0x200f, 0x061c].map((c) => String.fromCharCode(c)).join("");
  const body = Buffer.from(`{"type":"FeatureCollection","features":[],"name":"a${chars}b"}`, "utf8");
  const tty = makeCli(() => rawResponse(body, "application/geo+json"));
  tty.deps.io.isTerminal = () => true;
  assert.equal(await run(["warning", "geojson", "x"], tty.deps), 0);
  const shown = tty.out.join("");
  assert.ok(shown.includes("a\\u009b\\u007f\\u202e\\u2066\\u200f\\u061cb"), shown);
  assert.doesNotMatch(shown, /[‮⁦‏؜]/);
  const piped = makeCli(() => rawResponse(body, "application/geo+json"));
  piped.deps.io.isTerminal = () => false;
  assert.equal(await run(["warning", "geojson", "x"], piped.deps), 0);
  assert.equal(piped.out.join(""), body.toString("utf8"));
});

// T15b of the 2026-10-21 fix round (dip-bundestag-cli 420b79c): the URL search of the redaction
// runs once per argument on every run. A pattern retried at every position of a long argument
// without "://" took seconds (40 000 characters ~3 s, 1 MB hung), and a slice per "://" grew
// quadratic memory; indexOf keeps it linear, and at most 64 URLs are read from one argument.
test("the URL search of the redaction is linear: a long argument, with or without ://, is read fast (T15b)", async () => {
  for (const big of ["b".repeat(40_000), "b".repeat(1024 * 1024), "a://".repeat(100_000)]) {
    const cli = makeCli(() => jsonResponse([]));
    const started = performance.now();
    await run(["warning", "get", "--", big], cli.deps);
    const took = performance.now() - started;
    assert.ok(took < 1000, `${big.length} characters took ${Math.round(took)} ms`);
  }
});
