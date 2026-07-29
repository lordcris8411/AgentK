import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mergeWorkspaceWatchKind } from "../.electron-dist/workspace-watch.js";

test("workspace watcher preserves structural changes while debouncing", () => {
  assert.equal(mergeWorkspaceWatchKind(undefined, "change"), "change");
  assert.equal(mergeWorkspaceWatchKind(undefined, "rename"), "rename");
  assert.equal(mergeWorkspaceWatchKind("rename", "change"), "rename");
  assert.equal(mergeWorkspaceWatchKind("change", "rename"), "rename");
});

test("a Windows file creation remains a structural event after native watch coalescing", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-k-workspace-watch-"));
  const events = [];
  const watcher = watch(root, { recursive: true }, (kind, name) => {
    if (String(name) === "created.cpp") events.push(kind);
  });
  try {
    await writeFile(join(root, "created.cpp"), "int main() { return 0; }\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(events.reduce(mergeWorkspaceWatchKind, undefined), "rename", JSON.stringify(events));
  } finally {
    watcher.close();
    await rm(root, { force: true, recursive: true });
  }
});
