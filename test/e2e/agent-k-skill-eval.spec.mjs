import { _electron as electron, expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { allCases } from "../../evaluation/agent-k/specs.mjs";

const repository = resolve(import.meta.dirname, "../..");
const caseId = process.env.AGENT_K_EVAL_CASE_ID;
const specification = allCases.find((item) => item.id === caseId);
const replay = process.env.AGENT_K_EVAL_REPLAY === "1";
const enabled = (process.env.AGENT_K_EVAL_LIVE === "1" || replay) && Boolean(specification);
const editorContents = {
  pal: "zeta=#ffffff\nalpha=#000000\n", todoz: "[ ] verify editor action\n[x] keep completed\n", outlinez: "# Root\n## Nested\n",
  timelinez: "2026-12-01 launch\n2026-01-01 start\n", kvz: "zeta=3\nalpha=1\n", bookmarkz: "https://example.test/a\nhttps://example.test/a\n",
  inventoryz: "apples=2\npears=3\n", routez: "start -> middle -> finish\n", snippetz: "zeta: last\nalpha: first\n", scorez: "low=-5\nhigh=120\n",
};

function run(command, args, cwd, timeout = 120_000) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill(); rejectRun(new Error(`${command} timed out`)); }, timeout);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolveRun({ stdout, stderr }) : rejectRun(new Error(`${command} exited ${code}\n${stderr || stdout}`)); });
  });
}

