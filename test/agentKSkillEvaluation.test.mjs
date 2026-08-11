import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { allCases, categories, skillDevelopment } from "../evaluation/agent-k/specs.mjs";
import { markdownReport, mergePlatformResults } from "../evaluation/agent-k/report.mjs";
import { validateEditor, validateInvocationEvidence, validateSkill, validateTheme } from "../evaluation/agent-k/validators.mjs";
import { execute as executeRecordTool } from "../evaluation/agent-k/fixtures/skill/agent-k-eval-record-tools/scripts/run.mjs";

test("evaluation catalog has the agreed sample counts and stable unique ids", () => {
  assert.equal(categories["theme-development"].length, 10);
  assert.equal(categories["skill-development"].length, 10);
  assert.equal(categories["editor-development"].length, 10);
  assert.equal(categories["language-development"].length, 2);
  assert.equal(categories["skill-invocation"].length, 10);
  assert.equal(categories["editor-invocation"].length, 10);
  assert.equal(categories["csharp-invocation"].length, 10);
  assert.equal(categories["typescript-invocation"].length, 10);
  assert.equal(categories["cpp-invocation"].length, 10);
  assert.equal(allCases.length, 82);
  assert.equal(new Set(allCases.map((item) => item.id)).size, allCases.length);
});

test("language authoring specs pin isolated Windows and Linux toolchains", () => {
  const source = JSON.stringify(categories["language-development"]);
  for (const value of ["10.0.302", "0.26.0", "24.18.1", "5.3.0", "6.0.3", "Windows x64", "Linux x64", "staging", "cache"]) assert.match(source, new RegExp(value.replaceAll(".", "\\."), "u"));
});

test("ordinary Skill authoring publishes the exact API while keeping validation data hidden", () => {
  for (const specification of skillDevelopment) {
    assert.match(specification.prompt, new RegExp(`Operation argument: ${JSON.stringify(specification.contract.operation)}`, "u"));
    assert.ok(specification.prompt.includes(`Input JSON shape: ${specification.contract.inputShape}`));
    assert.ok(specification.prompt.includes(`Output JSON shape: ${specification.contract.outputShape}`));
    assert.ok(specification.prompt.includes(`Public example input: ${JSON.stringify(specification.contract.example.input)}`));
    assert.ok(specification.prompt.includes(`Required public example output: ${JSON.stringify(specification.contract.example.output)}`));
    assert.equal(specification.prompt.includes(JSON.stringify(specification.expected.input)), false, specification.id);
  }
});

test("Editor authoring publishes action behavior while keeping replay content hidden", () => {
  for (const specification of categories["editor-development"]) {
    assert.match(specification.prompt, /Public action contract:/u);
    assert.match(specification.prompt, /Public before example:/u);
    assert.match(specification.prompt, /Required after example:/u);
    assert.equal(specification.prompt.includes(JSON.stringify(specification.expected.input)), false, specification.id);
  }
});

test("Editor replay waits for workspace readiness before opening a generated format", async () => {
  const source = await readFile(new URL("e2e/agent-k-skill-eval.spec.mjs", import.meta.url), "utf8");
  const replayBranch = source.slice(source.indexOf("if (replay) {", source.indexOf('test("runs one isolated')));
  assert.ok(replayBranch.indexOf("composer-editor") < replayBranch.indexOf("runDevelopmentReplay"));
});

test("language invocation waits for workspace readiness before opening the text Editor", async () => {
  const source = await readFile(new URL("e2e/agent-k-skill-eval.spec.mjs", import.meta.url), "utf8");
  const branch = source.slice(source.indexOf('if (["csharp-invocation", "typescript-invocation"]'));
  assert.ok(branch.indexOf("composer-editor") < branch.indexOf("runLanguageHostCase"));
});

