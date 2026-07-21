import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

function packagePath(nodeModules, name) {
  return join(nodeModules, ...name.split("/"));
}

async function packageManifest(path) {
  return JSON.parse(await readFile(join(path, "package.json"), "utf8"));
}

async function copyPiRuntime(projectDir) {
  const sourceNodeModules = join(projectDir, "node_modules");
  const runtimeRoot = join(projectDir, ".pi-runtime");
  const runtimeNodeModules = join(runtimeRoot, "node_modules");
  const pending = ["@earendil-works/pi-coding-agent"];
  const copied = new Set();

  await rm(runtimeRoot, { recursive: true, force: true });
  await mkdir(runtimeNodeModules, { recursive: true });
  while (pending.length) {
    const name = pending.pop();
    if (!name || copied.has(name)) continue;
    const source = packagePath(sourceNodeModules, name);
    if (!existsSync(source)) continue;
    copied.add(name);
    const manifest = await packageManifest(source);
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    })) pending.push(dependency);
    await cp(source, packagePath(runtimeNodeModules, name), {
      recursive: true,
      dereference: true,
      filter: (path) => !path.includes(`${join("node_modules", ".cache")}`),
    });
  }
}

export default async function beforePack(context) {
  await copyPiRuntime(resolve(context.packager.projectDir));
}
