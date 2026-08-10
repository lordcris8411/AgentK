import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import {
  CSHARP_LS_VERSION,
  DOTNET_SDK_VERSION,
  NETCOREDBG_VERSION,
  directCSharpProjects,
  managedArchives,
  privateChildEnvironment,
  privateProjectPaths,
  type CSharpProject,
} from "./worker.ts";

function requireReady(result: CSharpProject | undefined): CSharpProject {
  if (!result || result.status === "failed") throw new Error(result?.error ?? "C# lifecycle did not return a project");
  assert.equal(result.status, "ready");
  return result;
}

test("pins official .NET, csharp-ls, and netcoredbg archives for Windows/Linux x64", () => {
  assert.equal(DOTNET_SDK_VERSION, "10.0.302");
  assert.equal(CSHARP_LS_VERSION, "0.26.0");
  assert.equal(NETCOREDBG_VERSION, "3.2.0-1092");
  const windows = managedArchives("win32", "x64");
  const linux = managedArchives("linux", "x64");
  assert.match(windows?.sdk.url ?? "", /dotnet-sdk-10\.0\.302-win-x64\.zip$/u);
  assert.equal(windows?.sdk.hashAlgorithm, "sha512");
  assert.equal(windows?.sdk.hash.length, 128);
  assert.match(linux?.sdk.url ?? "", /dotnet-sdk-10\.0\.302-linux-x64\.tar\.gz$/u);
  assert.equal(linux?.sdk.hashAlgorithm, "sha512");
  assert.equal(linux?.sdk.hash.length, 128);
  assert.equal(windows?.csharpLs.hash, "2b03987aef07bb708bfe56a7bfb370364c7c8203e69aa677a37594bbe21a15b0");
  assert.equal(linux?.csharpLs.url, windows?.csharpLs.url);
  assert.equal(windows?.debugger.hash, "3c410a45fa502415203a94fcb88654af65bf8e3dac158a5527a722e7a6b9274a");
  assert.equal(linux?.debugger.hash, "080eb3b2d2152465f599d3b33d1ee6e747794e11cc0a3773ec689f5e5f2c5afa");
  assert.equal(managedArchives("darwin", "x64"), undefined);
  assert.equal(managedArchives("linux", "arm64"), undefined);
});

test("recognizes only .sln and .csproj direct children", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agent-k-csharp-markers-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "Example.sln"), "");
  await writeFile(join(root, "Library.CSPROJ"), "");
  await writeFile(join(root, "nested", "Ignored.csproj"), "");
  assert.deepEqual((await directCSharpProjects(root)).map((path) => relative(root, path)).sort(), ["Example.sln", "Library.CSPROJ"]);
});

test("constructs a child-only private dotnet environment and project-specific generated paths", () => {
  const cache = resolve("agent-k-cache", "language-packs", "csharp-ls");
  const first = privateProjectPaths(cache, resolve("workspace", "first"));
  const second = privateProjectPaths(cache, resolve("workspace", "second"));
  assert.notEqual(first.build, second.build);
  for (const path of Object.values(first)) assert.equal(relative(cache, path).startsWith(".."), false, path);
  const toolchain = { root: join(cache, "tools", "dotnet"), dotnet: join(cache, "tools", "dotnet", "dotnet"), csharpLs: join(cache, "tools", "csharp-ls.dll"), debugger: join(cache, "tools", "netcoredbg") };
  const environment = privateChildEnvironment(toolchain, first, { PATH: "GLOBAL-PATH", SystemRoot: "C:\\Windows" });
  assert.equal(environment.PATH, toolchain.root);
  assert.equal(environment.DOTNET_ROOT, toolchain.root);
  assert.equal(environment.DOTNET_CLI_HOME, first.cliHome);
  assert.equal(environment.NUGET_PACKAGES, first.nuget);
  assert.equal(environment.DOTNET_MULTILEVEL_LOOKUP, "0");
  assert.match(environment.BaseOutputPath ?? "", /projects[/\\][a-f0-9]{64}[/\\]build/u);
  assert.match(environment.BaseIntermediateOutputPath ?? "", /MSBuildProjectName/u);
  assert.match(environment.MSBuildProjectExtensionsPath ?? "", /MSBuildProjectName/u);
  assert.equal(environment.TEMP, first.temp);
});

test("lifecycle acceptance rejects a resolved failed load or status result", () => {
  assert.throws(() => requireReady({ root: "project", name: "project", status: "failed", error: "probe failed" }), /probe failed/u);
  assert.throws(() => requireReady(undefined), /did not return/u);
  assert.equal(requireReady({ root: "project", name: "project", status: "ready" }).status, "ready");
});
