import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cmakeDebugBuildDirectory, cmakeDebugTargets, cmakeProjectRoots, prioritizeCMakeProjectRoots } from "./cmake-debug.ts";

test("keeps managed CMake debug build paths short and isolated", () => {
  const cache = join("C:\\Users\\developer\\AppData\\Roaming\\com.example.agentk", "Cache", "language-servers", "cpp-clangd");
  const first = cmakeDebugBuildDirectory(cache, "D:\\project\\first", "toolchain-v1", "Debug");
  const second = cmakeDebugBuildDirectory(cache, "D:\\project\\second", "toolchain-v1", "Debug");
  const release = cmakeDebugBuildDirectory(cache, "D:\\project\\first", "toolchain-v1", "Release");

  assert.ok(first.length < cache.length + 22, first);
  assert.notEqual(first, second);
  assert.notEqual(first, release);
  assert.match(first, /[\\/]d[\\/][0-9a-f]{16}[\\/]d$/u);
  assert.match(release, /[\\/]d[\\/][0-9a-f]{16}[\\/]r$/u);
});

test("prioritizes the nested CMake project containing the active file", () => {
  const roots = ["/workspace/native", "/workspace/tools", "/workspace/site/native-addon"];
  assert.deepEqual(prioritizeCMakeProjectRoots(roots, "/workspace/site/native-addon/src/addon.cpp"), [
    "/workspace/site/native-addon", "/workspace/native", "/workspace/tools",
  ]);
  assert.deepEqual(prioritizeCMakeProjectRoots(roots), roots);
});

test("finds CMake projects below a container workspace", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "agent-k-cmake-workspace-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const app = join(workspace, "helloworld");
  await mkdir(join(app, "nested"), { recursive: true });
  await mkdir(join(workspace, "build", "ignored"), { recursive: true });
  await writeFile(join(app, "CMakeLists.txt"), "project(hello)");
  await writeFile(join(app, "nested", "CMakeLists.txt"), "project(nested)");
  await writeFile(join(workspace, "build", "ignored", "CMakeLists.txt"), "project(ignored)");

  assert.deepEqual(await cmakeProjectRoots(workspace), [await realpath(app)]);
});

test("reads and orders executable targets from the CMake File API", async (context) => {
  const build = await mkdtemp(join(tmpdir(), "agent-k-cmake-debug-"));
  context.after(() => rm(build, { recursive: true, force: true }));
  const reply = join(build, ".cmake", "api", "v1", "reply");
  await mkdir(reply, { recursive: true });
  await writeFile(join(reply, "index-test.json"), JSON.stringify({ reply: { "codemodel-v2": { jsonFile: "codemodel.json" } } }));
  await writeFile(join(reply, "codemodel.json"), JSON.stringify({ configurations: [{ targets: [
    { id: "tool::1", jsonFile: "target-tool.json", name: "tool" },
    { id: "library::1", jsonFile: "target-library.json", name: "library" },
    { id: "app::1", jsonFile: "target-app.json", name: "app" },
  ] }] }));
  await writeFile(join(reply, "target-tool.json"), JSON.stringify({ artifacts: [{ path: "bin/tool" }], name: "tool", type: "EXECUTABLE" }));
  await writeFile(join(reply, "target-app.json"), JSON.stringify({ artifacts: [{ path: "bin/app" }], name: "app", type: "EXECUTABLE" }));
  await writeFile(join(reply, "target-library.json"), JSON.stringify({ artifacts: [{ path: "lib/library.a" }], name: "library", type: "STATIC_LIBRARY" }));
  await mkdir(join(build, "bin"));
  await writeFile(join(build, "bin", "app"), "binary");

  assert.deepEqual(await cmakeDebugTargets(build), [
    { built: true, id: "app::1", name: "app", program: join(build, "bin", "app") },
    { built: false, id: "tool::1", name: "tool", program: join(build, "bin", "tool") },
  ]);
});

test("rejects CMake artifacts that escape the build directory", async (context) => {
  const build = await mkdtemp(join(tmpdir(), "agent-k-cmake-debug-escape-"));
  context.after(() => rm(build, { recursive: true, force: true }));
  const reply = join(build, ".cmake", "api", "v1", "reply");
  await mkdir(reply, { recursive: true });
  await writeFile(join(reply, "index-test.json"), JSON.stringify({ reply: { "codemodel-v2": { jsonFile: "codemodel.json" } } }));
  await writeFile(join(reply, "codemodel.json"), JSON.stringify({ configurations: [{ targets: [{ id: "bad::1", jsonFile: "target.json", name: "bad" }] }] }));
  await writeFile(join(reply, "target.json"), JSON.stringify({ artifacts: [{ path: "../outside" }], name: "bad", type: "EXECUTABLE" }));
  assert.deepEqual(await cmakeDebugTargets(build), []);
});
