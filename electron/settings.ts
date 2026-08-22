import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { shell } from "electron";
import { configuredProviderModels, isManagedProviderOverride, mergedProviderModels } from "./model-provider.js";
import type { PiLaunch } from "./pi-runtime.js";
import type { ClientSettings, JsonObject } from "./types.js";
import { discoveredModels, enrichOllamaModelCapabilities, localModelsEndpoint, type ProviderModelDraft } from "./model-discovery.js";
import { normalizedThinkingLevelMap, THINKING_LEVELS, type ThinkingLevel, type ThinkingLevelMap } from "./model-reasoning.js";
import { remoteProviderModelState } from "./remote-model-catalog.js";
import { loginOpenAICodex, macTerminalLoginArguments } from "./provider-login.js";
import {
  asArray,
  asObject,
  asString,
  atomicWrite,
  errorMessage,
  piAgentDirectory,
  readJson,
} from "./utils.js";

export interface ProviderDraft {
  id: string;
  previousId?: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  models: ProviderModelDraft[];
  local: boolean;
}

export type { ProviderModelDraft } from "./model-discovery.js";

function validatedThinkingLevelMap(value: unknown, modelId = ""): ThinkingLevelMap | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = asObject(value);
  const entries = THINKING_LEVELS.flatMap((level) => {
    const mapped = source[level];
    return typeof mapped === "string" || mapped === null ? [[level, mapped] as const] : [];
  });
  return entries.length
    ? normalizedThinkingLevelMap(modelId, Object.fromEntries(entries) as ThinkingLevelMap)
    : undefined;
}

const DEFAULT_SETTINGS: ClientSettings = {
  version: 17,
  theme: "light",
  locale: "zh-CN",
  permissionMode: "ask",
  browserId: "default",
  cacheDirectory: "",
  localModelDirectory: "",
  piExecutable: "",
  terminalCharset: "utf-8",
  workerPoolSize: 4,
  agentLoopDetectionEnabled: true,
  environmentPromptEnabled: false,
  autoCompactEnabled: true,
  autoCompactPrompt: "",
  editorWordWrap: false,
  disabledFileEditors: [],
  disabledFileEditorSkills: [],
  disabledLanguagePacks: [],
  disabledModelProviders: [],
  disabledModels: [],
  pinnedWorkspaces: [],
  defaultModel: "",
  defaultThinkingLevel: "off",
  sessionModels: {},
  sessionThinkingLevels: {},
  leftPanelWidth: 304,
  rightPanelWidth: 420,
  fileExplorerWidth: 190,
  fileExplorerCollapsed: false,
  leftPanelHidden: false,
  rightPanelHidden: false,
  developmentDockHeight: 280,
  developmentDockCollapsed: false,
  developmentDockTerminalVisible: true,
  windowWidth: 1600,
  windowHeight: 920,
  windowMaximized: false,
};

function safeBrowserId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function editorSettingIds(value: unknown): string[] {
  return [
    ...new Set(
      asArray(value).filter(
        (entry): entry is string =>
          typeof entry === "string" &&
          entry.length >= 2 &&
          entry.length <= 128 &&
          /^[a-z0-9][a-z0-9._-]+$/i.test(entry),
      ),
    ),
  ];
}

function modelProviderIds(value: unknown): string[] {
  return [
    ...new Set(
      asArray(value).filter(
        (entry): entry is string =>
          typeof entry === "string" &&
          entry.length > 0 &&
          entry.length <= 80 &&
          /^[A-Za-z0-9_-]+$/.test(entry),
      ),
    ),
  ];
}

function modelSettingKeys(value: unknown): string[] {
  return [
    ...new Set(
      asArray(value).filter((entry): entry is string => {
        if (typeof entry !== "string" || entry.length > 512) return false;
        const separator = entry.indexOf("/");
        return separator > 0 &&
          separator < entry.length - 1 &&
          /^[A-Za-z0-9_-]+$/.test(entry.slice(0, separator));
      }),
    ),
  ];
}

