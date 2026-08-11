import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fetchWithRetry, withNetworkRetry } from "./download.ts";

test("language tool downloads retry transient failures but not permanent client errors", async () => {
  let transient = 0;
  let permanent = 0;
  const server = createServer((request, response) => {
    if (request.url === "/transient") {
      transient += 1;
      response.statusCode = transient < 3 ? 503 : 200;
      response.end(transient < 3 ? "retry" : "ok");
      return;
    }
    permanent += 1;
    response.statusCode = 404;
    response.end("missing");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const recovered = await fetchWithRetry(`http://127.0.0.1:${address.port}/transient`);
    assert.equal(await recovered.text(), "ok");
    assert.equal(transient, 3);
    const missing = await fetchWithRetry(`http://127.0.0.1:${address.port}/missing`);
    assert.equal(missing.status, 404);
    assert.equal(permanent, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("language tool downloads retry stream-level network resets", async () => {
  let attempts = 0;
  const value = await withNetworkRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new TypeError("terminated", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
    return "complete";
  });
  assert.equal(value, "complete");
  assert.equal(attempts, 3);
});
