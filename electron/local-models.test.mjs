import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LLAMA_CPP_BUILD,
  LLAMA_RUNTIME_ASSETS,
  LOCAL_MODEL_PROVIDER_ID,
  LocalModelManager,
  applyLocalModelReasoningPolicy,
  completeShardGroup,
  fetchWithRetry,
  parseGgufShard,
  parseHubRepository,
  readGgufMetadata,
  resolveGpuLayers,
  selectAutomaticBackend,
  validateToolCallResponse,
} from "../.electron-dist/local-models.js";

function ggufString(value) {
  const text = Buffer.from(value, "utf8");
  const result = Buffer.alloc(8 + text.length);
  result.writeBigUInt64LE(BigInt(text.length), 0);
  text.copy(result, 8);
  return result;
}

function ggufFixture() {
  const entries = [
    ["general.architecture", 8, ggufString("llama")],
    ["general.parameter_count", 10, (() => { const value = Buffer.alloc(8); value.writeBigUInt64LE(1_080_632_832n); return value; })()],
    ["llama.context_length", 4, (() => { const value = Buffer.alloc(4); value.writeUInt32LE(32_768); return value; })()],
    ["llama.block_count", 4, (() => { const value = Buffer.alloc(4); value.writeUInt32LE(24); return value; })()],
  ];
  const header = Buffer.alloc(24);
  header.write("GGUF", 0, "ascii");
  header.writeUInt32LE(3, 4);
  header.writeBigUInt64LE(0n, 8);
  header.writeBigUInt64LE(BigInt(entries.length), 16);
  return Buffer.concat([header, ...entries.flatMap(([key, type, value]) => { const typeBuffer = Buffer.alloc(4); typeBuffer.writeUInt32LE(type, 0); return [ggufString(key), typeBuffer, value]; })]);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function waitFor(check, timeout = 8_000, label = "condition") {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const result = await check();
        if (result) { resolve(result); return; }
      } catch (cause) { reject(cause); return; }
      if (Date.now() >= deadline) { reject(new Error(`Timed out waiting for ${label}`)); return; }
      setTimeout(poll, 30);
    };
    void poll();
  });
}

