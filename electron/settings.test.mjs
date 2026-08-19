import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { discoveredModels, enrichOllamaModelCapabilities, localModelsEndpoint } from "../.electron-dist/model-discovery.js";
import { macTerminalLoginArguments, piModelRuntimeEntry, runOpenAICodexLogin } from "../.electron-dist/provider-login.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

test("preserves vLLM's reported max model length when discovering models", () => {
  assert.deepEqual(discoveredModels({
    data: [
      { id: "vllm-model", max_model_len: 524288 },
      { id: "standard-model" },
    ],
  }), [
    { id: "vllm-model", contextWindow: 524288, input: ["text"] },
    { id: "standard-model", input: ["text"] },
  ]);
});

test("preserves image capabilities reported by an OpenAI-compatible server", () => {
  assert.deepEqual(discoveredModels({
    data: [
      { id: "vision-a", modalities: ["text", "image"] },
      { id: "vision-b", capabilities: { vision: true } },
    ],
  }), [
    { id: "vision-a", input: ["text", "image"] },
    { id: "vision-b", input: ["text", "image"] },
  ]);
});

test("keeps the OpenAI API path when the base URL has no trailing slash", () => {
  assert.equal(localModelsEndpoint("http://localhost:8000/v1").toString(), "http://localhost:8000/v1/models");
  assert.equal(localModelsEndpoint("http://localhost:8000/v1/").toString(), "http://localhost:8000/v1/models");
  assert.equal(localModelsEndpoint("http://localhost:8000").toString(), "http://localhost:8000/v1/models");
});

test("reads Ollama's declared vision capability for each installed model", async () => {
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/") { response.end("Ollama is running"); return; }
    if (request.url === "/v1/models") { response.end(JSON.stringify({ data: [{ id: "gemma3:4b" }] })); return; }
    if (request.url === "/api/show") {
      let body = "";
      for await (const chunk of request) body += chunk;
      assert.equal(JSON.parse(body).model, "gemma3:4b");
      response.end(JSON.stringify({ capabilities: ["completion", "vision"] }));
      return;
    }
    response.statusCode = 404; response.end();
  });
  const port = await listen(server);
  try {
    assert.deepEqual(await enrichOllamaModelCapabilities(new URL(`http://127.0.0.1:${port}/v1`), [{ id: "gemma3:4b", input: ["text"] }]), [
      { id: "gemma3:4b", input: ["text", "image"] },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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

test("OpenAI OAuth resolves the bundled model runtime and opens browser login directly", async () => {
  assert.equal(
    piModelRuntimeEntry({ executable: "electron.exe", args: ["C:\\runtime\\pi-coding-agent\\dist\\cli.js"] }),
    "C:\\runtime\\pi-coding-agent\\dist\\index.js",
  );
  const opened = [];
  const runtime = {
    async login(providerId, type, interaction) {
      assert.equal(providerId, "openai-codex");
      assert.equal(type, "oauth");
      assert.equal(await interaction.prompt({ type: "select", message: "method", options: [{ id: "browser", label: "Browser" }] }), "browser");
      interaction.notify({ type: "auth_url", url: "https://auth.openai.com/oauth/authorize" });
    },
  };
  await runOpenAICodexLogin(runtime, async (url) => { opened.push(url); });
  assert.deepEqual(opened, ["https://auth.openai.com/oauth/authorize"]);
});
