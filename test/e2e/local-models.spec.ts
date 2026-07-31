import { _electron as electron, expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function ggufString(value: string): Buffer {
  const text = Buffer.from(value, "utf8"); const result = Buffer.alloc(8 + text.length);
  result.writeBigUInt64LE(BigInt(text.length)); text.copy(result, 8); return result;
}

function ggufFixture(): Buffer {
  const context = Buffer.alloc(4); context.writeUInt32LE(32_768);
  const entries: Array<[string, number, Buffer]> = [["general.architecture", 8, ggufString("llama")], ["llama.context_length", 4, context]];
  const header = Buffer.alloc(24); header.write("GGUF"); header.writeUInt32LE(3, 4); header.writeBigUInt64LE(BigInt(entries.length), 16);
  return Buffer.concat([header, ...entries.flatMap(([key, type, value]) => { const kind = Buffer.alloc(4); kind.writeUInt32LE(type); return [ggufString(key), kind, value]; })]);
}

test("Settings manages one verified llama.cpp model without exposing other local models", async () => {
  const userData = mkdtempSync(join(tmpdir(), "agent-k-local-model-e2e-"));
  const model = Buffer.concat([ggufFixture(), Buffer.alloc(1024 * 1024)]); const sha256 = createHash("sha256").update(model).digest("hex");
  const importSource = join(userData, "import-source.gguf");
  writeFileSync(importSource, model);
  const hub = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/openapi/v1/models") return response.end(JSON.stringify({ success: true, data: { models: [{ id: "fixture/tool-model-GGUF", display_name: "Tool Model GGUF", downloads: 42, tags: ["library:gguf"], private: false, gated: false }] } }));
    if (url.pathname === "/api/v1/models/fixture/tool-model-GGUF/repo/files") return response.end(JSON.stringify({ Code: 200, Data: { Files: [{ Path: "tool-model-Q4_K_M.gguf", Size: model.length, Sha256: sha256 }] } }));
    if (url.pathname === "/models/fixture/tool-model-GGUF/resolve/master/tool-model-Q4_K_M.gguf") { response.setHeader("content-type", "application/octet-stream"); response.setHeader("etag", "fixture-v1"); let offset = 0; const write = () => { if (response.destroyed) return; if (offset >= model.length) return response.end(); const end = Math.min(model.length, offset + 64 * 1024); response.write(model.subarray(offset, end)); offset = end; setTimeout(write, 20); }; write(); return; }
    response.statusCode = 404; return response.end(JSON.stringify({ error: "not found" }));
  });
  const hubPort = await new Promise<number>((resolve, reject) => { hub.once("error", reject); hub.listen(0, "127.0.0.1", () => { const address = hub.address(); if (!address || typeof address === "string") reject(new Error("No hub port")); else resolve(address.port); }); });
  const executable = join(userData, "fake-llama-server.mjs");
  const launchArgsLog = join(userData, "llama-launch-args.jsonl");
  writeFileSync(executable, `import http from 'node:http';import { appendFileSync } from 'node:fs';
const args=process.argv.slice(2);const get=n=>args[args.indexOf(n)+1];const key=get('--api-key');
appendFileSync(${JSON.stringify(launchArgsLog)},JSON.stringify(args)+'\\n');
if(!get('--cache-type-k')||!get('--cache-type-v')){console.error('missing KV cache types');process.exit(2)}
const started=Date.now();console.error('fixture llama-server started');http.createServer(async(req,res)=>{if(req.headers.authorization!=='Bearer '+key){res.statusCode=401;return res.end()}if(req.url==='/health')return res.end(JSON.stringify({status:Date.now()-started<600?'loading model':'ok'}));if(req.url==='/props')return res.end(JSON.stringify({chat_template:'{{ messages }}'}));let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):{};res.setHeader('content-type','application/json');if(body.tool_choice&&body.tool_choice!=='none')return res.end(JSON.stringify({choices:[{message:{role:'assistant',tool_calls:[{id:'call-1',type:'function',function:{name:'agent_k_tool_probe',arguments:'{"value":37}'}}]}}]}));return res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'continued'}}]}))}).listen(Number(get('--port')),'127.0.0.1');`, "utf8");
  const isolatedHome = join(userData, "home"); mkdirSync(isolatedHome, { recursive: true });
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: ["."], cwd: repositoryRoot, env: { ...environment, HOME: isolatedHome, USERPROFILE: isolatedHome, AGENT_K_E2E: "1", AGENT_K_E2E_USER_DATA: userData, AGENT_K_E2E_LOCAL_MODEL_ENDPOINT: `http://127.0.0.1:${hubPort}`, AGENT_K_E2E_LOCAL_MODEL_NODE: process.execPath, AGENT_K_E2E_LOCAL_MODEL_RUNTIME: executable } });
  try {
    await application.firstWindow();
    const main = await expect.poll(() => application.windows().find((page) => !page.url().includes("splashscreen"))).not.toBeUndefined().then(() => application.windows().find((page) => !page.url().includes("splashscreen"))!);
    await main.waitForLoadState("domcontentloaded");
    await main.evaluate((cwd) => window.agentK.invoke("prepare_session", { cwd }), userData);
    await main.evaluate(() => window.dispatchEvent(new CustomEvent("agent-k-open-settings", { detail: { page: "models" } })));
    await expect(main.locator(".local-model-section")).toBeVisible();
    const localModelsEnabled = main.locator(".local-model-heading .resource-toggle");
    await expect(localModelsEnabled).toHaveAttribute("aria-checked", "true");
    const localModelsToggle = main.locator(".local-model-expand-button");
    await expect(localModelsToggle).toHaveAttribute("aria-expanded", "false");
    await expect(main.locator(".local-model-discovery")).toHaveCount(0);
    await localModelsToggle.click();
    await expect(localModelsToggle).toHaveAttribute("aria-expanded", "true");
    const defaultStoragePath = await main.evaluate(() => window.agentK.invoke<{ defaultStoragePath: string }>("local_models_list", {}).then((snapshot) => snapshot.defaultStoragePath));
    await expect(main.locator("#local-model-storage-path")).toHaveValue(defaultStoragePath);
    await expect(main.locator(".local-model-storage > small")).toContainText(defaultStoragePath);
    await main.locator(".local-model-discovery .segmented-control button", { hasText: "ModelScope" }).click();
    const search = main.locator('.local-model-discovery input[placeholder*="GGUF"]').first();
    await search.fill("tool model");
    await main.locator(".local-model-discovery .inline-field").first().locator("button").click();
    await expect(main.locator(".local-model-results")).toContainText("Tool Model GGUF");
    await main.locator(".local-model-results button").first().click();
    await expect(main.locator(".local-model-inspection-feedback")).toContainText(/已找到 1 个 GGUF 文件|Found 1 GGUF file/);
    await expect(main.locator(".local-model-files")).toContainText("tool-model-Q4_K_M.gguf");
    await main.locator(".local-model-files button").click();
    await expect(main.locator(".local-model-queue")).toBeVisible();
    await expect(main.locator(".local-model-queue > .is-new")).toHaveCount(1);
    await expect(main.locator(".local-model-queue small")).toContainText(/%.*\/s/, { timeout: 10_000 });
    await main.locator('.local-model-queue button[aria-label*="取消"], .local-model-queue button[aria-label*="Cancel"]').click();
    await expect(main.locator(".local-model-queue")).toHaveCount(0);
    await main.locator(".local-model-files button").click();
    await expect(main.locator(".local-model-queue")).toBeVisible();
    await main.locator('.local-model-queue button[aria-label*="暂停"], .local-model-queue button[aria-label*="Pause"]').click();
    await expect(main.locator(".local-model-queue")).toContainText(/已暂停|Paused/);
    await main.locator('.local-model-queue button[aria-label*="继续"], .local-model-queue button[aria-label*="Resume"]').click();
    const card = main.locator(".local-model-card").filter({ hasText: "tool-model-Q4_K_M" });
    await expect(card).toBeVisible({ timeout: 15_000 });
    const advancedButton = card.locator('button[aria-expanded]');
    await expect(advancedButton).toContainText(/高级|Advanced/);
    await advancedButton.click();
    await expect(advancedButton).toHaveAttribute("aria-expanded", "true");
    await expect(advancedButton).toContainText(/收起|Collapse/);
    const advancedLayout = await card.locator(".local-model-advanced-fields > label").evaluateAll((labels) => labels.map((label) => {
      const bounds = label.getBoundingClientRect();
      return { left: Math.round(bounds.left), top: Math.round(bounds.top), width: Math.round(bounds.width) };
    }));
    expect(new Set(advancedLayout.slice(0, 3).map((bounds) => bounds.top)).size).toBe(1);
    expect(new Set(advancedLayout.slice(0, 3).map((bounds) => bounds.width)).size).toBe(1);
    expect(new Set(advancedLayout.slice(3, 6).map((bounds) => bounds.top)).size).toBe(1);
    const backendSelect = card.locator(".local-model-advanced select").first();
    const linuxCudaAvailable = await main.evaluate(() => window.agentK.invoke<{ hardware: { platform: string; availableBackends: string[] } }>("local_models_list", {}).then((snapshot) => snapshot.hardware.platform === "linux" && snapshot.hardware.availableBackends.includes("cuda12")));
    if (linuxCudaAvailable) {
      await expect(backendSelect.locator('option[value="cuda12"]')).toContainText(/ai-dock.*第三方|ai-dock.*third-party/i);
      await expect(card.locator(".local-model-backend-note.is-warning")).toContainText(/ai-dock/);
    }
    await backendSelect.selectOption(linuxCudaAvailable ? "cuda12" : "cpu");
    await card.locator(".local-model-context-input").fill("65536");
    await card.locator(".local-model-cache-type-k").selectOption("q8_0");
    await card.locator(".local-model-cache-type-v").selectOption("q4_0");
    await card.locator(".local-model-advanced-footer button").click();
    await expect.poll(() => main.evaluate(() => window.agentK.invoke<{ models: Array<{ config: { contextSize: number; cacheTypeK: string; cacheTypeV: string } }> }>("local_models_list", {}).then((snapshot) => snapshot.models[0]?.config))).toEqual(expect.objectContaining({ contextSize: 65_536, cacheTypeK: "q8_0", cacheTypeV: "q4_0" }));
    await card.locator("button", { hasText: /验证工具|Verify tools/ }).click();
    if (linuxCudaAvailable) {
      const consent = main.locator(".local-runtime-consent");
      await expect(consent).toBeVisible();
      await expect(consent).toContainText(/ai-dock\/llama\.cpp-cuda/);
      await expect(consent).toContainText("5576a132d768b240b1c3e950e71b456cbf7b90c6a38dca2fcd93f965b32098c9");
      await consent.locator("button.is-primary").click();
      await expect(consent).toHaveCount(0);
    }
    await expect(card).toContainText(/工具协议兼容|Tool protocol compatible/, { timeout: 20_000 });
    await expect.poll(() => readFileSync(launchArgsLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]).some((args) => args[args.indexOf("--cache-type-k") + 1] === "q8_0" && args[args.indexOf("--cache-type-v") + 1] === "q4_0")).toBe(true);
    await main.evaluate(() => window.addEventListener("agent-k-model-changed", () => { document.body.dataset.localModelCatalogRefresh = "yes"; }, { once: true }));
    await card.locator("button", { hasText: /设为当前|Set current/ }).click();
    await expect(card).toContainText(/当前|Current/, { timeout: 15_000 });
    await expect(main.locator("body")).toHaveAttribute("data-local-model-catalog-refresh", "yes");
    const catalog = await main.evaluate(() => window.agentK.invoke<Array<{ id: string; models: Array<{ id: string }> }>>("get_provider_catalog", {}));
    const managed = catalog.find((provider) => provider.id === "agent-k-llama-cpp");
    expect(managed?.models.map((entry) => entry.id)).toEqual(["tool-model-q4_k_m"]);
    await expect(main.locator('.model-current-row option[value="agent-k-llama-cpp/tool-model-q4_k_m"]')).toHaveCount(1);
    const piModelsPath = join(isolatedHome, ".pi", "agent", "models.json");
    const managedModels = readFileSync(piModelsPath, "utf8");
    const withoutManaged = JSON.parse(managedModels) as { providers: Record<string, unknown> };
    delete withoutManaged.providers["agent-k-llama-cpp"];
    writeFileSync(piModelsPath, JSON.stringify(withoutManaged));
    await main.evaluate(() => window.agentK.invoke("reload_pi_runtimes", {}));
    writeFileSync(piModelsPath, managedModels);
    const recoveredModel = await main.evaluate(() => window.agentK.invoke<{ id?: string }>("pi_command", { command: { type: "set_model", provider: "agent-k-llama-cpp", modelId: "tool-model-q4_k_m" } }));
    expect(recoveredModel.id).toBe("tool-model-q4_k_m");
    await expect(main.locator(".startup-splash")).toHaveCount(0);
    const sessionSwitchError = await main.evaluate(async () => { try { await window.agentK.invoke("pi_command", { command: { type: "set_model", provider: "agent-k-llama-cpp", modelId: "some-other-local-model" } }); return ""; } catch (cause) { return String(cause); } });
    expect(sessionSwitchError).toContain("Settings");
    await expect(main.locator(".provider-card").filter({ hasText: "agent-k-llama-cpp" })).toHaveCount(0);
    await main.evaluate((path) => window.agentK.invoke("local_models_import", { path }), importSource);
    await expect(main.locator(".local-model-card")).toHaveCount(2);
    const imported = main.locator(".local-model-card").filter({ hasText: "import-source" });
    await expect(imported).toContainText(/待验证|Pending verification/);
    await expect(main.locator('.model-current-row option[value="agent-k-llama-cpp/import-source"]')).toHaveCount(0);
    await card.locator(".fa-play").locator("..").click();
    const runSplash = main.locator(".startup-splash");
    await expect(runSplash).toContainText(/本地模型运行事务|Local model run transaction/);
    await expect(runSplash).toContainText("tool-model-Q4_K_M");
    await expect.poll(() => main.evaluate(() => Boolean(document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)?.closest(".startup-splash")))).toBe(true);
    await expect(runSplash.locator(".splash-transaction-status")).toContainText(/进度|Progress/);
    await expect(runSplash.locator(".splash-progress-track")).toBeVisible();
    await expect(card).toContainText(/运行中|Running/, { timeout: 15_000 });
    await expect(runSplash).toHaveCount(0);
    await expect(card.locator(".local-model-badges")).toHaveText(/^(当前|Current)(运行中|Running)(工具协议兼容|Tool protocol compatible)$/);
    await card.locator(".fa-stop").locator("..").click();
    await expect(card).not.toContainText(/运行中|Running/, { timeout: 15_000 });
    await main.locator(".local-model-heading button", { hasText: /日志|Logs/ }).click();
    await expect(main.locator(".local-model-logs")).toContainText("fixture llama-server started");
    await main.locator(".local-model-logs header button").click();
    const defaultModel = main.locator(".model-current-row select");
    await defaultModel.selectOption("agent-k-llama-cpp/tool-model-q4_k_m");
    await expect.poll(() => main.evaluate(() => window.agentK.invoke<{ defaultModel: string }>("get_client_settings", {}).then((settings) => settings.defaultModel))).toBe("agent-k-llama-cpp/tool-model-q4_k_m");
    await main.evaluate(async () => { const settings = await window.agentK.invoke<Record<string, unknown>>("get_client_settings", {}); await window.agentK.invoke("save_client_settings", { settings: { ...settings, sessionModels: { "/fixture/session.jsonl": "agent-k-llama-cpp/tool-model-q4_k_m" } } }); });
    await imported.locator("button", { hasText: /高级|Advanced/ }).click();
    await imported.locator(".local-model-advanced select").first().selectOption("cpu");
    await imported.locator(".local-model-advanced-footer button").click();
    await imported.locator("button", { hasText: /验证工具|Verify tools/ }).click();
    await expect(imported).toContainText(/工具协议兼容|Tool protocol compatible/, { timeout: 20_000 });
    await expect.poll(() => readFileSync(launchArgsLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]).some((args) => args[args.indexOf("--cache-type-k") + 1] === "q8_0" && args[args.indexOf("--cache-type-v") + 1] === "q8_0")).toBe(true);
    await imported.locator("button", { hasText: /设为当前|Set current/ }).click();
    await expect.poll(async () => ({
      activeModelId: await main.evaluate(() => window.agentK.invoke<{ activeModelId?: string }>("local_models_list", {}).then((snapshot) => snapshot.activeModelId)),
      errors: await main.locator(".local-model-content > .local-model-error").allTextContents(),
    }), { timeout: 15_000 }).toEqual({ activeModelId: "import-source", errors: [] });
    await expect(imported.locator(".local-model-badges")).toContainText(/当前|Current/, { timeout: 15_000 });
    await expect(card.locator(".local-model-badges")).not.toContainText(/当前|Current/);
    await expect(defaultModel).toHaveValue("agent-k-llama-cpp/import-source");
    const migratedSettings = await main.evaluate(() => window.agentK.invoke<{ sessionModels: Record<string, string> }>("get_client_settings", {}));
    expect(migratedSettings.sessionModels["/fixture/session.jsonl"]).toBe("agent-k-llama-cpp/import-source");
    await expect(main.locator('.model-current-row option[value="agent-k-llama-cpp/tool-model-q4_k_m"]')).toHaveCount(0);
    await card.locator(".fa-trash").locator("..").click();
    const oldModelDelete = main.locator(".local-model-delete-confirm");
    await expect(oldModelDelete).toContainText(/tool-model-Q4_K_M/i);
    await oldModelDelete.locator("button", { hasText: /删除|Delete/ }).click();
    await expect(card).toHaveCount(0);
    const afterOldDelete = await main.evaluate(() => window.agentK.invoke<Array<{ id: string; models: Array<{ id: string }> }>>("get_provider_catalog", {}));
    expect(afterOldDelete.find((provider) => provider.id === "agent-k-llama-cpp")?.models.map((model) => model.id)).toEqual(["import-source"]);
    await imported.locator(".fa-trash").locator("..").click();
    const importedModelDelete = main.locator(".local-model-delete-confirm");
    await expect(importedModelDelete).toContainText("import-source");
    await importedModelDelete.locator("button", { hasText: /删除|Delete/ }).click();
    await expect(imported).toHaveCount(0);
    await expect(defaultModel).toHaveValue("");
    const clearedSettings = await main.evaluate(() => window.agentK.invoke<{ sessionModels: Record<string, string> }>("get_client_settings", {}));
    expect(clearedSettings.sessionModels["/fixture/session.jsonl"]).toBeUndefined();
    const afterDelete = await main.evaluate(() => window.agentK.invoke<Array<{ id: string }>>("get_provider_catalog", {}));
    expect(afterDelete.some((provider) => provider.id === "agent-k-llama-cpp")).toBe(false);
  } finally {
    await application.close();
    await new Promise<void>((resolve) => hub.close(() => resolve()));
    rmSync(userData, { force: true, recursive: true });
  }
});

