import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

test("Electron main-process packages are shipped as production dependencies", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const imports = new Set();
  for (const path of await sourceFiles(join(root, "electron"))) {
    const source = await readFile(path, "utf8");
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    const visit = (node) => {
      let specifier;
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) specifier = node.moduleSpecifier.text;
      else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) specifier = node.arguments[0].text;
      if (specifier && specifier !== "electron" && !specifier.startsWith(".") && !specifier.startsWith("node:"))
        imports.add(packageName(specifier));
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  for (const dependency of imports) {
    assert.ok(
      Object.hasOwn(manifest.dependencies ?? {}, dependency),
      `${dependency} is imported by the Electron main process but is not a production dependency`,
    );
  }
});
