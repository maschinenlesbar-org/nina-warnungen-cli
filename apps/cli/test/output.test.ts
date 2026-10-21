// The output path (src/cli/shared.ts, the file seam in io.ts): rendering, `-o` and `--force`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderJson } from "../src/cli/shared.js";
import { run } from "../src/cli/run.js";
import { defaultIO, type CliDeps } from "../src/cli/io.js";
import { NinaClient } from "@maschinenlesbar.org/nina-warnungen-client/internal/client";
import { NinaIOError } from "@maschinenlesbar.org/nina-warnungen-client/internal/errors";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/nina-warnungen-client/internal/http";
import { jsonResponse, makeMockTransport, untimed } from "./helpers.js";

function makeCli(responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () => jsonResponse([])) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(untimed(s)),
      writeFile: () => {},
      outBinary: (d) => out.push(d.toString("utf8")),
    },
    createClient: (opts) => new NinaClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

test("--compact takes the gap path only for an answer holding a huge string, the fast path otherwise", (t) => {
  // On Node 26 V8's fast stringifier (no gap) aborts the process on a ~250 MB string that
  // JSON.parse made ("Zone Allocation failed", exit 134); the gap path prints it. Only the fast
  // path is iterative there, though, and prints nesting the gap path refuses at ~7,000 levels.
  // So the path is chosen per answer. Too big a body for this suite: this pins the calls.
  const { deps, out } = makeCli();
  const stringify = t.mock.method(JSON, "stringify", () => '"stub"');
  const huge = "x".repeat(64 * 1024 * 1024);
  renderJson(deps, { compact: true }, { id: "a1", text: huge });
  renderJson(deps, { compact: true }, { id: "a1", x: [[["Hochwasser"]]], text: huge.slice(1) });
  renderJson(deps, { compact: true }, { [huge]: 1 });
  renderJson(deps, { compact: true }, [[huge]]);
  renderJson(deps, {}, { id: "a1" });
  const calls = stringify.mock.calls.map((call) => call.arguments);
  stringify.mock.restore();
  assert.deepEqual(calls.map((args) => (args.length >= 3 ? args[2] : "none")), ["", "none", "", "", 2]);
  assert.deepEqual(out, ['"stub"', '"stub"', '"stub"', '"stub"', '"stub"']);
});

test("printed JSON escapes DEL, C1 and the bidi controls, on stdout and in the -o file (K10)", async () => {
  // Built from char codes so the source stays free of them.
  const raw = [0x7f, 0x9b, 0x061c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069].map((c) => String.fromCharCode(c)).join("");
  const answer = [{ id: "a", i18nTitle: { de: `Hochwasser${raw}` } }];
  const escaped = "\\u007f\\u009b\\u061c\\u200e\\u200f\\u202a\\u202e\\u2066\\u2069";
  for (const argv of [["map-data", "lhp"], ["--compact", "map-data", "lhp"]]) {
    const cli = makeCli(() => jsonResponse(answer));
    assert.equal(await run(argv, cli.deps), 0);
    const text = cli.out.join("\n");
    assert.ok(text.includes(`Hochwasser${escaped}`), text);
    assert.deepEqual(JSON.parse(text), answer, "still the same JSON");
  }
  const files = new Map<string, Buffer>();
  const cli = makeCli(() => jsonResponse(answer));
  cli.deps.io.writeFile = (p, d) => void files.set(p, d);
  assert.equal(await run(["-o", "out.json", "map-data", "lhp"], cli.deps), 0);
  assert.ok(files.get("out.json")?.toString("utf8").includes(`Hochwasser${escaped}`));
});

// ---- -o and --force on real files (K7) -----------------------------------------------

const ANSWER = [{ id: "mow.1", i18nTitle: { de: "Hochwasser" } }];
const GEOJSON = '{"type":"FeatureCollection","features":[]}';

/** A CLI whose -o goes to the real file system (defaultIO's file functions); stdout and stderr captured. */
function fsCli(responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () => jsonResponse(ANSWER)) {
  const cli = makeCli(responder);
  cli.deps.io.writeFile = defaultIO.writeFile;
  const outputState = defaultIO.outputState;
  if (outputState !== undefined) cli.deps.io.outputState = outputState;
  return cli;
}

