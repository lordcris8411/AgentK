import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LLAMA_RUNTIME_ASSETS, LOCAL_MODEL_PROVIDER_ID, LocalModelManager } from "../.electron-dist/local-models.js";

if (!["linux", "win32"].includes(process.platform) || process.arch !== "x64") throw new Error("This smoke test requires Windows x64 or Linux x64");

const root = process.env.AGENT_K_LOCAL_MODEL_TEST_ROOT || await mkdtemp(join(tmpdir(), "agent-k-local-model-real-"));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const testHome = join(root, "home");
const quiet = process.env.AGENT_K_LOCAL_MODEL_TEST_QUIET === "1";
const report = (message) => { if (!quiet) process.stdout.write(message); };
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
const manager = new LocalModelManager({
  cachePath: join(root, "cache"),
  emit(event) {
    if (event.type === "local_models_changed") {
      const snapshot = manager.snapshot();
      const task = snapshot.downloads[0];
      const model = snapshot.models[0];
      const state = task ? `${task.status} ${task.completedBytes}/${task.totalBytes}` : model ? `${model.status} ${model.compatibility}` : "idle";
      report(`\r${state.padEnd(72)}`);
    }
  },
  piBusy: () => false,
  reloadPi: async () => undefined,
  migrateModelReferences: async () => undefined,
});

const waitFor = async (check, timeout) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resume) => setTimeout(resume, 250));
  }
  throw new Error("Timed out waiting for local model operation");
};