test("managed local model switch controls availability and disclosure", async () => {
  const userData = mkdtempSync(join(tmpdir(), "agent-k-local-model-toggle-e2e-"));
  const isolatedHome = join(userData, "home"); mkdirSync(isolatedHome, { recursive: true });
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: ["."], cwd: repositoryRoot, env: { ...environment, HOME: isolatedHome, USERPROFILE: isolatedHome, AGENT_K_E2E: "1", AGENT_K_E2E_USER_DATA: userData } });
  try {
    await application.firstWindow();
    const main = await expect.poll(() => application.windows().find((page) => !page.url().includes("splashscreen"))).not.toBeUndefined().then(() => application.windows().find((page) => !page.url().includes("splashscreen"))!);
    await main.waitForLoadState("domcontentloaded");
    await main.evaluate(() => window.dispatchEvent(new CustomEvent("agent-k-open-settings", { detail: { page: "models" } })));
    const enabled = main.locator(".local-model-heading .resource-toggle");
    await expect(enabled).toHaveAttribute("aria-checked", "true");
    await expect(main.locator(".local-model-expand-button")).toHaveCount(1);
    await enabled.click();
    await expect(main.locator(".local-model-section")).toHaveAttribute("aria-busy", "true");
    await expect(main.locator(".local-model-section")).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
    await expect(enabled).toHaveAttribute("aria-checked", "false");
    await expect(main.locator(".local-model-expand-button")).toHaveCount(0);
    await expect.poll(() => main.evaluate(() => window.agentK.invoke<{ disabledModelProviders: string[] }>("get_client_settings", {}).then((settings) => settings.disabledModelProviders))).toContain("agent-k-llama-cpp");
    await enabled.click();
    await expect(main.locator(".local-model-section")).toHaveAttribute("aria-busy", "true");
    await expect(main.locator(".local-model-section")).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
    await expect(enabled).toHaveAttribute("aria-checked", "true");
    await expect(main.locator(".local-model-expand-button")).toHaveCount(1);
    await expect.poll(() => main.evaluate(() => window.agentK.invoke<{ disabledModelProviders: string[] }>("get_client_settings", {}).then((settings) => settings.disabledModelProviders))).not.toContain("agent-k-llama-cpp");
  } finally {
    await application.close();
    rmSync(userData, { force: true, recursive: true });
  }
});

