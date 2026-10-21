// Compile-time checks of the exported library types; the runtime assertions are trivial.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NinaClient, RequestEngine } from "../src/index.js";
import { constantJson } from "./helpers.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ baseUrl: process.env.X }` fails to compile against an
  // option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "nina-warnungen-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { NinaClient, RequestEngine, nodeHttpTransport, type EngineOptions, type HttpRequest } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const options: EngineOptions = allUndefined<EngineOptions>();",
        "export const client = new NinaClient({ baseUrl: process.env.NINA_BASE_URL, timeoutMs: 15_000 });",
        "export const ids = async (): Promise<string[]> => (await client.mapData(\"dwd\")).map((w) => w.id);",
        "const engine = new RequestEngine(options);",
        "export const raw = engine.request(\"GET\", \"/x\", { query: undefined, accept: \"application/json\" });",
        "const request: HttpRequest = { method: \"GET\", url: \"https://h/x\", ...allUndefined<Omit<HttpRequest, \"method\" | \"url\">>() };",
        "export const sent = nodeHttpTransport(request);",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means its default, as an omitted one does", async () => {
  const mt = constantJson([]);
  const client = new NinaClient({
    baseUrl: undefined,
    userAgent: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    transport: mt.transport,
  });
  await client.mapData("dwd");
  assert.equal(mt.last().url, "https://warnung.bund.de/api31/dwd/mapData.json");
  assert.equal(mt.last().headers?.["User-Agent"], "nina-warnungen-cli");
  assert.equal(mt.last().timeoutMs, 30_000);
  assert.equal(mt.last().maxResponseBytes, 100 * 1024 * 1024);
  // The engine's request options too: an undefined query is no query.
  const engine = new RequestEngine({ transport: mt.transport });
  await engine.request("GET", "/x", { query: undefined, accept: "application/json" });
  assert.equal(mt.last().url, "https://warnung.bund.de/x");
});
