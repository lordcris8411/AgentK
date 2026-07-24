const invoke = <T>(command: string, args: Record<string, unknown> = {}) =>
  window.agentK.invoke<T>(command, args);

export type SessionSummary = {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  updatedAt: number;
  preview: string;
  runtimeId?: string;
  backend?: "pi" | "codex";
  codexThreadId?: string;
  piSessionPath?: string;
  needsContextSync?: boolean;
  codexModel?: string;
};
export type ProjectSummary = {
  cwd: string;
  name: string;
  isHome?: boolean;
  updatedAt: number;
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
  piExecutable: string;
  codexExecutable: string;
  piEnabled: boolean;
  codexEnabled: boolean;
  defaultBackend: "pi" | "codex";
  workerPoolSize: 2 | 3 | 4;
  autoCompactEnabled: boolean;
  autoCompactThreshold: number;
  autoCompactPrompt: string;
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
export type PiResource = {
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
};

export type PiResourceChange = {
  resource: PiResource;
  enabled: boolean;
  target: "resource" | "file-format";
};

export type FileFormatPluginResource = {
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
  runtime: { assets?: string; dependencies?: string[]; entry: string; style?: string };
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
};

export type EditorPluginRuntime = {
  assets: Record<string, string>;
  css: string;
  dependencies: string[];
  javascript: string;
  menuJavascript?: string;
  pluginId: string;
};

export type EditorPluginDependency = {
  cssUrl: string;
  dependencyId: string;
  javascriptUrl: string;
};

export type SkillHubScope = "user" | "project";

export type SkillHubPreview = {
  sourceUrl: string;
  source: string;
  name: string;
  description?: string;
  directoryName: string;
  hash: string;
  skillMarkdown: string;
  files: Array<{ path: string; bytes: number }>;
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

export type BackendStatus = { pi: boolean; codex: boolean };

export const desktop = {
  runtimeInfo: () => invoke<RuntimeInfo>("get_runtime_info"),
  getSettings: () => invoke<ClientSettings>("get_client_settings"),
  saveSettings: (settings: ClientSettings) =>
    invoke<ClientSettings>("save_client_settings", { settings }),
  backendStatus: () => invoke<BackendStatus>("get_backend_status"),
  reloadBackends: () => invoke<void>("reload_backends"),
  codexStartThread: (cwd: string) => invoke<{ thread?: { id?: string } }>("codex_start_thread", { cwd }),
  codexResumeThread: (threadId: string) => invoke<void>("codex_resume_thread", { threadId }),
  codexStartTurn: (threadId: string, text: string, cwd: string, model?: string) =>
    invoke<{ turn?: { id?: string } }>("codex_start_turn", { threadId, text, cwd, model }),
  codexModels: () => invoke<{ data?: Array<{ model?: string; displayName?: string; inputModalities?: string[]; isDefault?: boolean }> }>("codex_models"),
  codexPlugins: (cwd: string) => invoke<{ marketplaces?: Array<Record<string, unknown>> }>("codex_plugins", { cwd }),
  codexForkThread: (threadId: string, cwd: string, model?: string) =>
    invoke<{ thread?: { id?: string } }>("codex_fork_thread", { threadId, cwd, model }),
  codexInterrupt: (threadId: string, turnId: string) =>
    invoke<void>("codex_interrupt", { threadId, turnId }),
  codexInterruptActive: (threadId: string) => invoke<void>("codex_interrupt_active", { threadId }),
  createMirrorSession: (backend: "pi" | "codex", cwd: string) =>
    invoke<{ backend: "pi" | "codex"; sessionFile?: string; sessionId?: string; threadId?: string }>("create_mirror_session", { backend, cwd }),
  listBrowsers: () => invoke<BrowserOption[]>("list_browsers"),
  openExternalUrl: (url: string, browserId: string) =>
    invoke<void>("open_external_url", { url, browserId }),
  setSessionPermission: (sessionId: string, allowed: boolean) =>
    invoke<void>("set_session_permission", { sessionId, allowed }),
  saveProvider: (provider: ProviderDraft) =>
    invoke<void>("save_model_provider", { provider }),
  deleteProvider: (providerId: string) =>
    invoke<void>("delete_model_provider", { providerId }),
  providerCatalog: (runtimeId?: string) =>
    invoke<ProviderCatalogItem[]>("get_provider_catalog", { runtimeId }),
  saveProviderApiKey: (providerId: string, apiKey: string) =>
    invoke<void>("save_provider_api_key", { providerId, apiKey }),
  logoutProvider: (providerId: string) =>
    invoke<void>("logout_provider", { providerId }),
  openProviderLogin: (providerId: string) =>
    invoke<void>("open_provider_login", { providerId }),
  reloadPiRuntimes: () => invoke<void>("reload_pi_runtimes"),
  piResources: (cwd: string, runtimeId?: string) =>
    invoke<PiResource[]>("get_pi_resources", { cwd, runtimeId }),
  fileFormatPlugins: (cwd: string) =>
    invoke<FileFormatPluginResource[]>("get_file_format_plugins", { cwd }),
  firstPartyFileFormatPlugins: () =>
    invoke<FileFormatPluginResource[]>("get_first_party_file_format_plugins"),
  editorPluginRuntime: (cwd: string, pluginId: string) =>
    invoke<EditorPluginRuntime>("get_editor_plugin_runtime", { cwd, pluginId }),
  editorPluginDependency: (dependencyId: string) =>
    invoke<EditorPluginDependency>("get_editor_plugin_dependency", { dependencyId }),
  applyPiResourceChanges: (
    cwd: string,
    changes: PiResourceChange[],
    reload = false,
  ) => invoke<void>("apply_pi_resource_changes", { cwd, changes, reload }),
  previewSkillHub: (sourceUrl: string) =>
    invoke<SkillHubPreview>("preview_skill_hub", { sourceUrl }),
  installSkillHub: (sourceUrl: string, hash: string, scope: SkillHubScope, cwd: string) =>
    invoke<void>("install_skill_hub", { sourceUrl, hash, scope, cwd }),
  detectLocalService: (baseUrl: string) =>
    invoke<LocalServiceInfo>("detect_local_service", { baseUrl }),
  discoverModels: (baseUrl: string, ollama = false) =>
    invoke<string[]>("discover_local_models", { baseUrl, ollama }),
  listProjects: () => invoke<ProjectSummary[]>("list_projects"),
  addWorkspace: (cwd: string) => invoke<string>("add_workspace", { cwd }),
  registerConversation: (conversation: SessionSummary & { backend: "pi" | "codex" }) =>
    invoke<void>("register_conversation", { conversation }),
  updateStartupProgress: (
    message: string,
    current: number,
    total: number,
    theme: "light" | "dark",
  ) => invoke<void>("update_startup_progress", { message, current, total, theme }),
  finishStartup: () => invoke<void>("finish_startup"),
  sessionMessages: (path: string) =>
    invoke<Array<Record<string, unknown>>>("session_messages", { path }),
  appendConversationMessage: (path: string, message: Record<string, unknown>) =>
    invoke<void>("append_conversation_message", { path, message }),
  hideSession: (path: string, hidden: boolean) =>
    invoke<void>("hide_session", { path, hidden }),
  deleteSession: (path: string) => invoke<void>("delete_session", { path }),
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
  startWebProject: (root: string, path: string) =>
    invoke<{ id: string; url: string }>("start_web_project", { root, path }),
  compileCmakeProject: (root: string, path: string, terminalId: string) =>
    invoke<void>("compile_cmake_project", { root, path, terminalId }),
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
  startProjectConsole: (root: string, cols: number, rows: number) =>
    invoke<string>("start_project_console", { root, cols, rows }),
  writeProjectConsole: (id: string, data: string) => {
    const channel = window.agentK.projectConsole;
    if (!channel) return invoke<void>("write_project_console", { id, data });
    channel.write(id, data);
    return Promise.resolve();
  },
  resizeProjectConsole: (id: string, cols: number, rows: number) =>
    invoke<void>("resize_project_console", { id, cols, rows }),
  stopProjectConsole: (id: string) =>
    invoke<void>("stop_project_console", { id }),
  openInFileManager: (root: string, path = "") =>
    invoke<void>("open_in_file_manager", { root, path }),
  search: (root: string, query: string) =>
    invoke<string[]>("search_files", { root, query }),
  onEvent: (listener: (event: Record<string, unknown>) => void) =>
    Promise.resolve(window.agentK.onPiEvent(listener)),
  onProjectConsoleEvent: (listener: (event: Record<string, unknown>) => void) => {
    const channel = window.agentK.projectConsole;
    if (channel) return Promise.resolve(channel.onEvent(listener));
    return Promise.resolve(window.agentK.onPiEvent((event) => {
      if (String(event.type ?? "").startsWith("project_console_"))
        listener(event);
    }));
  },
};
