import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, join, parse, relative, resolve } from "node:path";
import type { RpcPool } from "./agent/pool.js";
import type { JsonObject, PiResource, PiResourceChange } from "./types.js";
import { discoverFileFormatPlugins } from "./file-formats.js";
import {
  asArray,
  asObject,
  asString,
  atomicWrite,
  homeDirectory,
  isPathInside,
  piAgentDirectory,
  readJson,
} from "./utils.js";

function normalizedResourceName(name: string): string {
  return name.toLocaleLowerCase("en-US");
}

function npmPackageName(source: string | undefined): string | undefined {
  if (!source?.startsWith("npm:")) return undefined;
  const specifier = source.slice(4);
  const match = specifier.startsWith("@")
    ? /^(@[^/]+\/[^@/]+)/.exec(specifier)
    : /^([^@/]+)/.exec(specifier);
  return match?.[1];
}

function extensionDirectoryName(path: string): string | undefined {
  let directory = dirname(path);
  for (let depth = 0; depth < 4; depth += 1) {
    const name = basename(directory);
    const normalized = name.toLocaleLowerCase("en-US");
    if (
      name &&
      !name.startsWith(".") &&
      !["dist", "extension", "extensions", "lib", "node_modules", "src"].includes(normalized)
    ) return name;
    if (name.startsWith(".")) break;
    directory = dirname(directory);
  }
  return undefined;
}

function resourceName(
  path: string,
  kind: PiResource["kind"],
  source?: string,
): string {
  if (kind === "skill" && basename(path) === "SKILL.md")
    return basename(resolve(path, "..")) || "skill";
  const entryName = parse(path).name;
  if (
    kind === "extension" &&
    ["index", "main"].includes(entryName.toLocaleLowerCase("en-US"))
  ) {
    return npmPackageName(source) ?? extensionDirectoryName(path) ?? entryName;
  }
  return entryName || kind;
}

function resourcesFromCommands(value: unknown): PiResource[] {
  const resources: PiResource[] = [];
  for (const raw of asArray(asObject(value).commands)) {
    const command = asObject(raw);
    const kind = asString(command.source);
    if (kind !== "skill" && kind !== "extension") continue;
    const info = asObject(command.sourceInfo);
    const path = asString(info.path);
    if (!path) continue;
    const source = asString(info.source) ?? path;
    const existing = resources.find(
      (resource) => resource.kind === kind && resource.path === path,
    );
    if (existing) {
      if (!existing.description && typeof command.description === "string")
        existing.description = command.description;
      continue;
    }
    resources.push({
      kind,
      name: resourceName(path, kind, source),
      ...(typeof command.description === "string"
        ? { description: command.description }
        : {}),
      path,
      source,
      scope: info.scope === "project" ? "project" : "user",
      origin: info.origin === "package" ? "package" : "top-level",
      ...(typeof info.baseDir === "string" ? { baseDir: info.baseDir } : {}),
      enabled: true,
    });
  }
  return resources;
}

function addDiscovered(
  resources: PiResource[],
  kind: PiResource["kind"],
  path: string,
  scope: PiResource["scope"],
  baseDir: string,
): void {
  if (resources.some((item) => item.kind === kind && item.path === path)) return;
  resources.push({
    kind,
    name: resourceName(path, kind),
    path,
    source: "auto",
    scope,
    origin: "top-level",
    baseDir,
    enabled: true,
  });
}

async function discoverSkills(
  resources: PiResource[],
  directory: string,
  scope: PiResource["scope"],
  baseDir: string,
  allowRootMarkdown: boolean,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  const skillFile = join(directory, "SKILL.md");
  if (existsSync(skillFile)) {
    addDiscovered(resources, "skill", skillFile, scope, baseDir);
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(".") || entry.name === "node_modules") return;
      const path = join(directory, entry.name);
      if (entry.isDirectory())
        await discoverSkills(resources, path, scope, baseDir, false);
      else if (allowRootMarkdown && extname(entry.name) === ".md")
        addDiscovered(resources, "skill", path, scope, baseDir);
    }),
  );
}

async function extensionEntries(directory: string): Promise<string[]> {
  try {
    const manifest = asObject(
      JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
    );
    const entries = asArray(asObject(manifest.pi).extensions)
      .filter((value): value is string => typeof value === "string")
      .map((value) => join(directory, value))
      .filter(existsSync);
    if (entries.length) return entries;
  } catch {
    // Fall back to conventional entry points.
  }
  return ["index.ts", "index.js"]
    .map((name) => join(directory, name))
    .filter(existsSync);
}

async function discoverExtensions(
  resources: PiResource[],
  directory: string,
  scope: PiResource["scope"],
  baseDir: string,
): Promise<void> {
  const rootEntries = await extensionEntries(directory);
  if (rootEntries.length) {
    rootEntries.forEach((path) =>
      addDiscovered(resources, "extension", path, scope, baseDir),
    );
    return;
  }
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isFile() && [".ts", ".js"].includes(extname(entry.name)))
      addDiscovered(resources, "extension", path, scope, baseDir);
    else if (entry.isDirectory())
      for (const extension of await extensionEntries(path))
        addDiscovered(resources, "extension", extension, scope, baseDir);
  }
}

