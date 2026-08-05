import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reconcilePiResourceRegistry } from "../.electron-dist/resources.js";

const extension = (path, name = "index") => ({
  enabled: true,
  kind: "extension",
  name,
  origin: "top-level",
  path,
  scope: "user",
  source: "cli",
});

test("resource registry removes deleted extensions and repairs cached entry-point names", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-k-resources-"));
  const installedPath = join(root, "node_modules", "pi-codex-goal", "src", "index.ts");
  const deletedPath = join(root, "node_modules", "removed-extension", "src", "index.ts");
  await mkdir(join(installedPath, ".."), { recursive: true });
  await writeFile(installedPath, "export {};\n", "utf8");
  try {
    const resources = reconcilePiResourceRegistry(
      [extension(installedPath), extension(deletedPath)],
      new Set(),
    );
    assert.deepEqual(resources.map((resource) => resource.name), ["pi-codex-goal"]);
    assert.equal(resources[0]?.path, installedPath);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("active virtual extensions remain in the registry", () => {
  const resource = extension("<inline:llama.cpp>", "<inline:llama");
  const key = `${resource.kind}\0${resource.path}`;
  assert.deepEqual(reconcilePiResourceRegistry([resource], new Set([key])), [resource]);
});
