import assert from "node:assert/strict";
import test from "node:test";
import { configuredProviderModels } from "../.electron-dist/model-provider.js";

test("provider edits preserve model metadata and default new models to reasoning", () => {
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
    reasoning: true,
  });
});
