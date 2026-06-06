import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { nodeHttpTransport } from "../src/client/http.js";
import { NinaNetworkError } from "../src/client/errors.js";

/** Start a throwaway loopback server for one test and return its base URL. */
async function withServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("performs a real GET and returns status, headers and body", async () => {
  await withServer(
    (req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: req.url }));
    },
    async (baseUrl) => {
      const resp = await nodeHttpTransport({ method: "GET", url: `${baseUrl}/o/nina/` });
      assert.equal(resp.status, 200);
      assert.equal(resp.headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(resp.body.toString("utf8")), { path: "/o/nina/" });
    },
  );
});

test("rejects an unsupported protocol with NinaNetworkError", async () => {
  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "ftp://example.test/x" }),
    NinaNetworkError,
  );
});

test("enforces maxResponseBytes", async () => {
  await withServer(
    (_req, res) => res.end("x".repeat(1000)),
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: 10 }),
        NinaNetworkError,
      );
    },
  );
});

test("a slow server triggers a timeout NinaNetworkError", async () => {
  await withServer(
    // Accept the connection but never respond, so the request times out.
    () => {},
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 50 }),
        (err) => err instanceof NinaNetworkError && /timed out/.test(err.message),
      );
    },
  );
});

test("a 302 redirect is returned as-is and never followed", async () => {
  let hits = 0;
  await withServer(
    (req, res) => {
      hits += 1;
      if (req.url === "/start") {
        res.statusCode = 302;
        res.setHeader("location", "/elsewhere");
        res.end();
        return;
      }
      res.statusCode = 200;
      res.end("followed");
    },
    async (baseUrl) => {
      const resp = await nodeHttpTransport({ method: "GET", url: `${baseUrl}/start` });
      assert.equal(resp.status, 302);
      assert.equal(resp.headers["location"], "/elsewhere");
      assert.equal(hits, 1); // the redirect target was never requested
    },
  );
});
