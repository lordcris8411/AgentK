import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { RpcBridge } from "../../.electron-dist/agent/rpc.js";

function bridgeFixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  // This is not an operating-system child process. Leaving pid unset is
  // essential: RpcBridge.stop() terminates a real Unix process group with
  // process.kill(-pid), and a fake pid of 1 would signal every process the
  // current user is allowed to terminate.
  child.pid = undefined;
  child.kill = () => true;
  const bridge = new RpcBridge(child, {
    appDataPath: "/tmp/agent-k-rpc-test",
    bundledExtensionsDirectory: "/tmp/agent-k-rpc-test/extensions",
    bundledSkillsDirectory: "/tmp/agent-k-rpc-test/skills",
    firstPartyEditorExtensions: [],
    firstPartyLanguageServerSkills: [],
    cwd: "/tmp/agent-k-rpc-test/workspace",
    launch: { executable: "pi", args: [] },
    permissionExtensionSource: "/tmp/agent-k-rpc-test/permissions.ts",
    runtimeId: "runtime-test",
    emit() {},
  });
  const close = () => {
    bridge.stop();
    child.stdout.end();
    child.stderr.end();
    child.emit("exit", 0, null);
  };
  return { bridge, child, close };
}

const flushLines = () => new Promise((resolve) => setImmediate(resolve));

function respondWithState(child, state) {
  child.stdin.once("data", (chunk) => {
    const request = JSON.parse(chunk.toString());
    child.stdout.write(`${JSON.stringify({ type: "response", command: "get_state", success: true, id: request.id, data: state })}\n`);
  });
}

test("runtime reservation does not count as an active Pi task", () => {
  const { bridge, close } = bridgeFixture();
  assert.equal(bridge.tryReserve(), true);
  assert.equal(bridge.isAvailable(), false);
  assert.equal(bridge.hasActiveAgentTask(), false);
  bridge.releaseReservation();
  close();
});

test("only an agent run or pending interaction counts as an active Pi task", async () => {
  const { bridge, child, close } = bridgeFixture();
  child.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
  await flushLines();
  assert.equal(bridge.hasActiveAgentTask(), true);
  child.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
  await flushLines();
  assert.equal(bridge.hasActiveAgentTask(), false);
  child.stdout.write(`${JSON.stringify({ type: "extension_ui_request", method: "confirm", id: "confirm-1" })}\n`);
  await flushLines();
  assert.equal(bridge.hasActiveAgentTask(), true);
  bridge.sendNotification({ type: "extension_ui_response", id: "confirm-1", value: false });
  assert.equal(bridge.hasActiveAgentTask(), false);

  child.stdout.write(`${JSON.stringify({ type: "extension_ui_request", method: "confirm", id: "stale-confirm" })}\n`);
  await flushLines();
  assert.equal(bridge.hasActiveAgentTask(), true);
  child.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
  await flushLines();
  assert.equal(bridge.hasActiveAgentTask(), false);
  close();
});

test("authoritative Pi state clears stale active-task event state", async () => {
  const { bridge, child, close } = bridgeFixture();
  child.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
  child.stdout.write(`${JSON.stringify({ type: "extension_ui_request", method: "confirm", id: "stale-confirm" })}\n`);
  await flushLines();
  assert.equal(bridge.hasActiveAgentTask(), true);

  respondWithState(child, { isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
  assert.equal(await bridge.refreshActiveAgentTask(), false);
  assert.equal(bridge.hasActiveAgentTask(), false);

  respondWithState(child, { isStreaming: false, isCompacting: true, pendingMessageCount: 0 });
  assert.equal(await bridge.refreshActiveAgentTask(), true);
  respondWithState(child, { isStreaming: false, isCompacting: false, pendingMessageCount: 1 });
  assert.equal(await bridge.refreshActiveAgentTask(), true);
  close();
});