async function discoverTopLevel(resources: PiResource[], cwd: string): Promise<void> {
  const userBase = piAgentDirectory();
  await Promise.all([
    discoverExtensions(resources, join(userBase, "extensions"), "user", userBase),
    discoverSkills(resources, join(userBase, "skills"), "user", userBase, true),
    discoverSkills(
      resources,
      join(homeDirectory(), ".agents", "skills"),
      "user",
      join(homeDirectory(), ".agents"),
      false,
    ),
    discoverExtensions(resources, join(cwd, ".pi", "extensions"), "project", join(cwd, ".pi")),
    discoverSkills(resources, join(cwd, ".pi", "skills"), "project", join(cwd, ".pi"), true),
    discoverSkills(resources, join(cwd, ".agents", "skills"), "project", join(cwd, ".agents"), false),
  ]);
}

export async function discoverTopLevelSkillNames(cwd: string): Promise<Set<string>> {
  const resources: PiResource[] = [];
  const userBase = piAgentDirectory();
  await Promise.all([
    discoverSkills(resources, join(userBase, "skills"), "user", userBase, true),
    discoverSkills(
      resources,
      join(homeDirectory(), ".agents", "skills"),
      "user",
      join(homeDirectory(), ".agents"),
      false,
    ),
    discoverSkills(resources, join(cwd, ".pi", "skills"), "project", join(cwd, ".pi"), true),
    discoverSkills(
      resources,
      join(cwd, ".agents", "skills"),
      "project",
      join(cwd, ".agents"),
      false,
    ),
  ]);
  return new Set(
    resources
      .filter((resource) => resource.kind === "skill")
      .map((resource) => normalizedResourceName(resource.name)),
  );
}

export async function getPiResources(
  appDataPath: string,
  pool: RpcPool,
  cwd: string,
  bundledExtensionsDirectory: string,
  bundledSkillsDirectory: string,
  firstPartyEditorExtensionsDirectory: string,
  runtimeId?: string,
): Promise<PiResource[]> {
  const active = resourcesFromCommands(
    await pool.command({ type: "get_commands" }, runtimeId),
  );
  const loaded = new Set(active.map((resource) => `${resource.kind}\0${resource.path}`));
  await discoverTopLevel(active, cwd);
  // Bundled skills are fallbacks. Pi's user/project skills take precedence by
  // name so the manager does not show two copies of the same skill.
  const shadowedBundledSkills = new Set(
    active
      .filter(
        (resource) =>
          resource.kind === "skill" &&
          !isPathInside(bundledSkillsDirectory, resource.path),
      )
      .map((resource) => normalizedResourceName(resource.name)),
  );
  await discoverExtensions(
    active,
    bundledExtensionsDirectory,
    "user",
    bundledExtensionsDirectory,
  );
  await discoverSkills(
    active,
    bundledSkillsDirectory,
    "user",
    bundledSkillsDirectory,
    false,
  );
  const fileFormats = await discoverFileFormatPlugins(cwd);
  const fileFormatByDirectory = new Map(
    fileFormats.map((plugin) => [resolve(dirname(plugin.path)), plugin]),
  );
  for (const resource of active) {
    if (resource.kind !== "skill") continue;
    const plugin = fileFormatByDirectory.get(resolve(dirname(resource.path)));
    if (!plugin) continue;
    resource.fileFormat = { id: plugin.id, name: plugin.name, enabled: true };
  }
  const registryPath = join(appDataPath, "pi-resources.json");
  const registry = await readJson<PiResource[]>(registryPath, []);
  for (const resource of active) {
    const index = registry.findIndex(
      (item) => item.kind === resource.kind && item.path === resource.path,
    );
    if (index >= 0) {
      const previous = registry[index];
      const priorFileFormat = previous?.fileFormat;
      const previousFileFormat =
        priorFileFormat?.id === resource.fileFormat?.id
          ? priorFileFormat
          : undefined;
      registry[index] = {
        ...resource,
        enabled:
          loaded.has(`${resource.kind}\0${resource.path}`) ||
          previous?.enabled !== false,
        ...(resource.fileFormat
          ? {
              fileFormat: {
                ...resource.fileFormat,
                enabled: previousFileFormat?.enabled !== false,
              },
            }
          : {}),
      };
    } else registry.push(resource);
  }
  registry.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
  await atomicWrite(registryPath, JSON.stringify(registry, null, 2));
  return registry.filter(
    (resource) =>
      !isPathInside(firstPartyEditorExtensionsDirectory, resource.path) &&
      (resource.kind !== "skill" ||
        !isPathInside(bundledSkillsDirectory, resource.path) ||
        !shadowedBundledSkills.has(normalizedResourceName(resource.name))),
  );
}

function updateFilterList(list: unknown[], path: string, enabled: boolean): void {
  const include = `+${path}`;
  const exclude = `-${path}`;
  const kept = list.filter((entry) => entry !== include && entry !== exclude);
  list.splice(0, list.length, ...kept, enabled ? include : exclude);
}