async function cloneCleanWorkspace(target) {
  await run("git", ["clone", "--local", "--no-checkout", repository, target], repository);
  await run("git", ["-C", target, "checkout", "--detach", "HEAD"], repository);
  if (process.env.AGENT_K_EVAL_CURRENT_WORKTREE === "1") {
    await new Promise((resolveOverlay, rejectOverlay) => {
      const diff = spawn("git", ["diff", "--binary", "HEAD", "--"], { cwd: repository, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const apply = spawn("git", ["-C", target, "apply", "--whitespace=nowarn", "-"], { cwd: repository, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let diffError = ""; let applyError = "";
      diff.stderr.setEncoding("utf8"); apply.stderr.setEncoding("utf8");
      diff.stderr.on("data", (chunk) => { diffError += chunk; }); apply.stderr.on("data", (chunk) => { applyError += chunk; });
      diff.stdout.pipe(apply.stdin);
      let diffCode; let applyCode;
      const finish = () => {
        if (diffCode === undefined || applyCode === undefined) return;
        if (diffCode === 0 && applyCode === 0) resolveOverlay();
        else rejectOverlay(new Error(`Unable to overlay the current worktree (git diff ${diffCode}, git apply ${applyCode})\n${diffError}${applyError}`));
      };
      diff.once("error", rejectOverlay); apply.once("error", rejectOverlay);
      diff.once("exit", (code) => { diffCode = code; finish(); }); apply.once("exit", (code) => { applyCode = code; finish(); });
    });
    const { stdout } = await run("git", ["ls-files", "--others", "--exclude-standard", "-z"], repository);
    for (const relativePath of stdout.split("\0").filter(Boolean)) {
      if (relativePath.replaceAll("\\", "/").split("/")[0].startsWith(".agent-k-")) continue;
      const source = join(repository, relativePath); const destination = join(target, relativePath);
      const resolvedSource = resolve(source); const resolvedTarget = resolve(target);
      if (resolvedSource === resolvedTarget || resolvedSource.startsWith(`${resolvedTarget}${sep}`)) continue;
      await mkdir(dirname(destination), { recursive: true }); await cp(source, destination, { recursive: true });
    }
  }
  const dependencies = join(repository, "node_modules");
  try { await symlink(dependencies, join(target, "node_modules"), process.platform === "win32" ? "junction" : "dir"); } catch { /* npm ci remains available to the evaluator if linking is unavailable. */ }
}

async function jsonSetting(name, sourceName, fallback = {}) {
  if (process.env[name]) return JSON.parse(process.env[name]);
  if (process.env[sourceName]) return JSON.parse(await readFile(resolve(process.env[sourceName]), "utf8"));
  return fallback;
}

async function seedIsolatedRuntime(runRoot, workspace) {
  const home = join(runRoot, "home"); const userData = join(runRoot, "user-data"); const piAgent = join(home, ".pi", "agent");
  await Promise.all([mkdir(piAgent, { recursive: true }), mkdir(userData, { recursive: true })]);
  const supplied = await jsonSetting("AGENT_K_EVAL_CLIENT_SETTINGS_JSON", "AGENT_K_EVAL_CLIENT_SETTINGS_PATH");
  if (!supplied.defaultModel) throw new Error("Live evaluation requires a default model in AGENT_K_EVAL_CLIENT_SETTINGS_JSON or AGENT_K_EVAL_CLIENT_SETTINGS_PATH");
  const sharedCache = resolve(runRoot, "..", "..", "cache", process.platform);
  const settings = { ...supplied, cacheDirectory: sharedCache, locale: "en-US", permissionMode: "full", workerPoolSize: 2 };
  await writeFile(join(userData, "client-settings.json"), `${JSON.stringify(settings)}\n`, "utf8");
  await writeFile(join(userData, "known-projects.json"), `${JSON.stringify([workspace])}\n`, "utf8");
  const configFiles = [
    ["AGENT_K_EVAL_AUTH_JSON", "AGENT_K_EVAL_AUTH_PATH", "auth.json"],
    ["AGENT_K_EVAL_MODELS_JSON", "AGENT_K_EVAL_MODELS_PATH", "models.json"],
    ["AGENT_K_EVAL_PI_SETTINGS_JSON", "AGENT_K_EVAL_PI_SETTINGS_PATH", "settings.json"],
  ];
  for (const [jsonName, pathName, fileName] of configFiles) {
    const content = process.env[jsonName] ?? (process.env[pathName] ? await readFile(resolve(process.env[pathName]), "utf8") : undefined);
    if (content) await writeFile(join(piAgent, fileName), content, "utf8");
  }
  return { home, userData };
}

async function setupInvocationWorkspace(workspace, artifactRoot, userData) {
  const fixtures = join(repository, "evaluation", "agent-k", "fixtures");
  if (specification.category === "skill-invocation") {
    await mkdir(join(workspace, ".pi", "skills"), { recursive: true });
    await cp(join(fixtures, "skill", "agent-k-eval-record-tools"), join(workspace, ".pi", "skills", "agent-k-eval-record-tools"), { recursive: true });
    if (specification.expected.artifactCase) {
      const source = join(artifactRoot, specification.expected.artifactCase, specification.expected.artifact);
      await cp(source, join(workspace, specification.expected.artifact), { recursive: true });
    }
  }
  if (specification.category === "editor-invocation") {
    await mkdir(join(workspace, ".pi", "skills"), { recursive: true });
    if (specification.expected.artifactCase) {
      const source = join(artifactRoot, specification.expected.artifactCase, specification.expected.artifact);
      await cp(source, join(workspace, ".pi", "skills", specification.expected.skill), { recursive: true });
    } else await cp(join(fixtures, "editor", "agent-k-eval-editor-actions"), join(workspace, ".pi", "skills", "agent-k-eval-editor-actions"), { recursive: true });
    const extension = specification.fixture.split(".").at(-1);
    await writeFile(join(workspace, specification.fixture), editorContents[extension], "utf8");
  }
  const language = specification.category.replace("-invocation", "");
  if (["csharp", "typescript", "cpp"].includes(language)) await cp(join(fixtures, "projects", language), workspace, { recursive: true });
  if (["csharp", "typescript"].includes(language)) {
    const developmentId = language === "csharp" ? "language-csharp" : "language-typescript";
    const pluginDirectory = language === "csharp" ? "csharp" : "typescript-javascript";
    const packId = language === "csharp" ? "agent-k.csharp" : "agent-k.typescript-javascript";
    const source = join(artifactRoot, developmentId, "language-packs", pluginDirectory);
    const target = join(userData, "language-packs", packId, "1.0.0");
    await mkdir(target, { recursive: true });
    await cp(source, target, { recursive: true });
    await writeFile(join(userData, "language-packs", packId, "active.json"), `${JSON.stringify({ enabled: true, version: "1.0.0" })}\n`, "utf8");
  }
}

async function setupDevelopmentReplay(workspace, artifactRoot, home, userData) {
  const caseRoot = join(artifactRoot, specification.id);
  if (specification.category === "theme-development") {
    const themes = join(home, ".pi", "agent", "k_themes");
    await mkdir(themes, { recursive: true });
    await cp(join(caseRoot, "themes", `${specification.expected.themeId}.json`), join(themes, `${specification.expected.themeId}.json`));
    const settingsPath = join(userData, "client-settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    await writeFile(settingsPath, `${JSON.stringify({ ...settings, theme: specification.expected.themeId })}\n`, "utf8");
  } else if (specification.category === "skill-development") {
    const source = join(caseRoot, specification.artifact);
    const target = join(workspace, specification.artifact);
    await mkdir(dirname(target), { recursive: true }); await cp(source, target, { recursive: true });
  } else if (specification.category === "editor-development") {
    const source = join(caseRoot, specification.artifact);
    const target = join(workspace, ".pi", "skills", specification.expected.id);
    await mkdir(dirname(target), { recursive: true }); await cp(source, target, { recursive: true });
    await writeFile(join(workspace, `replay.${specification.expected.extension}`), specification.expected.input, "utf8");
  } else if (specification.category === "language-development") {
    const language = specification.expected.languages.includes("csharp") ? "csharp" : "typescript";
    await cp(join(repository, "evaluation", "agent-k", "fixtures", "projects", language), workspace, { recursive: true });
    const source = join(caseRoot, specification.artifact);
    const manifest = JSON.parse(await readFile(join(source, "agent-k.language-pack.json"), "utf8"));
    if (typeof manifest.version !== "string") throw new Error(`Generated Language Pack ${specification.expected.id} has no version`);
    const target = join(userData, "language-packs", specification.expected.id, manifest.version);
    await mkdir(target, { recursive: true });
    await cp(source, target, { recursive: true });
    await writeFile(join(userData, "language-packs", specification.expected.id, "active.json"), `${JSON.stringify({ enabled: true, version: manifest.version })}\n`, "utf8");
  }
}

async function extractDevelopmentArtifact(workspace, home, artifactRoot) {
  const destination = join(artifactRoot, specification.id);
  await rm(destination, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); await mkdir(destination, { recursive: true });
  if (specification.category === "theme-development") {
    const fileName = `${specification.expected.themeId}.json`;
    await mkdir(join(destination, "themes"), { recursive: true });
    await cp(join(home, ".pi", "agent", "k_themes", fileName), join(destination, "themes", fileName));
  } else {
    const source = join(workspace, specification.artifact); const target = join(destination, specification.artifact);
    await mkdir(dirname(target), { recursive: true }); await cp(source, target, { recursive: true });
  }
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        const content = await readFile(path);
        files.push({ path: path.slice(destination.length + 1).replaceAll("\\", "/"), bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") });
      }
    }
  };
  await walk(destination);
  await writeFile(join(destination, "artifact-manifest.json"), `${JSON.stringify({ caseId: specification.id, files: files.sort((left, right) => left.path.localeCompare(right.path)) }, null, 2)}\n`, "utf8");
}

async function recoverSessionEvidence(home) {
  const sessionRoot = join(home, ".pi", "agent", "sessions"); const candidates = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".jsonl")) candidates.push({ path, modified: (await stat(path)).mtimeMs });
    }
  };
  await walk(sessionRoot);
  const latest = candidates.sort((left, right) => right.modified - left.modified)[0];
  if (!latest) throw new Error("Agent K closed before evidence capture and no Pi session was saved");
  const records = (await readFile(latest.path, "utf8")).split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const messages = records.filter((record) => record.type === "message" && record.message).map((record) => record.message);
  const assistant = [...messages].reverse().find((message) => message.role === "assistant" && message.model);
  const tokens = messages.reduce((total, message) => total + (Number(message.usage?.totalTokens) || 0), 0);
  const piSettings = await jsonSetting("AGENT_K_EVAL_PI_SETTINGS_JSON", "AGENT_K_EVAL_PI_SETTINGS_PATH");
  return {
    events: [], messages, recoveredSessionFile: latest.path,
    state: { model: assistant ? { id: assistant.model, provider: assistant.provider } : undefined, thinkingLevel: piSettings.defaultThinkingLevel },
    stats: { tokens },
  };
}

