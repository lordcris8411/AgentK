import assert from "node:assert/strict";
import test from "node:test";
import { discoveredModels } from "../.electron-dist/model-discovery.js";

test("preserves vLLM's reported max model length when discovering models", () => {
  assert.deepEqual(discoveredModels({
    data: [
      { id: "vllm-model", max_model_len: 524288 },
      { id: "standard-model" },
    ],
  }), [
    { id: "vllm-model", contextWindow: 524288 },
    { id: "standard-model" },
  ]);
});
