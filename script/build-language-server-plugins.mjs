import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
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
  if (!existsSync(source)) throw new Error(`Language server '${manifest.id}' is missing worker.ts`);
  if (!checkOnly) await rm(dirname(output), { recursive: true, force: true });
  await build({
    configFile: false,
    logLevel: "warn",
    publicDir: false,
    root,
    ssr: { noExternal: ["extract-zip"] },
    build: {
      emptyOutDir: true,
      ssr: source,
      minify: false,
      outDir: dirname(output),
      rollupOptions: { output: { entryFileNames: "worker.js", inlineDynamicImports: true } },
      sourcemap: false,
      target: "node22",
      write: !checkOnly,
    },
  });
  if (!checkOnly && !existsSync(output))
    throw new Error(`Language server '${manifest.id}' did not produce ${manifest.worker}`);
}
