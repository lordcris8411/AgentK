export type JsonObject = Record<string, unknown>;

export interface ClientSettings {
  version: number;
  theme: "light" | "dark" | "system";
  locale: "zh-CN" | "en-US";
  permissionMode: "ask" | "full";
  browserId: string;
  piExecutable: string;
  workerPoolSize: 2 | 3 | 4;
  editorWordWrap: boolean;
  disabledFileEditors: string[];
  disabledFileEditorSkills: string[];
  leftPanelWidth: number;
  rightPanelWidth: number;
  leftPanelHidden: boolean;
  rightPanelHidden: boolean;
  windowWidth: number;
  windowHeight: number;
  windowMaximized: boolean;
}

export interface SessionSummary {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  updatedAt: number;
  preview: string;
}

export interface ProjectSummary {
  cwd: string;
  name: string;
  isHome?: boolean;
  sessions: SessionSummary[];
}

export interface FileEntry {
  path: string;
  name: string;
  isDir: boolean;
  loaded: boolean;
  children: FileEntry[];
}

export interface PiResource {
  kind: "skill" | "extension";
  name: string;
  description?: string;
  path: string;
  source: string;
  scope: "user" | "project";
  origin: "top-level" | "package";
  baseDir?: string;
  enabled: boolean;
  fileFormat?: {
    id: string;
    name: string;
    enabled: boolean;
  };
}

export interface PiResourceChange {
  resource: PiResource;
  enabled: boolean;
  target: "resource" | "file-format";
}

export interface FileFormatPluginResource {
  apiVersion: 1;
  id: string;
  name: string;
  path: string;
  scope: "builtin" | "user" | "project";
  skillEnabled?: boolean;
  match: {
    absolutePaths?: string[];
    extensions?: string[];
    fileNames?: string[];
    mimeTypes?: string[];
  };
  editor: "plugin";
  runtime: { assets?: string; dependencies?: string[]; entry: string; menu?: string; style?: string };
  editable?: boolean;
  languageId?: string;
  mimeType?: string;
  mediaKind?: "image" | "audio" | "video" | "pdf";
  capabilities?: Array<{
    id: string;
    label: string;
    description: string;
    parameters?: Record<string, "string" | "number" | "boolean">;
  }>;
}

export interface EditorPluginRuntime {
  assets: Record<string, string>;
  css: string;
  dependencies: string[];
  javascript: string;
  menuJavascript?: string;
  pluginId: string;
}

export interface EditorPluginDependency {
  cssUrl: string;
  dependencyId: string;
  javascriptUrl: string;
}

export type SkillHubScope = "user" | "project";

export interface SkillHubPreview {
  sourceUrl: string;
  source: string;
  name: string;
  description?: string;
  directoryName: string;
  hash: string;
  skillMarkdown: string;
  files: Array<{ path: string; bytes: number }>;
}

export interface WorkerPoolStatus {
  total: number;
  idle: number;
  busy: number;
  minimum: number;
}
