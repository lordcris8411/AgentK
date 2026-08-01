import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { RpcPool } from "../../.electron-dist/agent/pool.js";
import { buildEnvironmentSystemPrompt, RpcBridge } from "../../.electron-dist/agent/rpc.js";

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

test("environment prompt identifies the Windows host and its Bash boundary", () => {
  const prompt = buildEnvironmentSystemPrompt("win32", "x64", "Example CPU");
  assert.match(prompt, /Host operating system: Windows \(win32\)/);
  assert.match(prompt, /Host CPU: Example CPU/);
  assert.match(prompt, /Host instruction-set architecture: x86-64 \(AMD64\) \(Node architecture: x64\)/);
  assert.match(prompt, /Git Bash/);
  assert.match(prompt, /do not assume Linux package managers/);
  assert.doesNotMatch(prompt, /Current system local time/);
});

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

test("pool abort waits for Pi to acknowledge that the session is idle", async () => {
  const pool = new RpcPool({
    appDataPath: "/tmp/agent-k-rpc-test",
    bundledExtensionsDirectory: "/tmp/agent-k-rpc-test/extensions",
    bundledSkillsDirectory: "/tmp/agent-k-rpc-test/skills",
    firstPartyEditorExtensions: [],
    firstPartyLanguageServerSkills: [],
    launch: { executable: "pi", args: [] },
    minimum: 2,
    permissionExtensionSource: "/tmp/agent-k-rpc-test/permissions.ts",
    emit() {},
  });
  let acknowledge;
  let command;
  const fakeBridge = {
    isClosed: () => false,
    request: (value) => {
      command = value;
      return new Promise((resolve) => { acknowledge = resolve; });
    },
    stop() {},
  };
  pool.workers.set("runtime-test", fakeBridge);
  let completed = false;
  const pending = pool.abort("runtime-test").then(() => { completed = true; });
  await flushLines();
  assert.deepEqual(command, { type: "abort" });
  assert.equal(completed, false);
  acknowledge({ type: "response", success: true, data: "abort" });
  await pending;
  assert.equal(completed, true);
  pool.shutdown();
});

test("pool synchronizes Pi native auto-compaction across existing runtimes", async () => {
  const pool = new RpcPool({
    appDataPath: "/tmp/agent-k-rpc-test",
    bundledExtensionsDirectory: "/tmp/agent-k-rpc-test/extensions",
    bundledSkillsDirectory: "/tmp/agent-k-rpc-test/skills",
    firstPartyEditorExtensions: [],
    firstPartyLanguageServerSkills: [],
    launch: { executable: "pi", args: [] },
    minimum: 2,
    permissionExtensionSource: "/tmp/agent-k-rpc-test/permissions.ts",
    emit() {},
  });
  const commands = [];
  const fakeBridge = (runtimeId) => ({
    runtimeId,
    isClosed: () => false,
    request: async (value) => {
      commands.push({ runtimeId, value });
      return { success: true };
    },
    stop() {},
  });
  pool.workers.set("runtime-a", fakeBridge("runtime-a"));
  pool.workers.set("runtime-b", fakeBridge("runtime-b"));

  await pool.setAutoCompaction(false);

  assert.deepEqual(commands, [
    {
      runtimeId: "runtime-a",
      value: { type: "set_auto_compaction", enabled: false },
    },
    {
      runtimeId: "runtime-b",
      value: { type: "set_auto_compaction", enabled: false },
    },
  ]);
  pool.shutdown();
});

test("new sessions preserve the model shown by their prepared runtime", async () => {
  const pool = new RpcPool({
    appDataPath: "/tmp/agent-k-rpc-test",
    bundledExtensionsDirectory: "/tmp/agent-k-rpc-test/extensions",
    bundledSkillsDirectory: "/tmp/agent-k-rpc-test/skills",
    firstPartyEditorExtensions: [],
    firstPartyLanguageServerSkills: [],
    launch: { executable: "pi", args: [] },
    minimum: 2,
    permissionExtensionSource: "/tmp/agent-k-rpc-test/permissions.ts",
    emit() {},
  });
  const commands = [];
  const fakeBridge = {
    isClosed: () => false,
    request: async (value) => {
      commands.push(value);
      if (value.type === "get_state")
        return {
          success: true,
          data: {
            model: { provider: "local", id: "qwen3.6-27b" },
            sessionFile: "/tmp/session.jsonl",
            sessionId: "session-test",
          },
        };
      return { success: true, data: {} };
    },
    stop() {},
  };
  pool.workers.set("runtime-test", fakeBridge);

  const state = await pool.createSession("runtime-test");

  assert.deepEqual(commands, [
    { type: "get_state" },
    { type: "new_session" },
    { type: "set_model", provider: "local", modelId: "qwen3.6-27b" },
    { type: "get_state" },
  ]);
  assert.deepEqual(state.model, { provider: "local", id: "qwen3.6-27b" });
  pool.shutdown();
});
