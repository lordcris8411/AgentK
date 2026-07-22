import { existsSync } from "node:fs";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const buildScriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(buildScriptPath), "..");
const extensionsDirectory = join(root, "editor", "extensions");
const entries = await readdir(extensionsDirectory, { withFileTypes: true });
const force = process.argv.includes("--force");
const monacoDependencyDirectory = join(root, "editor", "dependencies", "monaco-editor@0.55.1");
const monacoDependencyManifest = JSON.parse(
  await readFile(join(monacoDependencyDirectory, "dependency.json"), "utf8"),
);

async function upToDate(inputs, outputs) {
  if (force || outputs.some((path) => !existsSync(path))) return false;
  const [inputStats, outputStats] = await Promise.all([
    Promise.all(inputs.filter(existsSync).map((path) => stat(path))),
    Promise.all(outputs.map((path) => stat(path))),
  ]);
  const newestInput = Math.max(...inputStats.map((value) => value.mtimeMs));
  const oldestOutput = Math.min(...outputStats.map((value) => value.mtimeMs));
  return oldestOutput >= newestInput;
}

const dependencyOutputs = [
  join(monacoDependencyDirectory, "dist", "dependency.iife.js"),
  join(monacoDependencyDirectory, "dist", "dependency.css"),
  join(monacoDependencyDirectory, "dist", "assets"),
];
if (!await upToDate([
  join(monacoDependencyDirectory, "dependency.json"),
  join(monacoDependencyDirectory, "dependency.ts"),
  buildScriptPath,
  join(root, "package-lock.json"),
], dependencyOutputs)) {
  await rm(join(monacoDependencyDirectory, "dist"), { force: true, recursive: true });
  await build({
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "warn",
    publicDir: false,
    root,
    build: {
      assetsInlineLimit: 0,
      cssCodeSplit: false,
      emptyOutDir: true,
      lib: {
        entry: join(monacoDependencyDirectory, "dependency.ts"),
        formats: ["iife"],
        name: "AgentKDependency_monaco_editor",
        fileName: "dependency",
        cssFileName: "dependency",
      },
      minify: "esbuild",
      outDir: join(monacoDependencyDirectory, "dist"),
      rollupOptions: { output: { inlineDynamicImports: true } },
      sourcemap: false,
      target: "chrome142",
    },
  });
  const dependencyAssetBase =
    `agentk-editor://dependency/${encodeURIComponent(monacoDependencyManifest.id)}/asset/`;
  const dependencyEntry = join(monacoDependencyDirectory, "dist", "dependency.iife.js");
  const dependencyStyle = join(monacoDependencyDirectory, "dist", "dependency.css");
  await Promise.all([dependencyEntry, dependencyStyle].map(async (path) => {
    const source = await readFile(path, "utf8");
    await writeFile(path, source.replaceAll("/assets/", dependencyAssetBase));
  }));
  const missingOutputs = dependencyOutputs.filter((path) => !existsSync(path));
  if (missingOutputs.length)
    throw new Error(`Monaco Editor dependency did not produce: ${missingOutputs.join(", ")}`);
}

for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
  const packageDirectory = join(extensionsDirectory, entry.name);
  const manifestPath = join(packageDirectory, "editor.json");
  if (!existsSync(manifestPath))
    throw new Error(`First-party Editor '${entry.name}' is missing editor.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.apiVersion !== 1 || manifest.editor !== "plugin" || !manifest.runtime?.entry)
    throw new Error(`First-party Editor '${entry.name}' is not a programmable API v1 package`);
  const source = join(packageDirectory, "editor.ts");
  if (!existsSync(source))
    throw new Error(`Programmable Editor '${manifest.id}' is missing editor.ts`);
  const sourceContents = await readFile(source, "utf8");
  const relativeImports = [...sourceContents.matchAll(/(?:from\s*|import\s*)["'](\.{1,2}\/[^"']+)["']/g)]
    .map((match) => match[1]);
  const sdkDirectory = join(root, "editor", "sdk");
  for (const specifier of relativeImports) {
    const target = resolve(packageDirectory, specifier);
    const packageRelative = relative(packageDirectory, target);
    const sdkRelative = relative(sdkDirectory, target);
    const insidePackage = !isAbsolute(packageRelative) && packageRelative !== ".." && !packageRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
    const insideSdk = !isAbsolute(sdkRelative) && sdkRelative !== ".." && !sdkRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
    if (!insidePackage && !insideSdk)
      throw new Error(`Editor '${manifest.id}' imports code or styles from another plugin: ${specifier}`);
  }
  const outDir = join(packageDirectory, "dist");
  const outputs = [
    join(packageDirectory, manifest.runtime.entry),
    ...(manifest.runtime.style ? [join(packageDirectory, manifest.runtime.style)] : []),
    ...(manifest.runtime.assets ? [join(packageDirectory, manifest.runtime.assets)] : []),
  ];
  const inputs = [
    manifestPath,
    source,
    join(packageDirectory, "editor.css"),
    join(root, "editor", "sdk", "index.ts"),
    buildScriptPath,
    join(root, "package-lock.json"),
  ];
  if (await upToDate(inputs, outputs)) continue;
  await rm(outDir, { force: true, recursive: true });

  await build({
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "warn",
    publicDir: false,
    root,
    build: {
      assetsInlineLimit: 16 * 1024 * 1024,
      cssCodeSplit: false,
      emptyOutDir: true,
      lib: {
        entry: source,
        formats: ["iife"],
        name: `AgentKEditor_${entry.name.replace(/[^a-z0-9_$]/gi, "_")}`,
        fileName: "editor",
        cssFileName: "editor",
      },
      minify: "esbuild",
      outDir,
      rollupOptions: {
        output: { inlineDynamicImports: true },
      },
      sourcemap: false,
      target: "chrome142",
    },
  });
  const missingOutputs = outputs.filter((path) => !existsSync(path));
  if (missingOutputs.length)
    throw new Error(`Editor '${manifest.id}' did not produce: ${missingOutputs.join(", ")}`);
}
