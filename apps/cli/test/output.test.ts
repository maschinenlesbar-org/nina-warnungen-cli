// The output path (src/cli/shared.ts, the file seam in io.ts): rendering, `-o` and `--force`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderJson } from "../src/cli/shared.js";
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
