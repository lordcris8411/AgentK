import assert from "node:assert/strict";
import test from "node:test";
import {
  configuredProviderModels,
  isManagedProviderOverride,
  mergedProviderModels,
} from "../.electron-dist/model-provider.js";
import {
  explicitReasoningLevels,
  explicitReasoningOffValue,
  explicitVisionSupport,
  inferModelReasoning,
  modelReasoningOffValue,
  normalizedThinkingLevelMap,
} from "../.electron-dist/model-reasoning.js";

test("provider edits preserve model metadata and keep unverified new models out of reasoning", () => {
  const models = configuredProviderModels({
    models: [{
      id: "existing-model",
      name: "Existing model",
      reasoning: false,
      input: ["text", "image"],
      thinkingLevelMap: { off: "off", high: "high" },
    }],
  }, [{ id: "existing-model" }, { id: "new-model" }]);

  assert.deepEqual(models[0], {
    id: "existing-model",
    name: "Existing model",
    reasoning: false,
    input: ["text", "image"],
    thinkingLevelMap: { off: "off", high: "high" },
  });
  assert.deepEqual(models[1], {
    id: "new-model",
    name: "new-model",
    reasoning: false,
  });
});

test("remote catalog additions augment built-in models instead of replacing them", () => {
  assert.deepEqual(mergedProviderModels([
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true },
  ], [
    { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision EXP", input: ["text", "image"] },
  ]), [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true },
    { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision EXP", input: ["text", "image"] },
  ]);
});

test("an AgentK-only catalog overlay keeps a built-in provider in its original group", () => {
  assert.equal(isManagedProviderOverride({
    models: [{ id: "deepseek-v4-flash-vision-exp" }],
  }, ["deepseek-v4-flash-vision-exp"]), true);
  assert.equal(isManagedProviderOverride({
    baseUrl: "https://proxy.example/v1",
    models: [{ id: "deepseek-v4-flash-vision-exp" }],
  }, ["deepseek-v4-flash-vision-exp"]), false);
  assert.equal(isManagedProviderOverride({
    models: [{ id: "manual-preview" }, { id: "deepseek-v4-flash-vision-exp" }],
  }, ["deepseek-v4-flash-vision-exp"]), false);
});

test("extracts only explicitly documented reasoning levels", () => {
  assert.deepEqual(
    explicitReasoningLevels("Unexpected reasoning effort: high. Supported reasoning types are xhigh (default), medium, and low."),
    ["low", "medium", "xhigh"],
  );
  assert.deepEqual(explicitReasoningLevels("This is a high quality reasoning model."), []);
  assert.deepEqual(explicitReasoningLevels("Benchmark quality is high."), []);
});

test("preserves the provider's disabled-reasoning wire value", () => {
  assert.equal(
    explicitReasoningOffValue("Supported reasoning effort values: none, low, medium, and high."),
    "none",
  );
  assert.equal(modelReasoningOffValue("Qwen/Qwen3.8-27B"), "none");
  assert.equal(modelReasoningOffValue("Qwen/Qwen3.2-27B"), "off");
  assert.deepEqual(
    normalizedThinkingLevelMap("Qwen3.8-27B", { off: "off", high: "high" }),
    { off: "none", high: "high" },
  );
});

test("detects explicit image-input support without confusing image generation", () => {
  assert.equal(explicitVisionSupport("This multimodal model supports text and image input."), true);
  assert.equal(explicitVisionSupport("A text-to-image generation model."), false);
  assert.equal(explicitVisionSupport("This model supports image generation from text prompts."), false);
  assert.equal(explicitVisionSupport("", "Qwen2.5-VL-7B-Instruct"), true);
});

test("infers a per-model reasoning map from a public model card", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "hf.test" && url.pathname === "/api/models")
      return Response.json([{ id: "Qwen/Qwen3.8-27B" }]);
    if (url.hostname === "hf.test" && url.pathname.endsWith("/README.md"))
      return new Response("Supported reasoning effort values: xhigh (default), medium, and low.");
    if (url.hostname === "ms.test") return Response.json({ Data: { Models: [] } });
    return new Response("", { status: 404 });
  };
  const profiles = await inferModelReasoning(["Qwen3.8-27B-FP8"], {
    fetchImpl,
    huggingFaceBaseUrl: "https://hf.test",
    modelScopeBaseUrl: "https://ms.test",
  });

  assert.deepEqual(profiles, [{
    modelId: "Qwen3.8-27B-FP8",
    reasoning: true,
    input: ["text"],
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: null,
      xhigh: "xhigh",
      max: null,
    },
    assessment: {
      source: "rules",
      repository: "Qwen/Qwen3.8-27B",
      evidence: "Explicit levels: low, medium, xhigh",
    },
  }]);
});

test("keeps reasoning disabled when public sources do not establish support", async () => {
  const profiles = await inferModelReasoning(["unknown-model"], {
    fetchImpl: async () => Response.json({ data: [], Data: { Models: [] } }),
    huggingFaceBaseUrl: "https://hf.test",
    modelScopeBaseUrl: "https://ms.test",
  });
  assert.deepEqual(profiles, [{
    modelId: "unknown-model",
    reasoning: false,
    input: ["text"],
    assessment: { source: "unverified", repository: undefined },
  }]);
});

test("infers image input from a public multimodal model card", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "hf.test" && url.pathname === "/api/models")
      return Response.json([{ id: "org/vision-model" }]);
    if (url.hostname === "hf.test" && url.pathname.endsWith("/README.md"))
      return new Response("This multimodal model supports image input and visual question answering.");
    if (url.hostname === "ms.test") return Response.json({ Data: { Models: [] } });
    return new Response("", { status: 404 });
  };
  const profiles = await inferModelReasoning(["vision-model"], {
    fetchImpl,
    huggingFaceBaseUrl: "https://hf.test",
    modelScopeBaseUrl: "https://ms.test",
  });

  assert.deepEqual(profiles, [{
    modelId: "vision-model",
    reasoning: false,
    input: ["text", "image"],
    assessment: {
      source: "rules",
      repository: "org/vision-model",
      evidence: "Explicit image input support",
    },
  }]);
});

test("recognizes a known vision-family model ID even when hubs return no card", async () => {
  const profiles = await inferModelReasoning(["qwen2.5vl:7b"], {
    fetchImpl: async () => Response.json({ data: [], Data: { Models: [] } }),
    huggingFaceBaseUrl: "https://hf.test",
    modelScopeBaseUrl: "https://ms.test",
  });
  assert.deepEqual(profiles[0].input, ["text", "image"]);
  assert.equal(profiles[0].assessment.source, "rules");
});
