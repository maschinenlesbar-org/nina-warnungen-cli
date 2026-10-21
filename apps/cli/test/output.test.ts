// The output path (src/cli/shared.ts, the file seam in io.ts): rendering, `-o` and `--force`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderJson } from "../src/cli/shared.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { NinaClient } from "@maschinenlesbar.org/nina-warnungen-client/internal/client";
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
