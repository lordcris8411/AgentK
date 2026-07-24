import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { shell } from "electron";
import type { PiLaunch } from "./pi-runtime.js";
import type { ClientSettings, JsonObject } from "./types.js";
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
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  models: string[];
  local: boolean;
}

const DEFAULT_SETTINGS: ClientSettings = {
  version: 6,
  theme: "light",
  locale: "zh-CN",
  permissionMode: "ask",
  browserId: "default",
  piExecutable: "",
  codexExecutable: "",
  piEnabled: true,
  codexEnabled: false,
  defaultBackend: "pi",
  workerPoolSize: 4,
  autoCompactEnabled: true,
  autoCompactThreshold: 45,
  autoCompactPrompt: "",
  editorWordWrap: false,
  disabledFileEditors: [],
  disabledFileEditorSkills: [],
  leftPanelWidth: 304,
  rightPanelWidth: 420,
  leftPanelHidden: false,
  rightPanelHidden: false,
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
  if (["light", "dark", "system"].includes(String(source.theme)))
    settings.theme = source.theme as ClientSettings["theme"];
  if (["zh-CN", "en-US"].includes(String(source.locale)))
    settings.locale = source.locale as ClientSettings["locale"];
  if (["ask", "full"].includes(String(source.permissionMode)))
    settings.permissionMode = source.permissionMode as ClientSettings["permissionMode"];
  if (safeBrowserId(source.browserId)) settings.browserId = source.browserId;
  if (typeof source.piExecutable === "string" && source.piExecutable.length <= 4096)
    settings.piExecutable = source.piExecutable.trim();
  if (typeof source.codexExecutable === "string" && source.codexExecutable.length <= 4096)
    settings.codexExecutable = source.codexExecutable.trim();
  if (typeof source.piEnabled === "boolean") settings.piEnabled = source.piEnabled;
  if (typeof source.codexEnabled === "boolean") settings.codexEnabled = source.codexEnabled;
  if (["pi", "codex"].includes(String(source.defaultBackend)))
    settings.defaultBackend = source.defaultBackend as ClientSettings["defaultBackend"];
  if (!settings.piEnabled && !settings.codexEnabled) settings.piEnabled = true;
  if (settings.defaultBackend === "pi" && !settings.piEnabled) settings.defaultBackend = "codex";
  if (settings.defaultBackend === "codex" && !settings.codexEnabled) settings.defaultBackend = "pi";
  if ([2, 3, 4].includes(Number(source.workerPoolSize)))
    settings.workerPoolSize = Number(source.workerPoolSize) as 2 | 3 | 4;
  if (typeof source.autoCompactEnabled === "boolean")
    settings.autoCompactEnabled = source.autoCompactEnabled;
  if (Number(source.autoCompactThreshold) >= 40 && Number(source.autoCompactThreshold) <= 90)
    settings.autoCompactThreshold = Math.round(Number(source.autoCompactThreshold));
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
  if (Number(source.leftPanelWidth) >= 240 && Number(source.leftPanelWidth) <= 2400)
    settings.leftPanelWidth = Number(source.leftPanelWidth);
  if (Number(source.rightPanelWidth) >= 420 && Number(source.rightPanelWidth) <= 3200)
    settings.rightPanelWidth = Number(source.rightPanelWidth);
  if (typeof source.leftPanelHidden === "boolean")
    settings.leftPanelHidden = source.leftPanelHidden;
  if (typeof source.rightPanelHidden === "boolean")
    settings.rightPanelHidden = source.rightPanelHidden;
  if (Number(source.windowWidth) >= 1452 && Number(source.windowWidth) <= 16384)
    settings.windowWidth = Number(source.windowWidth);
  if (Number(source.windowHeight) >= 640 && Number(source.windowHeight) <= 16384)
    settings.windowHeight = Number(source.windowHeight);
  if (typeof source.windowMaximized === "boolean")
    settings.windowMaximized = source.windowMaximized;
  settings.version = Math.max(7, Number(source.version) || 7);
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
    settings.piExecutable === original.piExecutable &&
    settings.codexExecutable === original.codexExecutable &&
    settings.piEnabled === original.piEnabled &&
    settings.codexEnabled === original.codexEnabled &&
    settings.defaultBackend === original.defaultBackend &&
    settings.workerPoolSize === original.workerPoolSize &&
    settings.autoCompactEnabled === original.autoCompactEnabled &&
    settings.autoCompactThreshold === original.autoCompactThreshold &&
    settings.autoCompactPrompt === original.autoCompactPrompt &&
    settings.editorWordWrap === original.editorWordWrap &&
    sameStringArray(original.disabledFileEditors, settings.disabledFileEditors) &&
    sameStringArray(original.disabledFileEditorSkills, settings.disabledFileEditorSkills) &&
    settings.leftPanelWidth === original.leftPanelWidth &&
    settings.rightPanelWidth === original.rightPanelWidth &&
    settings.leftPanelHidden === original.leftPanelHidden &&
    settings.rightPanelHidden === original.rightPanelHidden &&
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
  if (!validProviderId(id))
    throw new Error("Provider ID may contain only letters, numbers, - and _");
  new URL(provider.baseUrl);
  if (!provider.models.length || provider.models.some((model) => !model.trim()))
    throw new Error("At least one model ID is required");
  const directory = piAgentDirectory();
  await mkdir(directory, { recursive: true });
  const path = join(directory, "models.json");
  const root = await jsonObject(path);
  const providers = asObject(root.providers);
  providers[id] = {
    name: provider.name.trim() || id,
    baseUrl: provider.baseUrl.trim(),
    api: provider.api,
    models: provider.models.map((model) => ({ id: model.trim(), name: model.trim() })),
    ...(provider.local
      ? { apiKey: provider.id === "ollama" ? "ollama" : "local" }
      : {}),
  };
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
    models.push({ id, ...(typeof model.name === "string" ? { name: model.name } : {}) });
    modelsByProvider.set(provider, models);
  }
  const directory = piAgentDirectory();
  const auth = await jsonObject(join(directory, "auth.json"));
  const custom = asObject((await jsonObject(join(directory, "models.json"))).providers);
  const catalog: JsonObject[] = BUILTIN_PROVIDERS.map(([id, name, apiKey, oauth]) => {
    const value = asObject(custom[id]);
    const configuredModels = asArray(value.models).map(asObject).filter((model) => typeof model.id === "string");
    const result: JsonObject = {
      id,
      name: asString(value.name) ?? name,
      source: Object.hasOwn(custom, id) ? "custom" : "builtin",
      configured: Object.hasOwn(auth, id) || modelsByProvider.has(id),
      authMethods: [apiKey ? "api_key" : undefined, oauth ? "oauth" : undefined].filter(Boolean),
      models: configuredModels.length ? configuredModels : modelsByProvider.get(id) ?? [],
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

export async function discoverLocalModels(baseUrl: string, ollama: boolean): Promise<string[]> {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol))
    throw new Error("Only HTTP(S) model services are supported");
  const isOllama = ollama || (await detectLocalService(baseUrl)).kind === "ollama";
  const modelsUrl = new URL(base.pathname.replace(/\/$/, "").endsWith("/v1") ? "models" : "v1/models", base);
  try {
    const body = asObject(await fetchJson(modelsUrl, 8_000));
    const models = asArray(body.data)
      .map((item) => asString(asObject(item).id))
      .filter((item): item is string => Boolean(item));
    if (models.length) return [...new Set(models)].sort();
  } catch {
    // Ollama has a separate model-list endpoint.
  }
  if (!isOllama) throw new Error("No models were returned by the local service");
  const body = asObject(await fetchJson(new URL("/api/tags", base), 8_000));
  return [...new Set(asArray(body.models)
    .map((item) => asString(asObject(item).name))
    .filter((item): item is string => Boolean(item)))].sort();
}

export function openProviderLogin(providerId: string, launch: PiLaunch): void {
  const id = providerId.trim();
  if (!validProviderId(id)) throw new Error("Invalid provider ID");
  const cwd = piAgentDirectory();
  const command = process.platform === "win32"
    ? { executable: launch.executable, args: [...launch.args] }
    : { executable: "sh", args: ["-lc", `printf '\\nAgent K: enter /login ${id} in Pi to authenticate.\\n\\n'; exec \"$1\"`, "agent-k-login", launch.executable, ...launch.args] };
  const candidates: Array<{ executable: string; args: string[] }> = process.platform === "win32"
    ? [command]
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
