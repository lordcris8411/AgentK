import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
const { CppService } = await import("./dist/worker.js") as { CppService: typeof import("./worker.ts").CppService };

const enabled = process.env.AGENT_K_CPP_COLD_INTEGRATION === "1";

test(`cold C++ load, semantics, private build and CodeLLDB debug on ${process.platform} x64`, { skip: !enabled, timeout: 1_800_000 }, async (context) => {
  assert.ok(process.platform === "win32" || process.platform === "linux");
  assert.equal(process.arch, "x64");
  const parent = await mkdtemp(join(tmpdir(), "agent-k-cpp-integration-"));
  const root = join(parent, "source");
  const externalCache = process.env.AGENT_K_CPP_INTEGRATION_CACHE;
  const cache = externalCache ? resolve(externalCache) : join(parent, "agent-k-cache");
  await mkdir(root, { recursive: true });
  let service: InstanceType<typeof CppService> | undefined;
  context.after(async () => { await service?.shutdown(); await rm(parent, { force: true, recursive: true }); });
  await writeFile(join(root, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)\nproject(agent_k_cpp_integration LANGUAGES CXX)\nadd_executable(agent_k_cpp main.cpp)\nset_property(TARGET agent_k_cpp PROPERTY CXX_STANDARD 17)\n");
  const source = join(root, "main.cpp");
  await writeFile(source, "#include <chrono>\n#include <thread>\nint answer() { return 42; }\nint main() { std::this_thread::sleep_for(std::chrono::seconds(30)); return answer() == 42 ? 0 : 1; }\n");
  const original = (await readdir(root)).sort();
  const systemTools = Object.fromEntries([
    ["cmake", process.env.AGENT_K_CPP_SYSTEM_CMAKE],
    ["ninja", process.env.AGENT_K_CPP_SYSTEM_NINJA],
    ["clangd", process.env.AGENT_K_CPP_SYSTEM_CLANGD],
    [process.platform === "win32" ? "compiler-windows" : "compiler-linux", process.env.AGENT_K_CPP_SYSTEM_COMPILER],
  ].flatMap(([id, command]) => command ? [[id, { command: resolve(command) }]] : []));
  service = new CppService(cache, (event) => {
    if (event.type === "language_pack_confirmation_request" && typeof event.requestId === "string") service?.respondConfirmation(event.requestId, true);
  }, systemTools);
  const loaded = await service.load(root);
  assert.ok(loaded.status === "ready" || loaded.status === "indexing", loaded.error);
  const uri = pathToFileURL(source).href;
  assert.equal(await service.notify(source, "textDocument/didOpen", { textDocument: { uri, languageId: "cpp", version: 1, text: await readFile(source, "utf8") } }), true);
  const hover = await service.lsp(source, "textDocument/hover", { textDocument: { uri }, position: { line: 2, character: 5 } });
  assert.notEqual(hover, undefined);
  const built = await service.agent({ action: "build", workspace: root, profile: "Debug" }) as { code?: unknown; stderr?: unknown };
  assert.equal(built.code, 0, JSON.stringify(built, undefined, 2));
  const configurations = await service.debugConfigurations(root, undefined, false, "Debug");
  const target = configurations.find((item) => item.name === "agent_k_cpp");
  assert.ok(target, "private CMake output did not produce a debug target");
  const debug = await service.debugStart({ mode: "launch", root, stopOnEntry: true, targetId: target.id });
  assert.ok(["running", "stopped"].includes(debug.state), debug.error);
  await service.debugStop(debug.sessionId);
  await service.unload(root);
  assert.deepEqual((await readdir(root)).sort(), original, "source tree acquired generated output");
  await service.shutdown();
  service = undefined;
});
