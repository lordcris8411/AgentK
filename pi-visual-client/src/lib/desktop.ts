import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type SessionSummary = {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  updatedAt: number;
  preview: string;
  runtimeId?: string;
};
export type ProjectSummary = {
  cwd: string;
  name: string;
  isHome?: boolean;
  sessions: SessionSummary[];
};
export type FileEntry = {
  path: string;
  name: string;
  isDir: boolean;
  loaded: boolean;
  children: FileEntry[];
};

export type ClientSettings = {
  version: number;
  theme: "light" | "dark" | "system";
  locale: "zh-CN" | "en-US";
  permissionMode: "ask" | "full";
  browserId: string;
  workerPoolSize: 2 | 3 | 4;
};

export type WorkerPoolStatus = {
  total: number;
  idle: number;
  busy: number;
  minimum: number;
};

export type BrowserOption = {
  id: string;
  name: string;
};

export type RuntimeInfo = {
  piVersion: string;
  operatingSystem: string;
  architecture: string;
};

export type ProviderCatalogItem = {
  id: string;
  name: string;
  baseUrl?: string;
  api?: string;
  source: "builtin" | "custom" | "extension";
  configured: boolean;
  authMethods: Array<"api_key" | "oauth">;
  models: Array<{ id: string; name?: string }>;
};

export type ProviderDraft = {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  models: string[];
  local: boolean;
};

export type LocalServiceInfo = {
  kind: "ollama" | "vllm" | "lm-studio" | "openai-compatible";
  displayName: string;
};

export const desktop = {
  runtimeInfo: () => invoke<RuntimeInfo>("get_runtime_info"),
  getSettings: () => invoke<ClientSettings>("get_client_settings"),
  saveSettings: (settings: ClientSettings) =>
    invoke<ClientSettings>("save_client_settings", { settings }),
  listBrowsers: () => invoke<BrowserOption[]>("list_browsers"),
  openExternalUrl: (url: string, browserId: string) =>
    invoke<void>("open_external_url", { url, browserId }),
  setSessionPermission: (sessionId: string, allowed: boolean) =>
    invoke<void>("set_session_permission", { sessionId, allowed }),
  saveProvider: (provider: ProviderDraft) =>
    invoke<void>("save_model_provider", { provider }),
  deleteProvider: (providerId: string) =>
    invoke<void>("delete_model_provider", { providerId }),
  detectLocalService: (baseUrl: string) =>
    invoke<LocalServiceInfo>("detect_local_service", { baseUrl }),
  discoverModels: (baseUrl: string, ollama = false) =>
    invoke<string[]>("discover_local_models", { baseUrl, ollama }),
  listProjects: () => invoke<ProjectSummary[]>("list_projects"),
  addWorkspace: (cwd: string) => invoke<string>("add_workspace", { cwd }),
  updateStartupProgress: (
    message: string,
    current: number,
    total: number,
    theme: "light" | "dark",
  ) => invoke<void>("update_startup_progress", { message, current, total, theme }),
  finishStartup: () => invoke<void>("finish_startup"),
  sessionMessages: (path: string) =>
    invoke<Array<Record<string, unknown>>>("session_messages", { path }),
  hideSession: (path: string, hidden: boolean) =>
    invoke<void>("hide_session", { path, hidden }),
  renameSession: (path: string, name: string) =>
    invoke<void>("rename_session", {
      path,
      name,
      timestamp: new Date().toISOString(),
    }),
  spawnWorker: (cwd: string) => invoke<string>("spawn_pi_worker", { cwd }),
  resizeWorkerPool: (size: number) =>
    invoke<WorkerPoolStatus>("resize_pi_pool", { size }),
  workerPoolStatus: () =>
    invoke<WorkerPoolStatus>("get_worker_pool_status"),
  connect: (cwd: string, sessionPath?: string, runtimeId?: string) =>
    invoke<string>("connect_pi", { cwd, sessionPath, runtimeId }),
  prepareSession: (cwd: string) => invoke<string>("prepare_session", { cwd }),
  createSession: (runtimeId: string) =>
    invoke<{ sessionFile?: string; sessionId?: string }>("create_session", {
      runtimeId,
    }),
  command: (command: Record<string, unknown>, runtimeId?: string) =>
    invoke<unknown>("pi_command", { command, runtimeId }),
  abort: (runtimeId?: string) => invoke<void>("pi_abort", { runtimeId }),
  closeRuntime: (runtimeId: string) =>
    invoke<void>("close_pi_runtime", { runtimeId }),
  extensionResponse: (
    response: Record<string, unknown>,
    runtimeId?: string,
  ) => invoke<void>("pi_extension_ui_response", { response, runtimeId }),
  tree: (root: string) => invoke<FileEntry>("project_tree", { root }),
  projectContext: (root: string) => invoke<string>("project_context", { root }),
  directory: (root: string, path: string) =>
    invoke<FileEntry>("directory_tree", { root, path }),
  read: (root: string, path: string) =>
    invoke<string>("read_text_file", { root, path }),
  readBinary: (root: string, path: string) =>
    invoke<ArrayBuffer>("read_binary_file", { root, path }),
  saveTempAttachment: (name: string, data: number[]) =>
    invoke<string>("save_temp_attachment", { name, data }),
  startPreview: (root: string, path: string, content: string) =>
    invoke<string>("start_workspace_preview", { root, path, content }),
  write: (root: string, path: string, content: string) =>
    invoke<void>("write_text_file", { root, path, content }),
  mkdir: (root: string, path: string) =>
    invoke<void>("create_directory", { root, path }),
  move: (root: string, from: string, to: string) =>
    invoke<void>("move_path", { root, from, to }),
  copy: (root: string, from: string, to: string) =>
    invoke<void>("copy_path", { root, from, to }),
  importPaths: (root: string, targetDir: string, sources: string[]) =>
    invoke<void>("import_external_paths", { root, targetDir, sources }),
  trash: (root: string, path: string) =>
    invoke<void>("trash_path", { root, path }),
  openTerminal: (root: string, path: string) =>
    invoke<void>("open_terminal_at", { root, path }),
  openInFileManager: (root: string, path = "") =>
    invoke<void>("open_in_file_manager", { root, path }),
  search: (root: string, query: string) =>
    invoke<string[]>("search_files", { root, query }),
  onEvent: (listener: (event: Record<string, unknown>) => void) =>
    listen<Record<string, unknown>>("pi-rpc-event", ({ payload }) =>
      listener(payload),
    ),
};
