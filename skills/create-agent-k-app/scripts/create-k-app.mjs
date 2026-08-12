import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const targetArg = args.shift();
if (!targetArg) {
  console.error("Usage: node create-k-app.mjs <target> --name <name> --author <author> --functionality <summary>");
  process.exit(2);
}
const allowedOptions = new Set(["name", "author", "functionality", "version"]);
const options = new Map();
while (args.length) {
  const flag = args.shift();
  const name = flag?.startsWith("--") ? flag.slice(2) : "";
  const value = args.shift();
  if (!allowedOptions.has(name) || !value || value.startsWith("--"))
    throw new Error(`Invalid option: ${flag ?? ""}`);
  if (options.has(name)) throw new Error(`Duplicate option: --${name}`);
  options.set(name, value);
}
const option = (name, fallback) => options.get(name) ?? fallback;
const target = resolve(targetArg);
const appPath = join(target, "app.html");
const configPath = join(target, "config.k");
await mkdir(target, { recursive: true });
const existing = new Map((await readdir(target)).map((name) => [name.toLocaleLowerCase("en-US"), name]));
for (const name of ["app.html", "app.htm", "config.k"]) {
  if (existing.has(name)) throw new Error(`Refusing to overwrite existing file: ${join(target, existing.get(name))}`);
}
const skillRoot = dirname(dirname(fileURLToPath(import.meta.url)));
await copyFile(join(skillRoot, "assets", "app.html"), appPath);
const config = {
  schemaVersion: 1,
  name: option("name", target.split(/[\\/]/).pop() || "Agent K App"),
  author: option("author", "Unknown"),
  functionality: option("functionality", "An interactive Agent K directory app."),
  version: option("version", "0.1.0"),
  reserved: {},
  settings: {},
};
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(`Created k-app in ${target}`);
