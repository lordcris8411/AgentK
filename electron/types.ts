export type JsonObject = Record<string, unknown>;

export interface ClientSettings {
  version: number;
  theme: string;
  locale: "zh-CN" | "en-US";
  permissionMode: "ask" | "full";
  browserId: string;
  cacheDirectory: string;
  localModelDirectory: string;
  piExecutable: string;
  workerPoolSize: 2 | 3 | 4;
  agentLoopDetectionEnabled: boolean;
  environmentPromptEnabled: boolean;
  autoCompactEnabled: boolean;
  autoCompactPrompt: string;
  editorWordWrap: boolean;
  disabledFileEditors: string[];
  disabledFileEditorSkills: string[];
  disabledLanguageServers: string[];
  disabledLanguageServerSkills: string[];
  disabledModelProviders: string[];
  disabledModels: string[];
  pinnedWorkspaces: string[];
  defaultModel: string;
  sessionModels: Record<string, string>;
  leftPanelWidth: number;
  rightPanelWidth: number;
  fileExplorerWidth: number;
  leftPanelHidden: boolean;
  rightPanelHidden: boolean;
  developmentDockHeight: number;
  developmentDockCollapsed: boolean;
  developmentDockTerminalVisible: boolean;
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
  description?: string;
  isHome?: boolean;
  updatedAt: number;
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
    version?: string;
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
  description?: string;
  version?: string;
  path: string;
  scope: "builtin" | "user" | "project";
  skillEnabled?: boolean;
  contextMarkers?: string[];
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
