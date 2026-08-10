import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const colorPattern = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu;
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function assertion(name, passed, detail = "") {
  return { name, passed: Boolean(passed), ...(detail ? { detail } : {}) };
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function flattenColors(value, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === "string" ? [[path, child]] : flattenColors(child, path);
  });
}

function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  if (!colorPattern.test(foreground ?? "") || !colorPattern.test(background ?? "")) return 0;
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
  if (!match) return { fields: {}, valid: false };
  const fields = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    if (separator < 1) return { fields, valid: false };
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/gu, "");
  }
  return { fields, valid: true };
}

function relativeArtifact(root, artifact) {
  const normalized = artifact.replace(/^\.pi[\\/]agent[\\/]k_themes[\\/]/u, "themes/");
  return resolve(root, normalized);
}

export async function validateTheme(root, specification, template) {
  const path = relativeArtifact(root, specification.artifact);
  const checks = [assertion("theme file exists", await exists(path), path)];
  if (!checks[0].passed) return checks;
  let theme;
  try { theme = JSON.parse(await readFile(path, "utf8")); }
  catch (cause) { return [...checks, assertion("theme is valid JSON", false, String(cause))]; }
  checks.push(assertion("theme id matches", theme.id === specification.expected.themeId, String(theme.id)));
  checks.push(assertion("theme base matches", theme.base === specification.expected.base, String(theme.base)));
  for (const group of ["colors", "components", "monaco", "terminal"]) {
    const required = Object.keys(template[group] ?? {});
    const actual = theme[group] && typeof theme[group] === "object" ? theme[group] : {};
    checks.push(assertion(`${group} contains every required key`, required.every((key) => key in actual), required.filter((key) => !(key in actual)).join(", ")));
  }
  const colorEntries = ["colors", "components", "monaco", "monacoSyntax", "terminal"].flatMap((group) => flattenColors(theme[group], group));
  checks.push(assertion("all color values are hex", colorEntries.length > 0 && colorEntries.every(([, value]) => colorPattern.test(value))));
  const contrastPairs = [
    ["primary text", theme.colors?.["text-primary"], theme.colors?.["surface-panel"]],
    ["primary action", theme.components?.["primary-action-foreground"], theme.components?.["primary-action"]],
    ["active item", theme.components?.["active-item-foreground"], theme.components?.["active-item"]],
    ["terminal", theme.terminal?.foreground, theme.terminal?.background],
  ];
  checks.push(assertion("essential text contrast is at least 4.5:1", contrastPairs.every(([, foreground, background]) => contrastRatio(foreground, background) >= 4.5), contrastPairs.map(([name, foreground, background]) => `${name}=${contrastRatio(foreground, background).toFixed(2)}`).join(", ")));
  checks.push(assertion("logo layers are distinct", theme.colors?.["icon-primary"] !== theme.colors?.["icon-secondary"]));
  checks.push(assertion("terminal palette is independent", theme.terminal?.background !== theme.colors?.["surface-app"] || theme.terminal?.foreground !== theme.colors?.["text-primary"]));
  return checks;
}

function run(command, args, cwd, timeout = 30_000) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (cause) => { clearTimeout(timer); resolveRun({ code: -1, stderr: String(cause), stdout, timedOut }); });
    child.once("exit", (code) => { clearTimeout(timer); resolveRun({ code: code ?? -1, stderr, stdout, timedOut }); });
  });
}

