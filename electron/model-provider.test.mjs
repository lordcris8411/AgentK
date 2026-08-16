import assert from "node:assert/strict";
import test from "node:test";
import { configuredProviderModels } from "../.electron-dist/model-provider.js";
import { explicitReasoningLevels, inferModelReasoning } from "../.electron-dist/model-reasoning.js";

test("provider edits preserve model metadata and keep unverified new models out of reasoning", () => {
  const models = configuredProviderModels({
    models: [{
      id: "existing-model",
      name: "Existing model",
      reasoning: false,
      thinkingLevelMap: { off: "off", high: "high" },
    }],
  }, [{ id: "existing-model" }, { id: "new-model" }]);

  assert.deepEqual(models[0], {
    id: "existing-model",
    name: "Existing model",
    reasoning: false,
    thinkingLevelMap: { off: "off", high: "high" },
  });
  assert.deepEqual(models[1], {
    id: "new-model",
    name: "new-model",
    reasoning: false,
  });
});

test("extracts only explicitly documented reasoning levels", () => {
  assert.deepEqual(
    explicitReasoningLevels("Unexpected reasoning effort: high. Supported reasoning types are xhigh (default), medium, and low."),
    ["low", "medium", "xhigh"],
  );
  assert.deepEqual(explicitReasoningLevels("This is a high quality reasoning model."), []);
  assert.deepEqual(explicitReasoningLevels("Benchmark quality is high."), []);
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
    thinkingLevelMap: {
      off: "off",
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
    assessment: { source: "unverified", repository: undefined },
  }]);
});
