import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cachedCompilationDatabase,
  cmakeConfigurationSnapshot,
  findProjectCompilationDatabase,
  prepareClangdCompilationDatabase,
  recordCompilationDatabase,
} from "./cmake-cache.ts";
import {
  DEFAULT_VSWHERE_PATH,
  managedToolchainArchives,
  managedToolchainMarker,
  parseWindowsEnvironment,
  toolchainArchiveFormat,
} from "./toolchain.ts";

test("uses the standard Visual Studio Installer path when vswhere is not discoverable", () => {
  assert.equal(DEFAULT_VSWHERE_PATH, "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe");
});

test("uses standalone clangd on Linux and Windows", () => {
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
});

test("parses the Visual Studio developer environment without pseudo variables", () => {
  assert.deepEqual(parseWindowsEnvironment("Path=C:\\VS\\bin;C:\\Windows\r\nINCLUDE=C:\\VS\\include\r\n=C:=C:\\work\r\n"), {
    Path: "C:\\VS\\bin;C:\\Windows",
    INCLUDE: "C:\\VS\\include",
  });
});

test("routes ZIP tool archives away from tar", () => {
  assert.equal(toolchainArchiveFormat("ninja-linux.zip"), "zip");
  assert.equal(toolchainArchiveFormat("clangd-linux-22.1.6.ZIP"), "zip");
  assert.equal(toolchainArchiveFormat("cmake-linux.tar.gz"), "tar");
  assert.equal(toolchainArchiveFormat("llvm.tar.xz"), "tar");
  assert.throws(() => toolchainArchiveFormat("download.html"), /Unsupported toolchain archive/);
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
