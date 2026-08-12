import type { ThemeDefinition } from "./themes";

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
};
export type ProjectSummary = {
  cwd: string;
  name: string;
  description?: string;
  isHome?: boolean;
  pinned?: boolean;
  updatedAt: number;
  sessions: SessionSummary[];
};
export type FileEntry = {
  path: string;
  name: string;
  isDir: boolean;
  loaded: boolean;
  children: FileEntry[];
  iconPath?: string;
  preview?: {
    configPath?: string;
    kind: "k-app" | "index" | "readme";
    path: string;
  };
};
export type KAppProcess = {
  args: string[];
  command: string;
  cwd: string;
  exitCode?: number;
  exitedAt?: number;
  id: string;
  pid?: number;
  signal?: string;
  startedAt: number;
  status: "running" | "exited" | "failed";
  successful?: boolean;
};
export type KAppProcessOutput = {
  stderr: string;
  stderrCursor: number;
  stdout: string;
  stdoutCursor: number;
};
export type LanguagePackProject = { packId: string; packName: string; root: string; name: string; status: "preparing" | "configuring" | "starting" | "indexing" | "ready" | "failed" | "stopped"; error?: string; indexProgress?: string; [key: string]: unknown };
export type LanguagePackTrace = { elapsedMs?: number; error?: string; file?: string; method: string; phase: "rejected" | "request" | "response" | "sent" | "timeout" | "write-error"; timestamp: number; version?: number };
export type LanguagePack = {
  apiVersion: 1;
  kind: "language-pack";
  version: string;
  displayName: string;
  enabled?: boolean;
  id: string;
  platforms: string[];
  languages: string[];
  fileExtensions: string[];
  projectMarkers: string[];
  actions: Array<{ id: string; method: string; description: string; parameters: Record<string, unknown> }>;
  permissions: { externalTools: string[]; network: boolean; processes: boolean; workspaceWrite: boolean };
  toolchains: Array<{ id: string; system?: { commands: string[]; versionRange: string }; fallback?: { version: string; platforms: Record<string, { url: string; sha256?: string; sha512?: string }> } }>;
  toolchainSources: Array<{ command?: string; id: string; source: "private" | "system"; version: string }>;
  projectMenu?: {
    loadLabel: string;
    unloadLabel: string;
    actions?: Array<{
      defaultProfile?: string;
      id: string;
      label: string;
      method: string;
      profiles?: Array<{ id: string; label: string }>;
    }>;
  };
  editorContribution?: { description: string; editorPluginId: string; id: string; name: string; version: string };
  skills: Array<{ markdown: string; name: string }>;
  commands?: Array<{ id: string; title: string; kind: "project-manager" }>;
  debugServer?: {
    adapters: Array<{ command: string; platforms: string[] }>;
    prepareMethod?: string;
    providers: Array<{ fileExtensions: string[]; id: string; label: string; languages: string[]; modes: Array<"attach" | "dump" | "launch">; priority: number; projectMarkers: string[] }>;
    protocol: "dap";
  };
};
export type LanguagePackPreview = LanguagePack & { approvalToken: string };

export type ClientSettings = {
  version: number;
  theme: string;
  locale: "zh-CN" | "en-US";
  permissionMode: "ask" | "full";
  browserId: string;
  cacheDirectory: string;
  localModelDirectory: string;
  piExecutable: string;
  terminalCharset: "utf-8" | "gbk";
  workerPoolSize: 2 | 3 | 4;
  agentLoopDetectionEnabled: boolean;
  environmentPromptEnabled: boolean;
  autoCompactEnabled: boolean;
  autoCompactPrompt: string;
  editorWordWrap: boolean;
  disabledFileEditors: string[];
  disabledFileEditorSkills: string[];
  disabledLanguagePacks: string[];
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
  version?: string;
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
    version?: string;
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
  description?: string;
  version?: string;
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
  models: Array<{ id: string; name?: string; contextWindow?: number; reasoning?: boolean }>;
  agentKManaged?: boolean;
};

