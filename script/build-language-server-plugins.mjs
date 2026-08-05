import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = join(root, "language-servers");
const checkOnly = process.argv.includes("--check");

for (const entry of await readdir(packages, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = join(packages, entry.name);
  const manifestPath = join(directory, "agent-k.language-server.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.apiVersion !== 1 || typeof manifest.id !== "string" || typeof manifest.worker !== "string")
    throw new Error(`Language server '${entry.name}' has an invalid manifest`);
  const source = join(directory, "worker.ts");
  const output = join(directory, manifest.worker);
  const stagingDirectory = join(directory, ".agent-k-language-server-build");
  const stagingOutput = join(stagingDirectory, "worker.js");
  if (!existsSync(source)) throw new Error(`Language server '${manifest.id}' is missing worker.ts`);
  if (!checkOnly) await rm(stagingDirectory, { recursive: true, force: true });
  try {
    await build({
      configFile: false,
      logLevel: "warn",
      publicDir: false,
      root,
      // Language workers are copied to extraResources and launched from outside
      // app.asar. They cannot resolve dependencies from the host application's
      // packaged node_modules, so every non-Node dependency must be bundled.
      ssr: { noExternal: true },
      build: {
        emptyOutDir: !checkOnly,
        ssr: source,
        minify: false,
        outDir: checkOnly ? dirname(output) : stagingDirectory,
        rollupOptions: { output: { entryFileNames: "worker.js", inlineDynamicImports: true } },
        sourcemap: false,
        target: "node22",
        write: !checkOnly,
      },
    });
    if (!checkOnly) {
      if (!existsSync(stagingOutput))
        throw new Error(`Language server '${manifest.id}' did not produce ${manifest.worker}`);
      // Keep the last usable worker discoverable while Vite builds its replacement.
      // Development app restarts and test builds may otherwise race with plugin scan.
      await mkdir(dirname(output), { recursive: true });
      await copyFile(stagingOutput, output);
    }
  } finally {
    if (!checkOnly) await rm(stagingDirectory, { recursive: true, force: true });
  }
}
