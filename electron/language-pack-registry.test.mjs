import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { discoverLanguagePacks, LanguagePackRegistry, validateLanguagePackDirectory } from "../.electron-dist/language-pack-registry.js";
import { LanguagePackToolchainManager } from "../.electron-dist/language-pack-toolchains.js";

async function fixture(manifest, workerSource = "process.on('message', (m) => { if (m?.type !== 'request') return; process.send?.({ type: 'response', id: m.id, result: m.method === 'list' ? [] : undefined }); if (m.method === 'shutdown') process.disconnect?.(); });\n") {
  const directory = await mkdtemp(join(tmpdir(), "agent-k-language-plugin-"));
  const plugin = join(directory, "example");
  await mkdir(plugin, { recursive: true });
  await writeFile(join(plugin, "worker.js"), workerSource);
  await writeFile(join(plugin, "agent-k.language-pack.json"), JSON.stringify(manifest));
  return { directory, plugin, remove: () => rm(directory, { force: true, recursive: true }) };
}

function validManifest(overrides = {}) {
  return {
    apiVersion: 1, kind: "language-pack", version: "1.0.0", displayName: "Example", id: "example-pack", platforms: [process.platform],
    languages: ["example"], fileExtensions: [".example"], projectMarkers: ["example.config"],
    actions: [{ id: "project.list", method: "agent", description: "List projects.", parameters: { type: "object" } }],
    editorContribution: { id: "example-text", name: "Example text", description: "Example text editing.", version: "1.0.0", editorPluginId: "agent-k.text" },
    skills: [{ name: "example-tools", markdown: "---\nname: example-tools\ndescription: Use the example pack.\n---\n" }],
    permissions: { externalTools: ["example", "example-debug"], network: false, processes: true, workspaceWrite: false },
    toolchains: [{ id: "example", system: { commands: ["example"], versionRange: ">=1 <2" } }], worker: "worker.js", ...overrides,
  };
}

test("probes Windows command scripts without child_process shell mode", { skip: process.platform !== "win32" }, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-k-command-probe-"));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const command = join(directory, "fixture.cmd");
  await writeFile(command, "@echo 1.2.3\r\n", "utf8");
  const manager = new LanguagePackToolchainManager({
    toolchains: [{ id: "fixture", system: { commands: [command], versionRange: ">=1 <2" } }],
  });
  const tools = await manager.resolveSystemTools();
  assert.equal(tools.fixture?.version, "1.2.3");
  assert.equal(tools.fixture?.command, command);
});

test("discovers a trusted Language Pack manifest", async () => {
  const source = await fixture({
    apiVersion: 1,
    kind: "language-pack",
    version: "1.0.0",
    displayName: "Example Language Pack",
    id: "example-lsp",
    platforms: [process.platform],
    languages: ["example"],
    fileExtensions: [".example"],
    projectMarkers: ["example.config"],
    actions: [{ id: "project.list", method: "agent", description: "List projects.", parameters: { type: "object" } }],
    editorContribution: { id: "example-text", name: "Example text", description: "Example text editing.", version: "1.0.0", editorPluginId: "agent-k.text" },
    skills: [{ name: "example-tools", markdown: "---\nname: example-tools\ndescription: Use the example Language Pack.\n---\n" }],
    permissions: { externalTools: ["example", "example-debug"], network: false, processes: true, workspaceWrite: false },
    toolchains: [{ id: "example", system: { commands: ["example"], versionRange: ">=1 <2" } }],
    projectMenu: {
      loadLabel: "Load example",
      unloadLabel: "Unload example",
      actions: [{ id: "build", label: "Build", method: "terminalCommand", defaultProfile: "Debug", profiles: [{ id: "Debug", label: "Debug" }, { id: "Release", label: "Release" }] }],
    },
    commands: [{ id: "active-example-projects", title: "Active Example projects", kind: "project-manager" }],
    worker: "worker.js",
    debugServer: { protocol: "dap", prepareMethod: "debugPrepare", adapters: [{ command: "example-debug", platforms: ["win32"] }], providers: [{ id: "example-debug", label: "Example", languages: ["example"], fileExtensions: [".example"], projectMarkers: ["example.config"], modes: ["launch", "attach"], priority: 50 }] },
  });
  try {
    const plugins = await discoverLanguagePacks(source.directory);
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0]?.id, "example-lsp");
    assert.deepEqual(plugins[0]?.debugServer?.adapters, [{ command: "example-debug", platforms: ["win32"] }]);
    assert.equal(plugins[0]?.debugServer?.prepareMethod, "debugPrepare");
    assert.deepEqual(plugins[0]?.debugServer?.providers[0], { id: "example-debug", label: "Example", languages: ["example"], fileExtensions: [".example"], projectMarkers: ["example.config"], modes: ["launch", "attach"], priority: 50 });
    assert.deepEqual(plugins[0]?.commands, [{ id: "active-example-projects", title: "Active Example projects", kind: "project-manager" }]);
    assert.deepEqual(plugins[0]?.projectMenu?.actions?.[0], { id: "build", label: "Build", method: "terminalCommand", defaultProfile: "Debug", profiles: [{ id: "Debug", label: "Debug" }, { id: "Release", label: "Release" }] });
  } finally { await source.remove(); }
});

