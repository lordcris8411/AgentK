import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const target = resolve(process.argv[2] ?? ".");
const names = await readdir(target);
const files = new Map(names.map((name) => [name.toLocaleLowerCase("en-US"), name]));
const app = files.get("app.html") ?? files.get("app.htm");
const configName = files.get("config.k");
if (!app) throw new Error("k-app requires app.html or app.htm");
if (!configName) throw new Error("k-app requires config.k");
const config = JSON.parse(await readFile(resolve(target, configName), "utf8"));
if (config?.schemaVersion !== 1) throw new Error("config.k schemaVersion must be 1");
for (const key of ["name", "author", "functionality"]) {
  if (typeof config[key] !== "string" || !config[key].trim())
    throw new Error(`config.k ${key} must be a non-empty string`);
}
if (typeof config.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(config.version))
  throw new Error("config.k version must be a semantic version");
for (const key of ["reserved", "settings"]) {
  if (!config[key] || typeof config[key] !== "object" || Array.isArray(config[key]))
    throw new Error(`config.k ${key} must be an object`);
}
console.log(`Valid k-app: ${target} (${app}, ${configName})`);
