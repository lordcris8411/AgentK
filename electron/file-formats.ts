import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { FileFormatPluginResource, PiResource } from "./types.js";
import { homeDirectory, piAgentDirectory, readJson } from "./utils.js";

const MAX_PLUGIN_SOURCE_BYTES = 64 * 1024;
const editors = new Set(["text", "markdown", "html", "media", "unsupported"]);
const mediaKinds = new Set(["image", "audio", "video", "pdf"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function parsePlugin(source: string, path: string, scope: FileFormatPluginResource["scope"]): FileFormatPluginResource | undefined {
  const match = /\/\*\s*agent-k-file-format\s*\n([\s\S]*?)\*\//i.exec(source);
  if (!match?.[1]) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return undefined;
  }
  const value = asRecord(raw);
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const editor = typeof value.editor === "string" ? value.editor : "";
  const rawMatch = asRecord(value.match);
  const extensions = strings(rawMatch.extensions).map((item) => item.toLowerCase().replace(/^\./, "")).filter(Boolean);
  const fileNames = strings(rawMatch.fileNames).map((item) => item.toLowerCase()).filter(Boolean);
  if (!id || !/^[a-z0-9][a-z0-9._-]{1,80}$/i.test(id) || !name || !editors.has(editor) || (!extensions.length && !fileNames.length)) return undefined;
  const capabilities = (Array.isArray(value.capabilities) ? value.capabilities : []).flatMap((entry) => {
    const capability = asRecord(entry);
    return typeof capability.id === "string" && typeof capability.label === "string" && typeof capability.description === "string"
      ? [{ id: capability.id, label: capability.label, description: capability.description }]
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
  if (editor === "media" && !mediaKind) return undefined;
  return {
    id,
    name,
    path,
    scope,
    match: { ...(extensions.length ? { extensions } : {}), ...(fileNames.length ? { fileNames } : {}) },
    editor: editor as FileFormatPluginResource["editor"],
    ...(value.editable === true ? { editable: true } : {}),
    ...(typeof value.monacoLanguage === "string" ? { monacoLanguage: value.monacoLanguage } : {}),
    ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
    ...(mediaKind ? { mediaKind } : {}),
    ...(capabilities.length ? { capabilities } : {}),
    ...(contextActions.length ? { contextActions } : {}),
  };
}

async function discover(directory: string, scope: FileFormatPluginResource["scope"], depth = 0): Promise<FileFormatPluginResource[]> {
  if (depth > 3) return [];
  const editorPath = join(directory, "editor.ts");
  if (existsSync(join(directory, "SKILL.md")) && existsSync(editorPath)) {
    try {
      const source = await readFile(editorPath, "utf8");
      if (Buffer.byteLength(source, "utf8") > MAX_PLUGIN_SOURCE_BYTES) return [];
      const plugin = parsePlugin(source, editorPath, scope);
      return plugin ? [plugin] : [];
    } catch {
      return [];
    }
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
): Promise<FileFormatPluginResource[]> {
  const [plugins, registry] = await Promise.all([
    discoverFileFormatPlugins(cwd),
    readJson<PiResource[]>(join(appDataPath, "pi-resources.json"), []),
  ]);
  const disabled = new Set(
    registry.flatMap((resource) =>
      resource.kind === "skill" && resource.fileFormat?.enabled === false
        ? [`${pathKey(dirname(resource.path))}\0${resource.fileFormat.id}`]
        : [],
    ),
  );
  return plugins.filter((plugin) =>
    !disabled.has(`${pathKey(dirname(plugin.path))}\0${plugin.id}`),
  );
}
