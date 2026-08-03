import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cachedCompilationDatabase,
  cmakeConfigurationSnapshot,
  findProjectCompilationDatabase,
  isCMakeConfigurationPath,
  prepareClangdCompilationDatabase,
  privateClangdIndexDirectory,
  recordCompilationDatabase,
} from "./cmake-cache.ts";

import {
  findToolchainExecutable,
  managedDebuggerArchive,
  managedDebuggerExecutable,
  managedDebuggerMarker,
  managedToolchainArchives,
  managedToolchainDownloadPrompt,
  managedToolchainMarker,
  toolchainArchiveFormat,
} from "./toolchain.ts";
import { selectWorkspaceSymbols } from "./skill-symbols.ts";
import { languageSkillStatusState, languageSkillUsable } from "./skill-status.ts";
import { cmakeBuildCommand } from "./build-command.ts";

test("project build commands honor the selected CMake profile", () => {
  const command = cmakeBuildCommand("C:\\source", "C:\\source\\build", "Release", "win32");
  assert.match(command, /-DCMAKE_BUILD_TYPE=Release/);
  assert.match(command, /--config Release/);
  assert.match(command, /\$LASTEXITCODE/);
});

test("pairs the clangd index with the private CMake build cache key", () => {
  assert.equal(
    privateClangdIndexDirectory(join("cache", "language-servers", "cpp-clangd"), join("cache", "language-servers", "cpp-clangd", "cpp-build", "workspace-hash")),
    join("cache", "language-servers", "cpp-clangd", "cpp-index", "workspace-hash"),
  );
});

test("allows C++ Language Skill queries during indexing and marks results partial", () => {
  assert.equal(languageSkillUsable("indexing", true), true);
  assert.equal(languageSkillUsable("ready", true), true);
  assert.equal(languageSkillUsable("starting", true), false);
  assert.equal(languageSkillUsable("indexing", false), false);

  const partial = languageSkillStatusState("indexing");
  assert.equal(partial.status, "indexing");
  assert.equal(partial.indexReady, false);
  assert.equal(partial.partial, true);
  assert.match(String(partial.warning), /empty result is not authoritative/);

  const complete = languageSkillStatusState("ready");
  assert.equal(complete.status, "ready");
  assert.equal(complete.indexReady, true);
  assert.equal(complete.partial, false);
  assert.equal("warning" in complete, false);
});

test("selects only exact clangd workspace symbols for semantic skill actions", () => {
  const range = { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } };
  const symbols = [
    { name: "render", containerName: "Renderer", kind: 6, location: { uri: "file:///project/render.cpp", range } },
    { name: "rendererState", kind: 13, location: { uri: "file:///project/state.cpp", range } },
    { name: "RenderState", kind: 23, location: { uri: "file:///project/state.hpp", range } },
  ];

  assert.deepEqual(selectWorkspaceSymbols(symbols, "Renderer::render").map((item) => item.name), ["render"]);
  assert.deepEqual(selectWorkspaceSymbols(symbols, "render").map((item) => item.name), ["render"]);
  assert.deepEqual(selectWorkspaceSymbols(symbols, "renderer"), []);
  assert.deepEqual(selectWorkspaceSymbols(symbols, "RenderState", true).map((item) => item.name), ["RenderState"]);
  assert.deepEqual(selectWorkspaceSymbols(symbols, "render", true), []);
});

test("pins standalone clangd and a complete managed LLVM compiler toolchain", () => {
  const linux = managedToolchainArchives("linux");
  const windows = managedToolchainArchives("win32");

  assert.equal(linux.clangd.owner, "clangd");
  assert.equal(linux.clangd.repository, "clangd");
  assert.equal(linux.clangd.asset, "clangd-linux-22.1.6.zip");
  assert.equal(windows.clangd.owner, "clangd");
  assert.equal(windows.clangd.asset, "clangd-windows-22.1.6.zip");
  assert.doesNotMatch(linux.clangd.asset, /LLVM-Linux|clang\+llvm/i);
  assert.doesNotMatch(windows.clangd.asset, /LLVM-Linux|clang\+llvm/i);
  assert.match(managedToolchainMarker("win32"), /clangd-windows-22\.1\.6\.zip/);
  assert.equal(windows.llvm.owner, "mstorsjo");
  assert.equal(windows.llvm.repository, "llvm-mingw");
  assert.equal(windows.llvm.asset, "llvm-mingw-20260616-ucrt-x86_64.zip");
  assert.equal(windows.llvm.bytes, 187_504_083);
  assert.equal(linux.llvm.owner, "llvm");
  assert.equal(linux.llvm.repository, "llvm-project");
  assert.equal(linux.llvm.asset, "LLVM-22.1.8-Linux-X64.tar.xz");
  assert.match(managedToolchainMarker("win32"), /llvm-mingw-20260616-ucrt-x86_64\.zip/);
});

