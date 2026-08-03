import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const inspectorSource = await readFile(
  new URL("../src/components/layout/InspectorPanel.tsx", import.meta.url),
  "utf8",
);
const conversationSource = await readFile(
  new URL("../src/features/conversation/ConversationWorkspace.tsx", import.meta.url),
  "utf8",
);

test("C++ project folder selection owns Debug and README presentation", () => {
  assert.match(inspectorSource, /selectedLanguagePlugin\?\.languages\.includes\("cpp"\)/);
  assert.match(inspectorSource, /plugin\.projectMarkers\.some/);
  assert.match(inspectorSource, /selectedLanguageProject\?\.root \?\? absoluteWorkspacePath/);
  assert.match(inspectorSource, /entry\.name\.toLocaleLowerCase\("en-US"\) === "readme\.md"/);
  assert.match(inspectorSource, /prepareAndOpenDebug\(selectedCppLanguagePlugin, selectedCppProject\.root\)/);
  assert.match(inspectorSource, /await desktop\.languageServerCall\(plugin\.id, plugin\.debugServer\.prepareMethod\)[\s\S]*?await desktopWindow\.openDebug\(projectRoot\)/);
  assert.match(inspectorSource, /if \(selectedLanguageProject\) void unloadLanguageProject/);
  assert.match(inspectorSource, /loadLanguageProject\(selectedLanguagePlugin, selectedCppProject\.root\)/);
  assert.doesNotMatch(inspectorSource, /currentIsWorkspaceFile\s*\?\s*\(\s*<button[\s\S]*?openDebug/);
});

test("language projects remain visible in the tree before their server is loaded", () => {
  assert.match(inspectorSource, /status: "unloaded"/);
  assert.match(inspectorSource, /statusLabel: en \? "Language service not loaded" : "未加载语言服务"/);
  assert.match(inspectorSource, /plugin\.projectMarkers\.some/);
});

test("nested C++ folders are owned by the outer language project", () => {
  assert.match(inspectorSource, /function detectedLanguageProjectPlugins/);
  assert.match(inspectorSource, /owningPluginIds\.has\(plugin\.id\)/);
  assert.match(inspectorSource, /visit\(child, nextOwners\)/);
  assert.match(inspectorSource, /const cmakeSolution = Boolean\(languageProject\) && isCMakeSolutionDirectory/);
});

test("project build action renders profiles and sends the selected profile to the plugin", () => {
  assert.match(inspectorSource, /className="language-build-split"/);
  assert.match(inspectorSource, /selectedProfileAction\.profiles\?\.map/);
  assert.match(inspectorSource, /arguments: profile \? \[profile\] : \[\]/);
});

test("missing README action is delivered through the normal Pi prompt path", () => {
  assert.match(inspectorSource, /new CustomEvent\("agent-k-submit-prompt"/);
  assert.match(conversationSource, /submit\("queue", message, \[\]\)/);
});
