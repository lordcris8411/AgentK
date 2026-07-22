import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  editorPluginDependencyFilePath,
  getEditorPluginDependency,
  loadFirstPartyFileFormatPlugins,
} from "../.electron-dist/file-formats.js";

const skill = `---
name: test-editor
description: Strict Editor package test
---

# Test
`;

async function fixture(files) {
  const directory = await mkdtemp(join(tmpdir(), "agent-k-editor-test-"));
  const plugin = join(directory, "test");
  await mkdir(plugin, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const target = join(plugin, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  return { directory, remove: () => rm(directory, { force: true, recursive: true }) };
}

test("loads only a complete programmable API v1 Editor", async () => {
  const source = await fixture({
    "SKILL.md": skill,
    "editor.ts": "export {};",
    "editor.json": JSON.stringify({
      apiVersion: 1,
      editor: "plugin",
      id: "test.editor",
      languageId: "test-language",
      match: {
        absolutePaths: ["/opt/test/fixture.test", "C:\\test\\fixture.test"],
        extensions: ["test"],
        fileNames: ["fixture.test"],
        mimeTypes: ["application/x-test", "text/*"],
      },
      name: "Test Editor",
      runtime: { entry: "dist/editor.js" },
    }),
    "dist/editor.js": "(() => undefined)();",
  });
  try {
    const plugins = await loadFirstPartyFileFormatPlugins(source.directory);
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0]?.editor, "plugin");
    assert.equal(plugins[0]?.apiVersion, 1);
    assert.equal(plugins[0]?.languageId, "test-language");
    assert.deepEqual(plugins[0]?.match, {
      absolutePaths: ["/opt/test/fixture.test", "C:\\test\\fixture.test"],
      extensions: ["test"],
      fileNames: ["fixture.test"],
      mimeTypes: ["application/x-test", "text/*"],
    });
  } finally {
    await source.remove();
  }
});

test("rejects the Monaco-specific language field", async () => {
  const source = await fixture({
    "SKILL.md": skill,
    "editor.ts": "export {};",
    "editor.json": JSON.stringify({
      apiVersion: 1,
      editor: "plugin",
      id: "test.old-language-field",
      match: { extensions: ["test"] },
      monacoLanguage: "json",
      name: "Old language field",
      runtime: { entry: "dist/editor.js" },
    }),
    "dist/editor.js": "(() => undefined)();",
  });
  try {
    await assert.rejects(
      loadFirstPartyFileFormatPlugins(source.directory),
      /schema validation/,
    );
  } finally {
    await source.remove();
  }
});

test("rejects the former JSON-in-editor.ts comment format", async () => {
  const source = await fixture({
    "SKILL.md": skill,
    "editor.ts": `/* agent-k-file-format\n{"id":"test.legacy","name":"Legacy","match":{"extensions":["old"]},"editor":"text"}\n*/`,
  });
  try {
    await assert.rejects(
      loadFirstPartyFileFormatPlugins(source.directory),
      /Invalid first-party Editor manifest/,
    );
  } finally {
    await source.remove();
  }
});

test("accepts absolute-path and MIME-only matching without an extension rule", async () => {
  const source = await fixture({
    "SKILL.md": skill,
    "editor.ts": "export {};",
    "editor.json": JSON.stringify({
      apiVersion: 1,
      editor: "plugin",
      id: "test.mime-only",
      match: {
        absolutePaths: ["/srv/records/current"],
        mimeTypes: ["application/x-record", "application/*"],
      },
      name: "MIME Editor",
      runtime: { entry: "dist/editor.js" },
    }),
    "dist/editor.js": "(() => undefined)();",
  });
  try {
    const plugins = await loadFirstPartyFileFormatPlugins(source.directory);
    assert.deepEqual(plugins[0]?.match, {
      absolutePaths: ["/srv/records/current"],
      mimeTypes: ["application/x-record", "application/*"],
    });
  } finally {
    await source.remove();
  }
});

test("rejects declarative host-editor types and missing runtimes", async () => {
  const source = await fixture({
    "SKILL.md": skill,
    "editor.ts": "export {};",
    "editor.json": JSON.stringify({
      apiVersion: 1,
      editor: "text",
      id: "test.declarative",
      match: { extensions: ["test"] },
      name: "Declarative Editor",
    }),
  });
  try {
    await assert.rejects(
      loadFirstPartyFileFormatPlugins(source.directory),
      /schema validation/,
    );
  } finally {
    await source.remove();
  }
});

test("serves versioned Editor dependencies through cached internal URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-k-editor-dependency-test-"));
  const extensions = join(root, "editor", "extensions");
  const dependency = join(root, "editor", "dependencies", "test-library@1.2.3");
  const assets = join(dependency, "dist", "assets");
  await mkdir(extensions, { recursive: true });
  await mkdir(assets, { recursive: true });
  await Promise.all([
    writeFile(join(dependency, "dependency.json"), JSON.stringify({
      id: "test-library@1.2.3",
      runtime: {
        assets: "dist/assets",
        entry: "dist/dependency.js",
        style: "dist/dependency.css",
      },
    })),
    writeFile(join(dependency, "dist", "dependency.js"), "globalThis.testLibrary = {};"),
    writeFile(join(dependency, "dist", "dependency.css"), ".test-library {}"),
    writeFile(join(assets, "worker-abc.js"), "self.onmessage = () => {};"),
  ]);
  try {
    const runtime = await getEditorPluginDependency(
      extensions,
      "test-library@1.2.3",
    );
    assert.deepEqual(runtime, {
      cssUrl: "agentk-editor://dependency/test-library%401.2.3/style",
      dependencyId: "test-library@1.2.3",
      javascriptUrl: "agentk-editor://dependency/test-library%401.2.3/entry",
    });
    assert.equal(
      await editorPluginDependencyFilePath(
        extensions,
        "test-library@1.2.3",
        "asset",
        "worker-abc.js",
      ),
      join(assets, "worker-abc.js"),
    );
    await assert.rejects(
      editorPluginDependencyFilePath(
        extensions,
        "test-library@1.2.3",
        "asset",
        "../dependency.js",
      ),
      /Invalid Editor dependency file/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
