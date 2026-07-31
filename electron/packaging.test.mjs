import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

function packageName(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

function moduleSpecifiers(path, source, scriptKind) {
  const specifiers = new Set();
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, scriptKind);
  const visit = (node) => {
    let specifier;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
      specifier = node.moduleSpecifier.text;
    else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
        specifier = node.arguments[0].text;
    }
    if (specifier) specifiers.add(specifier);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

test("Electron main-process packages are shipped as production dependencies", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const imports = new Set();
  for (const path of await sourceFiles(join(root, "electron"))) {
    const source = await readFile(path, "utf8");
    for (const specifier of moduleSpecifiers(path, source, ts.ScriptKind.TS)) {
      if (specifier && specifier !== "electron" && !specifier.startsWith(".") && !specifier.startsWith("node:"))
        imports.add(packageName(specifier));
    }
  }
  for (const dependency of imports) {
    assert.ok(
      Object.hasOwn(manifest.dependencies ?? {}, dependency),
      `${dependency} is imported by the Electron main process but is not a production dependency`,
    );
  }
});

test("bundled language workers do not depend on host node_modules", async () => {
  const packages = join(root, "language-servers");
  for (const entry of await readdir(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packages, entry.name, "agent-k.language-server.json");
    let manifest;
    try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch { continue; }
    const workerPath = join(packages, entry.name, manifest.worker);
    const source = await readFile(workerPath, "utf8");
    for (const specifier of moduleSpecifiers(workerPath, source, ts.ScriptKind.JS)) {
      const normalized = specifier.replace(/^node:/, "");
      assert.ok(
        specifier.startsWith(".") || specifier.startsWith("/") || nodeBuiltins.has(normalized),
        `${manifest.id} worker leaves '${specifier}' external and will fail outside the development node_modules tree`,
      );
    }
  }
});

test("bundled language workers initialize outside the development tree", async () => {
  const packages = join(root, "language-servers");
  for (const entry of await readdir(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packages, entry.name, "agent-k.language-server.json");
    let manifest;
    try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch { continue; }
    const isolated = await mkdtemp(join(tmpdir(), "agent-k-language-worker-"));
    const workerPath = join(isolated, "worker.js");
    await copyFile(join(packages, entry.name, manifest.worker), workerPath);
    const child = fork(workerPath, [], { execArgv: [], silent: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8 * 1024); });
    try {
      const result = await new Promise((resolveWorker, rejectWorker) => {
        const timeout = setTimeout(() => rejectWorker(new Error(`${manifest.id} worker timed out\n${stderr}`)), 10_000);
        child.once("error", rejectWorker);
        child.once("exit", (code, signal) => {
          if (code !== 0) rejectWorker(new Error(`${manifest.id} worker exited (${code ?? signal ?? "unknown"})\n${stderr}`));
        });
        child.on("message", (message) => {
          if (message?.type !== "response") return;
          if (message.error) { clearTimeout(timeout); rejectWorker(new Error(message.error)); return; }
          if (message.id === 1) child.send({ args: [], id: 2, method: "list", type: "request" });
          if (message.id === 2) { clearTimeout(timeout); resolveWorker(message.result); }
        });
        child.send({ args: [isolated], id: 1, method: "initialize", type: "request" });
      });
      assert.ok(Array.isArray(result), `${manifest.id} worker returned an invalid project list`);
    } finally {
      if (child.connected) child.disconnect();
      child.kill();
      await rm(isolated, { force: true, recursive: true });
    }
  }
});