let succeeded = false;
try {
  await manager.initialize();
  const releases = new Map();
  for (const rootAsset of Object.values(LLAMA_RUNTIME_ASSETS)) {
    for (let asset = rootAsset; asset; asset = asset.companion) {
      if (asset.url) {
        const url = new URL(asset.url);
        assert.equal(url.protocol, "https:");
        assert.equal(url.hostname, "files.pythonhosted.org");
        assert.match(asset.sha256, /^[a-f0-9]{64}$/);
        continue;
      }
      const repository = asset.repository ?? rootAsset.repository ?? "ggml-org/llama.cpp";
      let releaseDigests = releases.get(repository);
      if (!releaseDigests) {
        const release = await fetch(`https://api.github.com/repos/${repository}/releases/tags/b10182`, { headers: { accept: "application/vnd.github+json", "user-agent": "Agent-K-local-model-test" } });
        assert.equal(release.status, 200);
        const releaseBody = await release.json();
        releaseDigests = new Map(releaseBody.assets.map((entry) => [entry.name, String(entry.digest).replace(/^sha256:/, "")]));
        releases.set(repository, releaseDigests);
      }
      assert.equal(releaseDigests.get(asset.name), asset.sha256, `Pinned digest changed for ${repository}/${asset.name}`);
    }
  }
  const repository = "OpenBMB/MiniCPM5-1B-GGUF";
  const searched = await manager.search("modelscope", "MiniCPM5-1B");
  assert.ok(searched.some((model) => model.repository === repository), "ModelScope search did not return the GGUF repository");
  const huggingFaceResults = await manager.search("huggingface", "MiniCPM5-1B");
  assert.ok(huggingFaceResults.some((model) => model.repository.toLowerCase() === "openbmb/minicpm5-1b-gguf"), "Hugging Face search did not return the GGUF repository");
  const huggingFaceRepo = await manager.inspectRepository("huggingface", "openbmb/MiniCPM5-1B-GGUF");
  assert.ok(huggingFaceRepo.files.some((file) => file.name === "MiniCPM5-1B-Q4_K_M.gguf"), "Hugging Face GGUF file discovery failed");
  const inspected = await manager.inspectRepository("modelscope", `https://www.modelscope.cn/models/${repository}`);
  const selected = inspected.files.find((file) => file.name === "MiniCPM5-1B-Q4_K_M.gguf");
  assert.ok(selected, "Q4_K_M GGUF was not found");
  assert.equal(selected.sha256, "81b64d05a23b17b34c475f42b3e72fbde62d4b92cc34541f7a8031d0752deafa");
  if (!manager.snapshot().models.some((item) => item.source === "modelscope")) await manager.enqueue("modelscope", repository, selected.name);
  const model = await waitFor(() => {
    const snapshot = manager.snapshot();
    const failed = snapshot.downloads.find((task) => task.status === "failed");
    if (failed) throw new Error(failed.error || "Model download failed");
    return snapshot.models.find((item) => item.source === "modelscope");
  }, 30 * 60_000);
  assert.equal(model.sha256.length, 64);
  const hfSelected = huggingFaceRepo.files.find((file) => file.name === selected.name);
  assert.ok(hfSelected);
  if (!manager.snapshot().models.some((item) => item.source === "huggingface" && item.repository?.toLowerCase() === huggingFaceRepo.repository.toLowerCase())) await manager.enqueue("huggingface", huggingFaceRepo.repository, hfSelected.name);
  const huggingFaceModel = await waitFor(() => {
    const snapshot = manager.snapshot(); const failed = snapshot.downloads.find((task) => task.status === "failed");
    if (failed) throw new Error(failed.error || "Hugging Face model download failed");
    return snapshot.models.find((item) => item.source === "huggingface" && item.repository?.toLowerCase() === huggingFaceRepo.repository.toLowerCase());
  }, 30 * 60_000);
  assert.equal(huggingFaceModel.files[0].sha256, selected.sha256);
  await manager.updateConfig(model.id, { backend: "cpu", contextSize: 16_384, gpuLayers: 0, threads: 0, maxOutputTokens: 8_192 });
  await manager.verify(model.id);
  assert.equal(manager.snapshot().models[0].compatibility, "tool-compatible");
  await manager.activate(model.id);
  const providerRoot = JSON.parse(await readFile(join(testHome, ".pi", "agent", "models.json"), "utf8"));
  const provider = providerRoot.providers[LOCAL_MODEL_PROVIDER_ID];
  assert.equal(provider.models[0].id, model.id);
  assert.equal(provider.models[0].maxTokens, 8_192);
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: "Reply with exactly LOCAL_MODEL_OK" }], temperature: 0, max_tokens: 32, stream: true }),
  });
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.match(stream, /data:/);
  const marker = join(root, "pi-tool-result.txt");
  await rm(marker, { force: true });
  const piPackage = [
    join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent"),
    join(process.cwd(), ".pi-runtime", "node_modules", "@earendil-works", "pi-coding-agent"),
  ].find((candidate) => existsSync(join(candidate, "dist", "cli.js")));
  assert.ok(piPackage, "The Pi coding agent package is required for the real tool-call test");
  const cli = join(piPackage, "dist", "cli.js");
  const extension = join(root, "agent-k-tool-probe.mjs");
  const typebox = pathToFileURL(join(piPackage, "node_modules", "typebox", "build", "index.mjs")).href;
  await writeFile(extension, `import { Type } from ${JSON.stringify(typebox)};\nimport { writeFile } from 'node:fs/promises';\nexport default function (pi) { pi.registerTool({ name: 'agent_k_tool_probe', label: 'Agent K tool probe', description: 'Write the deterministic Agent K compatibility marker', parameters: Type.Object({ value: Type.Integer() }), async execute(_id, params) { if (params.value !== 37) throw new Error('Expected value 37'); await writeFile(${JSON.stringify(marker)}, 'AGENT_K_PI_TOOL_OK'); return { content: [{ type: 'text', text: 'probe complete' }], details: {} }; } }); }\n`, "utf8");
  await new Promise((resolve, reject) => {
    const prompt = "Call agent_k_tool_probe exactly once with value 37. Do not explain before the tool call.";
    const child = spawn(process.execPath, [cli, "--print", "--no-session", "--no-extensions", "--extension", extension, "--no-builtin-tools", "--tools", "agent_k_tool_probe", "--no-skills", "--no-context-files", "--provider", LOCAL_MODEL_PROVIDER_ID, "--model", `${LOCAL_MODEL_PROVIDER_ID}/${model.id}`, prompt], { cwd: root, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let errors = "";
    let verified = false; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 120_000);
    const poll = setInterval(() => void readFile(marker, "utf8").then((value) => { if (value === "AGENT_K_PI_TOOL_OK" && !verified) { verified = true; child.kill(); } }).catch(() => undefined), 200);
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { errors += chunk.toString(); });
    child.once("error", reject);
    child.once("close", async (code) => { clearTimeout(timer); clearInterval(poll); const actual = await readFile(marker, "utf8").catch(() => "<missing>"); if (verified || actual === "AGENT_K_PI_TOOL_OK") resolve(undefined); else reject(new Error(`Pi tool smoke failed (${timedOut ? "timeout" : code}); marker=${JSON.stringify(actual)}: ${errors || output}`)); });
  });
  assert.equal(await readFile(marker, "utf8"), "AGENT_K_PI_TOOL_OK");
  const availableBackends = manager.snapshot().hardware.availableBackends;
  const configuredBackends = process.env.AGENT_K_LOCAL_MODEL_TEST_BACKENDS?.split(",").map((value) => value.trim()).filter(Boolean);
  const extraBackends = configuredBackends?.filter((backend) => backend !== "cpu") ?? availableBackends.filter((backend) => backend !== "auto" && backend !== "cpu");
  for (const backend of extraBackends) {
    assert.ok(["vulkan", "rocm", "cuda12", "cuda13"].includes(backend), `Unknown requested backend ${backend}`);
    assert.ok(availableBackends.includes(backend) || process.env.AGENT_K_LOCAL_MODEL_TEST_ALLOW_UNDETECTED_BACKENDS === "1", `Requested backend ${backend} was not detected; prerequisites are missing`);
    await manager.updateConfig(model.id, { backend, gpuLayers: -1 });
    assert.equal(manager.snapshot().models.find((item) => item.id === model.id).compatibility, "unverified");
    await manager.verify(model.id);
    assert.equal(manager.snapshot().models.find((item) => item.id === model.id).compatibility, "tool-compatible");
    await manager.activate(model.id);
    const backendResponse = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: `Reply with exactly ${backend.toUpperCase()}_OK` }], temperature: 0, max_tokens: 32 }),
    });
    assert.equal(backendResponse.status, 200);
    assert.match(await backendResponse.text(), new RegExp(`${backend}_OK`, "i"));
    await manager.stop();
  }
  const incompatibleRepository = await manager.inspectRepository("huggingface", "ggml-org/tiny-llamas");
  const incompatibleFile = incompatibleRepository.files.find((file) => file.name === "stories260K.gguf");
  assert.ok(incompatibleFile);
  if (!manager.snapshot().models.some((item) => item.repository === incompatibleRepository.repository)) await manager.enqueue("huggingface", incompatibleRepository.repository, incompatibleFile.name);
  const incompatibleModel = await waitFor(() => {
    const snapshot = manager.snapshot(); const failed = snapshot.downloads.find((task) => task.status === "failed");
    if (failed) throw new Error(failed.error || "Incompatible GGUF download failed");
    return snapshot.models.find((item) => item.repository === incompatibleRepository.repository);
  }, 5 * 60_000);
  await manager.updateConfig(incompatibleModel.id, { backend: "cpu", contextSize: 4_096, gpuLayers: 0, maxOutputTokens: 2_048 });
  await assert.rejects(manager.verify(incompatibleModel.id));
  assert.equal(manager.snapshot().models.find((item) => item.id === incompatibleModel.id).compatibility, "tool-incompatible");
  assert.equal(manager.snapshot().activeModelId, model.id);
  await manager.delete(incompatibleModel.id);
  await manager.delete(huggingFaceModel.id);
  succeeded = true;
  await writeFile(join(root, "real-local-model-result.txt"), "REAL_LOCAL_MODEL_TEST_OK\n", "utf8");
  report("\nREAL_LOCAL_MODEL_TEST_OK\n");
} catch (cause) {
  const failure = `${cause instanceof Error ? cause.stack : String(cause)}\n${manager.logsSnapshot().slice(-200).join("\n")}\n`;
  await writeFile(join(root, "real-local-model-error.txt"), failure, "utf8").catch(() => undefined);
  if (!quiet) process.stderr.write(`\n${failure}`);
  throw cause;
} finally {
  await manager.shutdown().catch(() => undefined);
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
  if (!process.env.AGENT_K_LOCAL_MODEL_TEST_ROOT && succeeded) await rm(root, { recursive: true, force: true });
  else if (!succeeded && !quiet) process.stderr.write(`Local model test artifacts retained at ${root}\n`);
}
