import { test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { InvalidArgumentError } from "commander";
import { escapeTerminalControls, parseIntArg } from "../src/cli/shared.js";

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

test("escapeTerminalControls escapes C0 but TAB/LF/CR, DEL, C1 and bidi controls, and nothing else", () => {
  assert.equal(escapeTerminalControls("plain\ttext\n\r ok"), "plain\ttext\n\r ok");
  assert.equal(escapeTerminalControls("a\u001b[31mb\u007fc\u009bd\u202ee"), "a\\u001b[31mb\\u007fc\\u009bd\\u202ee");
});

// Starts a process with a small heap: 30 s instead of the suite's 5 s.
test("escapeTerminalControls escapes millions of control characters within a small heap", { timeout: 30_000 }, () => {
  // One `+=` per escaped character made a rope node each: 16 million DEL aborted a 256 MB heap.
  const shared = new URL("../src/cli/shared.js", import.meta.url).href;
  const n = 8_000_000;
  const script =
    `const { escapeTerminalControls } = await import(${JSON.stringify(shared)});` +
    `process.stdout.write(String(escapeTerminalControls("\\u007f".repeat(${n})).length));`;
  const out = execFileSync(process.execPath, ["--max-old-space-size=256", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(out, String(n * 6));
});
