// Conformance test P21 (follow-up round 2026-10-06): the README ships in the npm tarball and
// is shown on npmjs.com, so every relative link in it must point at a file the package ships.
// A document the `files` allowlist leaves out is linked by its absolute GitHub URL instead.
// Dependency-free: reads README.md and package.json, no `npm pack`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The repo root, from the compiled test (dist/test/…). */
const ROOT = new URL("../../", import.meta.url);
const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, ROOT)), "utf8");

/** Relative link targets in markdown: inline `](target)` and reference `[x]: target`. */
function relativeTargets(markdown: string): string[] {
  const targets: string[] = [];
  for (const m of markdown.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) targets.push(m[1]!);
  for (const m of markdown.matchAll(/^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm)) targets.push(m[1]!);
  return targets.filter((t) => !/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(t));
}

/** Whether npm packs `path`, per `files` (plain paths and directory prefixes) and npm's always-included files. */
function shipped(path: string, files: readonly string[]): boolean {
  if (/^(?:readme(?:\.[^/]*)?|licen[cs]e(?:\.[^/]*)?|package\.json)$/i.test(path)) return true;
  return files
    .filter((entry) => !entry.startsWith("!"))
    .map((entry) => entry.replace(/^\.\//, "").replace(/\/+$/, ""))
    .some((entry) => path === entry || path.startsWith(`${entry}/`));
}

test("P21: every relative README link points at a file the npm package ships", () => {
  const files = (JSON.parse(read("package.json")) as { files?: string[] }).files ?? [];
  const targets = relativeTargets(read("README.md"));
  assert.ok(targets.length > 0, "expected at least one relative link (LICENSE)");
  const unshipped = targets
    .map((t) => t.replace(/[#?].*$/, "").replace(/^\.\//, ""))
    .filter((path) => path !== "" && !shipped(decodeURIComponent(path), files));
  assert.deepEqual(
    unshipped,
    [],
    `README links to files the package doesn't ship (404 on npmjs.com): ${unshipped.join(", ")}. ` +
      "Link them as https://github.com/maschinenlesbar-org/<repo>/blob/main/<path> instead.",
  );
});
