import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderModelDraft } from "./model-discovery.js";
import { discoveredModels, localModelsEndpoint } from "./model-discovery.js";
import type { JsonObject } from "./types.js";
import { asArray, asObject, asString, atomicWrite, piAgentDirectory, readJson } from "./utils.js";

const DISCOVERY_STATE_FILE = "agent-k-model-catalog.json";
const UNSUPPORTED_DYNAMIC_PROVIDERS = new Set([
  "amazon-bedrock", "azure-openai-responses", "cloudflare-ai-gateway",
  "cloudflare-workers-ai", "github-copilot", "google-vertex", "openai-codex",
  "radius", "vercel-ai-gateway",
]);
const API_KEY_ENVIRONMENT: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
};

export type ProviderCatalogTarget = {
  api: string;
  baseUrl: string;
  id: string;
  key?: string;
};

export async function remoteProviderModelState(): Promise<JsonObject> {
  return asObject(asObject(
    await readJson(join(piAgentDirectory(), DISCOVERY_STATE_FILE), { providers: {} }),
  ).providers);
}

function modelDisplayName(id: string): string {
  return id
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part.toLowerCase() === "deepseek"
      ? "DeepSeek"
      : /^(v\d|exp$)/iu.test(part)
        ? part.toUpperCase()
        : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function modelTokens(id: string): Set<string> {
  return new Set(id.toLowerCase().split(/[^a-z0-9]+/u).filter((part) => part.length > 1));
}

function compatibleRemoteModel(
  providerId: string,
  remote: ProviderModelDraft,
  available: unknown,
): JsonObject {
  const models = asArray(asObject(available).models).map(asObject)
    .filter((model) => asString(model.provider) === providerId);
  const wanted = modelTokens(remote.id);
  const matched = models
    .map((model) => ({
      model,
      score: [...modelTokens(asString(model.id) ?? "")].filter((token) => wanted.has(token)).length,
    }))
    .sort((left, right) => right.score - left.score)[0];
  const template = matched?.model ?? {};
  const compatibleTemplate = (matched?.score ?? 0) > 0;
  const inferredVision = /vision|(?:^|[-_/])vl(?:[-_/]|$)/iu.test(remote.id);
  const templateInput = compatibleTemplate
    ? asArray(template.input).filter((input): input is "text" | "image" =>
        input === "text" || input === "image",
      )
    : [];
  const input = remote.input?.includes("image") || inferredVision
    ? ["text", "image"] as Array<"text" | "image">
    : templateInput.length ? templateInput : ["text"];
  return {
    id: remote.id,
    name: remote.name?.trim() || modelDisplayName(remote.id),
    ...(typeof template.api === "string" ? { api: template.api } : {}),
    ...(typeof template.baseUrl === "string" ? { baseUrl: template.baseUrl } : {}),
    reasoning: typeof remote.reasoning === "boolean"
      ? remote.reasoning
      : compatibleTemplate && typeof template.reasoning === "boolean" ? template.reasoning : false,
    input,
    ...(remote.contextWindow !== undefined
      ? { contextWindow: remote.contextWindow }
      : compatibleTemplate && typeof template.contextWindow === "number" ? { contextWindow: template.contextWindow } : {}),
    ...(compatibleTemplate && typeof template.maxTokens === "number" ? { maxTokens: template.maxTokens } : {}),
    ...(compatibleTemplate && Object.keys(asObject(template.compat)).length ? { compat: asObject(template.compat) } : {}),
    ...(compatibleTemplate && Object.keys(asObject(template.thinkingLevelMap)).length
      ? { thinkingLevelMap: asObject(template.thinkingLevelMap) }
      : {}),
  };
}

export function mergeRemoteProviderModels(
  modelsRootValue: unknown,
  stateValue: unknown,
  providerId: string,
  remoteModels: ProviderModelDraft[],
  available: unknown,
): { modelsRoot: JsonObject; state: JsonObject; changed: boolean } {
  const modelsRoot = structuredClone(asObject(modelsRootValue));
  const providers = asObject(modelsRoot.providers);
  const provider = asObject(providers[providerId]);
  const state = structuredClone(asObject(stateValue));
  const stateProviders = asObject(state.providers);
  const previouslyManaged = new Set(
    asArray(stateProviders[providerId]).filter((id): id is string => typeof id === "string"),
  );
  const runtimeIds = new Set(asArray(asObject(available).models).flatMap((value) => {
    const model = asObject(value);
    const id = asString(model.id);
    // A model synchronized on the previous refresh is now visible through Pi,
    // but it is still AgentK-managed rather than part of Pi's bundled catalog.
    return asString(model.provider) === providerId && id && !previouslyManaged.has(id) ? [id] : [];
  }));
  const existingModels = asArray(provider.models).map(asObject);
  const manualModels = existingModels.filter((model) => {
    const id = asString(model.id);
    return Boolean(id && !previouslyManaged.has(id));
  });
  const manualIds = new Set(manualModels.flatMap((model) => asString(model.id) ?? []));
  const managedModels = [...new Map(remoteModels.map((model) => [model.id.trim(), model])).values()]
    .filter((model) => model.id && !runtimeIds.has(model.id) && !manualIds.has(model.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const managedIds = managedModels.map((model) => model.id);
  const nextModels = [
    ...manualModels,
    ...managedModels.map((model) => compatibleRemoteModel(providerId, model, available)),
  ];

  if (nextModels.length) {
    providers[providerId] = { ...provider, models: nextModels };
  } else if (Object.keys(provider).length) {
    const { models: _models, ...rest } = provider;
    if (Object.keys(rest).length) providers[providerId] = rest;
    else delete providers[providerId];
  }
  modelsRoot.providers = providers;
  if (managedIds.length) stateProviders[providerId] = managedIds;
  else delete stateProviders[providerId];
  state.providers = stateProviders;

  return {
    modelsRoot,
    state,
    changed: JSON.stringify(modelsRoot) !== JSON.stringify(asObject(modelsRootValue))
      || JSON.stringify(state) !== JSON.stringify(asObject(stateValue)),
  };
}

export function mergeDeepSeekModels(
  modelsRootValue: unknown,
  stateValue: unknown,
  remoteModelIds: string[],
  available: unknown,
): { modelsRoot: JsonObject; state: JsonObject; changed: boolean } {
  return mergeRemoteProviderModels(
    modelsRootValue,
    stateValue,
    "deepseek",
    remoteModelIds.map((id) => ({
      id,
      input: /vision|vl(?:-|$)/iu.test(id) ? ["text", "image"] : ["text"],
    })),
    available,
  );
}

function configuredKey(providerId: string, credentialValue: unknown, providerValue: unknown): string | undefined {
  const credential = asObject(credentialValue);
  if (credential.type === "oauth") return undefined;
  const stored = asString(credential.key) ?? asString(credential.apiKey);
  if (stored) return stored;
  const configured = asString(asObject(providerValue).apiKey);
  if (configured?.startsWith("$") && !configured.startsWith("$$")) {
    const environmentName = configured.replace(/^\$\{?/u, "").replace(/\}$/u, "");
    return process.env[environmentName];
  }
  if (configured && !configured.startsWith("!")) return configured;
  for (const name of API_KEY_ENVIRONMENT[providerId] ?? [`${providerId.toUpperCase().replace(/-/gu, "_")}_API_KEY`]) {
    if (process.env[name]) return process.env[name];
  }
  return undefined;
}

export function providerCatalogTargets(available: unknown, auth: JsonObject, custom: JsonObject): ProviderCatalogTarget[] {
  const firstModelByProvider = new Map<string, JsonObject>();
  for (const value of asArray(asObject(available).models)) {
    const model = asObject(value);
    const providerId = asString(model.provider);
    if (providerId && !firstModelByProvider.has(providerId)) firstModelByProvider.set(providerId, model);
  }
  const ids = new Set([...Object.keys(auth), ...Object.keys(custom), ...firstModelByProvider.keys()]);
  return [...ids].flatMap((id) => {
    if (UNSUPPORTED_DYNAMIC_PROVIDERS.has(id)) return [];
    const provider = asObject(custom[id]);
    const model = firstModelByProvider.get(id) ?? {};
    const baseUrl = asString(provider.baseUrl) ?? asString(model.baseUrl);
    const api = asString(provider.api) ?? asString(model.api);
    if (!baseUrl || !api) return [];
    let url: URL;
    try { url = new URL(baseUrl); } catch { return []; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return [];
    const key = configuredKey(id, auth[id], provider);
    const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (!key && !local) return [];
    return [{ id, baseUrl, api, ...(key ? { key } : {}) }];
  });
}

function googleModels(value: unknown): ProviderModelDraft[] {
  return asArray(asObject(value).models).flatMap((entry) => {
    const model = asObject(entry);
    const methods = asArray(model.supportedGenerationMethods);
    if (methods.length && !methods.includes("generateContent")) return [];
    const id = asString(model.baseModelId) ?? asString(model.name)?.replace(/^models\//u, "");
    if (!id) return [];
    const contextWindow = Number(model.inputTokenLimit);
    return [{
      id,
      ...(asString(model.displayName) ? { name: asString(model.displayName) } : {}),
      ...(Number.isInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
      input: /image|vision|gemini/iu.test(`${id} ${asString(model.description) ?? ""}`)
        ? ["text", "image"] : ["text"],
    }];
  });
}

function conversationModels(models: ProviderModelDraft[]): ProviderModelDraft[] {
  return models.filter((model) => !/(?:^|[-_/])(embedding|embed|moderation|whisper|tts|speech|transcri(?:be|ption)|dall-e|image-gen|realtime)(?:[-_/]|$)/iu.test(model.id));
}

function catalogRequest(target: ProviderCatalogTarget): { headers: Record<string, string>; url: URL } {
  const base = new URL(target.baseUrl);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (target.id === "google" || target.api === "google-generative-ai") {
    base.pathname = `${base.pathname.replace(/\/+$/u, "")}/models`;
    base.searchParams.set("pageSize", "1000");
    if (target.key) headers["x-goog-api-key"] = target.key;
    return { headers, url: base };
  }
  if (target.id === "deepseek") {
    base.pathname = `${base.pathname.replace(/\/+$/u, "")}/models`;
  } else {
    base.href = localModelsEndpoint(target.baseUrl).href;
  }
  if (target.id === "anthropic") base.searchParams.set("limit", "1000");
  if (target.key) {
    if (target.id === "anthropic" || target.api === "anthropic-messages") {
      headers["x-api-key"] = target.key;
      headers["anthropic-version"] = "2023-06-01";
    } else headers.Authorization = `Bearer ${target.key}`;
  }
  return { headers, url: base };
}

export async function discoverProviderModels(
  target: ProviderCatalogTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderModelDraft[]> {
  const request = catalogRequest(target);
  const response = await fetchImpl(request.url, {
    headers: request.headers,
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`${target.id}: model catalog request failed (${response.status})`);
  const body = await response.json();
  const models = target.id === "google" || target.api === "google-generative-ai"
    ? googleModels(body)
    : conversationModels(discoveredModels(body));
  if (!models.length) throw new Error(`${target.id}: model catalog was empty or incompatible`);
  return models;
}

export async function syncRemoteProviderModels(
  available: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<{ changed: boolean; errors: string[]; providers: string[] }> {
  const directory = piAgentDirectory();
  const auth = asObject(await readJson(join(directory, "auth.json"), {}));
  const modelsPath = join(directory, "models.json");
  const statePath = join(directory, DISCOVERY_STATE_FILE);
  let modelsRoot: unknown = await readJson(modelsPath, { providers: {} });
  let state: unknown = await readJson(statePath, { providers: {} });
  const custom = asObject(asObject(modelsRoot).providers);
  const targets = providerCatalogTargets(available, auth, custom);
  const results = await Promise.allSettled(targets.map(async (target) => ({
    id: target.id,
    models: await discoverProviderModels(target, fetchImpl),
  })));
  const errors: string[] = [];
  const providers: string[] = [];
  let changed = false;
  for (const result of results) {
    if (result.status === "rejected") {
      errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
      continue;
    }
    providers.push(result.value.id);
    const merged = mergeRemoteProviderModels(modelsRoot, state, result.value.id, result.value.models, available);
    modelsRoot = merged.modelsRoot;
    state = merged.state;
    changed ||= merged.changed;
  }
  if (changed) {
    await mkdir(directory, { recursive: true });
    await atomicWrite(statePath, JSON.stringify(state, null, 2));
    await atomicWrite(modelsPath, JSON.stringify(modelsRoot, null, 2));
  }
  return { changed, errors, providers };
}
