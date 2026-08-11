import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) => value.startsWith("--") ? [[value.slice(2), all[index + 1]]] : []));
for (const key of ["output", "id", "display-name", "languages", "extensions", "markers"]) if (!args[key]) throw new Error(`--${key} is required`);
if (!/^[a-z0-9][a-z0-9.-]*$/.test(args.id)) throw new Error("--id must be a stable lowercase dotted id");
const output = resolve(args.output); const template = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "template");
await mkdir(output, { recursive: false }); await cp(template, output, { recursive: true }); await mkdir(join(output, "dist"));
const jsonList = (value) => value.split(",").map((item) => JSON.stringify(item.trim())).join(", ");
const skillName = args.id.replaceAll(".", "-").slice(0, 64); let manifest = await readFile(join(output, "agent-k.language-pack.json"), "utf8");
for (const [from, to] of Object.entries({ __ID__: args.id, __DISPLAY_NAME__: args["display-name"], __LANGUAGES__: jsonList(args.languages), __EXTENSIONS__: jsonList(args.extensions), __MARKERS__: jsonList(args.markers), __SKILL_NAME__: skillName })) manifest = manifest.replaceAll(from, to);
await writeFile(join(output, "agent-k.language-pack.json"), manifest, "utf8");
console.log(output);