async function updateResourceFilter(
  resource: PiResource,
  cwd: string,
  enabled: boolean,
): Promise<void> {
  const settingsPath =
    resource.scope === "project"
      ? join(cwd, ".pi", "settings.json")
      : join(piAgentDirectory(), "settings.json");
  await mkdir(resolve(settingsPath, ".."), { recursive: true });
  const settings = await readJson<JsonObject>(settingsPath, {});
  const key = resource.kind === "skill" ? "skills" : "extensions";
  if (resource.origin === "package") {
    if (!resource.baseDir) throw new Error("Package resource is missing its base directory");
    const resourcePath = relative(resource.baseDir, resource.path).replaceAll("\\", "/");
    const packages = Array.isArray(settings.packages) ? settings.packages : [];
    let index = packages.findIndex((entry) =>
      typeof entry === "string"
        ? entry === resource.source
        : asString(asObject(entry).source) === resource.source,
    );
    if (index < 0) {
      packages.push({ source: resource.source });
      index = packages.length - 1;
    } else if (typeof packages[index] === "string") {
      packages[index] = { source: resource.source };
    }
    const packageSettings = asObject(packages[index]);
    const list = Array.isArray(packageSettings[key]) ? packageSettings[key] as unknown[] : [];
    updateFilterList(list, resourcePath, enabled);
    packageSettings[key] = list;
    packages[index] = packageSettings;
    settings.packages = packages;
  } else {
    const list = Array.isArray(settings[key]) ? settings[key] as unknown[] : [];
    updateFilterList(list, resource.path.replaceAll("\\", "/"), enabled);
    settings[key] = list;
  }
  await atomicWrite(settingsPath, JSON.stringify(settings, null, 2));
}

export async function applyPiResourceChanges(
  appDataPath: string,
  pool: RpcPool,
  cwd: string,
  changes: PiResourceChange[],
  forceReload = false,
): Promise<void> {
  if (!changes.length) {
    if (forceReload) await pool.reload();
    return;
  }
  for (const change of changes) {
    const resource = change.resource;
    if (
      !["skill", "extension"].includes(resource.kind) ||
      !["user", "project"].includes(resource.scope) ||
      !["top-level", "package"].includes(resource.origin) ||
      !["resource", "file-format"].includes(change.target) ||
      !resource.path.trim()
    ) throw new Error("Invalid Pi resource");
    if (change.target === "file-format" &&
      (resource.kind !== "skill" || !resource.fileFormat?.id))
      throw new Error("Invalid file-format plugin resource");
  }
  const registryPath = join(appDataPath, "pi-resources.json");
  const registry = await readJson<PiResource[]>(registryPath, []);

  type DesiredState = {
    resource: PiResource;
    initialSkillEnabled: boolean;
    skillEnabled: boolean;
    pluginEnabled?: boolean;
  };
  const desired = new Map<string, DesiredState>();
  for (const change of changes) {
    const key = `${change.resource.kind}\0${change.resource.path}`;
    let state = desired.get(key);
    if (!state) {
      const current = registry.find(
        (item) => item.kind === change.resource.kind && item.path === change.resource.path,
      );
      const resource = {
        ...change.resource,
        enabled: current?.enabled ?? change.resource.enabled,
        ...(change.resource.fileFormat
          ? {
              fileFormat: {
                ...change.resource.fileFormat,
                enabled:
                  current?.fileFormat?.id === change.resource.fileFormat.id
                    ? current.fileFormat.enabled
                    : change.resource.fileFormat.enabled,
              },
            }
          : {}),
      };
      state = {
        resource,
        initialSkillEnabled: resource.enabled,
        skillEnabled: resource.enabled,
        ...(resource.fileFormat ? { pluginEnabled: resource.fileFormat.enabled } : {}),
      };
      desired.set(key, state);
    }
    if (change.target === "resource") {
      state.skillEnabled = change.enabled;
      if (change.enabled && state.pluginEnabled !== undefined)
        state.pluginEnabled = true;
    } else {
      state.pluginEnabled = change.enabled;
      if (!change.enabled) state.skillEnabled = false;
    }
  }

  let piResourcesChanged = false;
  for (const state of desired.values()) {
    if (state.skillEnabled !== state.initialSkillEnabled) {
      await updateResourceFilter(state.resource, cwd, state.skillEnabled);
      piResourcesChanged = true;
    }
    const next: PiResource = {
      ...state.resource,
      enabled: state.skillEnabled,
      ...(state.resource.fileFormat && state.pluginEnabled !== undefined
        ? {
            fileFormat: {
              ...state.resource.fileFormat,
              enabled: state.pluginEnabled,
            },
          }
        : {}),
    };
    const index = registry.findIndex(
      (item) => item.kind === next.kind && item.path === next.path,
    );
    if (index >= 0) registry[index] = next;
    else registry.push(next);
  }
  await atomicWrite(registryPath, JSON.stringify(registry, null, 2));
  if (piResourcesChanged || forceReload) {
    const onlyProject = changes.every((change) => change.resource.scope === "project");
    await pool.reload(!forceReload && onlyProject ? cwd : undefined);
  }
}