test("new managed models default both KV caches to q8_0", async () => {
  const userData = mkdtempSync(join(tmpdir(), "agent-k-local-model-kv-default-e2e-"));
  const modelPath = join(userData, "kv-default.gguf");
  writeFileSync(modelPath, Buffer.concat([ggufFixture(), Buffer.alloc(1024)]));
  const isolatedHome = join(userData, "home"); mkdirSync(isolatedHome, { recursive: true });
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: ["."], cwd: repositoryRoot, env: { ...environment, HOME: isolatedHome, USERPROFILE: isolatedHome, AGENT_K_E2E: "1", AGENT_K_E2E_USER_DATA: userData } });
  try {
    await application.firstWindow();
    const main = await expect.poll(() => application.windows().find((page) => !page.url().includes("splashscreen"))).not.toBeUndefined().then(() => application.windows().find((page) => !page.url().includes("splashscreen"))!);
    await main.waitForLoadState("domcontentloaded");
    const modelId = await main.evaluate((path) => window.agentK.invoke<string>("local_models_import", { path }), modelPath);
    const config = await main.evaluate((id) => window.agentK.invoke<{ models: Array<{ id: string; config: { cacheTypeK: string; cacheTypeV: string } }> }>("local_models_list", {}).then((snapshot) => snapshot.models.find((model) => model.id === id)?.config), modelId);
    expect(config).toMatchObject({ cacheTypeK: "q8_0", cacheTypeV: "q8_0" });
  } finally {
    await application.close();
    rmSync(userData, { force: true, recursive: true });
  }
});