function sameStringArray(value: unknown, expected: string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

export function parseClientSettings(value: unknown): ClientSettings {
  const source = asObject(value);
  const settings = { ...DEFAULT_SETTINGS };
  if (/^(system|light|soft-light|dark|[a-z0-9][a-z0-9-]{1,63})$/i.test(String(source.theme)))
    settings.theme = String(source.theme);
  if (["zh-CN", "en-US"].includes(String(source.locale)))
    settings.locale = source.locale as ClientSettings["locale"];
  if (["ask", "full"].includes(String(source.permissionMode)))
    settings.permissionMode = source.permissionMode as ClientSettings["permissionMode"];
  if (safeBrowserId(source.browserId)) settings.browserId = source.browserId;
  if (
    typeof source.cacheDirectory === "string" &&
    source.cacheDirectory.length <= 4096 &&
    (!source.cacheDirectory.trim() || isAbsolute(source.cacheDirectory.trim()))
  ) settings.cacheDirectory = source.cacheDirectory.trim();
  if (
    typeof source.localModelDirectory === "string" &&
    source.localModelDirectory.length <= 4096 &&
    (!source.localModelDirectory.trim() || isAbsolute(source.localModelDirectory.trim()))
  ) settings.localModelDirectory = source.localModelDirectory.trim();
  if (typeof source.piExecutable === "string" && source.piExecutable.length <= 4096)
    settings.piExecutable = source.piExecutable.trim();
  if (["utf-8", "gbk"].includes(String(source.terminalCharset)))
    settings.terminalCharset = source.terminalCharset as ClientSettings["terminalCharset"];
  if ([2, 3, 4].includes(Number(source.workerPoolSize)))
    settings.workerPoolSize = Number(source.workerPoolSize) as 2 | 3 | 4;
  if (typeof source.agentLoopDetectionEnabled === "boolean")
    settings.agentLoopDetectionEnabled = source.agentLoopDetectionEnabled;
  if (typeof source.environmentPromptEnabled === "boolean")
    settings.environmentPromptEnabled = source.environmentPromptEnabled;
  if (typeof source.autoCompactEnabled === "boolean")
    settings.autoCompactEnabled = source.autoCompactEnabled;
  if (typeof source.autoCompactPrompt === "string" && source.autoCompactPrompt.length <= 4_000)
    settings.autoCompactPrompt = source.autoCompactPrompt;
  if (typeof source.editorWordWrap === "boolean")
    settings.editorWordWrap = source.editorWordWrap;
  settings.disabledFileEditors = editorSettingIds(source.disabledFileEditors);
  settings.disabledFileEditorSkills = [
    ...new Set([
      ...editorSettingIds(source.disabledFileEditorSkills),
      ...settings.disabledFileEditors,
    ]),
  ];
  settings.disabledLanguagePacks = editorSettingIds(source.disabledLanguagePacks);
  settings.disabledModelProviders = modelProviderIds(source.disabledModelProviders);
  settings.disabledModels = modelSettingKeys(source.disabledModels);
  settings.pinnedWorkspaces = [
    ...new Set(
      asArray(source.pinnedWorkspaces).filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 4_096,
      ),
    ),
  ];
  if (typeof source.defaultModel === "string" && source.defaultModel.length <= 256)
    settings.defaultModel = source.defaultModel;
  if (typeof source.defaultThinkingLevel === "string" && THINKING_LEVELS.includes(source.defaultThinkingLevel as ThinkingLevel))
    settings.defaultThinkingLevel = source.defaultThinkingLevel as ThinkingLevel;
  settings.sessionModels = Object.fromEntries(
    Object.entries(asObject(source.sessionModels)).flatMap(([path, model]) =>
      path.length <= 4096 && typeof model === "string" && model.length <= 256
        ? [[path, model]] : [],
    ),
  );
  settings.sessionThinkingLevels = Object.fromEntries(
    Object.entries(asObject(source.sessionThinkingLevels)).flatMap(([path, level]) =>
      path.length <= 4096 && typeof level === "string" && THINKING_LEVELS.includes(level as ThinkingLevel)
        ? [[path, level as ThinkingLevel]] : [],
    ),
  );
  if (Number(source.leftPanelWidth) >= 240 && Number(source.leftPanelWidth) <= 2400)
    settings.leftPanelWidth = Number(source.leftPanelWidth);
  if (Number(source.rightPanelWidth) >= 420 && Number(source.rightPanelWidth) <= 3200)
    settings.rightPanelWidth = Number(source.rightPanelWidth);
  if (Number(source.fileExplorerWidth) >= 110 && Number(source.fileExplorerWidth) <= 3000)
    settings.fileExplorerWidth = Number(source.fileExplorerWidth);
  if (typeof source.fileExplorerCollapsed === "boolean")
    settings.fileExplorerCollapsed = source.fileExplorerCollapsed;
  if (typeof source.leftPanelHidden === "boolean")
    settings.leftPanelHidden = source.leftPanelHidden;
  if (typeof source.rightPanelHidden === "boolean")
    settings.rightPanelHidden = source.rightPanelHidden;
  if (Number(source.developmentDockHeight) >= 150 && Number(source.developmentDockHeight) <= 8000)
    settings.developmentDockHeight = Number(source.developmentDockHeight);
  if (typeof source.developmentDockCollapsed === "boolean")
    settings.developmentDockCollapsed = source.developmentDockCollapsed;
  if (typeof source.developmentDockTerminalVisible === "boolean")
    settings.developmentDockTerminalVisible = source.developmentDockTerminalVisible;
  if (Number(source.windowWidth) >= 1372 && Number(source.windowWidth) <= 16384)
    settings.windowWidth = Number(source.windowWidth);
  if (Number(source.windowHeight) >= 640 && Number(source.windowHeight) <= 16384)
    settings.windowHeight = Number(source.windowHeight);
  if (typeof source.windowMaximized === "boolean")
    settings.windowMaximized = source.windowMaximized;
  settings.version = Math.max(17, Number(source.version) || 17);
  return settings;
}

