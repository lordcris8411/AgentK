import { existsSync } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  ClientSettings,
  EditorPluginDependency,
  EditorPluginRuntime,
  FileFormatPluginResource,
  PiResource,
} from "./types.js";
import { homeDirectory, piAgentDirectory, readJson } from "./utils.js";

const MAX_PLUGIN_SOURCE_BYTES = 64 * 1024;
const MAX_SKILL_SOURCE_BYTES = 256 * 1024;
const MAX_EDITOR_JAVASCRIPT_BYTES = 32 * 1024 * 1024;
const MAX_EDITOR_CSS_BYTES = 2 * 1024 * 1024;
const MAX_EDITOR_ASSETS_BYTES = 24 * 1024 * 1024;
const EDITOR_DEPENDENCY_ID = /^[a-z0-9][a-z0-9._-]{1,80}@[0-9]+\.[0-9]+\.[0-9]+$/i;
const mediaKinds = new Set(["image", "audio", "video", "pdf"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean)
    : [];
}

function capabilityParameters(
  value: unknown,
): Record<string, "string" | "number" | "boolean"> | undefined {
  const parameters = Object.entries(asRecord(value)).flatMap(([name, type]) =>
    /^[a-z0-9._-]+$/i.test(name) &&
    (type === "string" || type === "number" || type === "boolean")
      ? [[name, type] as const]
      : [],
  );
  return parameters.length ? Object.fromEntries(parameters) : undefined;
}

function safeRuntimePath(value: unknown, extension: string): string | undefined {
  if (typeof value !== "string" || !value || isAbsolute(value)) return undefined;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
  return normalized.toLowerCase().endsWith(extension) ? normalized : undefined;
}

function safeRuntimeDirectory(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || isAbsolute(value)) return undefined;
  const normalized = value.replaceAll("\\", "/").replace(/\/$/, "");
  return normalized.split("/").every((part) => part && part !== "." && part !== "..")
    ? normalized
    : undefined;
}

function isAbsoluteFilePath(value: string): boolean {
  return isAbsolute(value) || /^[a-z]:[\\/]/i.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value);
}

