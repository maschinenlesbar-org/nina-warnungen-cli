// CLI <-> library parity: the same input through run() and through the library,
// on one recording mock transport, must give the same outcome — both reject with
// no request sent, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { NinaClient } from "../src/client/client.js";
import { NinaValidationError } from "../src/client/errors.js";
import { parity, jsonResponse } from "./helpers.js";

/** Both sides rejected the input before any request, with the same message. */
function assertBothRejected(
  outcome: Awaited<ReturnType<typeof parity>>,
  label: string,
): NinaValidationError {
  const { cli, lib } = outcome;
  assert.equal(cli.code, 1, `${label}: CLI exit code`);
  assert.deepEqual(cli.requests, [], `${label}: CLI sent a request`);
  assert.equal(lib.ok, false, `${label}: library accepted the input`);
  assert.deepEqual(lib.requests, [], `${label}: library sent a request`);
  const error = (lib as { error: unknown }).error;
  assert.ok(error instanceof NinaValidationError, `${label}: ${String(error)}`);
  assert.equal(cli.err, `Error: ${error.message}`, label);
  return error;
}

// ---- Finding 1 (PAT-10): warning and archive identifiers ------------------------

const identifierCommands: Array<[string[], (c: NinaClient, id: string) => Promise<unknown>]> = [
  [["warning", "get"], (c, id) => c.warnings.get(id)],
  [["warning", "geojson"], (c, id) => c.warnings.geojson(id)],
  [["archive", "mapping"], (c, id) => c.archive.mapping(id)],
  [["archive", "get"], (c, id) => c.archive.get(id)],
];

test("parity: a blank or separator-bearing identifier is rejected by CLI and library alike", async () => {
  for (const [argv, call] of identifierCommands) {
    for (const id of ["", " ", "a/b", "a\\b", "../../etc/passwd", "/x.json"]) {
      const label = `${argv.join(" ")} ${JSON.stringify(id)}`;
      const error = assertBothRejected(
        await parity(["--compact", ...argv, "--", id], (transport) => call(new NinaClient({ transport }), id)),
        label,
      );
      assert.match(error.message, /^Invalid identifier: /, label);
    }
  }
});

test("parity: a valid identifier sends the identical request from CLI and library", async () => {
  for (const [argv, call] of identifierCommands) {
    const { cli, lib } = await parity(
      ["--compact", ...argv, "mow.DE-SL-SLS-W038-20260901-000"],
      (transport) => call(new NinaClient({ transport }), "mow.DE-SL-SLS-W038-20260901-000"),
      () => jsonResponse({ identifier: "x" }),
    );
    assert.equal(cli.code, 0, argv.join(" "));
    assert.equal(lib.ok, true, argv.join(" "));
    assert.equal(cli.requests.length, 1);
    assert.deepEqual(lib.requests.map((r) => r.url), cli.requests.map((r) => r.url));
  }
});
