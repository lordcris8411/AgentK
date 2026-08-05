import assert from "node:assert/strict";
import test from "node:test";
import { attachProviderRequestDump } from "../src/features/conversation/providerPayload.ts";

test("attaches provider requests to the latest user message with bounded history", () => {
  const items = [
    { role: "user", providerRequests: [{ capturedAt: 1, payload: { request: 1 } }] },
    { role: "assistant" },
    { role: "user" },
  ];
  const next = attachProviderRequestDump(items, { capturedAt: 2, payload: { request: 2 } }, 1, 8);
  assert.equal(next[0]?.providerRequests, undefined);
  assert.deepEqual(next[2]?.providerRequests, [{ capturedAt: 2, payload: { request: 2 } }]);
});
