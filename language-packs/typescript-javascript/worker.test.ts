import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { extractOfficialNodeArchive, isolatedRuntimePath, JS_DEBUG_VERSION, NODE_VERSION, nodeArchive, npmScriptShell, packageScriptForAction, resolveTypeScriptWorkspaceFile, runProcess, systemTarExecutable, TYPESCRIPT_LANGUAGE_SERVER_VERSION, TYPESCRIPT_VERSION } from "./worker.ts";

async function download(url: string, path: string): Promise<void> {
  const response = await fetch(url);
  assert.equal(response.ok, true, `download failed: ${response.status} ${url}`);
  assert.ok(response.body);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(path));
}

test("pins supported private TypeScript toolchains", () => {
  assert.equal(NODE_VERSION, "24.18.1");
  assert.equal(TYPESCRIPT_LANGUAGE_SERVER_VERSION, "5.3.0");
  assert.equal(TYPESCRIPT_VERSION, "6.0.3");
  assert.equal(JS_DEBUG_VERSION, "1.117.0");
  assert.equal(nodeArchive("darwin", "x64"), undefined);
  assert.equal(nodeArchive("linux", "arm64"), undefined);
  assert.deepEqual(nodeArchive("win32", "x64")?.asset, "node-v24.18.1-win-x64.zip");
  assert.deepEqual(nodeArchive("linux", "x64")?.asset, "node-v24.18.1-linux-x64.tar.xz");
});

test("resolves archive extraction through an absolute declared platform tool", () => {
  assert.equal(isAbsolute(systemTarExecutable()), true);
});

test("routes package lifecycle actions through declared npm scripts", () => {
  const packageJson = { scripts: { build: "vite build", start: "vite", test: "node --test" } };
  assert.equal(packageScriptForAction(packageJson, "build"), "build");
  assert.equal(packageScriptForAction(packageJson, "run"), "start");
  assert.equal(packageScriptForAction(packageJson, "test"), "test");
  assert.equal(packageScriptForAction({ scripts: { build: "" } }, "build"), undefined);
  assert.equal(packageScriptForAction({}, "build"), undefined);
});

test("rejects TypeScript run and test files outside the selected workspace", () => {
  const workspace = resolve("workspace", "typescript");
  assert.equal(resolveTypeScriptWorkspaceFile(workspace, join("test", "app.test.ts")), join(workspace, "test", "app.test.ts"));
  assert.throws(() => resolveTypeScriptWorkspaceFile(workspace, join("..", "outside.test.js")), /escapes the workspace/u);
});

test("exposes only the selected Node and npm directories to package scripts", () => {
  assert.equal(
    isolatedRuntimePath("C:\\private-node\\node.exe", undefined, "win32"),
    "C:\\private-node",
  );
  assert.equal(
    isolatedRuntimePath("/cache/node/bin/node", "/usr/bin/npm", "linux"),
    "/cache/node/bin:/usr/bin",
  );
});

test("uses an absolute npm script shell outside the isolated Linux PATH", () => {
  assert.equal(npmScriptShell("linux", {}), "/bin/sh");
  assert.equal(npmScriptShell("win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" }), "C:\\Windows\\System32\\cmd.exe");
});

// This intentionally exercises cold downloads and the real extractors for both
// official layouts. Set AGENT_K_SKIP_NODE_ARCHIVE_SMOKE=1 only in an explicitly
// offline environment; release verification runs it without that override.
test("cold-extracts both official Node archive layouts and executes the host private Node", { skip: process.env.AGENT_K_SKIP_NODE_ARCHIVE_SMOKE === "1", timeout: 300_000 }, async (context) => {
  const cache = await mkdtemp(join(tmpdir(), "agent-k-typescript-node-smoke-"));
  context.after(() => rm(cache, { recursive: true, force: true }));
  const platform = process.platform === "win32" ? "win32" : "linux";
  {
    const archive = nodeArchive(platform, "x64")!;
    const archivePath = join(cache, archive.asset);
    await download(archive.url, archivePath);
    assert.equal(createHash("sha256").update(await readFile(archivePath)).digest("hex"), archive.sha256);
    const extracted = join(cache, `extracted-${platform}`);
    const executable = await extractOfficialNodeArchive(archivePath, extracted, archive);
    assert.equal(executable.endsWith(archive.executable), true);
    const result = await runProcess(executable, ["--version"], { cwd: extracted, env: { ...process.env }, timeout: 30_000 });
    assert.equal(result.stdout.trim(), `v${NODE_VERSION}`);
  }
});

test("manifest routes TSX/JSX and declares the pinned JavaScript DAP adapter", async () => {
  const manifest = JSON.parse(await readFile(new URL("./agent-k.language-pack.json", import.meta.url), "utf8")) as { debugServer?: { adapters?: Array<{ command?: string }> }; languages: string[]; permissions?: { workspaceWrite?: boolean }; projectMarkers: string[]; toolchains?: Array<{ id?: string; fallback?: { version?: string } }> };
  assert.deepEqual(manifest.languages, ["typescript", "typescriptreact", "javascript", "javascriptreact"]);
  assert.deepEqual(manifest.projectMarkers, ["tsconfig.json", "jsconfig.json", "package.json"]);
  assert.equal(manifest.debugServer?.adapters?.[0]?.command, "js-debug");
  assert.equal(manifest.permissions?.workspaceWrite, true);
  assert.equal(manifest.toolchains?.find(({ id }) => id === "js-debug")?.fallback?.version, JS_DEBUG_VERSION);
});

test("private lockfile contains pinned npm integrity metadata", async () => {
  const lock = JSON.parse(await readFile(new URL("./package-lock.private.json", import.meta.url), "utf8")) as { packages: Record<string, { integrity?: string; version?: string }> };
  assert.equal(lock.packages["node_modules/typescript"]?.version, "6.0.3");
  assert.match(lock.packages["node_modules/typescript"]?.integrity ?? "", /^sha512-/);
  assert.equal(lock.packages["node_modules/typescript-language-server"]?.version, "5.3.0");
  assert.match(lock.packages["node_modules/typescript-language-server"]?.integrity ?? "", /^sha512-/);
});
