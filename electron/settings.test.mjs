import assert from "node:assert/strict";
import test from "node:test";
import { discoveredModels, localModelsEndpoint } from "../.electron-dist/model-discovery.js";
import { macTerminalLoginArguments } from "../.electron-dist/provider-login.js";

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

test("keeps the OpenAI API path when the base URL has no trailing slash", () => {
  assert.equal(localModelsEndpoint("http://localhost:8000/v1").toString(), "http://localhost:8000/v1/models");
  assert.equal(localModelsEndpoint("http://localhost:8000/v1/").toString(), "http://localhost:8000/v1/models");
  assert.equal(localModelsEndpoint("http://localhost:8000").toString(), "http://localhost:8000/v1/models");
});

test("macOS provider login launches bundled Pi through Terminal with quoted arguments", () => {
  const executable = "/Applications/Agent K.app/Contents/MacOS/Agent K";
  const cli = "/Applications/Agent K.app/Contents/Resources/pi runtime/cli.js";
  const args = macTerminalLoginArguments(
    "/Users/Example User",
    "anthropic",
    {
      executable,
      args: [cli],
      environment: { ELECTRON_RUN_AS_NODE: "1" },
    },
  );

  assert.ok(args.some((argument) =>
    argument.includes("quoted form of (item 1 of argv as text)"),
  ));
  assert.ok(args.some((argument) =>
    argument.includes("printf '\\nAgent K: enter /login %s"),
  ));
  assert.equal(args.includes(executable), true);
  assert.deepEqual(args.slice(-7), [
    "--",
    "/Users/Example User",
    "anthropic",
    "/usr/bin/env",
    "ELECTRON_RUN_AS_NODE=1",
    executable,
    cli,
  ]);
});
