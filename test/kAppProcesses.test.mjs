import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KAppProcessManager } from "../.electron-dist/k-app-processes.js";

const config = JSON.stringify({ schemaVersion: 1, name: "Test", author: "Agent K", functionality: "Test process APIs.", version: "1.0.0", reserved: {}, settings: {} });

const waitForExit = async (manager, root, directory, id) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await manager.status(root, directory, id);
    if (state.status !== "running") return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for k-app process");
};

test("k-app processes are shell-free, scoped, observable, and stoppable", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-k-process-test-"));
  const app = join(root, "sample app");
  const otherApp = join(root, "other app");
  const nested = join(app, "tasks");
  const manager = new KAppProcessManager();
  try {
    await mkdir(nested, { recursive: true });
    await mkdir(otherApp, { recursive: true });
    await writeFile(join(app, "app.html"), "<main>app</main>");
    await writeFile(join(app, "config.k"), config);
    await writeFile(join(otherApp, "app.html"), "<main>other</main>");
    await writeFile(join(otherApp, "config.k"), config);
    const started = await manager.start(root, "sample app", process.execPath, ["-e", "console.log('hello k-app')"], "tasks");
    assert.equal(started.status, "running");
    assert.equal((await manager.list(root, "sample app")).length, 1);
    await assert.rejects(manager.status(root, "other app", started.id), /Unknown k-app process/);
    const completed = await manager.wait(root, "sample app", started.id);
    assert.equal(completed.exitCode, 0);
    assert.equal(completed.successful, true);
    const output = await manager.output(root, "sample app", started.id, 0, 0);
    assert.match(output.stdout, /hello k-app/);
    assert.equal((await manager.output(root, "sample app", started.id, output.stdoutCursor, output.stderrCursor)).stdout, "");

    const failed = await manager.start(root, "sample app", process.execPath, ["-e", "console.error('failure');process.exit(7)"], ".");
    const failedCompletion = await manager.wait(root, "sample app", failed.id);
    assert.equal(failedCompletion.successful, false);
    assert.equal(failedCompletion.exitCode, 7);
    assert.match((await manager.output(root, "sample app", failed.id, 0, 0)).stderr, /failure/);

    const large = await manager.start(root, "sample app", process.execPath, ["-e", "process.stdout.write('x'.repeat(1100000))"], ".");
    await manager.wait(root, "sample app", large.id);
    const bounded = await manager.output(root, "sample app", large.id, 0, 0);
    assert.ok(bounded.stdout.length <= 1024 * 1024);
    assert.equal(bounded.stdoutCursor, 1100000);

    const longRunning = await manager.start(root, "sample app", process.execPath, ["-e", "setInterval(()=>{},1000)"], ".");
    await manager.stop(root, "sample app", longRunning.id);
    const stopped = await manager.wait(root, "sample app", longRunning.id);
    assert.equal(stopped.status, "exited");
    assert.equal(stopped.successful, false);

    await assert.rejects(
      manager.start(root, "sample app", process.execPath, ["-v"], ".."),
      /escapes the app directory/,
    );
    await assert.rejects(manager.list(root, "."), /valid k-app directory/);
    await assert.rejects(manager.start(root, "sample app", "", [], "."), /must not be empty/);
    await assert.rejects(manager.start(root, "sample app", process.execPath, Array(257).fill("x"), "."), /at most 256/);
    const opened = [];
    assert.deepEqual(
      await manager.open(root, "sample app", "taskmgr.exe", async (target) => { opened.push(target); return ""; }),
      { opened: true },
    );
    assert.deepEqual(opened, ["taskmgr.exe"]);
    await assert.rejects(
      manager.open(root, "sample app", "missing.exe", async () => "No application is associated"),
      /No application is associated/,
    );
    await assert.rejects(
      manager.open(root, "sample app", "../outside.txt", async () => ""),
      /escapes the app directory/,
    );
    if (process.platform === "win32") {
      await assert.rejects(
        manager.start(root, "sample app", "explorer.exe", [], "."),
        /use AgentK\.processes\.open/,
      );
      await assert.rejects(
        manager.start(root, "sample app", "taskmgr.exe", [], "."),
        /use AgentK\.processes\.open/,
      );
    }
  } finally {
    manager.shutdown();
    await rm(root, { force: true, recursive: true });
  }
});