/** Run `body` with a fresh temp directory that is always removed. */
async function inTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nina-warnungen-output-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("-o writes what stdout would show, plus a newline, and says so in an INFO record", async () => {
  await inTempDir(async (dir) => {
    const shown = fsCli();
    assert.equal(await run(["map-data", "dwd"], shown.deps), 0);
    const path = join(dir, "dwd.json");
    const cli = fsCli();
    assert.equal(await run(["-o", path, "map-data", "dwd"], cli.deps), 0);
    const written = readFileSync(path, "utf8");
    assert.equal(written, `${shown.out.join("\n")}\n`);
    assert.deepEqual(cli.out, []);
    assert.deepEqual(cli.err, [`INFO  [nina.output] Wrote ${Buffer.byteLength(written)} bytes to ${path}`]);
    const geo = fsCli(() => jsonResponse(JSON.parse(GEOJSON)));
    const geoPath = join(dir, "w.geojson");
    assert.equal(await run(["-o", geoPath, "warning", "geojson", "mow.1"], geo.deps), 0);
    assert.equal(readFileSync(geoPath, "utf8"), GEOJSON);
    assert.deepEqual(readdirSync(dir).sort(), ["dwd.json", "w.geojson"], "no temporary file is left");
  });
});

test("-o - prints to stdout and creates no file, with --force too", async () => {
  await inTempDir(async (dir) => {
    const cli = fsCli();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      assert.equal(await run(["--compact", "-o", "-", "map-data", "dwd"], cli.deps), 0);
      assert.equal(await run(["--compact", "-o", "-", "--force", "map-data", "dwd"], cli.deps), 0);
    } finally {
      process.chdir(cwd);
    }
    assert.equal(cli.out.length, 2);
    assert.deepEqual(cli.err, []);
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("a refused -o target is a usage error before any request", async () => {
  await inTempDir(async (dir) => {
    const existing = join(dir, "existing.json");
    writeFileSync(existing, "keep");
    const dangling = join(dir, "dangling.json");
    symlinkSync(join(dir, "nowhere"), dangling);
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const cases: Array<[string[], string]> = [
      [["-o", "", "map-data", "dwd"], "Expected a non-empty value."],
      [["-o", "  ", "map-data", "dwd"], "Expected a non-empty value."],
      [["--force", "map-data", "dwd"], "--force needs --output (it only allows overwriting the -o file)."],
      [["-o", existing, "map-data", "dwd"], `Refusing to overwrite existing file "${existing}"; pass --force to overwrite.`],
      [["-o", existing, "warning", "geojson", "mow.1"], `Refusing to overwrite existing file "${existing}"; pass --force to overwrite.`],
      [["-o", dangling, "map-data", "dwd"], `Refusing to overwrite existing file "${dangling}"; pass --force to overwrite.`],
      [["-o", sub, "map-data", "dwd"], `"${sub}" is a directory; give a file path to --output.`],
      [["-o", sub, "--force", "map-data", "dwd"], `"${sub}" is a directory; give a file path to --output.`],
    ];
    for (const [argv, message] of cases) {
      const cli = fsCli();
      assert.equal(await run(argv, cli.deps), 1, argv.join(" "));
      assert.equal(cli.mt.calls.length, 0, `${argv.join(" ")} sent a request`);
      assert.ok(cli.err.some((line) => line.startsWith("ERROR [nina.cli]") && line.includes(message)), `${argv.join(" ")}: ${cli.err.join(" | ")}`);
    }
    assert.equal(readFileSync(existing, "utf8"), "keep");
    assert.deepEqual(readdirSync(dir).sort(), ["dangling.json", "existing.json", "sub"]);
  });
});

test("--force replaces an existing file, keeps its mode, and writes through a symlink", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, "out.json");
    writeFileSync(path, "old");
    chmodSync(path, 0o600);
    assert.equal(await run(["--compact", "-o", path, "--force", "map-data", "dwd"], fsCli().deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), ANSWER);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const link = join(dir, "latest.json");
    symlinkSync(path, link);
    assert.equal(await run(["--compact", "-o", link, "--force", "dashboard", "055150000000"], fsCli(() => jsonResponse([])).deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), []);
    assert.deepEqual(readdirSync(dir).sort(), ["latest.json", "out.json"]);
  });
});

