import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
const root = process.argv[2]; if (!root) throw new Error("Usage: build.mjs <pack-directory>");
await mkdir(join(root, "dist"), { recursive: true }); await copyFile(join(root, "worker.mjs"), join(root, "dist", "worker.js"));
const { validatePack } = await import("./validate.mjs"); const { manifest } = await validatePack(root); console.log(`Built ${manifest.id}@${manifest.version}`);