function parsePluginValue(raw: unknown, path: string, scope: FileFormatPluginResource["scope"]): FileFormatPluginResource | undefined {
  const value = asRecord(raw);
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const editor = typeof value.editor === "string" ? value.editor : "";
  const rawMatch = asRecord(value.match);
  const rawExtensions = strings(rawMatch.extensions);
  const rawFileNames = strings(rawMatch.fileNames);
  const rawAbsolutePaths = strings(rawMatch.absolutePaths);
  const rawMimeTypes = strings(rawMatch.mimeTypes);
  const extensions = rawExtensions
    .map((item) => item.toLowerCase().replace(/^\./, ""))
    .filter((item) => /^[a-z0-9][a-z0-9+_-]*$/i.test(item));
  const fileNames = rawFileNames
    .filter((item) => !item.includes("/") && !item.includes("\\"));
  const absolutePaths = rawAbsolutePaths.filter(isAbsoluteFilePath);
  const mimeTypes = rawMimeTypes
    .map((item) => item.toLowerCase())
    .filter((item) => /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(?:\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/i.test(item));
  const invalidMatchRule =
    (rawMatch.extensions !== undefined && (!Array.isArray(rawMatch.extensions) || extensions.length !== rawMatch.extensions.length)) ||
    (rawMatch.fileNames !== undefined && (!Array.isArray(rawMatch.fileNames) || fileNames.length !== rawMatch.fileNames.length)) ||
    (rawMatch.absolutePaths !== undefined && (!Array.isArray(rawMatch.absolutePaths) || absolutePaths.length !== rawMatch.absolutePaths.length)) ||
    (rawMatch.mimeTypes !== undefined && (!Array.isArray(rawMatch.mimeTypes) || mimeTypes.length !== rawMatch.mimeTypes.length));
  if (
    !id ||
    !/^[a-z0-9][a-z0-9._-]{1,80}$/i.test(id) ||
    !name ||
    editor !== "plugin" ||
    value.apiVersion !== 1 ||
    invalidMatchRule ||
    (!extensions.length && !fileNames.length && !absolutePaths.length && !mimeTypes.length)
  ) return undefined;
  const capabilities = (Array.isArray(value.capabilities) ? value.capabilities : []).flatMap((entry) => {
    const capability = asRecord(entry);
    const parameters = capabilityParameters(capability.parameters);
    return typeof capability.id === "string" && typeof capability.label === "string" && typeof capability.description === "string"
      ? [{
          id: capability.id,
          label: capability.label,
          description: capability.description,
          ...(parameters ? { parameters } : {}),
        }]
      : [];
  });
  const contextActions = (Array.isArray(value.contextActions) ? value.contextActions : []).flatMap((entry) => {
    const action = asRecord(entry);
    const when = action.when === "directory" || action.when === "both" ? action.when : "file";
    return typeof action.id === "string" && typeof action.label === "string"
      ? [{ id: action.id, label: action.label, when: when as "file" | "directory" | "both" }]
      : [];
  });
  const mediaKind = typeof value.mediaKind === "string" && mediaKinds.has(value.mediaKind)
    ? value.mediaKind as FileFormatPluginResource["mediaKind"]
    : undefined;
  const rawRuntime = asRecord(value.runtime);
  const runtimeEntry = safeRuntimePath(rawRuntime.entry, ".js");
  const runtimeStyle = rawRuntime.style === undefined
    ? undefined
    : safeRuntimePath(rawRuntime.style, ".css");
  const runtimeAssets = rawRuntime.assets === undefined
    ? undefined
    : safeRuntimeDirectory(rawRuntime.assets);
  const runtimeDependencies = strings(rawRuntime.dependencies);
  const languageId = typeof value.languageId === "string"
    ? value.languageId.trim()
    : undefined;
  if (
    !runtimeEntry ||
    (rawRuntime.style !== undefined && !runtimeStyle) ||
    (rawRuntime.assets !== undefined && !runtimeAssets) ||
    (rawRuntime.dependencies !== undefined &&
      (!Array.isArray(rawRuntime.dependencies) ||
        runtimeDependencies.length !== rawRuntime.dependencies.length ||
        new Set(runtimeDependencies).size !== runtimeDependencies.length)) ||
    runtimeDependencies.some((dependency) => !EDITOR_DEPENDENCY_ID.test(dependency)) ||
    value.monacoLanguage !== undefined ||
    (value.languageId !== undefined &&
      (!languageId || !/^[a-z0-9][a-z0-9._+-]*$/i.test(languageId)))
  )
    return undefined;
  return {
    apiVersion: 1,
    id,
    name,
    path,
    scope,
    match: {
      ...(absolutePaths.length ? { absolutePaths } : {}),
      ...(extensions.length ? { extensions } : {}),
      ...(fileNames.length ? { fileNames } : {}),
      ...(mimeTypes.length ? { mimeTypes } : {}),
    },
    editor: "plugin",
    runtime: {
      entry: runtimeEntry,
      ...(runtimeStyle ? { style: runtimeStyle } : {}),
      ...(runtimeAssets ? { assets: runtimeAssets } : {}),
      ...(runtimeDependencies.length ? { dependencies: runtimeDependencies } : {}),
    },
    ...(value.editable === true ? { editable: true } : {}),
    ...(languageId ? { languageId } : {}),
    ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
    ...(mediaKind ? { mediaKind } : {}),
    ...(capabilities.length ? { capabilities } : {}),
    ...(contextActions.length ? { contextActions } : {}),
  };
}

async function readPlugin(directory: string, scope: FileFormatPluginResource["scope"]): Promise<FileFormatPluginResource | undefined> {
  const manifestPath = join(directory, "editor.json");
  if (!existsSync(manifestPath)) return undefined;
  const source = await readFile(manifestPath, "utf8");
  if (Buffer.byteLength(source, "utf8") > MAX_PLUGIN_SOURCE_BYTES)
    throw new Error(`Editor manifest exceeds 64 KiB: ${manifestPath}`);
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (cause) {
    throw new Error(`Editor manifest is not valid JSON: ${manifestPath}`, { cause });
  }
  const plugin = parsePluginValue(raw, manifestPath, scope);
  if (!plugin) throw new Error(`Editor manifest failed schema validation: ${manifestPath}`);
  if (!existsSync(join(directory, "editor.ts")))
    throw new Error(`Editor source is required: ${join(directory, "editor.ts")}`);
  for (const asset of [plugin.runtime.entry, plugin.runtime.style, plugin.runtime.assets]) {
    if (asset && !existsSync(resolve(directory, asset)))
      throw new Error(`Editor '${plugin.id}' is missing runtime asset: ${asset}`);
  }
  return plugin;
}

async function discover(directory: string, scope: FileFormatPluginResource["scope"], depth = 0): Promise<FileFormatPluginResource[]> {
  if (depth > 3) return [];
  if (existsSync(join(directory, "SKILL.md"))) {
    const plugin = await readPlugin(directory, scope);
    if (plugin) return [plugin];
  }
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => discover(join(directory, entry.name), scope, depth + 1)))).flat();
  } catch {
    return [];
  }
}