export async function validateSkill(root, specification) {
  const directory = resolve(root, specification.artifact);
  const skillPath = join(directory, "SKILL.md");
  const runnerPath = join(directory, "scripts", "run.mjs");
  const testPath = join(directory, "scripts", "run.test.mjs");
  const checks = [
    assertion("skill directory name matches", basename(directory) === specification.expected.name),
    assertion("SKILL.md exists", await exists(skillPath), skillPath),
    assertion("runner exists", await exists(runnerPath), runnerPath),
    assertion("tests exist", await exists(testPath), testPath),
  ];
  if (checks[1].passed) {
    const source = await readFile(skillPath, "utf8");
    const frontmatter = parseFrontmatter(source);
    checks.push(assertion("frontmatter is valid", frontmatter.valid));
    checks.push(assertion("frontmatter has only name and description", Object.keys(frontmatter.fields).sort().join(",") === "description,name"));
    checks.push(assertion("skill name is valid and matches", frontmatter.fields.name === specification.expected.name && skillNamePattern.test(frontmatter.fields.name ?? "")));
    checks.push(assertion("description is useful", (frontmatter.fields.description?.length ?? 0) >= 40));
    const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "").trim();
    checks.push(assertion("SKILL.md documents the runner contract", body.length >= 80 && body.includes("scripts/run.mjs") && body.includes(specification.contract.operation)));
  }
  if (checks[2].passed) {
    const publicResult = await run(process.execPath, [runnerPath, specification.contract.operation, JSON.stringify(specification.contract.example.input)], directory);
    checks.push(assertion("public example exits successfully", publicResult.code === 0 && !publicResult.timedOut, publicResult.stderr));
    let publicOutput;
    try { publicOutput = JSON.parse(publicResult.stdout.trim()); } catch { publicOutput = Symbol("invalid-json"); }
    checks.push(assertion("public example output matches", isDeepStrictEqual(publicOutput, specification.contract.example.output), publicResult.stdout));
    const result = await run(process.execPath, [runnerPath, specification.expected.operation, JSON.stringify(specification.expected.input)], directory);
    checks.push(assertion("hidden invocation exits successfully", result.code === 0 && !result.timedOut, result.stderr));
    let output;
    try { output = JSON.parse(result.stdout.trim()); } catch { output = Symbol("invalid-json"); }
    checks.push(assertion("hidden invocation output matches", isDeepStrictEqual(output, specification.expected.output), result.stdout));
  }
  if (checks[3].passed) {
    const result = await run(process.execPath, ["--test", testPath], directory);
    checks.push(assertion("author tests pass", result.code === 0, result.stderr || result.stdout));
  }
  return checks;
}

export async function validateEditor(root, specification) {
  const directory = resolve(root, specification.artifact);
  const manifestPath = join(directory, "editor.json");
  const required = ["editor.ts", "editor.css", "SKILL.md", join("dist", "editor.iife.js")];
  const checks = [assertion("editor manifest exists", await exists(manifestPath), manifestPath)];
  for (const path of required) checks.push(assertion(`${path} exists`, await exists(join(directory, path))));
  if (!checks[0].passed) return checks;
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch (cause) { return [...checks, assertion("editor manifest is valid JSON", false, String(cause))]; }
  checks.push(assertion("editor uses API v1", manifest.apiVersion === 1));
  checks.push(assertion("editor id matches", manifest.id === specification.expected.id, String(manifest.id)));
  checks.push(assertion("editor is programmable", manifest.editor === "plugin" && manifest.editable === true));
  checks.push(assertion("file extension matches", manifest.match?.extensions?.includes(specification.expected.extension)));
  checks.push(assertion("capability is declared", manifest.capabilities?.some((item) => item?.id === specification.expected.action)));
  checks.push(assertion("runtime paths are relative", [manifest.runtime?.entry, manifest.runtime?.style, manifest.runtime?.menu].filter(Boolean).every((path) => typeof path === "string" && !/^(?:[a-z]:|[\\/])/iu.test(path) && !path.split(/[\\/]/u).includes(".."))));
  if (checks[3].passed) {
    const source = await readFile(join(directory, "SKILL.md"), "utf8");
    const frontmatter = parseFrontmatter(source);
    const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "").trim();
    checks.push(assertion("Editor Skill frontmatter is valid", frontmatter.valid && Object.keys(frontmatter.fields).sort().join(",") === "description,name"));
    checks.push(assertion("Editor Skill documents its capability", body.length >= 80 && body.includes("file-editor") && body.includes(specification.expected.action)));
  }
  const testFiles = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.test\.(?:mjs|js|ts)$/u.test(entry.name))
    .map((entry) => join(directory, entry.name));
  checks.push(assertion("Editor behavior tests exist", testFiles.length > 0));
  if (testFiles.length) {
    const result = await run(process.execPath, ["--test", ...testFiles], directory, 120_000);
    checks.push(assertion("Editor behavior tests pass", result.code === 0 && !result.timedOut, result.stderr || result.stdout));
  }
  return checks;
}