function lspRequest(method, file, language) {
  const uri = pathToFileURL(file).href;
  const position = language === "csharp" ? { line: 4, character: 24 } : { line: 2, character: 15 };
  const textDocument = { uri };
  const mapping = {
    diagnostics: ["textDocument/diagnostic", { textDocument }],
    definition: ["textDocument/definition", { textDocument, position }],
    references: ["textDocument/references", { textDocument, position, context: { includeDeclaration: true } }],
    hover: ["textDocument/hover", { textDocument, position }],
    "document-symbols": ["textDocument/documentSymbol", { textDocument }],
    "workspace-symbols": ["workspace/symbol", { query: language === "csharp" ? "Add" : "add" }],
    completion: ["textDocument/completion", { textDocument, position }],
    rename: ["textDocument/rename", { textDocument, position, newName: "sum" }],
    formatting: ["textDocument/formatting", { textDocument, options: { insertSpaces: true, tabSize: 2 } }],
    "organize-imports": ["workspace/executeCommand", { command: "_typescript.organizeImports", arguments: [uri, { mode: "SortAndCombine" }] }],
  };
  return mapping[method];
}

async function languageGeneratedPaths(workspace) {
  const generatedDirectoryNames = new Set([".cache", ".dotnet", ".nuget", ".typescript", "bin", "obj"]);
  const paths = [];
  const walk = async (directory, relativeDirectory = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (generatedDirectoryNames.has(entry.name)) { paths.push(relativePath); continue; }
      if (entry.isDirectory()) await walk(join(directory, entry.name), relativePath);
    }
  };
  await walk(workspace);
  return paths.sort();
}

