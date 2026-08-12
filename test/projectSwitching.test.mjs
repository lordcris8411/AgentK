import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const inspectorPath = resolve(
  import.meta.dirname,
  "..",
  "src",
  "components",
  "layout",
  "InspectorPanel.tsx",
);

test("late directory expansion results cannot escape their original workspace", async () => {
  const source = await readFile(inspectorPath, "utf8");
  assert.match(source, /const targetRoot = root;[\s\S]*desktop\.directory\(targetRoot, path\);[\s\S]*if \(currentRoot\.current !== targetRoot\) return;/u);
  assert.match(source, /if \(currentRoot\.current === targetRoot\)\s*onError\(`无法读取目录/u);
});

test("tree entry selection refreshes its directory loader when the workspace changes", async () => {
  const source = await readFile(inspectorPath, "utf8");
  assert.match(source, /const loadDirectory = useCallback\([\s\S]*?\}, \[onError, root\]\);/u);
  assert.match(source, /const selectTreeEntry = useCallback\([\s\S]*?\}, \[loadDirectory, paintTreeSelection\]\);/u);
});

test("activating an editor tab reveals and selects its file tree entry", async () => {
  const source = await readFile(inspectorPath, "utf8");
  assert.match(source, /function treePathForTab\(tab: Tab\)[\s\S]*?tab\.directoryPath[\s\S]*?tab\.projectOverview/u);
  assert.match(source, /useLayoutEffect\(\(\) => \{[\s\S]*?const tab = tabsRef\.current\.find\([\s\S]*?treePathForTab\(tab\)[\s\S]*?loadDirectory\(ancestor\.path\)[\s\S]*?paintTreeSelection\(entry\.path\)[\s\S]*?scrollIntoView/u);
});

test("workspace switching does not restore stale directory preview capabilities", async () => {
  const source = await readFile(inspectorPath, "utf8");
  assert.match(source, /restored\?\.tabs\.filter\(\(tab\) => !tab\.directoryPreview\)/u);
  assert.match(source, /const restoredActive = restored\?\.active && restoredTabs\.some/u);
});