test("pins a private portable CodeLLDB debugger for supported desktop platforms", () => {
  const archive = managedDebuggerArchive("linux", "x64");
  assert.equal(archive?.owner, "vadimcn");
  assert.equal(archive?.repository, "codelldb");
  assert.equal(archive?.asset, "codelldb-linux-x64.vsix");
  assert.equal(archive?.sha256, "b85b45a8570051d535b0927c6c9da11c39f3a056c73559064647faf7f37f637d");
  assert.match(managedDebuggerMarker("linux", "x64") ?? "", /codelldb-linux-x64\.vsix/);
  assert.equal(managedDebuggerArchive("darwin", "x64")?.asset, "codelldb-darwin-x64.vsix");
  assert.equal(managedDebuggerArchive("darwin", "arm64")?.asset, "codelldb-darwin-arm64.vsix");
  assert.equal(managedDebuggerArchive("win32", "x64")?.asset, "codelldb-win32-x64.vsix");
  assert.equal(managedDebuggerArchive("win32", "x64")?.sha256, "aa3f45175da3850973632fef1a1af0ed2382866bfd3dcd836544973831388a25");
  assert.equal(managedDebuggerExecutable("win32"), "codelldb.exe");
  assert.equal(managedDebuggerExecutable("linux"), "codelldb");
});

test("routes ZIP tool archives away from tar", () => {
  assert.equal(toolchainArchiveFormat("ninja-linux.zip"), "zip");
  assert.equal(toolchainArchiveFormat("clangd-linux-22.1.6.ZIP"), "zip");
  assert.equal(toolchainArchiveFormat("codelldb-linux-x64.vsix"), "zip");
  assert.equal(toolchainArchiveFormat("cmake-linux.tar.gz"), "tar");
  assert.equal(toolchainArchiveFormat("llvm.tar.xz"), "tar");
  assert.throws(() => toolchainArchiveFormat("download.html"), /Unsupported toolchain archive/);
});

test("finds preferred toolchain executables without traversing the extracted LLVM tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-k-toolchain-"));
  try {
    await mkdir(join(root, "bin"));
    const executable = join(root, "bin", "clang");
    await writeFile(executable, "");
    assert.equal(await findToolchainExecutable(root, "clang"), executable);
    if (process.platform !== "win32") {
      await rm(executable);
      await symlink("/bin/sh", executable);
      assert.equal(await findToolchainExecutable(root, "clang"), executable);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("describes the isolated LLVM download before provisioning", () => {
  const llvm = managedToolchainArchives("win32").llvm;
  const prompt = managedToolchainDownloadPrompt([{ archive: llvm, tool: "llvm" }]);
  assert.equal(prompt.title, "下载 C++ 工具链");
  assert.match(prompt.message, /LLVM\/Clang compiler \(178\.8 MB\)/);
  assert.match(prompt.message, /不会修改系统 PATH/);
});

test("reuses a fresh compilation database from a conventional project build directory", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agent-k-cmake-project-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const cmakeLists = join(root, "CMakeLists.txt");
  const build = join(root, "build");
  const commands = join(build, "compile_commands.json");
  await mkdir(build);
  await writeFile(cmakeLists, "project(example)\n", "utf8");
  await writeFile(commands, "[]\n", "utf8");
  await utimes(cmakeLists, new Date(1_000), new Date(1_000));
  await utimes(commands, new Date(2_000), new Date(2_000));

  const snapshot = await cmakeConfigurationSnapshot(root);
  assert.equal(await findProjectCompilationDatabase(root, snapshot), commands);
});

test("invalidates a compilation database after project CMake configuration changes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agent-k-cmake-stale-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const cmakeLists = join(root, "CMakeLists.txt");
  const build = join(root, "build");
  const commands = join(build, "compile_commands.json");
  await mkdir(build);
  await writeFile(cmakeLists, "project(example)\n", "utf8");
  await writeFile(commands, "[]\n", "utf8");
  await utimes(commands, new Date(2_000), new Date(2_000));
  await utimes(cmakeLists, new Date(3_000), new Date(3_000));

  const snapshot = await cmakeConfigurationSnapshot(root);
  assert.equal(await findProjectCompilationDatabase(root, snapshot), undefined);
});

