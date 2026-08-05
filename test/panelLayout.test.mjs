import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fitPanelWidths } from "../src/components/layout/panelLayout.ts";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("clamps an oversized persisted inspector before the first window resize", () => {
  assert.deepEqual(fitPanelWidths(1600, 245, 1343), {
    left: 245,
    right: 643,
  });
});

test("preserves valid persisted panel widths", () => {
  assert.deepEqual(fitPanelWidths(1600, 304, 420), {
    left: 304,
    right: 420,
  });
});

test("keeps both panel minimums and the workspace minimum", () => {
  assert.deepEqual(fitPanelWidths(1372, 1000, 1000), {
    left: 240,
    right: 420,
  });
});

test("all resizable inspector layout is backed by client settings", async () => {
  const [inspector, dock, settings] = await Promise.all([
    source("src/components/layout/InspectorPanel.tsx"),
    source("src/components/layout/DevelopmentDock.tsx"),
    source("electron/settings.ts"),
  ]);
  assert.match(inspector, /useState\(settings\.fileExplorerWidth\)/);
  assert.match(inspector, /if \(!settingsReady \|\| explorerLayoutRestored\.current\) return/);
  assert.match(inspector, /updateSettings\(\{\s*fileExplorerWidth:/);
  assert.match(dock, /useState\(settings\.developmentDockHeight\)/);
  assert.match(dock, /if \(!settingsReady \|\| layoutRestored\.current\) return/);
  assert.match(dock, /developmentDockHeight: Math\.round\(heightRef\.current\)/);
  assert.match(dock, /developmentDockCollapsed: next/);
  assert.match(dock, /developmentDockTerminalVisible: next/);
  assert.match(settings, /fileExplorerWidth: 190/);
  assert.match(settings, /developmentDockHeight: 280/);
});

test("file selection creates a visible pending tab before storage finishes", async () => {
  const inspector = await source("src/components/layout/InspectorPanel.tsx");
  assert.match(inspector, /loading\?: boolean/);
  assert.match(inspector, /tabsRef\.current = pendingTabs;\s*setTabs\(pendingTabs\);\s*activateTab\(path\)/);
  assert.match(inspector, /current\?\.loading[\s\S]*Opening file…/);
  assert.match(inspector, /const liveTabs = tabsRef\.current/);
});