export async function loadClientSettings(appDataPath: string): Promise<ClientSettings> {
  return parseClientSettings(
    await readJson(join(appDataPath, "client-settings.json"), {}),
  );
}

export async function saveClientSettings(
  appDataPath: string,
  input: unknown,
): Promise<ClientSettings> {
  const settings = parseClientSettings(input);
  const original = asObject(input);
  const valid =
    settings.theme === original.theme &&
    settings.locale === original.locale &&
    settings.permissionMode === original.permissionMode &&
    settings.browserId === original.browserId &&
    settings.cacheDirectory === original.cacheDirectory &&
    settings.localModelDirectory === original.localModelDirectory &&
    settings.piExecutable === original.piExecutable &&
    settings.terminalCharset === original.terminalCharset &&
    settings.workerPoolSize === original.workerPoolSize &&
    settings.agentLoopDetectionEnabled === original.agentLoopDetectionEnabled &&
    settings.environmentPromptEnabled === original.environmentPromptEnabled &&
    settings.autoCompactEnabled === original.autoCompactEnabled &&
    settings.autoCompactPrompt === original.autoCompactPrompt &&
    settings.editorWordWrap === original.editorWordWrap &&
    sameStringArray(original.disabledFileEditors, settings.disabledFileEditors) &&
    sameStringArray(original.disabledFileEditorSkills, settings.disabledFileEditorSkills) &&
    sameStringArray(original.disabledLanguagePacks, settings.disabledLanguagePacks) &&
    sameStringArray(original.disabledModelProviders, settings.disabledModelProviders) &&
    sameStringArray(original.disabledModels, settings.disabledModels) &&
    sameStringArray(original.pinnedWorkspaces, settings.pinnedWorkspaces) &&
    settings.defaultModel === original.defaultModel &&
    settings.defaultThinkingLevel === original.defaultThinkingLevel &&
    JSON.stringify(settings.sessionModels) === JSON.stringify(original.sessionModels) &&
    JSON.stringify(settings.sessionThinkingLevels) === JSON.stringify(original.sessionThinkingLevels) &&
    settings.leftPanelWidth === original.leftPanelWidth &&
    settings.rightPanelWidth === original.rightPanelWidth &&
    settings.fileExplorerWidth === original.fileExplorerWidth &&
    settings.fileExplorerCollapsed === original.fileExplorerCollapsed &&
    settings.leftPanelHidden === original.leftPanelHidden &&
    settings.rightPanelHidden === original.rightPanelHidden &&
    settings.developmentDockHeight === original.developmentDockHeight &&
    settings.developmentDockCollapsed === original.developmentDockCollapsed &&
    settings.developmentDockTerminalVisible === original.developmentDockTerminalVisible &&
    settings.windowWidth === original.windowWidth &&
    settings.windowHeight === original.windowHeight &&
    settings.windowMaximized === original.windowMaximized;
  if (!valid) throw new Error("Invalid client settings");
  await atomicWrite(
    join(appDataPath, "client-settings.json"),
    JSON.stringify(settings, null, 2),
  );
  return settings;
}

type Browser = { id: string; name: string; executable: string };

function which(command: string): string | undefined {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [command], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.split(/\r?\n/)[0]?.trim() : undefined;
}

