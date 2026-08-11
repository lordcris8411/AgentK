import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Markdown preview and conversation use the same presentation rules", async () => {
  const [shared, theme, conversation, previewCss, preview] = await Promise.all([
    source("editor/shared/markdown-content.css"),
    source("src/styles/theme.css"),
    source("src/features/conversation/ConversationWorkspace.tsx"),
    source("editor/extensions/markdown/editor.css"),
    source("editor/extensions/markdown/editor.ts"),
  ]);
  assert.match(shared, /\.agent-k-markdown-content h1/);
  assert.match(shared, /\.agent-k-markdown-content table/);
  assert.match(shared, /\.agent-k-markdown-content pre/);
  assert.match(theme, /@import "\.\.\/\.\.\/editor\/shared\/markdown-content\.css"/);
  assert.match(previewCss, /@import "\.\.\/\.\.\/shared\/markdown-content\.css"/);
  assert.match(conversation, /className="agent-k-markdown-content message-content"/);
  assert.match(preview, /preview\.className = "agent-k-markdown-content markdown-preview"/);
});

test("preview surfaces receive compact controls and themed scrollbars", async () => {
  const [imageCss, sdk, html, inspector, main] = await Promise.all([
    source("editor/extensions/image/editor.css"),
    source("editor/sdk/index.ts"),
    source("editor/extensions/html/editor.ts"),
    source("src/components/layout/InspectorPanel.tsx"),
    source("electron/main.ts"),
  ]);
  assert.match(imageCss, /\.image-toolbar button \{[^}]*height: 25px;[^}]*min-width: 25px;/s);
  assert.match(sdk, /function applyEditorScrollbarTheme/);
  assert.match(html, /themedPreviewDocument\(model\.getValue\(\), themeConfig\)/);
  assert.match(inspector, /styleWebPreviewScrollbars\(current\.webPreviewUrl!/);
  assert.match(main, /case "style-preview-scrollbars"/);
});

test("preview console capture waits for the application renderer to load", async () => {
  const main = await source("electron/main.ts");
  const createWindows = main.slice(main.indexOf("function createWindows"), main.indexOf("function loadDebugWindow"));
  assert.match(createWindows, /webContents\.once\("did-finish-load", \(\) => \{[\s\S]*?enablePreviewConsole\(window\)/u);
  assert.doesNotMatch(createWindows, /if \(process\.env\.AGENT_K_E2E !== "1"\) enablePreviewConsole\(mainWindow\)/u);
});
