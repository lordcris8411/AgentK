import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { directoryPresentation, previewHtml } from "../electron/directory-preview.ts";
import { directoryAppWorkspacePath } from "../src/features/file-formats/directoryPreview.ts";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const normalized = (path) => path?.replaceAll("\\", "/");

test("directory presentation recognizes k-apps and preserves app/index/readme priority", () => {
  const app = directoryPresentation("tools/demo", ["ICON.SVG", "README.md", "Index.htm", "App.html"]);
  assert.equal(normalized(app.iconPath), "tools/demo/ICON.SVG");
  assert.deepEqual(app.preview && { ...app.preview, path: normalized(app.preview.path) }, { kind: "index", path: "tools/demo/Index.htm" });
  assert.equal(directoryPresentation("tools/plain-app", ["App.html"]).preview, undefined);
  const kApp = directoryPresentation("tools/k-app", ["CONFIG.K", "app.htm", "index.html"]).preview;
  assert.deepEqual(kApp && {
    ...kApp,
    configPath: normalized(kApp.configPath),
    path: normalized(kApp.path),
  }, { configPath: "tools/k-app/CONFIG.K", kind: "k-app", path: "tools/k-app/app.htm" });
  const index = directoryPresentation("docs", ["README.md", "index.html"]).preview;
  assert.deepEqual(index && { ...index, path: normalized(index.path) }, { kind: "index", path: "docs/index.html" });
  const readme = directoryPresentation("docs", ["README.md"]).preview;
  assert.deepEqual(readme && { ...readme, path: normalized(readme.path) }, { kind: "readme", path: "docs/README.md" });
});

test("directory app file access cannot escape its directory", () => {
  assert.equal(directoryAppWorkspacePath("tools/demo", "data/config.json"), "tools/demo/data/config.json");
  assert.throws(() => directoryAppWorkspacePath("tools/demo", "../secret.txt"), /cannot leave/);
  assert.throws(() => directoryAppWorkspacePath("tools/demo", "C:/secret.txt"), /must be relative/);
  assert.throws(() => directoryAppWorkspacePath("tools/demo", "/secret.txt"), /must be relative/);
});

test("only k-app HTML receives the Agent K JavaScript bridge before app scripts", () => {
  const app = previewHtml(Buffer.from("<html><head><script>startApp()</script></head></html>"), "token", true).toString("utf8");
  const index = previewHtml(Buffer.from("<main>index</main>"), "token", false).toString("utf8");
  assert.match(app, /Object\.defineProperty\(window,'AgentK'/);
  assert.match(app, /files:Object\.freeze/);
  assert.match(app, /pi:Object\.freeze/);
  assert.match(app, /processes:Object\.freeze/);
  assert.ok(app.indexOf("Object.defineProperty(window,'AgentK'") < app.indexOf("startApp()"));
  assert.doesNotMatch(index, /agent-k-directory-app-request/);
});

test("the injected k-app API emits exact asynchronous host requests", async () => {
  const html = previewHtml(Buffer.from("<main>app</main>"), "token", true).toString("utf8");
  const script = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1];
  assert.ok(script);
  const posted = [];
  const listeners = new Map();
  const sandbox = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    parent: { postMessage: (message) => posted.push(message) },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(script, sandbox);
  assert.ok(Object.isFrozen(sandbox.AgentK));
  assert.ok(Object.isFrozen(sandbox.AgentK.files));
  assert.ok(Object.isFrozen(sandbox.AgentK.processes));
  const request = (promise, expected) => {
    const message = posted.shift();
    assert.deepEqual(JSON.parse(JSON.stringify(message)), expected(message.requestId));
    listeners.get("message")({ data: { type: "agent-k-directory-app-response", requestId: message.requestId, ok: true, result: "ok" } });
    return promise;
  };
  await request(sandbox.AgentK.files.read("a.txt"), (requestId) => ({ type: "agent-k-directory-app-request", requestId, method: "files.read", arguments: { path: "a.txt" } }));
  await request(sandbox.AgentK.files.write("b.txt", "content"), (requestId) => ({ type: "agent-k-directory-app-request", requestId, method: "files.write", arguments: { path: "b.txt", content: "content" } }));
  await request(sandbox.AgentK.files.list("data"), (requestId) => ({ type: "agent-k-directory-app-request", requestId, method: "files.list", arguments: { path: "data" } }));
  await request(sandbox.AgentK.pi.send("hello"), (requestId) => ({ type: "agent-k-directory-app-request", requestId, method: "pi.send", arguments: { message: "hello" } }));
  await request(sandbox.AgentK.processes.start("node", ["task.mjs"], { cwd: "tools" }), (requestId) => ({ type: "agent-k-directory-app-request", requestId, method: "processes.start", arguments: { command: "node", args: ["task.mjs"], cwd: "tools" } }));
  await request(sandbox.AgentK.processes.wait("p1"), (requestId) => ({ type: "agent-k-directory-app-request", requestId, method: "processes.wait", arguments: { id: "p1" } }));
  await request(sandbox.AgentK.processes.output("p1", { stdoutCursor: 4, stderrCursor: 2 }), (requestId) => ({ type: "agent-k-directory-app-request", requestId, method: "processes.output", arguments: { id: "p1", stdoutCursor: 4, stderrCursor: 2 } }));
  await request(sandbox.AgentK.processes.stop("p1"), (requestId) => ({ type: "agent-k-directory-app-request", requestId, method: "processes.stop", arguments: { id: "p1" } }));
  await request(sandbox.AgentK.processes.open("chrome.exe"), (requestId) => ({ type: "agent-k-directory-app-request", requestId, method: "processes.open", arguments: { target: "chrome.exe" } }));
  const rejected = sandbox.AgentK.files.read("denied.txt");
  const denied = posted.shift();
  listeners.get("message")({ data: { type: "agent-k-directory-app-response", requestId: denied.requestId, ok: false, error: "denied" } });
  await assert.rejects(rejected, /denied/);
});