function detectedBrowsers(): Browser[] {
  const candidates: Array<[string, string, string[]]> =
    process.platform === "win32"
      ? [
          ["edge", "Microsoft Edge", [
            join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft/Edge/Application/msedge.exe"),
            join(process.env.ProgramFiles ?? "", "Microsoft/Edge/Application/msedge.exe"),
          ]],
          ["chrome", "Google Chrome", [
            join(process.env.ProgramFiles ?? "", "Google/Chrome/Application/chrome.exe"),
            join(process.env["ProgramFiles(x86)"] ?? "", "Google/Chrome/Application/chrome.exe"),
            join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
          ]],
          ["firefox", "Mozilla Firefox", [
            join(process.env.ProgramFiles ?? "", "Mozilla Firefox/firefox.exe"),
            join(process.env["ProgramFiles(x86)"] ?? "", "Mozilla Firefox/firefox.exe"),
          ]],
          ["brave", "Brave", [
            join(process.env.ProgramFiles ?? "", "BraveSoftware/Brave-Browser/Application/brave.exe"),
            join(process.env.LOCALAPPDATA ?? "", "BraveSoftware/Brave-Browser/Application/brave.exe"),
          ]],
        ]
      : [
          ["chrome", "Google Chrome", ["google-chrome"]],
          ["chromium", "Chromium", ["chromium"]],
          ["firefox", "Mozilla Firefox", ["firefox"]],
          ["brave", "Brave", ["brave-browser"]],
        ];
  return candidates.flatMap(([id, name, paths]) => {
    const executable = paths
      .map((candidate) =>
        process.platform === "win32" ? candidate : which(candidate),
      )
      .find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
    return executable ? [{ id, name, executable }] : [];
  });
}

export function listBrowsers(): Array<{ id: string; name: string }> {
  return [
    { id: "default", name: "System default" },
    ...detectedBrowsers().map(({ id, name }) => ({ id, name })),
  ];
}