export async function loadFirstPartyFileFormatPlugins(
  directory: string,
): Promise<FileFormatPluginResource[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new Error(`First-party Editor extension directory is unavailable: ${directory}`);
  }
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (!directories.length)
    throw new Error(`No first-party Editor extensions were found in: ${directory}`);
  const plugins: FileFormatPluginResource[] = [];
  const ids = new Set<string>();
  for (const entry of directories) {
    const packageDirectory = join(directory, entry.name);
    const skillPath = join(packageDirectory, "SKILL.md");
    if (!existsSync(skillPath))
      throw new Error(`Invalid first-party Editor extension '${entry.name}': SKILL.md is required`);
    const skillSource = await readFile(skillPath, "utf8");
    if (
      Buffer.byteLength(skillSource, "utf8") > MAX_SKILL_SOURCE_BYTES ||
      !/^---\s*\r?\n[\s\S]*?^name:\s*\S.+$[\s\S]*?^description:\s*\S.+$[\s\S]*?^---\s*$/im.test(skillSource)
    ) throw new Error(`Invalid first-party Editor Skill: ${skillPath}`);
    const plugin = await readPlugin(packageDirectory, "builtin");
    if (!plugin)
      throw new Error(`Invalid first-party Editor manifest: ${join(packageDirectory, "editor.json")}`);
    if (plugin.runtime) {
      if (!existsSync(join(packageDirectory, "editor.ts")))
        throw new Error(`Programmable first-party Editor '${plugin.id}' is missing editor.ts`);
      for (const asset of [plugin.runtime.entry, plugin.runtime.style, plugin.runtime.assets]) {
        if (asset && !existsSync(resolve(packageDirectory, asset)))
          throw new Error(`First-party Editor '${plugin.id}' is missing built runtime asset: ${asset}`);
      }
    }
    if (ids.has(plugin.id))
      throw new Error(`Duplicate first-party Editor id: ${plugin.id}`);
    ids.add(plugin.id);
    plugins.push(plugin);
  }
  return plugins;
}

function pathInside(parent: string, child: string): boolean {
  const result = relative(parent, child);
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

async function readRuntimeAsset(packageDirectory: string, asset: string, maximumBytes: number): Promise<string> {
  const [realPackageDirectory, realAsset] = await Promise.all([
    realpath(packageDirectory),
    realpath(resolve(packageDirectory, asset)),
  ]);
  if (!pathInside(realPackageDirectory, realAsset))
    throw new Error("Editor plugin runtime asset escapes its package directory");
  const source = await readFile(realAsset, "utf8");
  if (Buffer.byteLength(source, "utf8") > maximumBytes)
    throw new Error(`Editor plugin runtime asset is too large: ${asset}`);
  return source;
}

async function readRuntimeAssets(packageDirectory: string, directory: string | undefined): Promise<Record<string, string>> {
  if (!directory) return {};
  const [realPackageDirectory, realDirectory] = await Promise.all([
    realpath(packageDirectory),
    realpath(resolve(packageDirectory, directory)),
  ]);
  if (!pathInside(realPackageDirectory, realDirectory))
    throw new Error("Editor plugin asset directory escapes its package directory");
  const entries = await readdir(realDirectory, { withFileTypes: true });
  const assets: Record<string, string> = {};
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-z0-9._-]+$/i.test(entry.name)) continue;
    const source = await readFile(join(realDirectory, entry.name), "utf8");
    total += Buffer.byteLength(source, "utf8");
    if (total > MAX_EDITOR_ASSETS_BYTES)
      throw new Error("Editor plugin runtime assets are too large");
    assets[entry.name] = source;
  }
  return assets;
}