test("language invocation catalogs cover the required operations", () => {
  assert.deepEqual(categories["csharp-invocation"].map((item) => item.expected.method), ["diagnostics", "definition", "references", "hover", "document-symbols", "workspace-symbols", "completion", "rename", "formatting", "build"]);
  assert.deepEqual(categories["typescript-invocation"].map((item) => item.expected.method), ["diagnostics", "definition", "references", "hover", "document-symbols", "workspace-symbols", "completion", "rename", "formatting", "organize-imports"]);
  assert.deepEqual(categories["cpp-invocation"].map((item) => item.expected.method), ["definition", "references", "hover", "diagnostics", "symbols", "document-symbols", "incoming-calls", "outgoing-calls", "supertypes", "subtypes"]);
});

test("platform merge requires both Windows and Linux for every logical case", () => {
  const result = { schemaVersion: 1, caseId: "x", category: "skill-invocation", checks: [{ name: "ok", passed: true }], passed: true };
  const incomplete = mergePlatformResults([{ ...result, platform: "win32" }]);
  assert.equal(incomplete.success, false);
  assert.deepEqual(incomplete.cases[0].missingPlatforms, ["linux"]);
  const complete = mergePlatformResults([{ ...result, platform: "win32" }, { ...result, platform: "linux" }]);
  assert.equal(complete.success, true);
  assert.match(markdownReport(complete), /1\/1 PASS/u);
  assert.deepEqual(complete.productGaps, []);
  assert.match(markdownReport(complete), /## Product gaps\s+None\./u);
});

test("theme validator checks complete color groups and essential contrast", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agent-k-eval-theme-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const template = JSON.parse(await readFile(new URL("../skills/create-agent-k-theme/assets/theme.template.json", import.meta.url), "utf8"));
  const specification = { artifact: ".pi/agent/k_themes/my-theme.json", expected: { base: "dark", themeId: "my-theme" } };
  await mkdir(join(root, "themes"), { recursive: true });
  await writeFile(join(root, "themes", "my-theme.json"), JSON.stringify(template), "utf8");
  const checks = await validateTheme(root, specification, template);
  assert.equal(checks.every((item) => item.passed), true, JSON.stringify(checks));
});

test("Skill validator executes a generated Skill through the cross-platform Node interface", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agent-k-eval-skill-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const specification = skillDevelopment[0];
  const directory = join(root, specification.artifact);
  await mkdir(join(directory, "scripts"), { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---\nname: ${specification.expected.name}\ndescription: Deterministically summarize supplied JSON Lines records for repeatable Agent K evaluation tasks.\n---\n\n# Summarize\n\nRun \`node scripts/run.mjs summarize '<json-input>'\` and receive the documented JSON summary. This command accepts an object containing a lines array and rejects malformed inputs.\n`, "utf8");
  await writeFile(join(directory, "scripts", "run.mjs"), `const input=JSON.parse(process.argv[3]);let valid=0,invalid=0;const keys=new Set;for(const line of input.lines){try{const value=JSON.parse(line);valid++;Object.keys(value).forEach(key=>keys.add(key))}catch{invalid++}}process.stdout.write(JSON.stringify({valid,invalid,uniqueKeys:[...keys].sort()}));`, "utf8");
  await writeFile(join(directory, "scripts", "run.test.mjs"), `import test from 'node:test';test('ok',()=>{});`, "utf8");
  const checks = await validateSkill(root, specification);
  assert.equal(checks.every((item) => item.passed), true, JSON.stringify(checks));
});

test("Editor validator requires a documented capability and passing behavior tests", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agent-k-eval-editor-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const specification = categories["editor-development"][0];
  const directory = join(root, specification.artifact);
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(join(directory, "editor.json"), JSON.stringify({ apiVersion: 1, version: "1.0.0", id: specification.expected.id, name: "Test Editor", match: { extensions: [specification.expected.extension] }, editor: "plugin", editable: true, capabilities: [{ id: specification.expected.action, label: "Sort", description: "Sort entries." }], runtime: { entry: "dist/editor.iife.js", style: "dist/editor.css" } }), "utf8");
  await writeFile(join(directory, "editor.ts"), "export {};\n", "utf8");
  await writeFile(join(directory, "editor.css"), "textarea {}\n", "utf8");
  await writeFile(join(directory, "dist", "editor.iife.js"), "(() => {})();\n", "utf8");
  await writeFile(join(directory, "dist", "editor.css"), "textarea {}\n", "utf8");
  await writeFile(join(directory, "SKILL.md"), `---\nname: test-editor\ndescription: Use the test Editor to sort palette entries currently open in Agent K.\n---\n\n# Test Editor\n\nCall the agent_k file-editor capability with action ${specification.expected.action} for the active matching file.\n`, "utf8");
  await writeFile(join(directory, "editor.test.mjs"), "import test from 'node:test'; test('behavior', () => {});\n", "utf8");
  const checks = await validateEditor(root, specification);
  assert.equal(checks.every((item) => item.passed), true, JSON.stringify(checks));
});

