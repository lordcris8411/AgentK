export type PreviewKind = "image" | "audio" | "video" | "pdf";

/**
 * Discovery metadata for an Agent K file-format editor.
 *
 * Plugins select files by exact basename, absolute path, extension, and/or
 * MIME type. The host owns
 * file access, saving, and the existing file-tree actions; plugins can only
 * append actions after those built-in context-menu entries.
 */
export type FileFormatEditor = "plugin";

export type FileFormatCapability = {
  id: string;
  label: string;
  description: string;
  parameters?: Record<string, "string" | "number" | "boolean">;
};

export type FileFormatContextAction = {
  id: string;
  label: string;
  when?: "file" | "directory" | "both";
};

export type FileFormatPlugin = {
  apiVersion: 1;
  id: string;
  name: string;
  match: {
    absolutePaths?: readonly string[];
    extensions?: readonly string[];
    fileNames?: readonly string[];
    mimeTypes?: readonly string[];
  };
  editor: FileFormatEditor;
  runtime: { assets?: string; dependencies?: string[]; entry: string; style?: string };
  scope?: "builtin" | "user" | "project";
  skillEnabled?: boolean;
  editable?: boolean;
  languageId?: string;
  mimeType?: string;
  mediaKind?: PreviewKind;
  contextActions?: readonly FileFormatContextAction[];
  capabilities?: readonly FileFormatCapability[];
};

export type FileMatchContext = {
  absolutePath: string;
  mimeType: string;
  path: string;
};

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? "";
}

function extensionFor(path: string): string {
  const name = fileName(path).toLowerCase();
  return name.includes(".") ? name.split(".").pop() ?? "" : "";
}

function normalizedAbsolutePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

function matchesMimeType(pattern: string, mimeType: string): boolean {
  const normalizedPattern = pattern.toLowerCase();
  const normalizedMimeType = mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (normalizedPattern.endsWith("/*"))
    return normalizedMimeType.startsWith(normalizedPattern.slice(0, -1));
  return normalizedPattern === normalizedMimeType;
}

export function fileFormatMatchRank(
  plugin: FileFormatPlugin,
  context: FileMatchContext,
): number {
  const name = fileName(context.path);
  const extension = extensionFor(context.path);
  const absolutePath = normalizedAbsolutePath(context.absolutePath);
  if (plugin.match.absolutePaths?.some((candidate) => normalizedAbsolutePath(candidate) === absolutePath)) return 50;
  if (plugin.match.fileNames?.some((candidate) => candidate === name)) return 40;
  if (plugin.match.extensions?.some((candidate) => candidate.toLowerCase().replace(/^\./, "") === extension)) return 30;
  if (plugin.match.mimeTypes?.some((candidate) => !candidate.endsWith("/*") && matchesMimeType(candidate, context.mimeType))) return 20;
  if (plugin.match.mimeTypes?.some((candidate) => matchesMimeType(candidate, context.mimeType))) return 10;
  return 0;
}

export function matchesFileFormat(
  plugin: FileFormatPlugin,
  context: FileMatchContext,
): boolean {
  return fileFormatMatchRank(plugin, context) > 0;
}

export function fileExtension(path: string): string {
  return extensionFor(path);
}
