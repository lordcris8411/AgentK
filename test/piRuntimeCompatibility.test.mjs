import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const projectDirectory = resolve(import.meta.dirname, "..");
const piCli = process.env.AGENT_K_TEST_PI_CLI || join(
  projectDirectory,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js",
);
const nodeExecutable = process.env.AGENT_K_TEST_NODE_EXECUTABLE || process.execPath;
const permissionExtension = process.env.AGENT_K_TEST_PERMISSION_EXTENSION || join(
  projectDirectory,
  "agent-k-permissions.ts",
);
const kPlanExtension = process.env.AGENT_K_TEST_K_PLAN_EXTENSION || join(
  projectDirectory,
  "extensions",
  "k-plan",
  "index.ts",
);

test("desktop startup waits for one Pi runtime instead of the full standby pool", async () => {
  const source = await readFile(join(projectDirectory, "src", "App.tsx"), "utf8");
  assert.match(source, /const warmWorkerCount = initialCwd \? 1 : 0;/u);
  assert.doesNotMatch(source, /const warmWorkerCount = persistedSettings\.workerPoolSize;/u);
});

test("the pinned Pi runtime serves Agent K's RPC contract and extensions", { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-k-pi-contract-"));
  const child = spawn(
    nodeExecutable,
    [
      piCli,
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--offline",
      "--extension",
      permissionExtension,
      "--extension",
      kPlanExtension,
    ],
    {
      cwd: projectDirectory,
      env: {
        ...process.env,
        AGENT_K_PERMISSION_STATE_PATH: join(temporary, "permissions.json"),
        AGENT_K_SETTINGS_PATH: join(temporary, "settings.json"),
        PI_CODING_AGENT_DIR: join(temporary, "pi"),
        PI_OFFLINE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const pending = new Map();
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const settle = pending.get(value.id);
    if (!settle || value.type !== "response") return;
    pending.delete(value.id);
    settle.resolve(value);
  });
  const exit = new Promise((resolveExit) => {
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  child.once("error", (error) => {
    for (const settle of pending.values()) settle.reject(error);
    pending.clear();
  });
  child.once("close", (code, signal) => {
    const error = new Error(
      `Pi RPC exited before replying (code ${String(code)}, signal ${String(signal)}): ${stderr}`,
    );
    for (const settle of pending.values()) settle.reject(error);
    pending.clear();
  });

  let sequence = 0;
  const request = (command) => new Promise((resolveRequest, reject) => {
    const id = `contract-${++sequence}`;
    pending.set(id, { reject, resolve: resolveRequest });
    child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
  });

  try {
    const state = await request({ type: "get_state" });
    assert.equal(state.success, true);
    assert.equal(typeof state.data?.sessionId, "string");
    assert.equal(typeof state.data?.isStreaming, "boolean");

    const models = await request({ type: "get_available_models" });
    assert.equal(models.success, true);
    assert.ok(Array.isArray(models.data?.models));

    const thinking = await request({ type: "get_available_thinking_levels" });
    assert.equal(thinking.success, true);
    assert.ok(thinking.data?.levels?.includes("off"));

    assert.equal(
      (await request({ type: "set_auto_compaction", enabled: false })).success,
      true,
    );
    assert.equal((await request({ type: "new_session" })).success, true);
    assert.equal((await request({ type: "get_state" })).success, true);
  } finally {
    child.stdin.end();
    const result = await exit;
    if (result.code !== 0 && result.code !== null)
      assert.fail(`Pi RPC exited with ${result.code}: ${stderr}`);
    await rm(temporary, { recursive: true, force: true });
  }
});
