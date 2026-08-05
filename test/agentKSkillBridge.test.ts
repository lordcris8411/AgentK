import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const legacyToolName = /agent_k_(?:file_editor|cpp_language_server|native_debugger)/u;

test("registers one compact Agent K Skill bridge without legacy tool definitions", async () => {
  const source = await readFile(join(root, "agent-k-permissions.ts"), "utf8");
  assert.equal(source.match(/name: "agent_k"/gu)?.length, 1);
  assert.match(source, /pi\.registerTool\(agentKTool\)/u);
  assert.doesNotMatch(source, /name: "agent_k_(?:file_editor|cpp_language_server|native_debugger)"/u);
  assert.match(source, /arguments: Type\.Optional\(Type\.Record/u);
});

test("documents Agent K host capabilities through Skills instead of legacy tools", async () => {
  const paths = [
    "skills/agent-k-file-editor/SKILL.md",
    "editor/extensions/audio/SKILL.md",
    "editor/extensions/html/SKILL.md",
    "editor/extensions/image/SKILL.md",
    "editor/extensions/markdown/SKILL.md",
    "editor/extensions/pdf/SKILL.md",
    "editor/extensions/text/SKILL.md",
    "editor/extensions/video/SKILL.md",
    "language-servers/cpp-clangd/SKILL.md",
    "language-servers/cpp-clangd/agent-k.language-server.json",
  ];
  const contents = await Promise.all(paths.map((path) => readFile(join(root, path), "utf8")));
  for (let index = 0; index < contents.length; index += 1) {
    assert.doesNotMatch(contents[index] ?? "", legacyToolName, paths[index]);
    assert.match(contents[index] ?? "", /agent_k/u, paths[index]);
  }
  assert.match(contents[0] ?? "", /capability: "file-editor"/u);
  assert.match(contents.at(-2) ?? "", /capability: "cpp-language-server"/u);
  assert.match(contents.at(-2) ?? "", /capability: "native-debugger"/u);
});
