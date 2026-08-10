import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { DebugSessionManager, type ManagedDebugSnapshot } from "../shared/debug-session-manager.ts";

function stopped(manager: DebugSessionManager, sessionId: string): Promise<ManagedDebugSnapshot> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Session ${sessionId} did not stop`)), 10_000);
    const poll = setInterval(() => {
      const snapshot = manager.list().find((item) => item.sessionId === sessionId);
      if (snapshot?.state === "stopped") { clearInterval(poll); clearTimeout(timeout); resolve(snapshot); }
    }, 20);
  });
}

test("DebugSessionManager attaches two processes without replacing the first session", async () => {
  if (process.platform === "win32") return;
  const root = process.cwd();
  const source = join(root, "package.json");
  const adapter = join(root, "test/fixtures/fake-debug-adapter.mjs");
  const previousSource = process.env.AGENT_K_E2E_SOURCE;
  process.env.AGENT_K_E2E_SOURCE = source;
  const manager = new DebugSessionManager(() => undefined, () => ({ adapter: "lldb", args: [adapter], command: process.execPath }));
  try {
    await manager.setBreakpoints(source, [1]);
    const first = await manager.start({ mode: "attach", processId: 101, root, sessionName: "Host" });
    const second = await manager.start({ mode: "attach", processId: 202, root, sessionName: "Worker" });
    assert.notEqual(first.sessionId, second.sessionId);
    const [firstStopped, secondStopped] = await Promise.all([stopped(manager, first.sessionId), stopped(manager, second.sessionId)]);
    assert.equal(firstStopped.sessionLabel, "Host");
    assert.equal(secondStopped.sessionLabel, "Worker");
    assert.deepEqual(manager.list().map((item) => item.sessionLabel), ["Host", "Worker"]);
    assert.equal(firstStopped.breakpoints[0]?.file, source);
    assert.equal(secondStopped.breakpoints[0]?.file, source);
    assert.equal(manager.select(first.sessionId).sessionId, first.sessionId);
    await manager.close(first.sessionId);
    assert.deepEqual(manager.list().map((item) => item.sessionId), [second.sessionId]);
    await manager.detach(second.sessionId);
    assert.deepEqual(manager.list(), []);
    const third = await manager.start({ mode: "attach", processId: 303, root, sessionName: "Transient" });
    await stopped(manager, third.sessionId);
    await manager.stop(third.sessionId);
    assert.deepEqual(manager.list(), []);
  } finally {
    manager.shutdown();
    if (previousSource === undefined) delete process.env.AGENT_K_E2E_SOURCE;
    else process.env.AGENT_K_E2E_SOURCE = previousSource;
  }
});