export async function validateLanguage(root, specification) {
  const directory = resolve(root, specification.artifact);
  const manifestPath = join(directory, "agent-k.language-pack.json");
  const workerPath = join(directory, "worker.ts");
  const checks = [
    assertion("language manifest exists", await exists(manifestPath), manifestPath),
    assertion("worker source exists", await exists(workerPath), workerPath),
    assertion("Language Skill exists", await exists(join(directory, "SKILL.md"))),
  ];
  if (!checks[0].passed) return checks;
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch (cause) { return [...checks, assertion("language manifest is valid JSON", false, String(cause))]; }
  checks.push(assertion("language extension uses API v1", manifest.apiVersion === 1));
  checks.push(assertion("language extension id matches", manifest.id === specification.expected.id));
  checks.push(assertion("languages match", specification.expected.languages.every((language) => manifest.languages?.includes(language))));
  checks.push(assertion("project markers match", specification.expected.markers.every((marker) => manifest.projectMarkers?.includes(marker))));
  checks.push(assertion("worker runtime exists", typeof manifest.worker === "string" && await exists(join(directory, manifest.worker ?? "missing"))));
  if (checks[1].passed) {
    const source = await readFile(workerPath, "utf8");
    const packageFiles = (await listFiles(directory)).filter((path) => /(?:\.ts|\.js|\.mjs|\.json|\.md)$/u.test(path) && !path.startsWith("dist/"));
    const packageSource = (await Promise.all(packageFiles.map((path) => readFile(join(directory, path), "utf8")))).join("\n");
    checks.push(assertion("pinned versions are present", specification.expected.versions.every((version) => packageSource.includes(version)), specification.expected.versions.filter((version) => !packageSource.includes(version)).join(", ")));
    checks.push(assertion("Windows and Linux are explicit", packageSource.includes("win32") && packageSource.includes("linux")));
    checks.push(assertion("digest verification is implemented", /sha(?:256|512)|digest|integrity/iu.test(packageSource)));
    checks.push(assertion("staging and atomic replacement are implemented", /stag/iu.test(packageSource) && /rename|atomic/iu.test(packageSource)));
    checks.push(assertion("worker uses its cache directory", /cache/iu.test(packageSource)));
    checks.push(assertion("download confirmation uses the resumable host handshake", packageSource.includes("language_pack_confirmation_request") && packageSource.includes("respondConfirmation")));
    checks.push(assertion("action IDs use host-compatible lowercase dot/kebab syntax", manifest.actions.every((action) => /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u.test(action.id ?? ""))));
    checks.push(assertion("every fallback archive has a host-verifiable digest", manifest.toolchains.every((toolchain) => !toolchain.fallback || Object.values(toolchain.fallback.platforms ?? {}).every((platform) => /^https:\/\//u.test(platform.url ?? "") && (/^[a-f0-9]{64}$/iu.test(platform.sha256 ?? "") || /^[a-f0-9]{128}$/iu.test(platform.sha512 ?? ""))))));
    if (specification.expected.languages.includes("csharp")) {
      checks.push(assertion(".NET worker isolates host state", ["DOTNET_ROOT", "DOTNET_CLI_HOME", "NUGET_PACKAGES", "DOTNET_MULTILEVEL_LOOKUP"].every((name) => packageSource.includes(name))));
      checks.push(assertion(".NET design-time and build outputs are private", ["BaseOutputPath", "BaseIntermediateOutputPath", "MSBuildProjectExtensionsPath"].every((name) => packageSource.includes(name))));
    }
    if (specification.expected.languages.includes("typescript")) {
      checks.push(assertion("Node and npm installation are isolated", /SHASUMS256/u.test(packageSource) && /ignore-scripts|ignoreScripts/u.test(packageSource) && /typescript.*(?:path|server)|tsserver.*path/iu.test(packageSource)));
    }
    checks.push(assertion("worker exposes lifecycle, agent, and LSP methods", ["initialize", "list", "load", "status", "unload", "restart", "cancel", "trace", "agent", "lsp", "notify", "shutdown"].every((method) => source.includes(method))));
  }
  return checks;
}

function visit(value, callback) {
  if (!value || typeof value !== "object") return;
  callback(value);
  if (Array.isArray(value)) for (const child of value) visit(child, callback);
  else for (const child of Object.values(value)) visit(child, callback);
}

export function validateInvocationEvidence(specification, evidence) {
  const serialized = JSON.stringify(evidence);
  const toolCalls = [];
  const strings = [];
  const hasCapturedEvents = Array.isArray(evidence.events);
  visit(hasCapturedEvents ? evidence.events : evidence, (value) => {
    if (hasCapturedEvents && value.type !== "tool_execution_start") return;
    const name = value.name ?? value.toolName ?? value.tool;
    const args = value.arguments ?? value.args ?? value.input;
    if (typeof name === "string") toolCalls.push({ name, args });
  });
  visit(evidence, (value) => {
    for (const child of Object.values(value)) if (typeof child === "string") strings.push(child);
  });
  const checks = [];
  if (specification.category === "skill-invocation") {
    const runner = toolCalls.find((call) => call.name === "bash" && strings.some((value) => value.includes("scripts/run.mjs")));
    const expectedJson = JSON.stringify(specification.expected.output);
    checks.push(assertion("matching Skill was expanded", serialized.includes(`<skill name=\\"${specification.expected.skill}\\"`) || serialized.includes(specification.expected.skill)));
    checks.push(assertion("Skill runner was executed", Boolean(runner)));
    checks.push(assertion("Skill operation and input were passed", Boolean(runner) && strings.some((value) => value.includes(specification.expected.operation) && value.includes(JSON.stringify(specification.expected.input)))));
    checks.push(assertion("expected result is present", strings.some((value) => value.includes(expectedJson)) || serialized.includes(expectedJson)));
  } else if (specification.category === "editor-invocation") {
    const call = toolCalls.find((item) => item.name === "agent_k" && item.args?.capability === specification.expected.capability);
    checks.push(assertion("matching Editor Skill was expanded", serialized.includes(specification.expected.skill)));
    checks.push(assertion("agent_k file-editor was called", Boolean(call)));
    checks.push(assertion("declared Editor action was used", call?.args?.action === specification.expected.action));
    checks.push(assertion("target Editor file was in context", serialized.includes(specification.fixture)));
    checks.push(assertion("Editor state changed as specified", typeof evidence.editorContent === "string" && (typeof specification.expected.output === "string" ? evidence.editorContent === specification.expected.output : evidence.editorContent !== evidence.initialEditorContent)));
    checks.push(assertion("Editor change was saved", typeof evidence.editorDiskContent === "string" && evidence.editorDiskContent === evidence.editorContent));
  } else if (specification.category === "cpp-invocation") {
    const calls = toolCalls.filter((item) => item.name === "agent_k" && item.args?.capability === "language" && item.args?.packId === "agent-k.cpp");
    checks.push(assertion("C++ Language Skill was expanded", serialized.includes("cpp-project-tools")));
    checks.push(assertion("status was called first", calls[0]?.args?.action === "project.status"));
    checks.push(assertion("semantic action was called", calls.some((call) => call.args?.action === `language.${specification.expected.method}`)));
  } else {
    const records = Array.isArray(evidence.languageHost?.records) ? evidence.languageHost.records : [];
    const expectedCommand = specification.expected.method === "build" ? "language_pack_call" : "language_pack_request";
    const record = records.find((item) => item?.pluginId === specification.expected.pluginId && item?.method === specification.expected.method && item?.command === expectedCommand);
    checks.push(assertion("language host request was recorded", Boolean(record)));
    checks.push(assertion("language response was successful", Boolean(record) && Object.prototype.hasOwnProperty.call(record, "result") && !Object.prototype.hasOwnProperty.call(record, "error") && record.result?.isError !== true));
    checks.push(assertion("Editor-to-LSP transport was exercised", specification.expected.method === "build"
      ? evidence.languageHost?.editorProbe?.method === "textDocument/documentSymbol"
      : record?.transport === "editor-frame"));
    checks.push(assertion("final Editor UI result was observable", typeof evidence.languageHost?.editorStatus === "string" && /completed|已完成/u.test(evidence.languageHost.editorStatus)));
    checks.push(assertion("language tooling did not write generated output into the source tree", Array.isArray(evidence.languageHost?.workspaceWrites) && evidence.languageHost.workspaceWrites.length === 0, (evidence.languageHost?.workspaceWrites ?? []).join(", ")));
  }
  return checks;
}

export function summarizeCase(specification, platform, checks, metadata = {}) {
  return {
    schemaVersion: 1,
    caseId: specification.id,
    category: specification.category,
    platform,
    passed: checks.length > 0 && checks.every((check) => check.passed),
    checks,
    ...metadata,
  };
}

export async function listFiles(root) {
  const output = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path); else output.push(path.slice(root.length + 1).replaceAll("\\", "/"));
    }
  }
  if (await exists(root)) await walk(root);
  return output.sort();
}