test("--force to a new path creates the file; over a dangling link it replaces the link with the file", async () => {
  await inTempDir(async (dir) => {
    const fresh = join(dir, "fresh.json");
    assert.equal(await run(["--compact", "-o", fresh, "--force", "map-data", "dwd"], fsCli().deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(fresh, "utf8")), ANSWER);
    const dangling = join(dir, "dangling.json");
    symlinkSync(join(dir, "nowhere"), dangling);
    assert.equal(await run(["--compact", "-o", dangling, "--force", "map-data", "dwd"], fsCli().deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(dangling, "utf8")), ANSWER);
    assert.deepEqual(readdirSync(dir).sort(), ["dangling.json", "fresh.json"]);
  });
});

test("a file that appears during the request is not overwritten: exit 1, an ERROR of nina.output", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, "race.json");
    const cli = fsCli(() => {
      writeFileSync(path, "theirs");
      return jsonResponse(ANSWER);
    });
    assert.equal(await run(["-o", path, "map-data", "dwd"], cli.deps), 1);
    assert.equal(readFileSync(path, "utf8"), "theirs");
    assert.deepEqual(cli.err, [`ERROR [nina.output] Refusing to overwrite existing file "${path}"; pass --force to overwrite.`]);
    assert.deepEqual(readdirSync(dir), ["race.json"]);
  });
});

test("a write the file system refuses is an ERROR of nina.output naming the file, exit 1", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, "missing-dir", "out.json");
    const cli = fsCli();
    assert.equal(await run(["-o", path, "map-data", "dwd"], cli.deps), 1);
    assert.equal(cli.err.length, 1);
    assert.match(cli.err[0]!, new RegExp(`^ERROR \\[nina\\.output\\] Could not write to ".*out\\.json": ENOENT`));
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("an answer too large to print is called too large, not too deep; the hint only where --compact prints (D7)", (t) => {
  const { deps } = makeCli();
  const real = JSON.stringify;
  // V8's own error for a text past its longest string, stood in for: a real one needs 512 MB.
  const tooLarge = (gap: unknown): boolean => gap === 2 || gap === "big";
  t.mock.method(JSON, "stringify", (value: unknown, replacer: never, gap: unknown) => {
    if (tooLarge(gap) || (gap === undefined && (value as { all?: boolean }).all === true)) throw new RangeError("Invalid string length");
    return real(value, replacer, gap as number);
  });
  const isOutputError = (pattern: RegExp) => (err: Error) => err instanceof NinaIOError && pattern.test(err.message);
  assert.throws(() => renderJson(deps, {}, { id: "a1" }), isOutputError(/^The answer is too large \(more than \d+ characters of JSON\) to pretty-print; try --compact\.$/));
  assert.throws(() => renderJson(deps, {}, { all: true }), isOutputError(/^The answer is too large \(more than \d+ characters of JSON\) to pretty-print\.$/));
  assert.throws(() => renderJson(deps, { compact: true }, { all: true }), isOutputError(/^The answer is too large \(more than \d+ characters of JSON\) to print\.$/));
});

test("terminal controls are escaped in chunks: the same text as one pass, across chunk edges (D7)", () => {
  const DEL = String.fromCharCode(0x7f);
  const C1 = String.fromCharCode(0x9b);
  const RLO = String.fromCharCode(0x202e);
  // Controls right before, at and after the 64 Ki edges, and a run of them.
  const text = ["a".repeat(65535), DEL, C1, "b".repeat(65534), RLO, DEL.repeat(70000), "ü😀", C1].join("");
  const { deps, out } = makeCli();
  renderJson(deps, { compact: true }, { text });
  const expected = JSON.stringify({ text }).replace(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  assert.equal(out[0], expected);
  assert.deepEqual(JSON.parse(out[0]!), { text });
});
