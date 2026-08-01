import assert from "node:assert/strict";
import test from "node:test";
import {
  isClosedPiRpcError,
  shutdownRuntime,
  type RuntimeShutdownOperations,
} from "../src/lib/runtimeLifecycle.ts";

function operations(
  calls: string[],
  overrides: Partial<RuntimeShutdownOperations> = {},
): RuntimeShutdownOperations {
  return {
    async abort(runtimeId) {
      calls.push(`abort:${runtimeId}`);
    },
    async cancelPending(runtimeId) {
      calls.push(`cancel:${runtimeId}`);
    },
    clearSessionUi(runtimeId) {
      calls.push(`clear:${runtimeId}`);
    },
    async close(runtimeId) {
      calls.push(`close:${runtimeId}`);
    },
    ...overrides,
  };
}

test("runtime shutdown waits for abort before closing the RPC transport", async () => {
  const calls: string[] = [];
  let resolveAbort!: () => void;
  const abortDone = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  const result = shutdownRuntime("runtime-1", operations(calls, {
    async abort(runtimeId) {
      calls.push(`abort:${runtimeId}`);
      await abortDone;
    },
  }));

  await Promise.resolve();
  assert.deepEqual(calls, ["cancel:runtime-1", "clear:runtime-1", "abort:runtime-1"]);
  resolveAbort();
  await result;
  assert.deepEqual(calls, [
    "cancel:runtime-1",
    "clear:runtime-1",
    "abort:runtime-1",
    "close:runtime-1",
  ]);
});

test("runtime shutdown tolerates a worker that was already closed", async () => {
  const calls: string[] = [];
  await shutdownRuntime("runtime-2", operations(calls, {
    async abort(runtimeId) {
      calls.push(`abort:${runtimeId}`);
      throw new Error("Pi RPC connection closed");
    },
  }));

  assert.equal(isClosedPiRpcError(
    "Error invoking remote method 'agent-k:invoke': Error: Pi RPC connection is closed; reconnect and try again",
  ), true);
  assert.equal(calls.at(-1), "close:runtime-2");
});

test("runtime shutdown closes the worker and reports a real abort failure", async () => {
  const calls: string[] = [];
  await assert.rejects(
    shutdownRuntime("runtime-3", operations(calls, {
      async abort(runtimeId) {
        calls.push(`abort:${runtimeId}`);
        throw new Error("abort failed");
      },
    })),
    /abort failed/,
  );
  assert.equal(calls.at(-1), "close:runtime-3");
});