test("Settings exposes but never overwrites a conflicting external provider", async () => {
  const userData = mkdtempSync(join(tmpdir(), "agent-k-local-model-conflict-e2e-"));
  const isolatedHome = join(userData, "home"); const piDirectory = join(isolatedHome, ".pi", "agent"); mkdirSync(piDirectory, { recursive: true });
  const modelsPath = join(piDirectory, "models.json");
  const external = { providers: { "agent-k-llama-cpp": { name: "External llama.cpp", baseUrl: "http://127.0.0.1:65534/v1", api: "openai-completions", apiKey: "external", models: [{ id: "external-model", name: "External model" }] } } };
  writeFileSync(modelsPath, JSON.stringify(external), "utf8");
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: ["."], cwd: repositoryRoot, env: { ...environment, HOME: isolatedHome, USERPROFILE: isolatedHome, AGENT_K_E2E: "1", AGENT_K_E2E_USER_DATA: userData } });
  try {
    await application.firstWindow();
    const main = await expect.poll(() => application.windows().find((page) => !page.url().includes("splashscreen"))).not.toBeUndefined().then(() => application.windows().find((page) => !page.url().includes("splashscreen"))!);
    await main.waitForLoadState("domcontentloaded");
    await main.evaluate((cwd) => window.agentK.invoke("prepare_session", { cwd }), userData);
    await main.evaluate(() => window.dispatchEvent(new CustomEvent("agent-k-open-settings", { detail: { page: "models" } })));
    await main.locator(".local-model-expand-button").click();
    await expect(main.locator(".local-model-section .local-model-error")).toContainText("not managed by Agent K");
    await expect(main.locator(".provider-card").filter({ hasText: "External llama.cpp" })).toHaveCount(1);
    expect(JSON.parse(readFileSync(modelsPath, "utf8"))).toEqual(external);
  } finally {
    await application.close(); rmSync(userData, { force: true, recursive: true });
  }
});

