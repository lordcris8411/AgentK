import assert from "node:assert/strict";
import test from "node:test";
import { modelIsEnabled, modelKey } from "../src/lib/modelAvailability.ts";

test("provider availability controls all of its models", () => {
  const settings = {
    disabledModelProviders: ["local"],
    disabledModels: [],
  };

  assert.equal(modelIsEnabled(settings, "local", "coder"), false);
  assert.equal(modelIsEnabled(settings, "remote", "coder"), true);
});

test("model availability is independent within an enabled provider", () => {
  const settings = {
    disabledModelProviders: [],
    disabledModels: [modelKey("local", "coder/v2")],
  };

  assert.equal(modelIsEnabled(settings, "local", "coder/v2"), false);
  assert.equal(modelIsEnabled(settings, "local", "vision/v2"), true);
});

test("same model ID remains independent across providers", () => {
  const settings = {
    disabledModelProviders: ["openai"],
    disabledModels: [modelKey("openai", "gpt-5.4")],
  };

  assert.equal(modelIsEnabled(settings, "openai", "gpt-5.4"), false);
  assert.equal(modelIsEnabled(settings, "openai-codex", "gpt-5.4"), true);
});
