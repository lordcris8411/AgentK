import type { PreviewKind } from "../../components/layout/MediaPreview";

/**
 * Stable, declarative contract for an Agent K file-format editor.
 *
 * Plugins select files by an exact basename and/or extension.  The host owns
 * file access, saving, and the existing file-tree actions; plugins can only
 * append actions after those built-in context-menu entries.
 */
export type FileFormatEditor = "text" | "markdown" | "html" | "media" | "unsupported";

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
  id: string;
  name: string;
  match: {
    extensions?: readonly string[];
    fileNames?: readonly string[];
  };
  editor: FileFormatEditor;
  editable?: boolean;
  monacoLanguage?: string;
  mimeType?: string;
  mediaKind?: PreviewKind;
  contextActions?: readonly FileFormatContextAction[];
  capabilities?: readonly FileFormatCapability[];
};

function normalizedFileName(path: string): string {
  return path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
}

function extensionFor(path: string): string {
  const name = normalizedFileName(path);
  return name.includes(".") ? name.split(".").pop() ?? "" : "";
}

export function matchesFileFormat(plugin: FileFormatPlugin, path: string): boolean {
  const name = normalizedFileName(path);
  const extension = extensionFor(path);
  return Boolean(
    plugin.match.fileNames?.includes(name) || plugin.match.extensions?.includes(extension),
  );
}

export function fileExtension(path: string): string {
  return extensionFor(path);
}
