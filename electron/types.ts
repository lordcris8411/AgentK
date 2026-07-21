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
}

export interface PiResourceChange {
  resource: PiResource;
  enabled: boolean;
}

export interface WorkerPoolStatus {
  total: number;
  idle: number;
  busy: number;
  minimum: number;
}