test("retries transient runtime downloads but not permanent client errors", async () => {
  let transientRequests = 0;
  let permanentRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/transient") {
      transientRequests += 1;
      response.statusCode = transientRequests < 3 ? 503 : 200;
      response.end(transientRequests < 3 ? "try again" : "ok");
      return;
    }
    permanentRequests += 1;
    response.statusCode = 404;
    response.end("missing");
  });
  const port = await listen(server);
  try {
    const recovered = await fetchWithRetry(`http://127.0.0.1:${port}/transient`);
    assert.equal(recovered.status, 200);
    assert.equal(await recovered.text(), "ok");
    assert.equal(transientRequests, 3);
    const missing = await fetchWithRetry(`http://127.0.0.1:${port}/missing`);
    assert.equal(missing.status, 404);
    assert.equal(permanentRequests, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("parses only official hub repository inputs and complete GGUF shards", () => {
  assert.equal(parseHubRepository("huggingface", "owner/repo"), "owner/repo");
  assert.equal(parseHubRepository("huggingface", "https://huggingface.co/owner/repo/tree/main"), "owner/repo");
  assert.equal(parseHubRepository("modelscope", "https://www.modelscope.cn/models/OpenBMB/MiniCPM5-1B-GGUF"), "OpenBMB/MiniCPM5-1B-GGUF");
  assert.throws(() => parseHubRepository("huggingface", "https://example.com/model.gguf"));
  assert.deepEqual(parseGgufShard("model-00002-of-00003.gguf"), { group: "model.gguf", index: 2, count: 3 });
  const files = [1, 2, 3].map((index) => ({ name: `model-${String(index).padStart(5, "0")}-of-00003.gguf`, group: "model.gguf", shardIndex: index, shardCount: 3, size: 1 }));
  assert.equal(completeShardGroup(files, files[1].name).length, 3);
  assert.throws(() => completeShardGroup(files.slice(0, 2), files[0].name), /complete/);
});

test("reads GGUF architecture, parameter count, and training context", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-k-gguf-"));
  try {
    const path = join(root, "model.gguf");
    await writeFile(path, ggufFixture());
    assert.deepEqual(await readGgufMetadata(path), { architecture: "llama", parameterCount: 1_080_632_832, trainingContext: 32_768, blockCount: 24 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects truncated GGUF metadata arrays", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-k-gguf-truncated-"));
  try {
    const header = Buffer.alloc(24); header.write("GGUF"); header.writeUInt32LE(3, 4); header.writeBigUInt64LE(1n, 16);
    const arrayType = Buffer.alloc(4); arrayType.writeUInt32LE(9);
    const elementType = Buffer.alloc(4); elementType.writeUInt32LE(0);
    const count = Buffer.alloc(8); count.writeBigUInt64LE(100n);
    const path = join(root, "truncated.gguf");
    await writeFile(path, Buffer.concat([header, ggufString("array"), arrayType, elementType, count]));
    await assert.rejects(readGgufMetadata(path), /array size/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("strictly validates standard forced tool calls", () => {
  const body = { choices: [{ message: { role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "agent_k_tool_probe", arguments: "{\"value\":37}" } }] } }] };
  assert.equal(validateToolCallResponse(body).arguments.value, 37);
  assert.throws(() => validateToolCallResponse({ choices: [{ message: { content: "I would call a tool" } }] }), /tool call/);
  assert.throws(() => validateToolCallResponse({ choices: [{ message: { tool_calls: [{ id: "x", type: "function", function: { name: "wrong", arguments: "{}" } }] } }] }), /wrong tool/);
  assert.throws(() => validateToolCallResponse({ choices: [{ message: { tool_calls: [{ id: "x", type: "function", function: { name: "agent_k_tool_probe", arguments: "no" } }] } }] }), /valid JSON/);
  assert.throws(() => validateToolCallResponse({ choices: [{ message: { tool_calls: [{ id: "x", type: "function", function: { name: "agent_k_tool_probe", arguments: "{\"value\":37,\"extra\":true}" } }] } }] }), /incorrect/);
});

test("applies per-conversation reasoning controls without forcing thinking on", () => {
  const piControlled = { model: "local", chat_template_kwargs: { enable_thinking: false, preserve_thinking: true } };
  assert.equal(applyLocalModelReasoningPolicy(piControlled, true), piControlled);
  assert.deepEqual(applyLocalModelReasoningPolicy({ model: "local", chat_template_kwargs: { custom: "kept", enable_thinking: true } }, false), {
    model: "local",
    chat_template_kwargs: { custom: "kept", enable_thinking: false, preserve_thinking: false },
  });
});

test("pins every supported llama.cpp b10182 runtime and CUDA companion", () => {
  assert.equal(LLAMA_CPP_BUILD, "b10182");
  assert.deepEqual(Object.keys(LLAMA_RUNTIME_ASSETS).sort(), ["linux-cpu", "linux-cuda12", "linux-rocm", "linux-vulkan", "win32-cpu", "win32-cuda12", "win32-cuda13", "win32-vulkan"]);
  const linuxCuda = LLAMA_RUNTIME_ASSETS["linux-cuda12"];
  assert.equal(linuxCuda.name, "llama.cpp-b10182-cuda-12.8-amd64.tar.gz");
  assert.equal(linuxCuda.sha256, "5576a132d768b240b1c3e950e71b456cbf7b90c6a38dca2fcd93f965b32098c9");
  assert.equal(linuxCuda.repository, "ai-dock/llama.cpp-cuda");
  assert.equal(linuxCuda.thirdParty, true);
  const cudaAssets = [];
  for (let asset = linuxCuda; asset; asset = asset.companion) cudaAssets.push(asset);
  assert.deepEqual(cudaAssets.map((asset) => asset.name), [
    "llama.cpp-b10182-cuda-12.8-amd64.tar.gz",
    "nvidia_cuda_runtime_cu12-12.8.90-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl",
    "nvidia_cublas_cu12-12.8.4.1-py3-none-manylinux_2_27_x86_64.whl",
    "nvidia_nccl_cu12-2.26.2-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl",
  ]);
  for (const rootAsset of Object.values(LLAMA_RUNTIME_ASSETS)) {
    for (let asset = rootAsset; asset; asset = asset.companion) assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  }
});

test("prefers native GPU runtimes before Vulkan in automatic mode", () => {
  assert.equal(selectAutomaticBackend("win32", ["auto", "cpu", "vulkan", "cuda12", "cuda13"]), "cuda13");
  assert.equal(selectAutomaticBackend("win32", ["auto", "cpu", "vulkan", "cuda12"]), "cuda12");
  assert.equal(selectAutomaticBackend("linux", ["auto", "cpu", "vulkan", "cuda12"]), "cuda12");
  assert.equal(selectAutomaticBackend("linux", ["auto", "cpu", "vulkan", "rocm"]), "rocm");
  assert.equal(selectAutomaticBackend("linux", ["auto", "cpu"]), "cpu");
});

test("delegates automatic GPU-layer fitting to llama.cpp", () => {
  assert.equal(resolveGpuLayers("cuda12", -1), "auto");
  assert.equal(resolveGpuLayers("vulkan", -1), "auto");
  assert.equal(resolveGpuLayers("cuda12", 12), 12);
  assert.equal(resolveGpuLayers("cpu", -1), 0);
  assert.equal(resolveGpuLayers("cpu", 12), 0);
});

test("waits for an explicit healthy llama-server status before reporting ready", async () => {
  const manager = new LocalModelManager({ cachePath: join(tmpdir(), "agent-k-health-test"), emit() {}, piBusy: () => false, reloadPi: async () => undefined, migrateModelReferences: async () => undefined });
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: requests < 3 ? "loading model" : "ok" }));
  });
  const port = await listen(server);
  manager.server = {};
  manager.serverPort = port;
  manager.serverToken = "health-test";
  try {
    await manager.waitForHealth({ error: undefined }, Date.now() + 2_000, new AbortController().signal);
    assert.equal(requests, 3);
  } finally {
    manager.server = undefined;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("downloads, verifies, activates and proxies only a tool-compatible model", { skip: process.platform !== "linux" || process.arch !== "x64" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-k-local-models-"));
  const previousHome = process.env.HOME;
  const modelBytes = Buffer.concat([ggufFixture(), Buffer.alloc(1024 * 1024)]);
  const digest = createHash("sha256").update(modelBytes).digest("hex");
  let remoteEtag = "fixture-v1";
  let rangeRequests = 0;
  let badHashFullRequests = 0;
  let badHashRangeRequests = 0;
  const hub = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/api/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify([{ id: "fixture/hf-gguf", downloads: 10, private: false, gated: false }, { id: "fixture/hf-false-positive", downloads: 1, private: false, gated: false }]));
      return;
    }
    if (url.pathname === "/api/models/fixture/hf-gguf") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ id: "fixture/hf-gguf", sha: "hf-rev", siblings: [{ rfilename: "hf.gguf", size: modelBytes.length, lfs: { size: modelBytes.length, sha256: digest } }] })); return; }
    if (url.pathname === "/api/models/fixture/hf-false-positive") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ id: "fixture/hf-false-positive", sha: "hf-rev", siblings: [{ rfilename: "README.md", size: 10 }] })); return; }
    if (url.pathname === "/openapi/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ success: true, data: { models: [{ id: "OpenBMB/MiniCPM5-1B-GGUF", display_name: "MiniCPM5-1B-GGUF", downloads: 123, tags: ["library:gguf"], private: false, gated: false }, { id: "fixture/not-actually-gguf", display_name: "False Positive", tags: ["gguf"], private: false, gated: false }] } }));
      return;
    }
    if (url.pathname === "/api/v1/models/fixture/not-actually-gguf/repo/files") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ Code: 200, Data: { Files: [{ Path: "README.md", Size: 10 }] } })); return; }
    if (url.pathname === "/api/v1/models/OpenBMB/MiniCPM5-1B-GGUF/repo/files") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ Code: 200, Data: { Files: [{ Path: "MiniCPM5-1B-Q4_K_M.gguf", Size: modelBytes.length, Sha256: digest }] } }));
      return;
    }
    if (url.pathname === "/api/v1/models/fixture/bad-hash/repo/files") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ Code: 200, Data: { Files: [{ Path: "bad.gguf", Size: modelBytes.length, Sha256: "0".repeat(64) }] } }));
      return;
    }
    if (url.pathname === "/api/v1/models/fixture/too-large/repo/files") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ Code: 200, Data: { Files: [{ Path: "huge.gguf", Size: Number.MAX_SAFE_INTEGER, Sha256: digest }] } }));
      return;
    }
    if (url.pathname === "/api/v1/models/fixture/unknown-size/repo/files") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ Code: 200, Data: { Files: [{ Path: "unknown.gguf", Size: 0, Sha256: digest }] } }));
      return;
    }
    if (url.pathname === "/api/v1/models/fixture/recovery/repo/files") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ Code: 200, Data: { Files: [{ Path: "recovered.gguf", Size: modelBytes.length, Sha256: digest }] } }));
      return;
    }
    if (url.pathname === "/models/OpenBMB/MiniCPM5-1B-GGUF/resolve/master/MiniCPM5-1B-Q4_K_M.gguf") {
      const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
      if (range) rangeRequests += 1;
      const resumable = Boolean(range && request.headers["if-range"] === remoteEtag);
      const start = resumable ? Number(range[1]) : 0;
      response.statusCode = resumable ? 206 : 200;
      response.setHeader("etag", remoteEtag);
      response.setHeader("content-length", modelBytes.length - start);
      if (resumable) response.setHeader("content-range", `bytes ${start}-${modelBytes.length - 1}/${modelBytes.length}`);
      let cursor = start;
      const write = () => {
        if (cursor >= modelBytes.length) { response.end(); return; }
        const end = Math.min(modelBytes.length, cursor + 64 * 1024);
        response.write(modelBytes.subarray(cursor, end)); cursor = end;
        setTimeout(write, 10);
      };
      write();
      return;
    }
    if (url.pathname === "/models/fixture/bad-hash/resolve/master/bad.gguf") {
      if (request.headers.range) { badHashRangeRequests += 1; response.statusCode = 416; response.end(); return; }
      badHashFullRequests += 1; response.setHeader("etag", "bad-v1"); response.end(modelBytes); return;
    }
    if (url.pathname === "/models/fixture/unknown-size/resolve/master/unknown.gguf") { response.setHeader("content-length", modelBytes.length); response.end(request.method === "HEAD" ? undefined : modelBytes); return; }
    if (url.pathname === "/models/fixture/recovery/resolve/master/recovered.gguf") {
      const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? ""); const start = range ? Number(range[1]) : 0;
      response.statusCode = range ? 206 : 200; response.setHeader("etag", "recovery-v1"); response.setHeader("content-length", modelBytes.length - start);
      if (range) response.setHeader("content-range", `bytes ${start}-${modelBytes.length - 1}/${modelBytes.length}`);
      let cursor = start; const write = () => { if (cursor >= modelBytes.length) { response.end(); return; } const end = Math.min(modelBytes.length, cursor + 64 * 1024); response.write(modelBytes.subarray(cursor, end)); cursor = end; setTimeout(write, 10); }; write(); return;
    }
    response.statusCode = 404; response.end();
  });
  const hubPort = await listen(hub);
  process.env.HOME = join(root, "home");
  let busy = false;
  let verifiedBusy = false;
  let reloads = 0;
  let failReload = false;
  const migrations = [];
  let emitHook = () => undefined;
  const manager = new LocalModelManager({
    cachePath: join(root, "cache"), emit(event) { emitHook(event); }, piBusy: () => busy,
    verifyPiBusy: async () => verifiedBusy,
    reloadPi: async () => { reloads += 1; if (failReload) throw new Error("fixture reload failure"); },
    migrateModelReferences: async (previous, next) => { migrations.push([previous, next]); },
    endpoints: { huggingface: `http://127.0.0.1:${hubPort}`, modelscope: `http://127.0.0.1:${hubPort}` }, verificationTimeoutMs: 1_500,
  });
  let managerStopped = false;
  try {
    const runtime = join(root, "cache", "local-models", "runtime", LLAMA_CPP_BUILD, "cpu");
    await mkdir(runtime, { recursive: true });
    const fakeServer = join(runtime, "llama-server");
    const spawnCounter = join(root, "llama-spawns.txt");
    const verificationFailureFlag = join(root, "force-verification-failure");
    await writeFile(fakeServer, `#!/usr/bin/env node
const http=require('node:http'); const fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(spawnCounter)},'1\\n'); const args=process.argv.slice(2); const value=(name)=>args[args.indexOf(name)+1]; const port=Number(value('--port')); const key=value('--api-key'); const alias=value('--alias'); process.stderr.write(Array.from({length:3105},(_,i)=>'fixture-log-'+i).join('\\n')+'\\n');
http.createServer(async(req,res)=>{ if(req.headers.authorization!=='Bearer '+key){res.statusCode=401;return res.end();} if(req.url==='/health')return res.end(JSON.stringify({status:alias.includes('health-timeout')?'loading model':'ok'})); if(req.url==='/props')return res.end(JSON.stringify({chat_template:'{{ messages }}'})); let raw=''; for await(const chunk of req)raw+=chunk; if(raw.includes('CRASH_NOW'))return process.exit(9); const body=raw?JSON.parse(raw):{}; res.setHeader('content-type', body.stream?'text/event-stream':'application/json'); if(body.stream){res.write('data: '+JSON.stringify({choices:[{delta:{content:'hello'}}]})+'\\n\\n'); return res.end('data: [DONE]\\n\\n');} if(alias.includes('timeout'))return; if(alias.includes('incompatible')||fs.existsSync(${JSON.stringify(verificationFailureFlag)}))return res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'plain text instead of a tool'}}]})); if(body.tool_choice && body.tool_choice!=='none')return res.end(JSON.stringify({choices:[{message:{role:'assistant',tool_calls:[{id:'probe-1',type:'function',function:{name:'agent_k_tool_probe',arguments:'{"value":37}'}}]}}]})); res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'tool result accepted'}}]})); }).listen(port,'127.0.0.1');
`, "utf8");
    await chmod(fakeServer, 0o755);
    await writeFile(join(runtime, ".agent-k-runtime.json"), JSON.stringify({ build: LLAMA_CPP_BUILD, backend: "cpu", assets: [{ name: LLAMA_RUNTIME_ASSETS["linux-cpu"].name, sha256: LLAMA_RUNTIME_ASSETS["linux-cpu"].sha256 }] }), "utf8");
    await manager.initialize();
    const results = await manager.search("modelscope", "MiniCPM5");
    assert.deepEqual(results.map((item) => item.repository), ["OpenBMB/MiniCPM5-1B-GGUF"]);
    const huggingFaceResults = await manager.search("huggingface", "fixture");
    assert.deepEqual(huggingFaceResults.map((item) => item.repository), ["fixture/hf-gguf"]);
    const inspected = await manager.inspectRepository("modelscope", "https://www.modelscope.cn/models/OpenBMB/MiniCPM5-1B-GGUF");
    assert.equal(inspected.files[0].sha256, digest);
    const sizedTask = await manager.enqueue("modelscope", "fixture/unknown-size", "unknown.gguf");
    assert.equal(manager.snapshot().downloads.find((task) => task.id === sizedTask)?.totalBytes, modelBytes.length);
    await manager.pauseDownload(sizedTask);
    await manager.cancelDownload(sizedTask);
    const taskId = await manager.enqueue("modelscope", inspected.repository, inspected.files[0].name);
    await waitFor(() => (manager.snapshot().downloads.find((task) => task.id === taskId)?.completedBytes ?? 0) > 0);
    const queuedTask = await manager.enqueue("modelscope", "fixture/bad-hash", "bad.gguf");
    await manager.pauseDownload(queuedTask);
    await new Promise((resume) => setTimeout(resume, 40));
    assert.notEqual(manager.snapshot().downloads.find((task) => task.id === taskId)?.status, "failed", "Pausing a queued task aborted the active download");
    await manager.pauseDownload(taskId);
    await waitFor(() => manager.snapshot().downloads.find((task) => task.id === taskId)?.status === "paused");
    remoteEtag = "fixture-v2";
    await manager.resumeDownload(taskId);
    const downloaded = await waitFor(() => manager.snapshot().models[0]);
    await manager.cancelDownload(queuedTask);
    assert.ok(rangeRequests > 0, "The resumed download did not use HTTP Range");
    const badTask = await manager.enqueue("modelscope", "fixture/bad-hash", "bad.gguf");
    const badResult = await waitFor(() => { const task = manager.snapshot().downloads.find((item) => item.id === badTask); return task?.status === "failed" ? task : undefined; });
    assert.match(badResult.error, /SHA-256 mismatch/);
    await manager.resumeDownload(badTask);
    await waitFor(() => { const task = manager.snapshot().downloads.find((item) => item.id === badTask); return task?.status === "failed" && task.updatedAt > badResult.updatedAt ? task : undefined; });
    assert.equal(badHashFullRequests, 2);
    assert.equal(badHashRangeRequests, 0, "Retrying a corrupt completed partial attempted to resume from EOF");
    assert.equal(manager.snapshot().models.length, 1);
    let cancelledPromise;
    let cancellationTriggered = false;
    emitHook = () => {
      const task = manager.snapshot().downloads.find((item) => item.repository === "fixture/bad-hash" && item.id !== badTask && item.status === "verifying-download");
      if (task && !cancellationTriggered) { cancellationTriggered = true; cancelledPromise = manager.cancelDownload(task.id); }
    };
    const cancelledTask = await manager.enqueue("modelscope", "fixture/bad-hash", "bad.gguf");
    await waitFor(() => cancellationTriggered, 8_000, "checksum cancellation hook");
    await cancelledPromise;
    emitHook = () => undefined;
    assert.equal(manager.snapshot().downloads.some((task) => task.id === cancelledTask), false);
    assert.equal(manager.snapshot().models.length, 1, "Cancelling checksum verification still imported a model");
    await assert.rejects(manager.enqueue("modelscope", "fixture/too-large", "huge.gguf"), /disk space/);
    assert.equal(downloaded.compatibility, "unverified");
    await manager.updateConfig(downloaded.id, { backend: "cpu", contextSize: 4096, reasoning: true });
    await manager.verify(downloaded.id);
    assert.equal(manager.snapshot().models[0].compatibility, "tool-compatible");
    busy = true;
    verifiedBusy = true;
    await assert.rejects(manager.activate(downloaded.id), /idle/);
    verifiedBusy = false;
    await manager.activate(downloaded.id);
    assert.equal(manager.snapshot().piBusy, true, "The fixture should retain a stale event-derived busy flag");
    verifiedBusy = true;
    await assert.rejects(manager.verify(downloaded.id), /idle/);
    busy = false;
    verifiedBusy = false;
    assert.equal(manager.snapshot().activeModelId, downloaded.id);
    assert.equal(reloads, 1);
    assert.deepEqual(migrations, [[undefined, downloaded.id]]);
    const providerRoot = JSON.parse(await readFile(join(process.env.HOME, ".pi", "agent", "models.json"), "utf8"));
    const provider = providerRoot.providers[LOCAL_MODEL_PROVIDER_ID];
    assert.equal(provider.models.length, 1);
    assert.equal(provider.models[0].id, downloaded.id);
    assert.equal(provider.models[0].reasoning, true);
    assert.deepEqual(provider.models[0].thinkingLevelMap, { off: "off", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null });
    assert.deepEqual(provider.models[0].compat, { supportsDeveloperRole: false, supportsReasoningEffort: false, thinkingFormat: "qwen-chat-template" });
    await manager.setEnabled(false);
    assert.equal(manager.snapshot().enabled, false);
    assert.equal(JSON.parse(await readFile(join(process.env.HOME, ".pi", "agent", "models.json"), "utf8")).providers[LOCAL_MODEL_PROVIDER_ID], undefined);
    const disabledRequest = await fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: downloaded.id, messages: [] }) });
    assert.equal(disabledRequest.status, 503);
    await manager.setEnabled(true);
    assert.equal(manager.snapshot().enabled, true);
    assert.equal(JSON.parse(await readFile(join(process.env.HOME, ".pi", "agent", "models.json"), "utf8")).providers[LOCAL_MODEL_PROVIDER_ID].models[0].id, downloaded.id);
    const unauthorized = await fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: downloaded.id, messages: [] }) });
    assert.equal(unauthorized.status, 401);
    const unsupportedEndpoint = await fetch(`${provider.baseUrl}/models`, { headers: { authorization: `Bearer ${provider.apiKey}` } });
    assert.equal(unsupportedEndpoint.status, 404);
    const missingModel = await fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ messages: [] }) });
    assert.equal(missingModel.status, 400);
    const runEvents = [];
    emitHook = (event) => { if (event.type === "local_model_run_progress") runEvents.push(event); };
    const streams = await Promise.all([1, 2].map(() => fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: downloaded.id, messages: [{ role: "user", content: "hello" }], stream: true }) })));
    assert.deepEqual(streams.map((stream) => stream.status), [200, 200]);
    assert.match(await streams[0].text(), /hello/);
    assert.match(await streams[1].text(), /hello/);
    assert.deepEqual(runEvents.filter((event) => event.status === "progress").map((event) => event.phase), ["preparing-runtime", "starting-server", "loading-model", "health-check"]);
    assert.equal(runEvents.at(-1)?.phase, "ready");
    assert.equal(runEvents.at(-1)?.status, "complete");
    assert.equal(new Set(runEvents.map((event) => event.transactionId)).size, 1);
    emitHook = () => undefined;
    assert.equal((await readFile(spawnCounter, "utf8")).trim().split("\n").length, 2, "Concurrent proxy requests started more than one lazy llama-server");
    const wrong = await fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: "old-model", messages: [], stream: false }) });
    assert.equal(wrong.status, 409);
    const crashed = await fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: downloaded.id, messages: [{ role: "user", content: "CRASH_NOW" }], stream: false }) });
    assert.equal(crashed.status, 502);
    await waitFor(() => manager.snapshot().models.find((model) => model.id === downloaded.id)?.status === "failed", 8_000, "llama-server crash state");
    const recovered = await fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: downloaded.id, messages: [{ role: "user", content: "recover" }], stream: true }) });
    assert.equal(recovered.status, 200);
    assert.match(await recovered.text(), /hello/);
    const activeOutput = manager.snapshot().models.find((model) => model.id === downloaded.id).config.maxOutputTokens;
    const changedOutput = activeOutput === 2_048 ? 4_096 : 2_048;
    failReload = true;
    await assert.rejects(manager.updateConfig(downloaded.id, { maxOutputTokens: changedOutput }), /fixture reload failure/);
    failReload = false;
    const activeAfterRollback = manager.snapshot().models.find((model) => model.id === downloaded.id);
    assert.equal(activeAfterRollback.config.maxOutputTokens, activeOutput);
    assert.equal(activeAfterRollback.compatibility, "tool-compatible");
    assert.equal(manager.snapshot().activeModelId, downloaded.id);
    const incompatiblePath = join(root, "incompatible.gguf");
    await writeFile(incompatiblePath, modelBytes);
    const incompatibleId = await manager.importGguf(incompatiblePath);
    await manager.updateConfig(incompatibleId, { backend: "cpu", contextSize: 4096 });
    await assert.rejects(manager.verify(incompatibleId), /standard tool call/);
    assert.equal(manager.snapshot().models.find((model) => model.id === incompatibleId).compatibility, "tool-incompatible");
    await assert.rejects(manager.activate(incompatibleId), /standard tool call/);
    assert.equal(manager.snapshot().activeModelId, downloaded.id);
    const stillManaged = JSON.parse(await readFile(join(process.env.HOME, ".pi", "agent", "models.json"), "utf8")).providers[LOCAL_MODEL_PROVIDER_ID];
    assert.deepEqual(stillManaged.models.map((model) => model.id), [downloaded.id]);
    const compatibleSecondPath = join(root, "compatible-second.gguf");
    await writeFile(compatibleSecondPath, modelBytes);
    const compatibleSecondId = await manager.importGguf(compatibleSecondPath);
    await manager.updateConfig(compatibleSecondId, { backend: "cpu", contextSize: 4096 });
    await manager.verify(compatibleSecondId);
    failReload = true;
    await assert.rejects(manager.activate(compatibleSecondId), /fixture reload failure/);
    failReload = false;
    assert.equal(manager.snapshot().activeModelId, downloaded.id);
    const rolledBackProvider = JSON.parse(await readFile(join(process.env.HOME, ".pi", "agent", "models.json"), "utf8")).providers[LOCAL_MODEL_PROVIDER_ID];
    assert.deepEqual(rolledBackProvider.models.map((model) => model.id), [downloaded.id]);
    assert.deepEqual(migrations.slice(-2), [[downloaded.id, compatibleSecondId], [compatibleSecondId, downloaded.id]]);
    const secondOutput = manager.snapshot().models.find((model) => model.id === compatibleSecondId).config.maxOutputTokens;
    await manager.updateConfig(compatibleSecondId, { maxOutputTokens: secondOutput === 2_048 ? 4_096 : 2_048 });
    assert.equal(manager.snapshot().models.find((model) => model.id === compatibleSecondId).compatibility, "unverified");
    const timeoutPath = join(root, "timeout.gguf");
    await writeFile(timeoutPath, modelBytes);
    const timeoutId = await manager.importGguf(timeoutPath);
    await manager.updateConfig(timeoutId, { backend: "cpu", contextSize: 4_096 });
    const timeoutStarted = Date.now();
    await assert.rejects(manager.verify(timeoutId), /abort|timeout/i);
    assert.ok(Date.now() - timeoutStarted < 3_000, "Tool verification exceeded its single combined timeout budget");
    assert.equal(manager.snapshot().models.find((model) => model.id === timeoutId).compatibility, "tool-incompatible");
    const healthTimeoutPath = join(root, "health-timeout.gguf");
    await writeFile(healthTimeoutPath, modelBytes);
    const healthTimeoutId = await manager.importGguf(healthTimeoutPath);
    await manager.updateConfig(healthTimeoutId, { backend: "cpu", contextSize: 4_096 });
    const healthTimeoutModel = manager.model(healthTimeoutId);
    await assert.rejects(manager.startModel(healthTimeoutModel, false), /healthy/i);
    assert.equal(manager.snapshot().models.find((model) => model.id === healthTimeoutId).status, "failed");
    assert.equal(manager.snapshot().runningModelId, undefined);
    assert.equal(manager.logsSnapshot().length, 3_000);
    assert.ok(!manager.logsSnapshot().some((line) => line.endsWith("fixture-log-0")));
    await writeFile(verificationFailureFlag, "1", "utf8");
    await assert.rejects(manager.verify(downloaded.id), /standard tool call/);
    assert.equal(manager.snapshot().models.find((model) => model.id === downloaded.id).compatibility, "tool-incompatible");
    assert.equal(manager.snapshot().activeModelId, undefined);
    const providersAfterFailedRevalidation = JSON.parse(await readFile(join(process.env.HOME, ".pi", "agent", "models.json"), "utf8")).providers;
    assert.equal(providersAfterFailedRevalidation[LOCAL_MODEL_PROVIDER_ID], undefined);
    assert.deepEqual(migrations.at(-1), [downloaded.id, undefined]);
    const recoveryTask = await manager.enqueue("modelscope", "fixture/recovery", "recovered.gguf");
    await waitFor(() => (manager.snapshot().downloads.find((task) => task.id === recoveryTask)?.completedBytes ?? 0) > 0, 8_000, "recovery download progress");
    await manager.shutdown(); managerStopped = true;
    const persisted = JSON.parse(await readFile(join(root, "cache", "local-models", "registry.json"), "utf8"));
    assert.equal(persisted.downloads.find((task) => task.id === recoveryTask).status, "queued");
    const restarted = new LocalModelManager({ cachePath: join(root, "cache"), emit() {}, piBusy: () => false, reloadPi: async () => undefined, migrateModelReferences: async () => undefined, endpoints: { modelscope: `http://127.0.0.1:${hubPort}` } });
    try { await restarted.initialize(); await waitFor(() => restarted.snapshot().models.find((item) => item.name === "recovered"), 8_000, "restarted download completion"); }
    finally { await restarted.shutdown(); }
  } finally {
    if (!managerStopped) await manager.shutdown().catch(() => undefined);
    await new Promise((resolve) => hub.close(resolve));
    process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("does not overwrite a conflicting non-Agent-K provider during initialization", { skip: process.platform !== "linux" || process.arch !== "x64" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-k-provider-conflict-"));
  const previousHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  const modelsPath = join(process.env.HOME, ".pi", "agent", "models.json");
  await mkdir(join(process.env.HOME, ".pi", "agent"), { recursive: true });
  const external = { providers: { [LOCAL_MODEL_PROVIDER_ID]: { name: "External provider", baseUrl: "http://127.0.0.1:9999/v1", api: "openai-completions", apiKey: "external", models: [{ id: "external" }] } } };
  await writeFile(modelsPath, JSON.stringify(external), "utf8");
  const manager = new LocalModelManager({ cachePath: join(root, "cache"), emit() {}, piBusy: () => false, reloadPi: async () => undefined, migrateModelReferences: async () => undefined });
  try {
    await manager.initialize();
    assert.match(manager.snapshot().providerConflict, /not managed by Agent K/);
    assert.deepEqual(JSON.parse(await readFile(modelsPath, "utf8")), external);
  } finally {
    await manager.shutdown().catch(() => undefined);
    process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("clears a persisted active model when its tool-verification cache is stale", { skip: process.platform !== "linux" || process.arch !== "x64" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-k-stale-local-model-"));
  const previousHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  const cachePath = join(root, "cache");
  const modelId = "stale-model";
  const modelDirectory = join(cachePath, "local-models", "models", modelId);
  const modelPath = join(modelDirectory, "stale.gguf");
  const registryPath = join(cachePath, "local-models", "registry.json");
  await mkdir(modelDirectory, { recursive: true });
  const bytes = ggufFixture();
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(modelPath, bytes);
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    activeModelId: modelId,
    downloads: [],
    models: [{ id: modelId, name: "Stale", source: "import", files: [{ name: "stale.gguf", path: modelPath, size: bytes.length, sha256: digest }], size: bytes.length, sha256: digest, architecture: "llama", trainingContext: 32_768, blockCount: 24, compatibility: "tool-compatible", compatibilityKey: "outdated-build-or-runtime", config: { backend: "cpu", contextSize: 4_096, gpuLayers: 0, threads: 0, maxOutputTokens: 2_048, reasoning: false }, status: "ready", createdAt: Date.now(), updatedAt: Date.now() }],
  }), "utf8");
  const migrations = [];
  const manager = new LocalModelManager({ cachePath, emit() {}, piBusy: () => false, reloadPi: async () => undefined, migrateModelReferences: async (previous, next) => migrations.push([previous, next]) });
  try {
    await manager.initialize();
    assert.equal(manager.snapshot().activeModelId, undefined);
    assert.equal(manager.snapshot().models[0].compatibility, "unverified");
    assert.deepEqual(migrations, [[modelId, undefined]]);
    const providers = JSON.parse(await readFile(join(process.env.HOME, ".pi", "agent", "models.json"), "utf8")).providers;
    assert.equal(providers[LOCAL_MODEL_PROVIDER_ID], undefined);
  } finally {
    await manager.shutdown().catch(() => undefined);
    process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("clears an interrupted provisioning error after the pinned runtime is complete", { skip: process.platform !== "linux" || process.arch !== "x64" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-k-provision-recovery-"));
  const previousHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  const cachePath = join(root, "cache");
  const modelId = "recovered-model";
  const modelDirectory = join(cachePath, "local-models", "models", modelId);
  const modelPath = join(modelDirectory, "recovered.gguf");
  const runtimeDirectory = join(cachePath, "local-models", "runtime", LLAMA_CPP_BUILD, "cpu");
  const registryPath = join(cachePath, "local-models", "registry.json");
  await mkdir(modelDirectory, { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true });
  const modelBytes = ggufFixture();
  const digest = createHash("sha256").update(modelBytes).digest("hex");
  await writeFile(modelPath, modelBytes);
  await writeFile(join(runtimeDirectory, "llama-server"), "fixture");
  await writeFile(join(runtimeDirectory, ".agent-k-runtime.json"), JSON.stringify({ build: LLAMA_CPP_BUILD, backend: "cpu", assets: [{ name: LLAMA_RUNTIME_ASSETS["linux-cpu"].name, sha256: LLAMA_RUNTIME_ASSETS["linux-cpu"].sha256 }] }));
  const interrupted = "Unable to provision the official llama.cpp runtime: This operation was aborted";
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    downloads: [],
    models: [{ id: modelId, name: "Recovered", source: "import", files: [{ name: "recovered.gguf", path: modelPath, size: modelBytes.length, sha256: digest }], size: modelBytes.length, sha256: digest, architecture: "llama", compatibility: "unverified", compatibilityError: interrupted, config: { backend: "cpu", contextSize: 4_096, gpuLayers: 0, threads: 0, maxOutputTokens: 2_048, reasoning: false }, status: "failed", error: interrupted, createdAt: Date.now(), updatedAt: Date.now() }],
  }));
  const manager = new LocalModelManager({ cachePath, emit() {}, piBusy: () => false, reloadPi: async () => undefined, migrateModelReferences: async () => undefined });
  try {
    await manager.initialize();
    const recovered = manager.snapshot().models[0];
    assert.equal(recovered.status, "ready");
    assert.equal(recovered.compatibility, "unverified");
    assert.equal(recovered.error, undefined);
    assert.equal(recovered.compatibilityError, undefined);
  } finally {
    await manager.shutdown().catch(() => undefined);
    process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("does not classify an official runtime provisioning failure as model tool incompatibility", { skip: process.platform !== "linux" || process.arch !== "x64" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-k-runtime-provision-failure-"));
  const previousHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  const runtimeHub = createServer((_request, response) => { response.statusCode = 404; response.end(); });
  const port = await listen(runtimeHub);
  const manager = new LocalModelManager({ cachePath: join(root, "cache"), emit() {}, piBusy: () => false, reloadPi: async () => undefined, migrateModelReferences: async () => undefined, endpoints: { github: `http://127.0.0.1:${port}/` } });
  try {
    await manager.initialize();
    const source = join(root, "provisioning.gguf");
    await writeFile(source, ggufFixture());
    const id = await manager.importGguf(source);
    await manager.updateConfig(id, { backend: "cpu", contextSize: 4_096 });
    await assert.rejects(manager.verify(id), /official llama\.cpp runtime.*HTTP 404/i);
    const model = manager.snapshot().models.find((item) => item.id === id);
    assert.equal(model.compatibility, "unverified");
    assert.equal(model.status, "failed");
  } finally {
    await manager.shutdown().catch(() => undefined);
    await new Promise((resolve) => runtimeHub.close(resolve));
    process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("copies a complete imported GGUF shard group into the private model library", { skip: process.platform !== "linux" || process.arch !== "x64" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-k-shard-import-"));
  const previousHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  const source = join(root, "source"); await mkdir(source, { recursive: true });
  const first = join(source, "fixture-00001-of-00002.gguf");
  const second = join(source, "fixture-00002-of-00002.gguf");
  await writeFile(first, ggufFixture()); await writeFile(second, Buffer.from("shard-two"));
  const manager = new LocalModelManager({ cachePath: join(root, "cache"), emit() {}, piBusy: () => false, reloadPi: async () => undefined, migrateModelReferences: async () => undefined });
  try {
    await manager.initialize();
    const id = await manager.importGguf(second);
    const model = manager.snapshot().models.find((item) => item.id === id);
    assert.deepEqual(model.files.map((file) => file.name), ["fixture-00001-of-00002.gguf", "fixture-00002-of-00002.gguf"]);
    assert.ok(model.files.every((file) => file.path.includes(join("local-models", "models", id))));
    const missing = join(source, "missing-00001-of-00002.gguf"); await writeFile(missing, ggufFixture());
    await assert.rejects(manager.importGguf(missing), /complete GGUF shard group/);
  } finally {
    await manager.shutdown().catch(() => undefined); process.env.HOME = previousHome; await rm(root, { recursive: true, force: true });
  }
});
