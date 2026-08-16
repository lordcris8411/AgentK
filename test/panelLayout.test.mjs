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

test("multiple Editors can float into independent windows and dock separately", async () => {
  const [inspector, main, pluginFrame, theme] = await Promise.all([
    source("src/components/layout/InspectorPanel.tsx"),
    source("electron/main.ts"),
    source("src/features/file-formats/PluginEditorFrame.tsx"),
    source("src/styles/theme.css"),
  ]);
  assert.match(inspector, /`agent-k-floating-editor-\$\{id\}`/);
  assert.match(inspector, /return createPortal\([\s\S]*?floatingWindow\.document\.body/);
  assert.match(inspector, /floating\.addEventListener\("pagehide"/);
  assert.match(inspector, /new Map<string, FloatingEditorSession>/);
  assert.match(inspector, /nextFloatingEditors\.set\(editorPath, session\)/);
  assert.match(inspector, /kind: directoryPreview \? "directory" : "plugin"/);
  assert.match(inspector, /activePluginEditorProps \|\| \(current\?\.directoryPreview && current\.webPreviewUrl\)/);
  assert.match(inspector, /function DirectoryPreviewSurface/);
  assert.match(inspector, /session\.kind === "directory"/);
  assert.match(inspector, /floatingEditor=\{floatingEditor\}/);
  assert.match(inspector, /tabs\.filter\(\(tab\) => !floatingEditors\.has\(tab\.path\)\)/);
  assert.match(inspector, /const remainingTabs = liveTabs\.filter\(\(tab\) => !nextFloatingEditors\.has\(tab\.path\)\)/);
  assert.match(inspector, /aria-label=\{en \? "Dock Editor" : "吸附 Editor"\}/);
  assert.match(inspector, /aria-label=\{en \? "Float Editor" : "浮动 Editor"\}/);
  assert.match(inspector, /window-icon-dock-editor/);
  assert.match(inspector, /window-icon-float-editor/);
  assert.match(inspector, /window-editor-placement-control/);
  assert.match(inspector, /renderEditorToolbar\(floatingTab, floatingEditor, true\)/);
  assert.match(inspector, /controlFloatingEditor\(floatingId, "minimize"\)/);
  assert.match(inspector, /floatingWindow=\{floatingEditor\?\.window\}/);
  assert.match(inspector, /floatingId=\{floatingEditor\?\.id\}/);
  assert.match(inspector, /key=\{floatingWindow \? "floating" : "docked"\}/);
  assert.doesNotMatch(inspector, /当前 Editor 已浮动/);
  assert.match(inspector, /floatingShortcuts = \[\.\.\.floatingEditors\.values\(\)\]\.map\(\(\{ path, window: floating \}\)/);
  assert.match(inspector, /void saveTab\(tab\)/);
  assert.match(inspector, /agent-k-floating-editor-message/);
  assert.match(inspector, /agent-k-floating-editor-send/);
  assert.match(inspector, /const hostWindow = frame\.ownerDocument\.defaultView \?\? window/);
  assert.match(pluginFrame, /frameRef\.current\?\.ownerDocument\.defaultView \?\? window/);
  assert.match(pluginFrame, /hostWindow \? window : frameRef\.current\?\.ownerDocument\.defaultView \?\? window/);
  assert.match(pluginFrame, /agent-k-floating-editor-message/);
  assert.match(pluginFrame, /hostWindow\.document\.createEvent\("CustomEvent"\)/);
  assert.match(pluginFrame, /if \(!hostWindow && event\.source !== frameRef\.current\?\.contentWindow\) return/);
  assert.match(pluginFrame, /send\("host-ready"\)/);
  assert.match(pluginFrame, /if \(initializedDocumentRef\.current !== documentIdentity\) initialize\(\)/);
  assert.match(pluginFrame, /!ready \|\| initializedDocumentRef\.current !== documentIdentity/);
  assert.match(pluginFrame, /if \(!frameUrl \|\| !frameRef\.current\) return/);
  assert.match(main, /\^agent-k-floating-editor-\[0-9a-f-\]\{36\}\$/);
  assert.match(main, /outlivesOpener: false/);
  assert.match(main, /frame: false/);
  assert.match(main, /floatingEditorWindows\.set\(id, child\)/);
  assert.match(main, /const previewWindow = floatingEditorId[\s\S]*?floatingEditorWindows\.get\(floatingEditorId\)/);
  assert.match(main, /child\.setParentWindow\(mainWindow\)/);
  assert.match(main, /child\.webContents\.setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(theme, /body\.is-floating-editor-window/);
  assert.match(theme, /\.editor-content-surface\.is-floating/);
  assert.match(theme, /\.floating-editor-window-titlebar/);
});