async function runLanguageHostCase(page, workspace) {
  const pluginId = specification.expected.pluginId;
  const mainFile = specification.expected.language === "csharp" ? join(workspace, "Program.cs") : join(workspace, "src", "main.js");
  const records = [];
  const invoke = async (command, args, approveDownload = false) => {
    try {
      let result;
      if (approveDownload) result = await invokeWithOptionalDownload(page, command, args);
      else result = await page.evaluate(({ command, args }) => window.agentK.invoke(command, args), { command, args });
      records.push({ pluginId, method: specification.expected.method, command, args, result }); return result;
    }
    catch (cause) { records.push({ pluginId, method: specification.expected.method, command, args, error: String(cause) }); throw cause; }
  };
  const generatedBefore = await languageGeneratedPaths(workspace);
  const editorPath = relative(workspace, mainFile).replaceAll("\\", "/");
  await page.evaluate((path) => window.dispatchEvent(new CustomEvent("agent-k-open-file-line", { detail: { line: 1, path } })), editorPath);
  const editorFrame = page.locator(".plugin-editor-frame").last();
  await expect(editorFrame).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".plugin-editor-loading")).toBeHidden({ timeout: 30_000 });
  const languageResult = editorFrame.contentFrame().locator(".agent-k-language-result");
  const loaded = await invoke("language_pack_call", { id: pluginId, method: "load", args: [workspace] }, true);
  if (loaded?.status === "failed") throw new Error(`Language project failed to load: ${JSON.stringify(loaded)}`);
  await expect(page.locator(".plugin-editor-loading")).toBeHidden({ timeout: 30_000 });
  await expect(editorFrame.contentFrame().locator(".agent-k-language-result")).toBeAttached({ timeout: 30_000 });
  if (specification.expected.method === "build") {
    const [probeMethod, probeParams] = lspRequest("document-symbols", mainFile, specification.expected.language);
    await page.evaluate(({ method, params }) => window.dispatchEvent(new CustomEvent("agent-k-file-format-action", {
      detail: { action: "language-service-request", method, params, pluginId: "agent-k.text" },
    })), { method: probeMethod, params: probeParams, path: editorPath });
    const probeMethodFromEditor = async () => {
      try { return JSON.parse(await languageResult.getAttribute("data-language-operation-result") ?? "null")?.method; }
      catch { return undefined; }
    };
    await expect.poll(probeMethodFromEditor, { timeout: 60_000 }).toBe(probeMethod);
    if (await languageResult.getAttribute("data-language-operation-status") === "error") {
      await page.evaluate(({ method, params }) => window.dispatchEvent(new CustomEvent("agent-k-file-format-action", {
        detail: { action: "language-service-request", method, params, pluginId: "agent-k.text" },
      })), { method: probeMethod, params: probeParams });
      await expect.poll(probeMethodFromEditor, { timeout: 60_000 }).toBe(probeMethod);
    }
    await expect(languageResult).toHaveAttribute("data-language-operation-status", "done", { timeout: 60_000 });
    const editorProbe = JSON.parse(await languageResult.getAttribute("data-language-operation-result"));
    const result = await invoke("language_pack_call", { id: pluginId, method: "build", args: [workspace] });
    const generatedAfter = await languageGeneratedPaths(workspace);
    return { editorPath, editorProbe, editorStatus: await languageResult.textContent(), records, loaded, result, workspaceWrites: generatedAfter.filter((path) => !generatedBefore.includes(path)) };
  }
  const [method, params] = lspRequest(specification.expected.method, mainFile, specification.expected.language);
  await page.evaluate(({ method, params }) => window.dispatchEvent(new CustomEvent("agent-k-file-format-action", {
    detail: { action: "language-service-request", method, params, pluginId: "agent-k.text" },
  })), { method, params, path: editorPath });
  await expect(languageResult).toHaveAttribute("data-language-operation-status", /^(?:done|error)$/u, { timeout: 60_000 });
  if (await languageResult.getAttribute("data-language-operation-status") === "error") {
    await page.evaluate(({ method, params }) => window.dispatchEvent(new CustomEvent("agent-k-file-format-action", {
      detail: { action: "language-service-request", method, params, pluginId: "agent-k.text" },
    })), { method, params });
  }
  await expect(languageResult).toHaveAttribute("data-language-operation-status", "done", { timeout: 60_000 });
  const editorUi = JSON.parse(await languageResult.getAttribute("data-language-operation-result"));
  records.push({ pluginId, method: specification.expected.method, command: "language_pack_request", args: { language: specification.expected.language, file: mainFile, method, params }, result: editorUi.result, transport: "editor-frame" });
  const generatedAfter = await languageGeneratedPaths(workspace);
  return { editorPath, editorStatus: await languageResult.textContent(), editorUi, records, loaded, result: editorUi.result, workspaceWrites: generatedAfter.filter((path) => !generatedBefore.includes(path)) };
}