test("uses the configured local model library after restarting", async () => {
  const userData = mkdtempSync(join(tmpdir(), "agent-k-local-model-path-e2e-"));
  const isolatedHome = join(userData, "home");
  const customLibrary = join(userData, "custom-model-library");
  mkdirSync(isolatedHome, { recursive: true });
  writeFileSync(join(userData, "client-settings.json"), JSON.stringify({ localModelDirectory: customLibrary }), "utf8");
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: ["."], cwd: repositoryRoot, env: { ...environment, HOME: isolatedHome, USERPROFILE: isolatedHome, AGENT_K_E2E: "1", AGENT_K_E2E_USER_DATA: userData } });
  try {
    await application.firstWindow();
    const main = await expect.poll(() => application.windows().find((page) => !page.url().includes("splashscreen"))).not.toBeUndefined().then(() => application.windows().find((page) => !page.url().includes("splashscreen"))!);
    await main.waitForLoadState("domcontentloaded");
    await main.evaluate(() => window.dispatchEvent(new CustomEvent("agent-k-open-settings", { detail: { page: "models" } })));
    await main.locator(".local-model-expand-button").click();
    await expect(main.locator("#local-model-storage-path")).toHaveValue(customLibrary);
    await expect(main.locator(".local-model-storage > small")).toContainText(customLibrary);
    expect(await main.evaluate(() => window.agentK.invoke<{ storagePath: string }>("local_models_list", {}))).toMatchObject({ storagePath: customLibrary });
  } finally {
    await application.close();
    rmSync(userData, { force: true, recursive: true });
  }
});
