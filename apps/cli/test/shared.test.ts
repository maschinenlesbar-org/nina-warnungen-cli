import { test } from "node:test";
import assert from "node:assert/strict";
import { InvalidArgumentError } from "commander";
import { parseIntArg } from "../src/cli/shared.js";

test("parseIntArg accepts plain non-negative decimals", () => {
  assert.equal(parseIntArg("0"), 0);
  assert.equal(parseIntArg("1"), 1);
  assert.equal(parseIntArg("30000"), 30000);
  assert.equal(parseIntArg("007"), 7);
});

test("parseIntArg rejects empty, whitespace, sign, decimal, hex and exponent forms", () => {
  for (const bad of [
    "",
    " ",
    "  5",
    "5 ",
    "-1",
    "+1",
    "5.0",
    "1.5",
    "0x10",
    "1e3",
    "Infinity",
    "NaN",
    "abc",
    "5abc",
  ]) {
    assert.throws(
      () => parseIntArg(bad),
      InvalidArgumentError,
      `expected "${bad}" to be rejected`,
    );
  }
});

test("parseIntArg rejects values beyond the safe-integer range", () => {
  assert.throws(() => parseIntArg("9".repeat(20)), InvalidArgumentError);
});