export async function openExternalUrl(url: string, browserId: string): Promise<void> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error("Only HTTP(S) links can be opened");
  if (browserId === "default") {
    await shell.openExternal(parsed.toString());
    return;
  }
  const browser = detectedBrowsers().find((item) => item.id === browserId);
  if (!browser) throw new Error("Selected browser is not installed");
  const child = spawn(browser.executable, [parsed.toString()], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export async function setSessionPermission(
  appDataPath: string,
  sessionId: string,
  allowed: boolean,
): Promise<void> {
  const path = join(appDataPath, "permission-state.json");
  const grants = new Set(await readJson<string[]>(path, []));
  if (allowed) grants.add(sessionId);
  else grants.delete(sessionId);
  await atomicWrite(path, JSON.stringify([...grants]));
}

function validProviderId(value: string): boolean {
  return value.length > 0 && value.length <= 80 && /^[A-Za-z0-9_-]+$/.test(value);
}

async function jsonObject(path: string): Promise<JsonObject> {
  return asObject(await readJson(path, {}));
}

export async function saveModelProvider(provider: ProviderDraft): Promise<void> {
  const id = provider.id.trim();
  const previousId = provider.previousId?.trim();
  if (!validProviderId(id))
    throw new Error("Provider ID may contain only letters, numbers, - and _");
  if (previousId && !validProviderId(previousId))
    throw new Error("Previous provider ID may contain only letters, numbers, - and _");
  new URL(provider.baseUrl);
  if (!provider.models.length || provider.models.some((model) => !model.id.trim()))
    throw new Error("At least one model ID is required");
  const models = provider.models.map((model) => {
    const modelId = model.id.trim();
    const contextWindow = Number(model.contextWindow);
    if (model.contextWindow !== undefined && (!Number.isInteger(contextWindow) || contextWindow <= 0))
      throw new Error("Model context window must be a positive integer");
    const input: Array<"text" | "image"> = model.input?.includes("image") ? ["text", "image"] : ["text"];
    return {
      id: modelId,
      name: model.name?.trim() || modelId,
      ...(model.contextWindow === undefined ? {} : { contextWindow }),
      reasoning: model.reasoning === true,
      input,
      ...(validatedThinkingLevelMap(model.thinkingLevelMap, modelId)
        ? { thinkingLevelMap: validatedThinkingLevelMap(model.thinkingLevelMap, modelId) }
        : {}),
    };
  });
  const directory = piAgentDirectory();
  await mkdir(directory, { recursive: true });
  const path = join(directory, "models.json");
  const root = await jsonObject(path);
  const providers = asObject(root.providers);
  const existingProvider = asObject(providers[id]);
  providers[id] = {
    name: provider.name.trim() || id,
    baseUrl: provider.baseUrl.trim(),
    api: provider.api,
    models: configuredProviderModels(existingProvider, models),
    ...(provider.local
      ? { apiKey: provider.id === "ollama" ? "ollama" : "local" }
      : {}),
  };
  if (previousId && previousId !== id) delete providers[previousId];
  root.providers = providers;
  await atomicWrite(path, JSON.stringify(root, null, 2));
}

export async function deleteModelProvider(providerId: string): Promise<void> {
  const path = join(piAgentDirectory(), "models.json");
  const root = await jsonObject(path);
  const providers = asObject(root.providers);
  delete providers[providerId];
  root.providers = providers;
  await atomicWrite(path, JSON.stringify(root, null, 2));
}

export async function saveProviderApiKey(
  providerId: string,
  apiKey: string,
): Promise<void> {
  const id = providerId.trim();
  const key = apiKey.trim();
  if (!validProviderId(id)) throw new Error("Invalid provider ID");
  if (!key) throw new Error("API key cannot be empty");
  const path = join(piAgentDirectory(), "auth.json");
  const auth = await jsonObject(path);
  auth[id] = { type: "api_key", key };
  await atomicWrite(path, JSON.stringify(auth, null, 2), true);
}

export async function logoutProvider(providerId: string): Promise<void> {
  const id = providerId.trim();
  if (!validProviderId(id)) throw new Error("Invalid provider ID");
  const path = join(piAgentDirectory(), "auth.json");
  const auth = await jsonObject(path);
  delete auth[id];
  await atomicWrite(path, JSON.stringify(auth, null, 2), true);
}

export type ProviderBalance = {
  available: boolean;
  balances: Array<{ currency: string; total: string }>;
};

export type CodexQuotaWindow = {
  usedPercent: number;
  windowDurationSeconds: number;
  resetsAt?: number;
};

export type CodexQuotaBucket = {
  id: string;
  name: string;
  allowed: boolean;
  limitReached: boolean;
  primary?: CodexQuotaWindow;
  secondary?: CodexQuotaWindow;
};

export type CodexQuota = {
  planType?: string;
  buckets: CodexQuotaBucket[];
  credits?: {
    hasCredits: boolean;
    unlimited: boolean;
    overageLimitReached: boolean;
    balance?: string;
  };
  resetCredits?: number;
  rateLimitReachedType?: string;
};

export type CodexQuotaResult =
  | { quota: CodexQuota; retryable: false }
  | { error: string; retryable: boolean };

function configuredApiKey(providerAuth: JsonObject): string | undefined {
  return asString(providerAuth.key) ?? asString(providerAuth.apiKey);
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function codexQuotaWindow(value: unknown): CodexQuotaWindow | undefined {
  const window = asObject(value);
  const usedPercent = finiteNumber(window.used_percent);
  const windowDurationSeconds = finiteNumber(window.limit_window_seconds);
  if (usedPercent === undefined || windowDurationSeconds === undefined) return undefined;
  const resetsAt = finiteNumber(window.reset_at);
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowDurationSeconds: Math.max(0, windowDurationSeconds),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function codexQuotaBucket(
  id: string,
  name: string,
  value: unknown,
): CodexQuotaBucket | undefined {
  const rateLimit = asObject(value);
  const primary = codexQuotaWindow(rateLimit.primary_window);
  const secondary = codexQuotaWindow(rateLimit.secondary_window);
  if (!primary && !secondary) return undefined;
  return {
    id,
    name,
    allowed: rateLimit.allowed !== false,
    limitReached: rateLimit.limit_reached === true,
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

function parseCodexQuota(value: unknown): CodexQuota {
  const body = asObject(value);
  const buckets: CodexQuotaBucket[] = [];
  const main = codexQuotaBucket("codex", "Codex", body.rate_limit);
  if (main) buckets.push(main);
  const codeReview = codexQuotaBucket(
    "code-review",
    "Code review",
    body.code_review_rate_limit,
  );
  if (codeReview) buckets.push(codeReview);
  for (const item of asArray(body.additional_rate_limits).map(asObject)) {
    const rateLimit = asObject(item.rate_limit);
    const id = asString(item.metered_feature) ?? asString(item.limit_name);
    const name = asString(item.limit_name) ?? id;
    if (!id || !name) continue;
    const bucket = codexQuotaBucket(id, name, rateLimit);
    if (bucket) buckets.push(bucket);
  }
  if (!buckets.length) throw new Error("Codex returned an invalid usage response");

  const creditsValue = asObject(body.credits);
  const hasCredits = creditsValue.has_credits === true;
  const unlimited = creditsValue.unlimited === true;
  const overageLimitReached = creditsValue.overage_limit_reached === true;
  const balance = asString(creditsValue.balance);
  const credits = Object.keys(creditsValue).length
    ? {
        hasCredits,
        unlimited,
        overageLimitReached,
        ...(balance ? { balance } : {}),
      }
    : undefined;
  const resetCreditsValue = asObject(body.rate_limit_reset_credits);
  const resetCredits = finiteNumber(resetCreditsValue.applicable_available_count);
  return {
    planType: asString(body.plan_type),
    buckets,
    ...(credits ? { credits } : {}),
    ...(resetCredits === undefined ? {} : { resetCredits }),
    rateLimitReachedType: asString(body.rate_limit_reached_type),
  };
}

export async function codexQuota(): Promise<CodexQuotaResult> {
  const auth = await jsonObject(join(piAgentDirectory(), "auth.json"));
  const credential = asObject(auth["openai-codex"]);
  const accessToken = asString(credential.access);
  const accountId = asString(credential.accountId);
  if (credential.type !== "oauth" || !accessToken || !accountId)
    return { error: "OpenAI Codex OAuth is not configured", retryable: false };
  try {
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
        "User-Agent": "AgentK",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 401 || response.status === 403)
      return { error: "OpenAI Codex session expired", retryable: false };
    if (!response.ok)
      return {
        error: `Codex usage request failed: ${response.status}`,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      };
    return { quota: parseCodexQuota(await response.json()), retryable: false };
  } catch (cause) {
    return {
      error: cause instanceof DOMException && cause.name === "TimeoutError"
        ? "Codex usage request timed out"
        : `Codex usage request failed: ${errorMessage(cause)}`,
      retryable: true,
    };
  }
}

export async function providerBalance(providerId: string): Promise<ProviderBalance> {
  const auth = await jsonObject(join(piAgentDirectory(), "auth.json"));
  if (providerId === "deepseek") {
    const key = configuredApiKey(asObject(auth.deepseek)) ?? process.env.DEEPSEEK_API_KEY;
    if (!key) throw new Error("DeepSeek API key is not configured");
    const response = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`DeepSeek balance request failed: ${response.status}`);
    const body = asObject(await response.json());
    return {
      available: body.is_available === true,
      balances: asArray(body.balance_infos).map(asObject).flatMap((entry) => {
        const currency = asString(entry.currency);
        const total = asString(entry.total_balance);
        return currency && total ? [{ currency, total }] : [];
      }),
    };
  }
  if (providerId === "openrouter") {
    const key = configuredApiKey(asObject(auth.openrouter)) ?? process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("OpenRouter API key is not configured");
    const response = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`OpenRouter credits request failed: ${response.status}`);
    const credits = asObject(asObject(await response.json()).data);
    const purchased = Number(credits.total_credits);
    const used = Number(credits.total_usage);
    if (!Number.isFinite(purchased) || !Number.isFinite(used))
      throw new Error("OpenRouter returned an invalid credits response");
    return {
      available: true,
      balances: [{ currency: "USD", total: Math.max(0, purchased - used).toFixed(4) }],
    };
  }
  throw new Error(`Balance is not supported for provider: ${providerId}`);
}

export async function migrateMisclassifiedVllm(): Promise<void> {
  const directory = piAgentDirectory();
  const modelsPath = join(directory, "models.json");
  const root = await jsonObject(modelsPath);
  const providers = asObject(root.providers);
  if (Object.hasOwn(providers, "vllm")) return;
  const candidate = asObject(providers.ollama);
  const baseUrl = asString(candidate.baseUrl);
  const name = asString(candidate.name) ?? "";
  if (!baseUrl || (name && name.toLowerCase() !== "ollama")) return;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return;
  }
  if (url.port !== "8000") return;
  try {
    if ((await detectLocalService(baseUrl)).kind !== "vllm") return;
  } catch {
    return;
  }
  providers.vllm = { ...candidate, name: "vLLM" };
  delete providers.ollama;
  root.providers = providers;
  await atomicWrite(modelsPath, JSON.stringify(root, null, 2));
  const settingsPath = join(directory, "settings.json");
  const settings = await jsonObject(settingsPath);
  if (settings.defaultProvider === "ollama") {
    settings.defaultProvider = "vllm";
    await atomicWrite(settingsPath, JSON.stringify(settings, null, 2));
  }
}

export async function migrateReasoningOffValues(): Promise<void> {
  const modelsPath = join(piAgentDirectory(), "models.json");
  const root = await jsonObject(modelsPath);
  let changed = false;
  for (const provider of Object.values(asObject(root.providers)).map(asObject)) {
    for (const model of asArray(provider.models).map(asObject)) {
      const modelId = asString(model.id);
      if (!modelId) continue;
      const current = validatedThinkingLevelMap(model.thinkingLevelMap);
      const normalized = normalizedThinkingLevelMap(modelId, current);
      if (current?.off !== normalized?.off) {
        model.thinkingLevelMap = normalized;
        changed = true;
      }
    }
  }
  if (changed) await atomicWrite(modelsPath, JSON.stringify(root, null, 2));
}

const BUILTIN_PROVIDERS: Array<[string, string, boolean, boolean]> = [
  ["amazon-bedrock", "Amazon Bedrock", true, false], ["ant-ling", "Ant Ling", true, false],
  ["anthropic", "Anthropic", true, true], ["azure-openai-responses", "Azure OpenAI", true, false],
  ["cerebras", "Cerebras", true, false], ["cloudflare-ai-gateway", "Cloudflare AI Gateway", true, false],
  ["cloudflare-workers-ai", "Cloudflare Workers AI", true, false], ["deepseek", "DeepSeek", true, false],
  ["fireworks", "Fireworks", true, false], ["github-copilot", "GitHub Copilot", true, true],
  ["google", "Google Gemini", true, false], ["google-vertex", "Google Vertex AI", true, false],
  ["groq", "Groq", true, false], ["huggingface", "Hugging Face", true, false],
  ["kimi-coding", "Kimi For Coding", true, false], ["minimax", "MiniMax", true, false],
  ["minimax-cn", "MiniMax China", true, false], ["mistral", "Mistral", true, false],
  ["moonshotai", "Moonshot AI", true, false], ["moonshotai-cn", "Moonshot AI China", true, false],
  ["nvidia", "NVIDIA NIM", true, false], ["openai", "OpenAI", true, false],
  ["openai-codex", "OpenAI Codex", false, true], ["opencode", "OpenCode Zen", true, false],
  ["opencode-go", "OpenCode Go", true, false], ["openrouter", "OpenRouter", true, false],
  ["qwen-token-plan", "Qwen Token Plan", true, false], ["qwen-token-plan-cn", "Qwen Token Plan China", true, false],
  ["radius", "Radius", true, true], ["together", "Together AI", true, false],
  ["vercel-ai-gateway", "Vercel AI Gateway", true, false], ["xai", "xAI", true, true],
  ["xiaomi", "Xiaomi MiMo", true, false], ["xiaomi-token-plan-cn", "Xiaomi Token Plan China", true, false],
  ["xiaomi-token-plan-ams", "Xiaomi Token Plan Amsterdam", true, false], ["xiaomi-token-plan-sgp", "Xiaomi Token Plan Singapore", true, false],
  ["zai", "Z.AI", true, false], ["zai-coding-cn", "Z.AI Coding China", true, false],
];

export async function providerCatalog(available: unknown): Promise<JsonObject[]> {
  const modelsByProvider = new Map<string, JsonObject[]>();
  for (const modelValue of asArray(asObject(available).models)) {
    const model = asObject(modelValue);
    const provider = asString(model.provider);
    const id = asString(model.id);
    if (!provider || !id) continue;
    const models = modelsByProvider.get(provider) ?? [];
    const input = asArray(model.input).filter((value): value is "text" | "image" =>
      value === "text" || value === "image",
    );
    models.push({
      id,
      ...(typeof model.name === "string" ? { name: model.name } : {}),
      ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
      ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
      ...(input.length ? { input } : {}),
      ...(validatedThinkingLevelMap(model.thinkingLevelMap, id)
        ? { thinkingLevelMap: validatedThinkingLevelMap(model.thinkingLevelMap, id) }
        : {}),
    });
    modelsByProvider.set(provider, models);
  }
  const directory = piAgentDirectory();
  const auth = await jsonObject(join(directory, "auth.json"));
  const custom = asObject((await jsonObject(join(directory, "models.json"))).providers);
  const remotelyManaged = await remoteProviderModelState();
  const catalog: JsonObject[] = BUILTIN_PROVIDERS.map(([id, name, apiKey, oauth]) => {
    const value = asObject(custom[id]);
    const configuredModels = asArray(value.models).map(asObject).filter((model) => typeof model.id === "string");
    const managedOnly = isManagedProviderOverride(value, remotelyManaged[id]);
    const result: JsonObject = {
      id,
      name: asString(value.name) ?? name,
      source: Object.hasOwn(custom, id) && !managedOnly ? "custom" : "builtin",
      configured: Object.hasOwn(auth, id) || modelsByProvider.has(id),
      authMethods: [apiKey ? "api_key" : undefined, oauth ? "oauth" : undefined].filter(Boolean),
      models: mergedProviderModels(modelsByProvider.get(id) ?? [], configuredModels),
    };
    if (typeof value.baseUrl === "string") result.baseUrl = value.baseUrl;
    if (typeof value.api === "string") result.api = value.api;
    modelsByProvider.delete(id);
    return result;
  });
  for (const [id, raw] of Object.entries(custom)) {
    if (BUILTIN_PROVIDERS.some(([builtin]) => builtin === id)) continue;
    const value = asObject(raw);
    const configuredModels = asArray(value.models).map(asObject).filter((model) => typeof model.id === "string");
    catalog.push({
      id,
      name: asString(value.name) ?? id,
      ...(typeof value.baseUrl === "string" ? { baseUrl: value.baseUrl } : {}),
      ...(typeof value.api === "string" ? { api: value.api } : {}),
      source: "custom",
      configured: Object.hasOwn(auth, id) || Boolean(asString(value.apiKey)) || modelsByProvider.has(id),
      authMethods: ["api_key"],
      models: configuredModels.length ? configuredModels : modelsByProvider.get(id) ?? [],
      ...(value.agentKManaged === true ? { agentKManaged: true } : {}),
    });
    modelsByProvider.delete(id);
  }
  for (const [id, models] of modelsByProvider)
    catalog.push({ id, name: id, source: "extension", configured: true, authMethods: [], models });
  return catalog.sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

async function fetchJson(url: URL, timeout: number): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

export async function detectLocalService(baseUrl: string): Promise<JsonObject> {
  const origin = new URL(baseUrl);
  if (!['http:', 'https:'].includes(origin.protocol))
    throw new Error("Only HTTP(S) model services are supported");
  origin.pathname = "/";
  origin.search = "";
  origin.hash = "";
  try {
    const response = await fetch(origin, { signal: AbortSignal.timeout(3_000) });
    if ((await response.text()).toLowerCase().includes("ollama is running"))
      return { kind: "ollama", displayName: "Ollama" };
  } catch {
    // Continue probing compatible services.
  }
  try {
    const version = asObject(await fetchJson(new URL("version", origin), 3_000));
    if (typeof version.version === "string")
      return { kind: "vllm", displayName: "vLLM" };
  } catch {
    // Fall back to the generic OpenAI-compatible classification.
  }
  if (origin.port === "1234") return { kind: "lm-studio", displayName: "LM Studio" };
  return { kind: "openai-compatible", displayName: "OpenAI-compatible" };
}

export async function discoverLocalModels(baseUrl: string, ollama: boolean): Promise<ProviderModelDraft[]> {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol))
    throw new Error("Only HTTP(S) model services are supported");
  const isOllama = ollama || (await detectLocalService(baseUrl)).kind === "ollama";
  const modelsUrl = localModelsEndpoint(baseUrl);
  try {
    const body = asObject(await fetchJson(modelsUrl, 8_000));
    const models = discoveredModels(body);
    if (models.length) {
      const sorted = [...new Map(models.map((model) => [model.id, model])).values()]
        .sort((left, right) => left.id.localeCompare(right.id));
      return isOllama ? enrichOllamaModelCapabilities(base, sorted) : sorted;
    }
  } catch {
    // Ollama has a separate model-list endpoint.
  }
  if (!isOllama) throw new Error("No models were returned by the local service");
  const body = asObject(await fetchJson(new URL("/api/tags", base), 8_000));
  const models = [...new Set(asArray(body.models)
    .map((item) => asString(asObject(item).name))
    .filter((item): item is string => Boolean(item)))].sort()
    .map((id) => ({ id }));
  return enrichOllamaModelCapabilities(base, models);
}