async function invokeWithOptionalDownload(page, command, args) {
  await page.evaluate(({ command, args }) => {
    window.__agentKLanguageOperation = { done: false };
    window.agentK.invoke(command, args).then((result) => { window.__agentKLanguageOperation = { done: true, result }; }, (cause) => { window.__agentKLanguageOperation = { done: true, error: String(cause) }; });
  }, { command, args });
  const dialog = page.locator(".language-server-confirmation");
  await Promise.race([
    dialog.waitFor({ state: "visible", timeout: 10_000 }).then(() => "dialog"),
    page.waitForFunction(() => window.__agentKLanguageOperation?.done === true, undefined, { timeout: 10_000 }).then(() => "done"),
  ]).catch(() => undefined);
  if (await dialog.isVisible()) {
    if (process.env.AGENT_K_EVAL_ALLOW_DOWNLOADS !== "1") throw new Error("Language tool download requested; set AGENT_K_EVAL_ALLOW_DOWNLOADS=1 to approve it");
    await dialog.getByRole("button", { name: "Download" }).click();
  }
  await page.waitForFunction(() => window.__agentKLanguageOperation?.done === true, undefined, { timeout: 15 * 60_000 });
  const operation = await page.evaluate(() => window.__agentKLanguageOperation);
  if (operation.error) throw new Error(operation.error);
  return operation.result;
}

