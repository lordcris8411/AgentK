import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadKAppConfig, parseKAppConfig } from "../.electron-dist/k-app-config.js";
import { confinedWorkspacePath } from "../.electron-dist/workspace-path.js";

const valid = (overrides = {}) => JSON.stringify({
  schemaVersion: 1,
  name: "Tools",
  author: "Agent K",
  functionality: "Test the app.",
  version: "1.2.3-beta.1+win.x64",
  reserved: { future: true },
  settings: { locale: "zh-CN" },
  ...overrides,
});

test("config.k validates required metadata while preserving settings and unknown fields", () => {
  const config = parseKAppConfig(valid({ custom: { value: 1 } }));
  assert.equal(config.version, "1.2.3-beta.1+win.x64");
  assert.deepEqual(config.settings, { locale: "zh-CN" });
  assert.deepEqual(config.custom, { value: 1 });
  for (const source of [
    "not json",
    "[]",
    valid({ schemaVersion: 2 }),
    valid({ author: " " }),
    valid({ version: "01.2.3" }),
    valid({ version: "1.2.3-alpha..1" }),
    valid({ reserved: [] }),
    valid({ settings: null }),
  ]) assert.throws(() => parseKAppConfig(source), /config\.k/);
});

test("host authorization requires a valid direct-child app and config.k", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-k-config-test-"));
  try {
    await writeFile(join(temporary, "app.html"), "<main>app</main>");
    await assert.rejects(loadKAppConfig(temporary, join(temporary, "app.html")), /requires config\.k/);
    await writeFile(join(temporary, "config.k"), "{}");
    await assert.rejects(loadKAppConfig(temporary, join(temporary, "app.html")), /schemaVersion/);
    await writeFile(join(temporary, "config.k"), valid());
    assert.equal((await loadKAppConfig(temporary, join(temporary, "app.html"))).author, "Agent K");
    await assert.rejects(loadKAppConfig(temporary, join(temporary, "index.html")), /only to a k-app/);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("workspace confinement rejects traversal, absolute outsiders, and symlink escapes", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-k-path-test-"));
  const workspace = join(temporary, "workspace");
  const outside = join(temporary, "outside.txt");
  try {
    await mkdir(workspace);
    await writeFile(join(workspace, "inside.txt"), "inside");
    await writeFile(outside, "outside");
    assert.equal(await confinedWorkspacePath(workspace, "inside.txt"), join(workspace, "inside.txt"));
    await assert.rejects(confinedWorkspacePath(workspace, "../outside.txt"), /outside the active project/);
    await assert.rejects(confinedWorkspacePath(workspace, outside), /outside the active project/);
    try {
      await symlink(outside, join(workspace, "escape.txt"), "file");
    } catch (cause) {
      if (cause?.code === "EPERM") {
        context.diagnostic("File symlink creation is unavailable on this Windows host");
        return;
      }
      throw cause;
    }
    await assert.rejects(confinedWorkspacePath(workspace, "escape.txt"), /resolves outside/);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});