test("fingerprints project CMake files but ignores generated build dependencies", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agent-k-cmake-fingerprint-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, "cmake"));
  await mkdir(join(root, "build", "_deps"), { recursive: true });
  await writeFile(join(root, "CMakeLists.txt"), "include(cmake/options.cmake)\n", "utf8");
  await writeFile(join(root, "cmake", "options.cmake"), "set(EXAMPLE ON)\n", "utf8");
  await writeFile(join(root, "build", "_deps", "CMakeLists.txt"), "project(generated)\n", "utf8");
  const initial = await cmakeConfigurationSnapshot(root);

  await writeFile(join(root, "build", "_deps", "CMakeLists.txt"), "project(changed_generated)\n", "utf8");
  assert.equal((await cmakeConfigurationSnapshot(root)).fingerprint, initial.fingerprint);
  await writeFile(join(root, "cmake", "options.cmake"), "set(EXAMPLE OFF)\n", "utf8");
  assert.notEqual((await cmakeConfigurationSnapshot(root)).fingerprint, initial.fingerprint);
});

test("classifies only project-owned CMake configuration changes", () => {
  const root = join(tmpdir(), "agent-k-cmake-project");
  assert.equal(isCMakeConfigurationPath(root, join(root, "CMakeLists.txt")), true);
  assert.equal(isCMakeConfigurationPath(root, join(root, "cmake", "options.cmake")), true);
  assert.equal(isCMakeConfigurationPath(root, join(root, "CMakePresets.json")), true);
  assert.equal(isCMakeConfigurationPath(root, join(root, "src", "main.cpp")), false);
  assert.equal(isCMakeConfigurationPath(root, join(root, "build", "_deps", "CMakeLists.txt")), false);
  assert.equal(isCMakeConfigurationPath(root, join(root, ".cache", "generated.cmake")), false);
  assert.equal(isCMakeConfigurationPath(root, join(root, "..", "CMakeLists.txt")), false);
});

test("persists the CMake fingerprint for Agent K compilation database caches", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agent-k-cmake-cache-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const build = join(root, ".agent-k-build");
  await mkdir(build);
  await writeFile(join(root, "CMakeLists.txt"), "project(example)\n", "utf8");
  const commands = join(build, "compile_commands.json");
  await writeFile(commands, "[]\n", "utf8");
  const initial = await cmakeConfigurationSnapshot(root);
  await recordCompilationDatabase(commands, initial);

  assert.equal(await cachedCompilationDatabase(build, initial), commands);
  await writeFile(join(root, "CMakeLists.txt"), "project(changed)\n", "utf8");
  assert.equal(await cachedCompilationDatabase(build, await cmakeConfigurationSnapshot(root)), undefined);
});

test("prepares a private clangd database without fetched dependency translation units", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agent-k-clangd-database-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const sourceBuild = join(root, "build");
  const target = join(root, ".agent-k-index");
  await mkdir(join(sourceBuild, "_deps", "library-src"), { recursive: true });
  await mkdir(join(root, "src"));
  const projectFile = join(root, "src", "main.cpp");
  const dependencyFile = join(sourceBuild, "_deps", "library-src", "library.cpp");
  const sourceCommands = join(sourceBuild, "compile_commands.json");
  await writeFile(sourceCommands, JSON.stringify([
    { command: "c++ -c main.cpp", directory: sourceBuild, file: projectFile },
    { command: "c++ -c library.cpp", directory: sourceBuild, file: dependencyFile },
  ]), "utf8");

  const prepared = await prepareClangdCompilationDatabase(root, sourceCommands, target);
  assert.equal(prepared.included, 1);
  assert.equal(prepared.excluded, 1);
  assert.deepEqual(JSON.parse(await readFile(prepared.commands, "utf8")), [
    { command: "c++ -c main.cpp", directory: sourceBuild, file: projectFile },
  ]);
});