export async function openProviderLogin(providerId: string, launch: PiLaunch): Promise<void> {
  const id = providerId.trim();
  if (!validProviderId(id)) throw new Error("Invalid provider ID");
  if (id === "openai-codex") {
    await loginOpenAICodex(launch, (url) => shell.openExternal(url));
    return;
  }
  const cwd = piAgentDirectory();
  const command = process.platform === "win32"
    ? { executable: launch.executable, args: [...launch.args] }
    : { executable: "sh", args: ["-lc", `printf '\\nAgent K: enter /login ${id} in Pi to authenticate.\\n\\n'; exec \"$1\"`, "agent-k-login", launch.executable, ...launch.args] };
  const candidates: Array<{ executable: string; args: string[] }> = process.platform === "win32"
    ? [command]
    : process.platform === "darwin"
      ? [{
          executable: "/usr/bin/osascript",
          args: macTerminalLoginArguments(cwd, id, launch),
        }]
      : [
        { executable: "xdg-terminal-exec", args: [command.executable, ...command.args] },
        { executable: "konsole", args: ["--workdir", cwd, "-e", command.executable, ...command.args] },
        { executable: "gnome-terminal", args: [`--working-directory=${cwd}`, "--", command.executable, ...command.args] },
        { executable: "kitty", args: ["--directory", cwd, command.executable, ...command.args] },
        { executable: "x-terminal-emulator", args: ["-e", command.executable, ...command.args] },
        { executable: "xterm", args: ["-e", command.executable, ...command.args] },
        ];
  for (const candidate of candidates) {
    if (
      process.platform !== "win32" &&
      !existsSync(candidate.executable) &&
      !which(candidate.executable)
    ) continue;
    try {
      const child = spawn(candidate.executable, candidate.args, {
        cwd,
        detached: true,
        shell: process.platform === "win32",
        stdio: "ignore",
        windowsHide: false,
        env: { ...process.env, ...launch.environment },
      });
      child.unref();
      return;
    } catch {
      // Try the next installed terminal.
    }
  }
  throw new Error(`No supported terminal emulator was found. Run Pi and enter /login ${id}.`);
}
