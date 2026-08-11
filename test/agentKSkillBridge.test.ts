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

test("file-editor actions wait for an iframe execution acknowledgement", async () => {
  const [bridge, ui, frame, sdk] = await Promise.all([
    readFile(join(root, "agent-k-permissions.ts"), "utf8"),
    readFile(join(root, "src/features/extensions/ExtensionUiContext.tsx"), "utf8"),
    readFile(join(root, "src/features/file-formats/PluginEditorFrame.tsx"), "utf8"),
    readFile(join(root, "editor/sdk/index.ts"), "utf8"),
  ]);

  assert.match(bridge, /await ctx\.ui\.input\(`\$\{fileFormatActionRequestPrefix\}/u);
  assert.match(ui, /fileFormatActionRequestPrefix/u);
  assert.match(frame, /const \{ respond, \.\.\.parameters \} = detail/u);
  assert.match(frame, /case "action-complete"/u);
  assert.match(sdk, /post\(nonce, "action-complete"/u);
  assert.match(sdk, /post\(nonce, "action-error"/u);
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
    "language-packs/cpp/SKILL.md",
    "language-packs/cpp/agent-k.language-pack.json",
  ];
  const contents = await Promise.all(paths.map((path) => readFile(join(root, path), "utf8")));
  for (let index = 0; index < contents.length; index += 1) {
    assert.doesNotMatch(contents[index] ?? "", legacyToolName, paths[index]);
    assert.match(contents[index] ?? "", /agent_k/u, paths[index]);
  }
  assert.match(contents[0] ?? "", /capability: "file-editor"/u);
  assert.match(contents.at(-2) ?? "", /capability: "language"/u);
  assert.match(contents.at(-2) ?? "", /packId: "agent-k\.cpp"/u);
  assert.doesNotMatch(contents.at(-2) ?? "", /cpp-language-server|native-debugger/u);
});

test("bundles dedicated guidance for creating callable Pi Skills", async () => {
  const source = await readFile(join(root, "skills/create-pi-skill/SKILL.md"), "utf8");

  assert.match(source, /description: Create or update standalone, reusable Pi Skills/u);
  assert.match(source, /exact command, operation names, input JSON shape, output JSON shape/u);
  assert.match(source, /A frontmatter-only `SKILL\.md` is incomplete/u);
  assert.match(source, /Execute each documented public example through the real command-line entry point/u);
  assert.match(source, /Windows and Linux/u);
});