export type ProviderDraft = {
  id: string;
  /** ID before an edit; lets the backend atomically replace a renamed provider. */
  previousId?: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  models: Array<{ id: string; name?: string; contextWindow?: number; reasoning?: boolean }>;
  local: boolean;
};
export type ProviderBalance = {
  available: boolean;
  balances: Array<{ currency: string; total: string }>;
};
export type CodexQuotaWindow = {
  usedPercent: number;
  windowDurationSeconds: number;
  resetsAt?: number;
};
export type CodexQuota = {
  planType?: string;
  buckets: Array<{
    id: string;
    name: string;
    allowed: boolean;
    limitReached: boolean;
    primary?: CodexQuotaWindow;
    secondary?: CodexQuotaWindow;
  }>;
  credits?: {
    hasCredits: boolean;
    unlimited: boolean;
    overageLimitReached: boolean;
    balance?: string;
  };
  resetCredits?: number;
  rateLimitReachedType?: string;
};
export type CodexQuotaResult =
  | { quota: CodexQuota; retryable: false }
  | { error: string; retryable: boolean };

export type LocalServiceInfo = {
  kind: "ollama" | "vllm" | "lm-studio" | "openai-compatible";
  displayName: string;
};

export type LocalModelSource = "huggingface" | "modelscope" | "import";
export type LocalModelBackend = "auto" | "cpu" | "metal" | "vulkan" | "rocm" | "cuda12" | "cuda13";
export type LocalModelKvCacheType = "f32" | "f16" | "bf16" | "q8_0" | "q4_0" | "q4_1" | "iq4_nl" | "q5_0" | "q5_1";
export type LocalModelCompatibility = "unverified" | "verifying-tools" | "tool-compatible" | "tool-incompatible";
export type LocalModelStatus = "queued" | "downloading" | "paused" | "verifying-download" | "ready" | "provisioning" | "loading" | "verifying-tools" | "running" | "stopping" | "failed" | "missing";
export type LocalModelRuntimeConfig = { backend: LocalModelBackend; contextSize: number; gpuLayers: number; threads: number; cacheTypeK: LocalModelKvCacheType; cacheTypeV: LocalModelKvCacheType; maxOutputTokens: number; reasoning: boolean };
export type LocalModelRecord = {
  id: string; name: string; source: LocalModelSource; repository?: string; revision?: string;
  files: Array<{ name: string; path: string; size: number; sha256: string }>;
  size: number; sha256: string; architecture?: string; quantization?: string; parameterCount?: number; trainingContext?: number; blockCount?: number;
  compatibility: LocalModelCompatibility; compatibilityError?: string; verifiedAt?: number; config: LocalModelRuntimeConfig; status: LocalModelStatus; error?: string; createdAt: number; updatedAt: number;
};
export type LocalModelDownloadTask = { id: string; source: Exclude<LocalModelSource, "import">; repository: string; revision: string; files: Array<{ name: string; url: string; size: number; sha256?: string; etag?: string }>; completedBytes: number; totalBytes: number; bytesPerSecond?: number; status: "queued" | "downloading" | "paused" | "verifying-download" | "failed"; error?: string; createdAt: number; updatedAt: number };
export type RuntimeDownloadProgress = { modelId: string; backend: Exclude<LocalModelBackend, "auto">; source: string; fileName: string; phase: "downloading" | "verifying" | "extracting"; completedBytes: number; totalBytes: number; bytesPerSecond: number };
export type LocalModelSnapshot = { enabled: boolean; activeModelId?: string; runningModelId?: string; models: LocalModelRecord[]; downloads: LocalModelDownloadTask[]; hardware: { platform: string; architecture: string; totalMemory: number; availableBackends: LocalModelBackend[]; gpu?: string; vram?: number }; proxyUrl: string; storagePath: string; defaultStoragePath: string; piBusy: boolean; runtimeDownload?: RuntimeDownloadProgress; verificationStage?: { modelId: string; phase: "preparing-runtime" | "loading-model" | "checking-template" | "requesting-tool-call" | "checking-tool-result" }; providerConflict?: string };
export type HubModelResult = { source: Exclude<LocalModelSource, "import">; repository: string; name: string; description?: string; downloads?: number; gated: boolean; private: boolean };
export type HubGgufFile = { name: string; size: number; sha256?: string; group: string; shardIndex: number; shardCount: number };

