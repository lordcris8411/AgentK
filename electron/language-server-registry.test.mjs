import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { discoverLanguageServerPlugins } from "../.electron-dist/language-server-registry.js";

async function fixture(manifest) {
  const directory = await mkdtemp(join(tmpdir(), "agent-k-language-plugin-"));
  const plugin = join(directory, "example");
  await mkdir(plugin, { recursive: true });
  await writeFile(join(plugin, "worker.js"), "process.on('message', () => undefined);\n");
  await writeFile(join(plugin, "agent-k.language-server.json"), JSON.stringify(manifest));
  return { directory, remove: () => rm(directory, { force: true, recursive: true }) };
}

test("discovers a trusted native language-server manifest", async () => {
  const source = await fixture({
    apiVersion: 1,
    displayName: "Example language server",
    id: "example-lsp",
    languages: ["example"],
    projectMarkers: ["example.config"],
    commands: [{ id: "active-example-projects", title: "Active Example projects", kind: "project-manager" }],
    worker: "worker.js",
    debugServer: { protocol: "dap", adapters: [{ command: "example-debug", platforms: ["win32"] }], providers: [{ id: "example-debug", label: "Example", languages: ["example"], fileExtensions: [".example"], projectMarkers: ["example.config"], modes: ["launch", "attach"], priority: 50 }] },
  });
  try {
    const plugins = await discoverLanguageServerPlugins(source.directory);
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0]?.id, "example-lsp");
    assert.deepEqual(plugins[0]?.debugServer?.adapters, [{ command: "example-debug", platforms: ["win32"] }]);
    assert.deepEqual(plugins[0]?.debugServer?.providers[0], { id: "example-debug", label: "Example", languages: ["example"], fileExtensions: [".example"], projectMarkers: ["example.config"], modes: ["launch", "attach"], priority: 50 });
    assert.deepEqual(plugins[0]?.commands, [{ id: "active-example-projects", title: "Active Example projects", kind: "project-manager" }]);
  } finally { await source.remove(); }
});

test("rejects worker paths escaping the trusted plugin package", async () => {
  const source = await fixture({ apiVersion: 1, displayName: "Unsafe", id: "unsafe", languages: ["unsafe"], projectMarkers: ["x"], worker: "../worker.js" });
  try { assert.deepEqual(await discoverLanguageServerPlugins(source.directory), []); }
  finally { await source.remove(); }
});
