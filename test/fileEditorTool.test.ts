import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  FILE_EDITOR_OPEN_REQUEST_PREFIX,
  requestFileOpen,
  validatedFileToOpen,
} from "../agent-file-editor.ts";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inspectorSource = await readFile(
  new URL("../src/components/layout/InspectorPanel.tsx", import.meta.url),
  "utf8",
);
const pluginFrameSource = await readFile(
  new URL("../src/features/file-formats/PluginEditorFrame.tsx", import.meta.url),
  "utf8",
);

test("a missing agent-requested file fails before contacting the editor UI", async () => {
  let inputCalls = 0;
  await assert.rejects(
    requestFileOpen(workspace, "definitely-missing.txt", { action: "open" }, async () => {
      inputCalls += 1;
      return JSON.stringify({ ok: true });
    }),
    /File does not exist: definitely-missing\.txt/,
  );
  assert.equal(inputCalls, 0);
});

test("file-open waits for a positive editor acknowledgement", async () => {
  const requests: string[] = [];
  await requestFileOpen(workspace, "package.json", { action: "open", path: "package.json" }, async (request) => {
    requests.push(request);
    return JSON.stringify({ ok: true });
  });
  assert.match(requests[0] ?? "", new RegExp(`^${FILE_EDITOR_OPEN_REQUEST_PREFIX}`));
});

test("an editor rejection remains a nonfatal tool-level error", async () => {
  await assert.rejects(
    requestFileOpen(workspace, "package.json", { action: "open" }, async () =>
      JSON.stringify({ ok: false, error: "Editor could not load this file." })),
    /Editor could not load this file\./,
  );
});

test("file-open rejects directories and paths outside the workspace", () => {
  assert.throws(() => validatedFileToOpen(workspace, "."), /Path is not a file/);
  assert.throws(() => validatedFileToOpen(workspace, ".."), /outside the current workspace/);
});

test("agent editor utility failures respond to the tool without showing UI errors", () => {
  assert.match(
    inspectorSource,
    /const runWebProject[\s\S]*?if \(detail\.respond\) event\.preventDefault\(\);[\s\S]*?if \(detail\.respond\) detail\.respond\(\{ ok: false, error: message \}\);[\s\S]*?else onError\(message\);/,
  );
  assert.match(
    inspectorSource,
    /captureRenderedPreview\(detail\.outputPath, !detail\.respond\)[\s\S]*?detail\.respond\?\.\(result\)/,
  );
  assert.match(
    pluginFrameSource,
    /const agentActions = \[\.\.\.pendingActions\.current\.values\(\)\];[\s\S]*?pending\.respond\(\{ ok: false, error \}\);[\s\S]*?if \(!agentActions\.length\) onError\(error\);/,
  );
});