async function agentKMainWindow(application) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    for (const candidate of application.windows()) {
      const ready = await candidate.evaluate(() => typeof window.agentK?.onPiEvent === "function").catch(() => false);
      if (ready) return candidate;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Agent K main window did not expose its preload bridge");
}

async function runDevelopmentReplay(page, workspace) {
  if (specification.category === "theme-development") {
    await page.waitForFunction((id) => window.agentKActiveTheme?.id === id, specification.expected.themeId, { timeout: 60_000 });
    return { activeTheme: await page.evaluate(() => window.agentKActiveTheme) };
  }
  if (specification.category === "skill-development") {
    const runtimeId = await page.evaluate((cwd) => window.agentK.invoke("prepare_session", { cwd }), workspace);
    const resources = await page.evaluate(({ cwd, runtimeId }) => window.agentK.invoke("get_pi_resources", { cwd, runtimeId }), { cwd: workspace, runtimeId });
    const installed = resources.find((resource) => resource.kind === "skill" && resource.name === specification.expected.name && resource.enabled !== false);
    expect(installed).toBeTruthy();
    return { installedSkill: installed, runtimeId };
  }
  if (specification.category === "editor-development") {
    const file = `replay.${specification.expected.extension}`;
    await page.evaluate((path) => window.dispatchEvent(new CustomEvent("agent-k-open-file-line", { detail: { line: 1, path } })), file);
    const frame = page.locator(".plugin-editor-frame"); await expect(frame).toBeVisible({ timeout: 30_000 });
    const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
    const settings = await page.evaluate(() => window.agentK.invoke("get_client_settings", {}));
    const nextTheme = themeBefore === "dark" ? "light" : "dark";
    await page.evaluate(({ settings, theme }) => window.agentK.invoke("save_client_settings", { settings: { ...settings, theme } }), { settings, theme: nextTheme });
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, nextTheme);
    await expect(frame).toBeVisible();
    await expect.poll(() => frame.contentFrame().locator("html").getAttribute("data-theme")).toBe(nextTheme);
    expect(await readFile(join(workspace, file), "utf8")).toBe(specification.expected.input);
    await page.evaluate(({ action, path, pluginId }) => window.dispatchEvent(new CustomEvent("agent-k-file-format-action", { detail: { action, path, pluginId } })), { action: specification.expected.action, path: file, pluginId: specification.expected.id });
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "s" })));
    await expect.poll(() => readFile(join(workspace, file), "utf8"), { timeout: 30_000 }).toBe(specification.expected.output);
    return { action: specification.expected.action, after: specification.expected.output, before: specification.expected.input, file, saved: await readFile(join(workspace, file), "utf8"), themeAfter: nextTheme, themeBefore };
  }
  const id = specification.expected.id;
  const records = [];
  const call = async (method, args = []) => {
    const result = method === "load"
      ? await invokeWithOptionalDownload(page, "language_pack_call", { id, method, args })
      : await page.evaluate(({ id, method, args }) => window.agentK.invoke("language_pack_call", { id, method, args }), { id, method, args });
    if ((method === "load" || method === "status") && result?.status === "failed") throw new Error(`Language lifecycle ${method} failed: ${JSON.stringify(result)}`);
    records.push({ args, method, result }); return result;
  };
  await call("load", [workspace]);
  await call("list");
  await call("status", [workspace]);
  await call("unload", [workspace]);
  await call("shutdown");
  return { records };
}