async function runtimeAssetNames(
  packageDirectory: string,
  directory: string | undefined,
): Promise<string[]> {
  if (!directory) return [];
  const [realPackageDirectory, realDirectory] = await Promise.all([
    realpath(packageDirectory),
    realpath(resolve(packageDirectory, directory)),
  ]);
  if (!pathInside(realPackageDirectory, realDirectory))
    throw new Error("Editor dependency asset directory escapes its package directory");
  const entries = await readdir(realDirectory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && /^[a-z0-9._-]+$/i.test(entry.name))
    .map((entry) => entry.name);
  const sizes = await Promise.all(
    names.map((name) => stat(join(realDirectory, name)).then((entry) => entry.size)),
  );
  if (sizes.reduce((total, size) => total + size, 0) > MAX_EDITOR_ASSETS_BYTES)
    throw new Error("Editor dependency runtime assets are too large");
  return names;
}

export async function getEditorPluginRuntime(
  appDataPath: string,
  cwd: string,
  firstPartyPlugins: readonly FileFormatPluginResource[],
  pluginId: string,
): Promise<EditorPluginRuntime> {
  const plugins = await getFileFormatPlugins(appDataPath, cwd, firstPartyPlugins);
  const plugin = plugins.find((candidate) => candidate.id === pluginId);
  if (!plugin?.runtime) throw new Error(`Editor plugin runtime is unavailable: ${pluginId}`);
  const packageDirectory = dirname(plugin.path);
  const [javascript, css, assets] = await Promise.all([
    readRuntimeAsset(packageDirectory, plugin.runtime.entry, MAX_EDITOR_JAVASCRIPT_BYTES),
    plugin.runtime.style
      ? readRuntimeAsset(packageDirectory, plugin.runtime.style, MAX_EDITOR_CSS_BYTES)
      : Promise.resolve(""),
    readRuntimeAssets(packageDirectory, plugin.runtime.assets),
  ]);
  return {
    assets,
    css,
    dependencies: plugin.runtime.dependencies ?? [],
    javascript,
    pluginId,
  };
}

export async function getEditorPluginDependency(
  firstPartyEditorExtensionsDirectory: string,
  dependencyId: string,
): Promise<EditorPluginDependency> {
  if (!EDITOR_DEPENDENCY_ID.test(dependencyId))
    throw new Error(`Invalid Editor dependency id: ${dependencyId}`);
  const dependencyDirectory = resolve(
    firstPartyEditorExtensionsDirectory,
    "..",
    "dependencies",
    dependencyId,
  );
  const manifestPath = join(dependencyDirectory, "dependency.json");
  const manifest = asRecord(JSON.parse(await readFile(manifestPath, "utf8")));
  if (manifest.id !== dependencyId)
    throw new Error(`Editor dependency manifest id does not match: ${dependencyId}`);
  const runtime = asRecord(manifest.runtime);
  const entry = safeRuntimePath(runtime.entry, ".js");
  const style = safeRuntimePath(runtime.style, ".css");
  const assetsDirectory = runtime.assets === undefined
    ? undefined
    : safeRuntimeDirectory(runtime.assets);
  if (!entry || !style || (runtime.assets !== undefined && !assetsDirectory))
    throw new Error(`Invalid Editor dependency runtime: ${dependencyId}`);
  await Promise.all([
    editorPluginDependencyFilePath(
      firstPartyEditorExtensionsDirectory,
      dependencyId,
      "entry",
    ),
    editorPluginDependencyFilePath(
      firstPartyEditorExtensionsDirectory,
      dependencyId,
      "style",
    ),
    runtimeAssetNames(dependencyDirectory, assetsDirectory),
  ]);
  const baseUrl = `agentk-editor://dependency/${encodeURIComponent(dependencyId)}`;
  return {
    cssUrl: `${baseUrl}/style`,
    dependencyId,
    javascriptUrl: `${baseUrl}/entry`,
  };
}

