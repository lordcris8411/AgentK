import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverProviderModels,
  mergeDeepSeekModels,
  mergeRemoteProviderModels,
  providerCatalogTargets,
} from "../.electron-dist/remote-model-catalog.js";

const available = {
  models: [{
    provider: "deepseek",
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    reasoning: true,
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    compat: { supportsDeveloperRole: false, thinkingFormat: "deepseek" },
    thinkingLevelMap: { off: "off", high: "high", max: "max" },
  }],
};

test("adds remote-only DeepSeek models beside the bundled catalog", () => {
  const merged = mergeDeepSeekModels(
    { providers: {} },
    { providers: {} },
    ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"],
    available,
  );

  assert.equal(merged.changed, true);
  assert.deepEqual(merged.state, {
    providers: { deepseek: ["deepseek-v4-flash-vision-exp"] },
  });
  assert.deepEqual(merged.modelsRoot.providers.deepseek.models, [{
    id: "deepseek-v4-flash-vision-exp",
    name: "DeepSeek V4 Flash Vision EXP",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    compat: { supportsDeveloperRole: false, thinkingFormat: "deepseek" },
    thinkingLevelMap: { off: "off", high: "high", max: "max" },
  }]);
});

test("removes retired managed models without touching manual models", () => {
  const merged = mergeDeepSeekModels(
    { providers: { deepseek: { models: [
      { id: "manual-preview", reasoning: false },
      { id: "retired-preview", reasoning: true },
    ] } } },
    { providers: { deepseek: ["retired-preview"] } },
    ["deepseek-v4-flash"],
    available,
  );

  assert.deepEqual(merged.modelsRoot.providers.deepseek.models, [
    { id: "manual-preview", reasoning: false },
  ]);
  assert.deepEqual(merged.state, { providers: {} });
});

test("keeps managed remote models stable across consecutive refreshes", () => {
  const modelsRoot = { providers: { deepseek: { models: [{
    id: "deepseek-v4-flash-vision-exp",
    name: "DeepSeek V4 Flash Vision EXP",
    reasoning: true,
    input: ["text", "image"],
  }] } } };
  const state = { providers: { deepseek: ["deepseek-v4-flash-vision-exp"] } };
  const refreshedAvailable = { models: [
    ...available.models,
    {
      provider: "deepseek",
      id: "deepseek-v4-flash-vision-exp",
      name: "DeepSeek V4 Flash Vision EXP",
      reasoning: true,
      input: ["text", "image"],
    },
  ] };
  const merged = mergeDeepSeekModels(
    modelsRoot,
    state,
    ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"],
    refreshedAvailable,
  );

  assert.equal(merged.changed, false);
  assert.deepEqual(merged.modelsRoot, modelsRoot);
  assert.deepEqual(merged.state, state);
});

test("merges remote additions for providers other than DeepSeek", () => {
  const googleAvailable = { models: [{
    provider: "google",
    id: "gemini-3.5-flash",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
  }] };
  const merged = mergeRemoteProviderModels(
    { providers: {} },
    { providers: {} },
    "google",
    [{ id: "gemini-3.7-flash", name: "Gemini 3.7 Flash", contextWindow: 2_000_000, input: ["text", "image"] }],
    googleAvailable,
  );

  assert.deepEqual(merged.state, { providers: { google: ["gemini-3.7-flash"] } });
  assert.deepEqual(merged.modelsRoot.providers.google.models, [{
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 2_000_000,
  }]);
});

test("discovers OpenAI-compatible provider models with bearer authentication", async () => {
  const calls = [];
  const models = await discoverProviderModels({
    id: "groq",
    api: "openai-completions",
    baseUrl: "https://api.groq.test/openai/v1",
    key: "secret",
  }, async (input, init) => {
    calls.push({ url: String(input), headers: init.headers });
    return Response.json({ data: [
      { id: "new-groq-model" },
      { id: "whisper-large-v3" },
      { id: "text-embedding-4" },
    ] });
  });

  assert.deepEqual(models, [{ id: "new-groq-model", input: ["text"] }]);
  assert.deepEqual(calls, [{
    url: "https://api.groq.test/openai/v1/models",
    headers: { Accept: "application/json", Authorization: "Bearer secret" },
  }]);
});

test("discovers only Gemini generation models with Google metadata", async () => {
  const calls = [];
  const models = await discoverProviderModels({
    id: "google",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    key: "gemini-secret",
  }, async (input, init) => {
    calls.push({ url: String(input), headers: init.headers });
    return Response.json({ models: [
      {
        name: "models/gemini-3.7-flash",
        baseModelId: "gemini-3.7-flash",
        displayName: "Gemini 3.7 Flash",
        description: "Multimodal Gemini model",
        inputTokenLimit: 2_000_000,
        supportedGenerationMethods: ["generateContent"],
      },
      {
        name: "models/gemini-embedding-002",
        supportedGenerationMethods: ["embedContent"],
      },
    ] });
  });

  assert.deepEqual(models, [{
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    contextWindow: 2_000_000,
    input: ["text", "image"],
  }]);
  assert.deepEqual(calls, [{
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    headers: { Accept: "application/json", "x-goog-api-key": "gemini-secret" },
  }]);
});

test("refresh targets every configured catalog provider and skips unsupported OAuth runtimes", () => {
  const targets = providerCatalogTargets({ models: [
    { provider: "deepseek", id: "deepseek-v4-flash", api: "openai-completions", baseUrl: "https://api.deepseek.com" },
    { provider: "google", id: "gemini-3.5-flash", api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
    { provider: "openai-codex", id: "gpt-5.6-codex", api: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex" },
  ] }, {
    deepseek: { type: "api_key", key: "deepseek-secret" },
    google: { type: "api_key", key: "google-secret" },
    "openai-codex": { type: "oauth", access: "oauth-secret" },
  }, {
    vllm: { baseUrl: "http://127.0.0.1:8000/v1", api: "openai-completions", apiKey: "local" },
  });

  assert.deepEqual(targets, [
    { id: "deepseek", baseUrl: "https://api.deepseek.com", api: "openai-completions", key: "deepseek-secret" },
    { id: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "google-generative-ai", key: "google-secret" },
    { id: "vllm", baseUrl: "http://127.0.0.1:8000/v1", api: "openai-completions", key: "local" },
  ]);
});