test("runs one isolated Agent K evaluation case", async () => {
  test.skip(!enabled, "Set AGENT_K_EVAL_LIVE=1 and AGENT_K_EVAL_CASE_ID to run live evaluation");
  const outputRoot = resolve(process.env.AGENT_K_EVAL_OUTPUT ?? join(repository, ".agent-k-evaluation"));
  const artifactRoot = resolve(process.env.AGENT_K_EVAL_ARTIFACT_ROOT ?? join(outputRoot, "artifacts"));
  const runRoot = join(outputRoot, "runs", `${replay ? "replay-" : ""}${specification.id}-${process.platform}`); const workspace = join(runRoot, "workspace");
  await rm(runRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); await mkdir(runRoot, { recursive: true });
  await cloneCleanWorkspace(workspace);
  if (!replay && specification.category === "language-development")
    await rm(join(workspace, specification.artifact), { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
  const { home, userData } = await seedIsolatedRuntime(runRoot, workspace);
  if (specification.category.endsWith("-invocation")) await setupInvocationWorkspace(workspace, artifactRoot, userData);
  if (replay) await setupDevelopmentReplay(workspace, artifactRoot, home, userData);
  const application = await electron.launch({
    args: ["."], cwd: repository,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      PSModuleAnalysisCachePath: join(home, "PowerShell", "ModuleAnalysisCache"),
      AGENT_K_DISABLE_SESSION_TITLES: "1",
      AGENT_K_E2E: "1",
      AGENT_K_E2E_USER_DATA: userData,
    },
  });
  try {
    const page = await agentKMainWindow(application);
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(() => {
      window.__agentKEvaluation = { events: [], settled: 0, started: 0 };
      window.agentK.onPiEvent((event) => { const state = window.__agentKEvaluation; state.events.push(event); if (event.type === "agent_start") state.started += 1; if (event.type === "agent_settled") state.settled += 1; });
    });
    if (replay) {
      await expect(page.locator('.composer-editor[contenteditable="true"]')).toBeVisible({ timeout: 120_000 });
      const replayEvidence = { caseId: specification.id, category: specification.category, platform: process.platform, startedAt: new Date().toISOString(), result: await runDevelopmentReplay(page, workspace) };
      replayEvidence.finishedAt = new Date().toISOString(); replayEvidence.passed = true;
      const evidenceDirectory = join(outputRoot, "evidence", specification.id); await mkdir(evidenceDirectory, { recursive: true });
      await page.screenshot({ path: join(evidenceDirectory, `replay-${process.platform}.png`), fullPage: true });
      await writeFile(join(evidenceDirectory, `replay-${process.platform}.json`), `${JSON.stringify(replayEvidence, null, 2)}\n`, "utf8");
      return;
    }
    const evaluationPrompt = process.env.AGENT_K_EVAL_PROMPT_OVERRIDE ?? specification.prompt;
    const evidence = { caseId: specification.id, category: specification.category, platform: process.platform, prompt: evaluationPrompt, events: [], startedAt: new Date().toISOString() };
    if (["csharp-invocation", "typescript-invocation"].includes(specification.category)) {
      await expect(page.locator('.composer-editor[contenteditable="true"]')).toBeVisible({ timeout: 120_000 });
      evidence.languageHost = await runLanguageHostCase(page, workspace);
    } else {
      await expect(page.locator('.composer-editor[contenteditable="true"]')).toBeVisible({ timeout: 120_000 });
      if (specification.category === "editor-invocation") {
        await page.evaluate((path) => window.dispatchEvent(new CustomEvent("agent-k-open-file-line", { detail: { line: 1, path } })), specification.fixture);
        await expect(page.locator(".plugin-editor-frame")).toBeVisible({ timeout: 30_000 });
        await expect(page.locator(".plugin-editor-loading")).toBeHidden({ timeout: 30_000 });
        evidence.initialEditorContent = await readFile(join(workspace, specification.fixture), "utf8");
      }
      if (specification.category === "cpp-invocation") {
        evidence.cppLoad = await invokeWithOptionalDownload(page, "language_pack_call", { id: "agent-k.cpp", method: "load", args: [workspace] });
      }
      const before = await page.evaluate(() => window.__agentKEvaluation.settled);
      await page.evaluate((message) => window.dispatchEvent(new CustomEvent("agent-k-submit-prompt", { detail: { message } })), evaluationPrompt);
      await page.waitForFunction((value) => window.__agentKEvaluation.started > value, before, { timeout: 120_000 });
      const settlementMs = Number(process.env.AGENT_K_EVAL_SETTLEMENT_MS)
        || (specification.category === "language-development" ? 30 : 15) * 60_000;
      try {
        await expect.poll(async () => page.evaluate(async (value) => {
          const evaluation = window.__agentKEvaluation;
          if (evaluation.settled > value) return true;
          const runtimeId = [...evaluation.events].reverse().find((event) => typeof event.runtimeId === "string")?.runtimeId;
          if (!runtimeId) return false;
          const state = await window.agentK.invoke("pi_command", { command: { type: "get_state" }, runtimeId });
          return state?.isStreaming !== true && state?.isCompacting !== true && Number(state?.pendingMessageCount ?? 0) === 0;
        }, before), { intervals: [1_000, 2_000, 5_000], timeout: settlementMs }).toBe(true);
      } catch (cause) {
        const captured = page.isClosed() ? await recoverSessionEvidence(home) : await page.evaluate(() => window.__agentKEvaluation);
        const evidenceDirectory = join(outputRoot, "evidence", specification.id); await mkdir(evidenceDirectory, { recursive: true });
        await writeFile(join(evidenceDirectory, `timeout-${process.platform}.json`), `${JSON.stringify({ ...evidence, events: captured.events, failure: String(cause) }, null, 2)}\n`, "utf8");
        throw cause;
      }
      let captured;
      try { captured = await page.evaluate(() => window.__agentKEvaluation); }
      catch (cause) {
        if (!page.isClosed()) throw cause;
        captured = await recoverSessionEvidence(home);
      }
      evidence.events = captured.events;
      if (captured.recoveredSessionFile) {
        evidence.messages = captured.messages; evidence.state = captured.state; evidence.stats = captured.stats;
      }
      const runtimeId = [...captured.events].reverse().find((event) => typeof event.runtimeId === "string")?.runtimeId;
      if (runtimeId) {
        evidence.state = await page.evaluate((runtimeId) => window.agentK.invoke("pi_command", { command: { type: "get_state" }, runtimeId }), runtimeId);
        evidence.messages = await page.evaluate((runtimeId) => window.agentK.invoke("pi_command", { command: { type: "get_messages" }, runtimeId }), runtimeId);
        evidence.stats = await page.evaluate((runtimeId) => window.agentK.invoke("pi_command", { command: { type: "get_session_stats" }, runtimeId }), runtimeId);
      }
      if (specification.category === "editor-invocation") {
        evidence.activeEditorFile = specification.fixture;
        const saveButton = page.locator('button[title^="Save"], button[title^="保存"]').last();
        await expect(saveButton).toBeEnabled({ timeout: 30_000 });
        await saveButton.click();
        await expect.poll(() => readFile(join(workspace, specification.fixture), "utf8"), { timeout: 30_000 }).not.toBe(evidence.initialEditorContent);
        evidence.editorDiskContent = await readFile(join(workspace, specification.fixture), "utf8");
        evidence.editorContent = evidence.editorDiskContent;
      }
    }
    evidence.finishedAt = new Date().toISOString();
    const evidenceDirectory = join(outputRoot, "evidence", specification.id); await mkdir(evidenceDirectory, { recursive: true });
    await page.screenshot({ path: join(evidenceDirectory, `${process.platform}.png`), fullPage: true });
    await writeFile(join(evidenceDirectory, `evidence-${process.platform}.json`), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    if (specification.category.endsWith("-development")) await extractDevelopmentArtifact(workspace, home, artifactRoot);
  } finally { await application.close(); }
});
