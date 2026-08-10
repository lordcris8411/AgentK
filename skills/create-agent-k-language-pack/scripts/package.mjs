import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
const source = resolve(process.argv[2] ?? "."); const outputRoot = resolve(process.argv[3] ?? "artifacts"); const { manifest } = await (await import("./validate.mjs")).validatePack(source); const output = join(outputRoot, `${manifest.id}-${manifest.version}`);
await rm(output, { recursive: true, force: true }); await mkdir(outputRoot, { recursive: true }); await cp(source, output, { recursive: true, filter: (path) => !/[\\/](?:node_modules|\.git|\.test-cache)(?:[\\/]|$)/.test(path) });
const files = []; async function walk(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await walk(path); else if (entry.name !== "SHA256SUMS.json") files.push(path); } } await walk(output);
const hashes = Object.fromEntries(await Promise.all(files.sort().map(async (path) => [relative(output, path).replaceAll("\\", "/"), createHash("sha256").update(await readFile(path)).digest("hex")]))); await writeFile(join(output, "SHA256SUMS.json"), `${JSON.stringify(hashes, null, 2)}\n`); console.log(output);