export async function editorPluginDependencyFilePath(
  firstPartyEditorExtensionsDirectory: string,
  dependencyId: string,
  kind: "asset" | "entry" | "style",
  assetName?: string,
): Promise<string> {
  if (
    !EDITOR_DEPENDENCY_ID.test(dependencyId) ||
    (kind === "asset" && (!assetName || !/^[a-z0-9._-]+$/i.test(assetName)))
  ) throw new Error("Invalid Editor dependency file");
  const dependencyDirectory = resolve(
    firstPartyEditorExtensionsDirectory,
    "..",
    "dependencies",
    dependencyId,
  );
  const manifest = asRecord(JSON.parse(
    await readFile(join(dependencyDirectory, "dependency.json"), "utf8"),
  ));
  if (manifest.id !== dependencyId)
    throw new Error(`Editor dependency manifest id does not match: ${dependencyId}`);
  const runtime = asRecord(manifest.runtime);
  const entry = safeRuntimePath(runtime.entry, ".js");
  const style = safeRuntimePath(runtime.style, ".css");
  const assetsDirectory = safeRuntimeDirectory(runtime.assets);
  const relativePath = kind === "entry"
    ? entry
    : kind === "style"
      ? style
      : assetsDirectory && assetName
        ? join(assetsDirectory, assetName)
        : undefined;
  if (!relativePath)
    throw new Error(`Invalid Editor dependency ${kind}: ${dependencyId}`);
  const [realDependencyDirectory, realFile] = await Promise.all([
    realpath(dependencyDirectory),
    realpath(resolve(dependencyDirectory, relativePath)),
  ]);
  if (!pathInside(realDependencyDirectory, realFile))
    throw new Error("Editor dependency file escapes its package directory");
  const size = (await stat(realFile)).size;
  const maximumBytes = kind === "entry"
    ? MAX_EDITOR_JAVASCRIPT_BYTES
    : kind === "style"
      ? MAX_EDITOR_CSS_BYTES
      : MAX_EDITOR_ASSETS_BYTES;
  if (size > maximumBytes)
    throw new Error(`Editor dependency ${kind} is too large`);
  return realFile;
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export async function discoverFileFormatPlugins(cwd: string): Promise<FileFormatPluginResource[]> {
  const home = homeDirectory();
  const found = (await Promise.all([
    discover(join(piAgentDirectory(), "skills"), "user"),
    discover(join(home, ".agents", "skills"), "user"),
    discover(join(cwd, ".pi", "skills"), "project"),
    discover(join(cwd, ".agents", "skills"), "project"),
  ])).flat();
  const unique = new Map<string, FileFormatPluginResource>();
  for (const plugin of found.sort((left, right) =>
    left.scope === right.scope ? 0 : left.scope === "user" ? -1 : 1,
  ))
    unique.set(plugin.id, plugin);
  return [...unique.values()];
}

export async function getFileFormatPlugins(
  appDataPath: string,
  cwd: string,
  firstPartyPlugins: readonly FileFormatPluginResource[],
): Promise<FileFormatPluginResource[]> {
  const [plugins, registry, settings] = await Promise.all([
    discoverFileFormatPlugins(cwd),
    readJson<PiResource[]>(join(appDataPath, "pi-resources.json"), []),
    readJson<Partial<ClientSettings>>(join(appDataPath, "client-settings.json"), {}),
  ]);
  const states = new Map(
    registry.flatMap((resource) =>
      resource.kind === "skill" && resource.fileFormat
        ? [[`${pathKey(dirname(resource.path))}\0${resource.fileFormat.id}`, resource] as const]
        : [],
    ),
  );
  const externalPlugins = plugins.flatMap((plugin) => {
    const resource = states.get(`${pathKey(dirname(plugin.path))}\0${plugin.id}`);
    if (resource?.fileFormat?.enabled === false) return [];
    return [{ ...plugin, skillEnabled: resource?.enabled !== false }];
  });
  const disabledEditors = new Set(
    Array.isArray(settings.disabledFileEditors)
      ? settings.disabledFileEditors.filter((id): id is string => typeof id === "string")
      : [],
  );
  const disabledSkills = new Set(
    Array.isArray(settings.disabledFileEditorSkills)
      ? settings.disabledFileEditorSkills.filter((id): id is string => typeof id === "string")
      : [],
  );
  const resolved = new Map<string, FileFormatPluginResource>();
  for (const plugin of firstPartyPlugins) {
    if (disabledEditors.has(plugin.id)) continue;
    resolved.set(plugin.id, {
      ...plugin,
      skillEnabled: !disabledSkills.has(plugin.id),
    });
  }
  for (const plugin of externalPlugins) resolved.set(plugin.id, plugin);
  return [...resolved.values()];
}