test("the Agent K bridge and toolbarless preview are enabled only for a k-app", async () => {
  const [files, inspector] = await Promise.all([
    source("electron/files.ts"),
    source("src/components/layout/InspectorPanel.tsx"),
  ]);
  assert.match(files, /appBridgePaths\.has\(relative\(state\.root, canonical\)\)/);
  assert.match(files, /if \(appBridge\) this\.preview\.appBridgePaths\.add\(relativePath\)/);
  assert.match(files, /"\.htm": "text\/html; charset=utf-8"/);
  assert.match(inspector, /selectedDirectoryPreview\.kind === "k-app"/);
  assert.match(inspector, /!current\.directoryPreview\?\.kApp \? <div className="web-project-preview-actions">/);
  assert.match(inspector, /desktop\.kAppProcessStart/);
  assert.match(inspector, /desktop\.kAppProcessOutput/);
  assert.match(inspector, /desktop\.kAppProcessOpen/);
  assert.match(inspector, /desktop\.kAppProcessWait/);
});

test("a module-based index directory preview uses its web development server", async () => {
  const inspector = await source("src/components/layout/InspectorPanel.tsx");
  assert.match(inspector, /names\.has\("index\.html"\) \|\| names\.has\("index\.htm"\)/);
  assert.match(inspector, /selectedDirectoryPreview\?\.kind === "index" && !selectedDirectoryEntry\.loaded/);
  assert.match(inspector, /selectedDirectoryPreview\.kind === "index" &&[\s\S]*?selectedDirectoryWebProject[\s\S]*?desktop\.startWebProject/u);
  assert.match(inspector, /catch \{[\s\S]*?webPreviewUrl = await desktop\.startPreview/u);
  assert.match(inspector, /sandbox=\{current\.directoryPreview\?\.appBridge/);
});

test("the directory README action follows the active system text color", async () => {
  const theme = await source("src/styles/theme.css");
  assert.match(theme, /\.cpp-project-readme-empty button \{[^}]*background: var\(--surface-raised\);[^}]*color: var\(--text-primary\);/s);
  assert.doesNotMatch(theme, /\.cpp-project-readme-empty button \{[^}]*background: var\(--component-primary-action/s);
  assert.doesNotMatch(theme, /\.cpp-project-readme-empty button \{[^}]*color: var\(--component-primary-action-foreground/s);
});

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
