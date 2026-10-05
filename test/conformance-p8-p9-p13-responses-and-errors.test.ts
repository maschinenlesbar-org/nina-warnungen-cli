// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { NinaClient as Client } from "../src/client/client.js";
import {
  NinaError as BaseError,
  NinaParseError as ParseError,
  NinaValidationError as ValidationError,
} from "../src/client/errors.js";
import type { NinaSource } from "../src/client/enums.js";
/** A call whose answer contains a text field, and how to read that field from the result. */
const textCall = (client: Client): Promise<unknown> => client.mapData("mowas");
const textBody = (text: string): unknown => [{ id: "mow.1", i18nTitle: { de: text } }];
const readText = (result: unknown): string => (result as Array<{ i18nTitle: { de: string } }>)[0]!.i18nTitle.de;
/** 2xx bodies the call must reject (error envelopes, empty or wrong shapes). `[]` is not one: it means "no warnings". */
const malformedBodies: unknown[] = [null, {}, "text", 42, { error: "boom" }, { message: "Not available" }, [null], [42], [[]]];
/** Library calls with wrong-typed or out-of-range input. */
const badCalls: Array<[string, () => unknown]> = [
  ["warnings.get(5)", () => new Client().warnings.get(5 as unknown as string)],
  ["warnings.get(null)", () => new Client().warnings.get(null as unknown as string)],
  ["archive.get({})", () => new Client().archive.get({} as unknown as string)],
  ["dashboard(12345678)", () => new Client().dashboard(12345678 as unknown as string)],
  ["dashboard(null)", () => new Client().dashboard(null as unknown as string)],
  ["mapData(5)", () => new Client().mapData(5 as unknown as NinaSource)],
  ["timeoutMs: 'x'", () => new Client({ timeoutMs: "x" as unknown as number })],
  ["timeoutMs: -1", () => new Client({ timeoutMs: -1 })],
  ["maxRetries: 1.5", () => new Client({ maxRetries: 1.5 })],
  ["retryDelayMs: 3e9", () => new Client({ retryDelayMs: 3_000_000_000 })],
  ["baseUrl: 5", () => new Client({ baseUrl: 5 as unknown as string })],
  ["userAgent: {}", () => new Client({ userAgent: {} as unknown as string })],
  ["transport: 'x'", () => new Client({ transport: "x" as unknown as never })],
  ["sleep: 5", () => new Client({ sleep: 5 as unknown as never })],
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(JSON.stringify(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(JSON.stringify(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});

test("P13: every rejected input is the validation error, never a raw TypeError", async () => {
  for (const [label, fn] of badCalls) {
    await assert.rejects(async () => fn(), (e: unknown) => e instanceof ValidationError, label);
  }
});