test("hot upgrade preserves the active pack when a newer worker fails its cold contract", async () => {
  const first = await fixture(validManifest());
  const second = await fixture(validManifest({ version: "1.1.0" }));
  const broken = await fixture(validManifest({ version: "1.2.0" }), "process.on('message', () => process.exit(7));\n");
  const state = await mkdtemp(join(tmpdir(), "agent-k-language-pack-upgrade-"));
  const registry = new LanguagePackRegistry(join(state, "bundled"), join(state, "installed"), join(state, "cache"), () => undefined);
  try {
    await registry.initialize();
    const firstPreview = await registry.preview(first.plugin);
    await registry.install(first.plugin, firstPreview.approvalToken);
    const secondPreview = await registry.preview(second.plugin);
    await registry.install(second.plugin, secondPreview.approvalToken);
    assert.equal(registry.list()[0]?.version, "1.1.0");
    await registry.setEnabled("example-pack", false);
    await registry.setEnabled("example-pack", true);
    assert.deepEqual(await registry.call("example-pack", "list"), []);
    const brokenPreview = await registry.preview(broken.plugin);
    await assert.rejects(() => registry.install(broken.plugin, brokenPreview.approvalToken), /exited|stopped|closed/u);
    assert.equal(registry.list()[0]?.version, "1.1.0");
    assert.deepEqual(await registry.call("example-pack", "list"), []);
  } finally {
    await registry.shutdown();
    await Promise.all([first.remove(), second.remove(), broken.remove(), rm(state, { force: true, recursive: true })]);
  }
});

test("requires preview approval and atomically exposes installed pack Skills", async () => {
  const source = await fixture(validManifest()); const state = await mkdtemp(join(tmpdir(), "agent-k-language-pack-state-"));
  const registry = new LanguagePackRegistry(join(state, "bundled"), join(state, "installed"), join(state, "cache"), () => undefined);
  try {
    await registry.initialize();
    await assert.rejects(() => registry.install(source.plugin, "missing"), /user-approved preview/u);
    const preview = await registry.preview(source.plugin); assert.equal(preview.id, "example-pack");
    const installed = await registry.install(source.plugin, preview.approvalToken); assert.equal(installed.enabled, true);
    assert.equal(registry.list()[0]?.id, "example-pack");
    assert.equal((await registry.skillDirectories()).length, 1);
    await registry.setEnabled("example-pack", false); assert.equal((await registry.skillDirectories()).length, 0);
    await registry.uninstall("example-pack"); assert.equal(registry.list().length, 0);
  } finally { await registry.shutdown(); await source.remove(); await rm(state, { force: true, recursive: true }); }
});

test("rejects duplicate actions, missing Skills, unsupported action schema, and undeclared fallback permissions", async () => {
  for (const manifest of [
    validManifest({ actions: [validManifest().actions[0], validManifest().actions[0]] }),
    validManifest({ skills: [] }),
    validManifest({ actions: [{ id: "project.list", method: "agent", description: "List.", parameters: { type: "string" } }] }),
    validManifest({ toolchains: [{ id: "example", fallback: { version: "1.0.0", platforms: { [process.platform]: { url: "https://example.invalid/tool.zip", sha256: "a".repeat(64) } } } }] }),
  ]) {
    const source = await fixture(manifest);
    try { await assert.rejects(() => validateLanguagePackDirectory(source.plugin), /Language Pack/u); } finally { await source.remove(); }
  }
});

test("rejects worker paths escaping the trusted pack", async () => {
  const source = await fixture({ ...validManifest({ id: "unsafe", languages: ["unsafe"], fileExtensions: [".unsafe"], projectMarkers: ["x"] }), worker: "../worker.js" });
  try { assert.deepEqual(await discoverLanguagePacks(source.directory), []); }
  finally { await source.remove(); }
});