test("invocation evidence requires observable tool use", () => {
  const specification = categories["editor-invocation"][0];
  const good = { expanded: "agent-k-eval-editor-actions", activeFile: "sample.pal", initialEditorContent: "zeta=1", editorContent: "alpha=1", editorDiskContent: "alpha=1", tool: { name: "agent_k", arguments: { capability: "file-editor", action: "sort-colors" } } };
  assert.equal(validateInvocationEvidence(specification, good).every((item) => item.passed), true);
  assert.equal(validateInvocationEvidence(specification, { text: "done" }).every((item) => item.passed), false);
});

test("language invocation evidence requires a successful host record", () => {
  const specification = categories["csharp-invocation"][1];
  const good = { languageHost: { editorStatus: "textDocument/definition completed", records: [{ pluginId: "agent-k.csharp", method: "definition", command: "language_pack_request", result: null, transport: "editor-frame" }], workspaceWrites: [] } };
  assert.equal(validateInvocationEvidence(specification, good).every((item) => item.passed), true);
  const failed = { languageHost: { records: [{ pluginId: "agent-k.csharp", method: "definition", command: "language_pack_request", error: "worker stopped" }] } };
  assert.equal(validateInvocationEvidence(specification, failed).every((item) => item.passed), false);
});

test("ordinary Skill evidence includes the exact operation, input, and output", () => {
  const specification = categories["skill-invocation"][0];
  const evidence = {
    expanded: "agent-k-eval-record-tools",
    tool: { name: "bash", arguments: { command: `node scripts/run.mjs ${specification.expected.operation} '${JSON.stringify(specification.expected.input)}'` } },
    output: JSON.stringify(specification.expected.output),
  };
  assert.equal(validateInvocationEvidence(specification, evidence).every((item) => item.passed), true);
});

test("C++ invocation ignores tool schema placeholders when checking status-first order", () => {
  const specification = categories["cpp-invocation"][0];
  const evidence = {
    expanded: "cpp-project-tools",
    state: { tools: [{ type: "toolCall", name: "agent_k", arguments: { capability: "language", packId: "agent-k.cpp" } }] },
    events: [
      { type: "tool_execution_start", toolName: "agent_k", args: { capability: "language", packId: "agent-k.cpp", action: "project.status" } },
      { type: "tool_execution_start", toolName: "agent_k", args: { capability: "language", packId: "agent-k.cpp", action: `language.${specification.expected.method}` } },
    ],
  };
  assert.equal(validateInvocationEvidence(specification, evidence).every((item) => item.passed), true);
});

test("ordinary Skill invocation includes generated Skill integration samples", () => {
  assert.equal(categories["skill-invocation"].filter((item) => item.expected.artifactCase).length, 3);
});

test("Editor invocation includes generated Editor integration samples", () => {
  assert.equal(categories["editor-invocation"].filter((item) => item.expected.artifactCase).length, 3);
});

test("golden record Skill covers every ordinary Skill invocation contract", () => {
  for (const specification of categories["skill-invocation"])
    assert.deepEqual(executeRecordTool(specification.expected.operation, specification.expected.input), specification.expected.output, specification.id);
});
