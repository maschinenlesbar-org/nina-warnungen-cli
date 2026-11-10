import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { nodeHttpTransport } from "../src/http.js";
import { NinaNetworkError } from "../src/errors.js";

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
        // Either the idle-socket timeout or the wall-clock deadline can win this
        // race (both are armed at timeoutMs, and the server sends nothing); both
        // are the correct outcome — a NinaNetworkError that ends the hung request.
        (err) => err instanceof NinaNetworkError && /timed out|deadline/.test(err.message),
      );
    },
  );
});

test("a slow-drip response is bounded by the wall-clock deadline", async () => {
  // The server dribbles one byte every 20ms and never ends. Each byte resets the
  // idle-socket timeout, so without a separate wall-clock deadline the request
  // would hang forever while staying under maxResponseBytes. The deadline must
  // still fire and surface a NinaNetworkError naming the deadline (not the idle
  // timeout) as the cause.
  const timers: NodeJS.Timeout[] = [];
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const t = setInterval(() => res.write("x"), 20);
      timers.push(t);
      res.on("close", () => clearInterval(t));
    },
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 80 }),
        (err: unknown) => {
          assert.ok(err instanceof NinaNetworkError);
          // The wall-clock deadline, not the idle timeout, is what caught it.
          assert.match(err.message, /deadline/);
          return true;
        },
      );
    },
  );
  for (const t of timers) clearInterval(t);
});

test("a timeoutMs beyond Node's timer range is capped, not fired after 1 ms", async () => {
  const warnings: string[] = [];
  const onWarning = (warning: Error) => void warnings.push(warning.name);
  process.on("warning", onWarning);
  try {
    await withServer(
      (_req, res) => void setTimeout(() => res.end("{}"), 50),
      async (baseUrl) => {
        const resp = await nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 3_000_000_000 });
        assert.equal(resp.body.toString("utf8"), "{}");
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings.filter((name) => name === "TimeoutOverflowWarning"), []);
  } finally {
    process.off("warning", onWarning);
  }
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

test("a header Node refuses rejects as NinaNetworkError, not a raw TypeError", async () => {
  // The engine refuses such a User-Agent up front; this guards a direct caller of
  // the transport. Node throws while building the request, before any connection.
  await assert.rejects(
    nodeHttpTransport({ method: "GET", url: "http://127.0.0.1:1/x", headers: { "User-Agent": "a\r\nb" } }),
    (err: unknown) => err instanceof NinaNetworkError && /Invalid request/.test(err.message),
  );
});

test("a URL typed without its scheme is refused without its user name, token or password (F5 class)", async () => {
  // `my_user:pw@h` doesn't parse ("_" is no scheme character) and was quoted with its password;
  // `T0kenS3cret:@h` parses with the token as its scheme, which the message named, lower-cased.
  // A mistyped scheme (`http//`, the colon left out; `htp:/`) left the userinfo unfound too.
  for (const url of [
    "my_user:s3cret-pw@h.example/x",
    "T0kenS3cret:@h.example/x",
    "alice:s3cret-pw@h.example/x",
    "http//alice:s3cret-pw@h.example/x",
    "http/alice:s3cret-pw@h.example/x",
    "htp:/alice:s3cret-pw@h.example/x",
  ]) {
    const err = await nodeHttpTransport({ method: "GET", url, headers: {} }).then(
      () => assert.fail(`${url}: accepted`),
      (caught: unknown) => caught,
    );
    assert.ok(err instanceof NinaNetworkError, String(err));
    assert.ok(!/s3cret|t0kens3cret|T0kenS3cret|my_user|alice/.test(err.message), err.message);
    assert.match(err.message, /\*\*\*@h\.example\/x/);
  }
  // A scheme spelled as one (`scheme://`) is still named.
  const ftp = await nodeHttpTransport({ method: "GET", url: "ftp://alice:s3cret-pw@h.example/x", headers: {} }).catch((e: unknown) => e);
  assert.ok(ftp instanceof NinaNetworkError && ftp.message === 'Unsupported protocol "ftp:" in URL: ftp://***@h.example/x', String(ftp));
});

/** A loopback TCP server that answers the first request with `answer` as raw bytes. */
async function withRawServer(answer: Buffer, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.end(answer));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("a body in many tiny chunks arrives whole and in order, and the byte cap still holds", async () => {
  // 300 001 chunks of 1 to 3 bytes: whatever the transport joins on the way, every byte is kept
  // once, in order (the memory side is conformance test P27, the bin in a small heap).
  const pieces = Array.from({ length: 300_001 }, (_, i) => "abc".slice(0, (i % 3) + 1));
  const head = "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n";
  const wire = Buffer.from(head + pieces.map((p) => `${p.length}\r\n${p}\r\n`).join("") + "0\r\n\r\n", "latin1");
  const expected = pieces.join("");
  await withRawServer(wire, async (baseUrl) => {
    const res = await nodeHttpTransport({ method: "GET", url: baseUrl });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, expected.length);
    assert.ok(res.body.equals(Buffer.from(expected, "latin1")));
  });
  await withRawServer(wire, async (baseUrl) => {
    await assert.rejects(
      () => nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: expected.length - 1 }),
      (err: unknown) => err instanceof NinaNetworkError && /exceeded the size limit/.test(err.message),
    );
  });
  await withRawServer(wire, async (baseUrl) => {
    const res = await nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: expected.length });
    assert.equal(res.body.length, expected.length);
  });
});