export const desktop = {
  runtimeInfo: () => invoke<RuntimeInfo>("get_runtime_info"),
  cacheDirectoryInfo: () => invoke<{ activePath: string; defaultPath: string }>("get_cache_directory_info"),
  validateCacheDirectory: (path: string) => invoke<string>("validate_cache_directory", { path }),
  getSettings: () => invoke<ClientSettings>("get_client_settings"),
  listThemes: () => invoke<ThemeDefinition[]>("list_themes"),
  importTheme: (path: string) => invoke<ThemeDefinition>("import_theme", { path }),
  removeTheme: (id: string) => invoke<void>("remove_theme", { id }),
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
  providerCatalog: (runtimeId?: string) =>
    invoke<ProviderCatalogItem[]>("get_provider_catalog", { runtimeId }),
  providerBalance: (providerId: "deepseek" | "openrouter") =>
    invoke<ProviderBalance>("get_provider_balance", { providerId }),
  codexQuota: () => invoke<CodexQuotaResult>("get_codex_quota"),
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
  installEditorPlugin: (sourceDirectory: string) => invoke<FileFormatPluginResource>("install_editor_plugin", { sourceDirectory }),
  editorPluginRuntime: (cwd: string, pluginId: string) =>
    invoke<EditorPluginRuntime>("get_editor_plugin_runtime", { cwd, pluginId }),
  editorPluginSkill: (cwd: string, pluginId: string) =>
    invoke<string>("get_editor_plugin_skill", { cwd, pluginId }),
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
    invoke<Array<{ id: string; contextWindow?: number; reasoning?: boolean }>>("discover_local_models", { baseUrl, ollama }),
  localModels: () => invoke<LocalModelSnapshot>("local_models_list"),
  searchLocalModels: (source: Exclude<LocalModelSource, "import">, query: string) => invoke<HubModelResult[]>("local_models_search", { source, query }),
  inspectLocalModelRepository: (source: Exclude<LocalModelSource, "import">, repository: string) => invoke<{ repository: string; revision: string; files: HubGgufFile[]; downloadable: boolean; reason?: string }>("local_models_inspect", { source, repository }),
  downloadLocalModel: (source: Exclude<LocalModelSource, "import">, repository: string, file: string) => invoke<string>("local_models_download", { source, repository, file }),
  pauseLocalModelDownload: (id: string) => invoke<void>("local_models_download_pause", { id }),
  resumeLocalModelDownload: (id: string) => invoke<void>("local_models_download_resume", { id }),
  cancelLocalModelDownload: (id: string) => invoke<void>("local_models_download_cancel", { id }),
  importLocalModel: (path: string) => invoke<string>("local_models_import", { path }),
  verifyLocalModel: (id: string) => invoke<void>("local_models_verify", { id }),
  activateLocalModel: (id: string) => invoke<void>("local_models_activate", { id }),
  runLocalModel: (id: string) => invoke<void>("local_models_run", { id }),
  setLocalModelsEnabled: (enabled: boolean) => invoke<ClientSettings>("local_models_set_enabled", { enabled }),
  stopLocalModel: () => invoke<void>("local_models_stop"),
  updateLocalModel: (id: string, config: Partial<LocalModelRuntimeConfig>) => invoke<void>("local_models_update", { id, config }),
  deleteLocalModel: (id: string) => invoke<void>("local_models_delete", { id }),
  localModelLogs: () => invoke<string[]>("local_models_logs"),
  listProjects: () => invoke<ProjectSummary[]>("list_projects"),
  addWorkspace: (cwd: string) => invoke<string>("add_workspace", { cwd }),
  removeWorkspace: (cwd: string) => invoke<void>("remove_workspace", { cwd }),
  updateStartupProgress: (
    message: string,
    current: number,
    total: number,
    theme: string,
  ) => invoke<void>("update_startup_progress", { message, current, total, theme }),
  finishStartup: () => invoke<void>("finish_startup"),
  sessionMessages: (path: string) =>
    invoke<Array<Record<string, unknown>>>("session_messages", { path }),
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
  directory: (root: string, path: string, depth: 1 | 2 = 2) =>
    invoke<FileEntry>("directory_tree", { root, path, depth }),
  browseDirectories: (path?: string) => invoke<{ path: string; parent: string; directories: string[]; files: string[]; drives: Array<{ name: string; path: string; device?: string; uuid?: string }> }>("browse_directories", { path }),
  createBrowsedDirectory: (parent: string, name: string) =>
    invoke<string>("create_browsed_directory", { name, parent }),
  read: (root: string, path: string) =>
    invoke<string>("read_text_file", { root, path }),
  readBinary: (root: string, path: string) =>
    invoke<ArrayBuffer>("read_binary_file", { root, path }),
  saveTempAttachment: (name: string, data: number[]) =>
    invoke<string>("save_temp_attachment", { name, data }),
  startPreview: (root: string, path: string, content: string, appBridge = false) =>
    invoke<string>("start_workspace_preview", { root, path, content, appBridge }),
    startWebProject: (root: string, path: string) =>
      invoke<{ id: string; url: string }>("start_web_project", { root, path }),
    kAppProcessStart: (root: string, directory: string, command: string, args: string[], cwd = ".") =>
      invoke<KAppProcess>("k_app_process_start", { args, command, cwd, directory, root }),
    kAppProcessList: (root: string, directory: string) =>
      invoke<KAppProcess[]>("k_app_process_list", { directory, root }),
    kAppProcessStatus: (root: string, directory: string, id: string) =>
      invoke<KAppProcess>("k_app_process_status", { directory, id, root }),
    kAppProcessWait: (root: string, directory: string, id: string) =>
      invoke<KAppProcess>("k_app_process_wait", { directory, id, root }),
    kAppProcessOutput: (root: string, directory: string, id: string, stdoutCursor = 0, stderrCursor = 0) =>
      invoke<KAppProcessOutput>("k_app_process_output", { directory, id, root, stderrCursor, stdoutCursor }),
    kAppProcessStop: (root: string, directory: string, id: string) =>
      invoke<KAppProcess>("k_app_process_stop", { directory, id, root }),
    kAppProcessOpen: (root: string, directory: string, target: string) =>
      invoke<{ opened: true }>("k_app_process_open", { directory, root, target }),
  listLanguagePacks: () => invoke<LanguagePack[]>("list_language_packs"),
  previewLanguagePack: (sourceDirectory: string) => invoke<LanguagePackPreview>("preview_language_pack", { sourceDirectory }),
  installLanguagePack: (sourceDirectory: string, approvalToken: string) => invoke<LanguagePack>("install_language_pack", { approvalToken, sourceDirectory }),
  uninstallLanguagePack: (id: string) => invoke<void>("uninstall_language_pack", { id }),
  listLanguagePackProjects: () => invoke<LanguagePackProject[]>("list_language_pack_projects"),
  languagePackCall: (id: string, method: string, ...args: unknown[]) => invoke<unknown>("language_pack_call", { args, id, method }),
  languagePackInvoke: (packId: string, action: string, arguments_: Record<string, unknown>, cwd: string) => invoke<unknown>("language_pack_invoke", { action, arguments: arguments_, cwd, packId }),
  languagePackRequest: (language: string, file: string, method: string, params: unknown) => invoke<unknown>("language_pack_request", { language, file, method, params }),
  languagePackNotify: (language: string, file: string, method: string, params: unknown) => invoke<void>("language_pack_notify", { language, file, method, params }),
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
  advancedSearch: (root: string, options: { caseSensitive?: boolean; directory?: string; filePattern?: string; query: string; wholeWord?: boolean }) =>
    invoke<Array<{ path: string; line: number; preview: string }>>("advanced_search_files", { root, ...options }),
  watchWorkspace: (root?: string) => invoke<void>("watch_workspace", { root }),
  onEvent: (listener: (event: Record<string, unknown>) => void) =>
    window.agentK.onPiEvent(listener),
  onProjectConsoleEvent: (listener: (event: Record<string, unknown>) => void) => {
    const channel = window.agentK.projectConsole;
    if (channel) return channel.onEvent(listener);
    return window.agentK.onPiEvent((event) => {
      if (String(event.type ?? "").startsWith("project_console_"))
        listener(event);
    });
  },
};
