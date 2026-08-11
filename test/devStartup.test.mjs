import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("development startup excludes generated Agent K worktrees from Vite watching", async () => {
  const config = await readFile(resolve(root, "vite.config.ts"), "utf8");
  assert.match(config, /ignored:\s*\["\*\*\/\.agent-k-\*\/\*\*"\]/u);
});

test("development startup bounds each Vite readiness request", async () => {
  const launcher = await readFile(resolve(root, "script", "electron-dev.mjs"), "utf8");
  assert.match(launcher, /signal:\s*AbortSignal\.timeout\(1_000\)/u);
});

test("desktop startup does not repeat Editor validation or wait for fonts", async () => {
  const app = await readFile(resolve(root, "src", "App.tsx"), "utf8");
  assert.doesNotMatch(app, /await desktop\.firstPartyFileFormatPlugins\(\)/u);
  assert.doesNotMatch(app, /document\.fonts\.ready/u);
});

test("Language Pack project discovery waits until critical startup is complete", async () => {
  const app = await readFile(resolve(root, "src", "App.tsx"), "utf8");
  const inspector = await readFile(resolve(root, "src", "components", "layout", "InspectorPanel.tsx"), "utf8");
  assert.match(app, /window\.dispatchEvent\(new Event\("agent-k-startup-ready"\)\)/u);
  assert.match(inspector, /addEventListener\("agent-k-startup-ready", refreshAfterStartup/u);
});
