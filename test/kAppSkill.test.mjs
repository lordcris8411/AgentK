import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import test from "node:test";
import { getPiResources } from "../.electron-dist/resources.js";

const run = promisify(execFile);
const skill = resolve(import.meta.dirname, "..", "skills", "create-agent-k-app");

test("create-agent-k-app metadata covers creation, repair, validation, Pi, files, theme, and processes", async () => {
  const [markdown, reference, metadata] = await Promise.all([
    readFile(join(skill, "SKILL.md"), "utf8"),
    readFile(join(skill, "references", "k-app.md"), "utf8"),
    readFile(join(skill, "agents", "openai.yaml"), "utf8"),
  ]);
  assert.doesNotMatch(markdown, /TODO/);
  for (const phrase of ["Create, update, repair, or validate", "project files", "Pi requests", "current theme", "managed shell-free processes"])
    assert.match(markdown, new RegExp(phrase, "i"));
  for (const method of ["files.list", "files.read", "files.write", "pi.send", "processes.start", "processes.wait", "processes.output", "processes.stop", "processes.open", "theme.get", "theme.onChange"])
    assert.match(reference, new RegExp(method.replace(".", "\\.")));
  assert.match(metadata, /Create secure, theme-aware Agent K k-apps/);
  assert.match(metadata, /\$create-agent-k-app/);
});

test("Agent K resource discovery exposes create-agent-k-app as a bundled Pi Skill", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-k-app-discovery-test-"));
  const cwd = join(temporary, "workspace");
  const extensions = join(temporary, "extensions");
  const editors = join(temporary, "editors");
  try {
    await Promise.all([mkdir(cwd), mkdir(extensions), mkdir(editors)]);
    const resources = await getPiResources(
      temporary,
      { command: async () => ({ commands: [] }) },
      cwd,
      extensions,
      resolve(skill, ".."),
      editors,
    );
    const resource = resources.find((entry) => entry.kind === "skill" && entry.name === "create-agent-k-app");
    assert.ok(resource);
    assert.equal(resolve(resource.path), resolve(skill, "SKILL.md"));
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("create-agent-k-app scaffolds and validates a portable k-app", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-k-app-test-"));
  const target = join(temporary, "sample app");
  try {
    await run(process.execPath, [
      join(skill, "scripts", "create-k-app.mjs"),
      target,
      "--name", "Sample tools",
      "--author", "Agent K",
      "--functionality", "Exercise the k-app API.",
      "--version", "1.2.3-beta.1+test",
    ]);
    const config = JSON.parse(await readFile(join(target, "config.k"), "utf8"));
    assert.deepEqual(config, {
      schemaVersion: 1,
      name: "Sample tools",
      author: "Agent K",
      functionality: "Exercise the k-app API.",
      version: "1.2.3-beta.1+test",
      reserved: {},
      settings: {},
    });
    const app = await readFile(join(target, "app.html"), "utf8");
    assert.match(app, /AgentK\.pi\.send/);
    assert.match(app, /AgentK\.theme\.get/);
    assert.match(app, /AgentK\.theme\.onChange/);
    const validation = await run(process.execPath, [
      join(skill, "scripts", "validate-k-app.mjs"),
      target,
    ]);
    assert.match(validation.stdout, /Valid k-app/);
    await assert.rejects(
      run(process.execPath, [join(skill, "scripts", "create-k-app.mjs"), target]),
      /Refusing to overwrite/,
    );
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("create-agent-k-app preserves a language project and refuses case-insensitive app conflicts", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-k-app-language-test-"));
  const target = join(temporary, "mixed-language-project");
  try {
    await mkdir(target);
    await writeFile(join(target, "package.json"), "{\"scripts\":{\"build\":\"tsc\"}}\n");
    await writeFile(join(target, "CMakeLists.txt"), "project(native)\n");
    await run(process.execPath, [join(skill, "scripts", "create-k-app.mjs"), target]);
    assert.match(await readFile(join(target, "package.json"), "utf8"), /tsc/);
    assert.match(await readFile(join(target, "CMakeLists.txt"), "utf8"), /native/);
    await rm(join(target, "app.html"));
    await rm(join(target, "config.k"));
    await writeFile(join(target, "APP.HTM"), "existing app");
    await assert.rejects(
      run(process.execPath, [join(skill, "scripts", "create-k-app.mjs"), target]),
      /Refusing to overwrite/,
    );
    assert.equal(await readFile(join(target, "APP.HTM"), "utf8"), "existing app");
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("create-agent-k-app validator rejects malformed manifests", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-k-app-invalid-test-"));
  const validate = join(skill, "scripts", "validate-k-app.mjs");
  try {
    await writeFile(join(temporary, "app.htm"), "<main>test</main>");
    const base = { schemaVersion: 1, name: "Test", author: "Agent K", functionality: "Test", version: "1.0.0", reserved: {}, settings: {} };
    for (const value of [
      { ...base, schemaVersion: 2 },
      { ...base, author: "" },
      { ...base, version: "01.0.0" },
      { ...base, reserved: [] },
      { ...base, settings: null },
    ]) {
      await writeFile(join(temporary, "config.k"), JSON.stringify(value));
      await assert.rejects(run(process.execPath, [validate, temporary]), /config\.k/i);
    }
    await writeFile(join(temporary, "config.k"), "not-json");
    await assert.rejects(run(process.execPath, [validate, temporary]), /JSON|Unexpected token/i);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("create-agent-k-app rejects ambiguous or unknown command options", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-k-app-options-test-"));
  const create = join(skill, "scripts", "create-k-app.mjs");
  try {
    await assert.rejects(run(process.execPath, [create, join(temporary, "one"), "--name"]), /Invalid option/);
    await assert.rejects(run(process.execPath, [create, join(temporary, "two"), "--unknown", "x"]), /Invalid option/);
    await assert.rejects(run(process.execPath, [create, join(temporary, "three"), "--name", "a", "--name", "b"]), /Duplicate option/);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});
