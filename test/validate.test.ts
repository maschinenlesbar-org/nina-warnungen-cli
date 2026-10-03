import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, type Problem } from "../src/client/validate.js";
import * as lib from "../src/index.js";
import { NinaError, NinaValidationError } from "../src/client/errors.js";
import { NinaClient } from "../src/client/client.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { parity, jsonResponse } from "./helpers.js";

const nonBlank: Problem<string> = (v) => (v.trim() === "" ? "Expected a non-empty value." : undefined);

function throwingDeps(error: Error) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), writeFile: () => {}, outBinary: () => {} },
    createClient: () => {
      throw error;
    },
  };
  return { deps, out, err };
}

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("identifier", "abc", nonBlank), "abc");
});

test("assertValid throws NinaValidationError 'Invalid <name>: <reason>'", () => {
  assert.throws(
    () => assertValid("identifier", "  ", nonBlank),
    (err: unknown) =>
      err instanceof NinaValidationError &&
      err instanceof NinaError &&
      err.name === "NinaValidationError" &&
      err.message === "Invalid identifier: Expected a non-empty value.",
  );
});

test("the validation layer is exported from the package root", () => {
  assert.equal(lib.assertValid, assertValid);
  assert.equal(lib.NinaValidationError, NinaValidationError);
});

test("run() maps a NinaValidationError raised in an action to the usage exit 1, 'Error: <message>'", async () => {
  const cli = throwingDeps(new NinaValidationError("Invalid thing: Expected a non-empty value."));
  assert.equal(await run(["map-data", "dwd"], cli.deps), 1);
  assert.deepEqual(cli.err, ["Error: Invalid thing: Expected a non-empty value."]);
  assert.deepEqual(cli.out, []);
});

test("run() still maps a plain NinaError to exit 1", async () => {
  const cli = throwingDeps(new NinaError("boom"));
  assert.equal(await run(["map-data", "dwd"], cli.deps), 1);
  assert.deepEqual(cli.err, ["Error: boom"]);
});

test("parity() runs one input through the CLI and the library on one recording transport", async () => {
  const { cli, lib: l } = await parity(
    ["--compact", "map-data", "dwd"],
    (transport) => new NinaClient({ transport }).mapData("dwd"),
    () => jsonResponse([{ id: "1" }]),
  );
  assert.equal(cli.code, 0);
  assert.equal(cli.requests.length, 1);
  assert.equal(l.ok, true);
  assert.equal(l.requests.length, 1);
  assert.equal(cli.requests[0]!.url, l.requests[0]!.url);
  assert.deepEqual(JSON.parse(cli.out), l.ok ? l.value : undefined);
});

test("identifierProblem rejects a blank, non-string or separator-bearing identifier", async () => {
  const { identifierProblem } = await import("../src/client/validate.js");
  assert.equal(identifierProblem("mow.DE-SL-SLS-W038-20260901-000"), undefined);
  assert.equal(identifierProblem("a b"), undefined);
  assert.equal(identifierProblem(""), "Expected a non-empty value.");
  assert.equal(identifierProblem("  "), "Expected a non-empty value.");
  assert.equal(identifierProblem(42), "Expected a string.");
  assert.equal(identifierProblem("a/b"), '"a/b" must not contain a path separator (/ or \\).');
  assert.equal(identifierProblem("a\\b"), '"a\\\\b" must not contain a path separator (/ or \\).');
  assert.equal(lib.identifierProblem, identifierProblem);
});
