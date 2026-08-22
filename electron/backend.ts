import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { constants, existsSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { access, cp, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type {
  ClientSettings,
  FileFormatPluginResource,
  JsonObject,
  PiResourceChange,
  SkillHubScope,
} from "./types.js";
import { RpcPool } from "./agent/pool.js";
import { resolvePiLaunch, type PiLaunch } from "./pi-runtime.js";
import { FileService } from "./files.js";
import {
  codexQuota,
  deleteModelProvider,
  detectLocalService,
  discoverLocalModels,
  listBrowsers,
  loadClientSettings,
  logoutProvider,
  openExternalUrl,
  openProviderLogin,
  providerBalance,
  providerCatalog,
  saveClientSettings,
  saveModelProvider,
  saveProviderApiKey,
  setSessionPermission,
  migrateMisclassifiedVllm,
  migrateReasoningOffValues,
  type ProviderDraft,
} from "./settings.js";
import { applyPiResourceChanges, getPiResources } from "./resources.js";
import {
  getEditorPluginDependency,
  getEditorPluginRuntime,
  getEditorPluginSkill,
  getFileFormatPlugins,
  installUserFileFormatPlugin,
  loadFirstPartyFileFormatPlugins,
} from "./file-formats.js";
import { installSkillHub, previewSkillHub } from "./skill-hub.js";
import { importTheme, listThemes, removeTheme, themeDirectory } from "./themes.js";
import { LanguagePackRegistry } from "./language-pack-registry.js";
import type { WorkspaceFileChange } from "./language-pack-host.js";
import {
  agentKBashRcConfig,
  agentKStarshipConfig,
  windowsTerminalInitialization,
} from "./terminal-profile.js";
import { asArray, asObject, asString, atomicWrite, errorMessage, isPathInside, randomId } from "./utils.js";
import { mergeWorkspaceWatchKind, type WorkspaceWatchKind } from "./workspace-watch.js";
import { inferModelReasoning } from "./model-reasoning.js";
import { syncRemoteProviderModels } from "./remote-model-catalog.js";
import { mountedVolumes } from "./mounted-volumes.js";
import { KAppProcessManager } from "./k-app-processes.js";
import {
  LOCAL_MODEL_PROVIDER_ID,
  LocalModelManager,
  type LocalModelBackend,
  type LocalModelSource,
  type LocalModelRuntimeConfig,
} from "./local-models.js";

export interface DesktopBackendOptions {
  appDataPath: string;
  bundledExtensionsSource: string;
  firstPartyEditorExtensionsSource: string;
  firstPartyLanguagePacksSource: string;
  bundledSkillsSource: string;
  bundledThemesSource: string;
  bundledPiCli: string;
  bundledPiNode: string;
  cachePath: string;
  localModelRoot?: string;
  permissionExtensionSource: string;
  emit(event: JsonObject): void;
  emitProjectConsole(event: JsonObject): void;
  updateSplash(message: string, current: number, total: number, theme: string): void;
  finishSplash(): void;
  openPath(path: string): Promise<string>;
}

type ProjectConsoleProcess = {
  root: string;
  terminal: IPty;
};

export class DesktopBackend {
  private readonly options: DesktopBackendOptions;
  private readonly files: FileService;
  private readonly bundledExtensionsDirectory: string;
  private readonly bundledSkillsDirectory: string;
  private readonly terminalProfilePath: string;
  private readonly terminalBashRcPath: string;
  private terminalCharset: ClientSettings["terminalCharset"] = "utf-8";
  private firstPartyEditorPlugins: FileFormatPluginResource[] = [];
  private piLaunch?: PiLaunch;
  private pool?: RpcPool;
  private localModels?: LocalModelManager;
  private readonly projectConsoles = new Map<string, ProjectConsoleProcess>();
  private readonly webProjects = new Map<string, ReturnType<typeof spawn>>();
  private readonly kAppProcesses = new KAppProcessManager();
  private readonly languagePacks: LanguagePackRegistry;
  private workspaceWatcher?: FSWatcher;
  private themeWatcher?: FSWatcher;
  private themeWatchTimer?: ReturnType<typeof setTimeout>;
  private settingsWatcher?: FSWatcher;
  private settingsWatchTimer?: ReturnType<typeof setTimeout>;
  private workspaceWatchRoot?: string;
  private readonly workspaceWatchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly workspaceWatchKinds = new Map<string, WorkspaceWatchKind>();
  private readonly workspaceLanguageChanges = new Map<string, WorkspaceFileChange>();
  private workspaceLanguageChangeTimer?: ReturnType<typeof setTimeout>;

  constructor(options: DesktopBackendOptions) {
    this.options = options;
    this.files = new FileService(options.appDataPath, options.cachePath);
    this.languagePacks = new LanguagePackRegistry(
      options.firstPartyLanguagePacksSource,
      join(options.appDataPath, "language-packs"),
      options.cachePath,
      (event) => this.options.emit(event),
    );
    this.bundledExtensionsDirectory = join(options.appDataPath, "bundled-extensions");
    this.bundledSkillsDirectory = join(options.appDataPath, "bundled-skills");
    this.terminalProfilePath = join(options.appDataPath, "terminal", "starship.toml");
    this.terminalBashRcPath = join(options.appDataPath, "terminal", "bashrc");
  }

  async initialize(): Promise<void> {
    const settings = await loadClientSettings(this.options.appDataPath);
    this.terminalCharset = settings.terminalCharset;
    const startupTheme = settings.theme;
    const startupText = (english: string, chinese: string) =>
      settings.locale === "en-US" ? english : chinese;
    await this.files.initialize();
    await this.reloadLanguagePacks(settings.disabledLanguagePacks);
    await migrateMisclassifiedVllm();
    await migrateReasoningOffValues();
    await cp(this.options.bundledExtensionsSource, this.bundledExtensionsDirectory, {
      recursive: true,
      force: true,
    });
    await cp(this.options.bundledSkillsSource, this.bundledSkillsDirectory, {
      recursive: true,
      force: true,
    });
    if (process.platform !== "win32") {
      await atomicWrite(this.terminalProfilePath, agentKStarshipConfig);
      await atomicWrite(this.terminalBashRcPath, agentKBashRcConfig);
    }
    this.options.updateSplash(
      startupText("Configuring Editor plugins…", "配置编辑器插件…"),
      0,
      1,
      startupTheme,
    );
    this.firstPartyEditorPlugins = await loadFirstPartyFileFormatPlugins(
      this.options.firstPartyEditorExtensionsSource,
    );
    this.options.updateSplash(
      startupText("Preparing desktop services…", "正在准备桌面服务…"),
      0,
      1,
      startupTheme,
    );
    this.piLaunch = resolvePiLaunch(
      settings.piExecutable,
      this.options.bundledPiCli,
      this.options.bundledPiNode,
    );
    this.startSettingsWatch();
    await this.startThemeWatch();
    let loadingStartupLocalModel = false;
    const localModelPhaseText: Record<string, [string, string]> = {
      "preparing-runtime": ["准备私有运行时", "Preparing private runtime"],
      "downloading-runtime": ["下载私有运行时", "Downloading private runtime"],
      "verifying-runtime": ["校验私有运行时", "Verifying private runtime"],
      "extracting-runtime": ["解压私有运行时", "Extracting private runtime"],
      "starting-server": ["启动 llama.cpp 服务", "Starting llama.cpp server"],
      "loading-model": ["加载 GGUF 模型", "Loading GGUF model"],
      "health-check": ["等待模型就绪", "Waiting for model readiness"],
      ready: ["模型已就绪", "Model ready"],
    };
    this.localModels = new LocalModelManager({
      cachePath: this.options.cachePath,
      rootPath: this.options.localModelRoot,
      enabled: !settings.disabledModelProviders.includes(LOCAL_MODEL_PROVIDER_ID),
      emit: (event) => {
        this.options.emit(event);
        if (!loadingStartupLocalModel || event.type !== "local_model_run_progress") return;
        const phase = asString(event.phase) ?? "preparing-runtime";
        const labels = localModelPhaseText[phase] ?? [phase, phase];
        const completed = typeof event.completed === "number" ? event.completed : 0;
        const total = typeof event.total === "number" && event.total > 0 ? event.total : 4;
        const bytesCompleted = typeof event.bytesCompleted === "number" ? event.bytesCompleted : 0;
        const bytesTotal = typeof event.bytesTotal === "number" ? event.bytesTotal : 0;
        const byteProgress = bytesTotal > 0 ? Math.min(1, Math.max(0, bytesCompleted / bytesTotal)) : 0;
        const modelName = asString(event.modelName) ?? startupText("local model", "本地模型");
        this.options.updateSplash(
          `${startupText("Loading managed local model", "正在加载托管本地模型")} · ${modelName} · ${labels[settings.locale === "en-US" ? 1 : 0]}`,
          Math.min(total, completed + byteProgress),
          total,
          startupTheme,
        );
      },
      piBusy: () => this.pool?.hasActiveAgentTasks() ?? false,
      verifyPiBusy: async () => this.pool?.hasActiveAgentTasksVerified() ?? false,
      reloadPi: async () => this.pool?.reload(),
      migrateModelReferences: async (previous, next) => {
        const current = await loadClientSettings(this.options.appDataPath);
        const oldKey = previous ? `${LOCAL_MODEL_PROVIDER_ID}/${previous}` : undefined;
        const nextKey = next ? `${LOCAL_MODEL_PROVIDER_ID}/${next}` : undefined;
        await saveClientSettings(this.options.appDataPath, {
          ...current,
          defaultModel: oldKey && current.defaultModel === oldKey ? nextKey ?? "" : current.defaultModel,
          sessionModels: Object.fromEntries(Object.entries(current.sessionModels).flatMap(([path, model]) => oldKey && model === oldKey ? nextKey ? [[path, nextKey]] : [] : [[path, model]])),
        });
      },
      ...(process.env.AGENT_K_E2E === "1" && process.env.AGENT_K_E2E_LOCAL_MODEL_ENDPOINT
        ? { endpoints: {
            huggingface: process.env.AGENT_K_E2E_LOCAL_MODEL_ENDPOINT,
            modelscope: process.env.AGENT_K_E2E_LOCAL_MODEL_ENDPOINT,
            github: process.env.AGENT_K_E2E_LOCAL_MODEL_ENDPOINT,
          } }
        : {}),
      ...(process.env.AGENT_K_E2E === "1" && process.env.AGENT_K_E2E_LOCAL_MODEL_RUNTIME && process.env.AGENT_K_E2E_LOCAL_MODEL_NODE
        ? { runtimeOverride: { executable: process.env.AGENT_K_E2E_LOCAL_MODEL_NODE, args: [process.env.AGENT_K_E2E_LOCAL_MODEL_RUNTIME] } }
        : {}),
    });
    await this.localModels.initialize();
    const startupLocalModelId = this.localModels.snapshot().activeModelId;
    if (!settings.disabledModelProviders.includes(LOCAL_MODEL_PROVIDER_ID) && startupLocalModelId) {
      loadingStartupLocalModel = true;
      try {
        await this.localModels.run(startupLocalModelId);
      } catch (cause) {
        this.options.emit({ type: "local_model_startup_error", modelId: startupLocalModelId, error: String(cause) });
      } finally {
        loadingStartupLocalModel = false;
      }
    }
    this.pool = new RpcPool({
      appDataPath: this.options.appDataPath,
      autoCompactionEnabled: settings.autoCompactEnabled,
      bundledExtensionsDirectory: this.bundledExtensionsDirectory,
      bundledSkillsDirectory: this.bundledSkillsDirectory,
      firstPartyEditorExtensions: this.firstPartyEditorPlugins.map((plugin) => ({
        directory: dirname(plugin.path),
        id: plugin.id,
      })),
      firstPartyLanguagePackSkills: await this.languagePacks.skillDirectories(),
      launch: this.piLaunch,
      minimum: settings.workerPoolSize,
      permissionExtensionSource: this.options.permissionExtensionSource,
      emit: this.options.emit,
    });
    // Session grants intentionally last only for this desktop run.
    await atomicWrite(join(this.options.appDataPath, "permission-state.json"), "[]");
  }

  private startSettingsWatch(): void {
    this.settingsWatcher?.close();
    try {
      this.settingsWatcher = watch(this.options.appDataPath, (_kind, name) => {
        if (String(name) !== "client-settings.json") return;
        if (this.settingsWatchTimer) clearTimeout(this.settingsWatchTimer);
        this.settingsWatchTimer = setTimeout(() => {
          this.settingsWatchTimer = undefined;
          this.options.emit({ type: "client_settings_changed" });
        }, 100);
      });
      this.settingsWatcher.on("error", (cause) => this.options.emit({ type: "settings_watch_error", error: String(cause) }));
    } catch (cause) {
      this.options.emit({ type: "settings_watch_error", error: String(cause) });
    }
  }

  private async startThemeWatch(): Promise<void> {
    this.themeWatcher?.close();
    if (this.themeWatchTimer) clearTimeout(this.themeWatchTimer);
    const root = themeDirectory();
    await mkdir(root, { recursive: true });
    try {
      this.themeWatcher = watch(root, { recursive: true }, () => {
        if (this.themeWatchTimer) clearTimeout(this.themeWatchTimer);
        this.themeWatchTimer = setTimeout(() => {
          this.themeWatchTimer = undefined;
          void this.emitThemeChange();
        }, 180);
      });
      this.themeWatcher.on("error", (cause) => this.options.emit({ type: "theme_watch_error", error: String(cause) }));
    } catch (cause) {
      this.options.emit({ type: "theme_watch_error", error: String(cause) });
    }
  }

  private async emitThemeChange(): Promise<void> {
    try {
      const settings = await loadClientSettings(this.options.appDataPath);
      const themes = await listThemes(this.options.appDataPath, this.options.bundledThemesSource);
      // A custom active theme being midway through a save can temporarily be
      // invalid. Keep the last known renderer palette until it validates.
      if (settings.theme !== "system" && !["light", "soft-light", "dark"].includes(settings.theme) && !themes.some((theme) => theme.id === settings.theme)) return;
      this.options.emit({ type: "themes_changed" });
    } catch (cause) {
      this.options.emit({ type: "theme_watch_error", error: String(cause) });
    }
  }

  async invoke(command: string, rawArgs: unknown): Promise<unknown> {
    const args = asObject(rawArgs);
    if (command === "get_provider_balance")
      return providerBalance(requiredString(args.providerId, "providerId"));
    if (command === "get_codex_quota") return codexQuota();
    if (command === "open_in_file_manager")
      return this.files.openInFileManager(
        requiredString(args.root, "root"),
        requiredString(args.path, "path"),
      );
    const pool = this.requirePool();
    switch (command) {
      case "get_runtime_info":
        return this.runtimeInfo();
      case "get_cache_directory_info":
        return { activePath: this.options.cachePath, defaultPath: join(this.options.appDataPath, "cache") };
      case "validate_cache_directory": {
        const path = requiredString(args.path, "path");
        if (!isAbsolute(path)) throw new Error("Cache directory must be an absolute path");
        await mkdir(path, { recursive: true });
        await access(path, constants.W_OK);
        return path;
      }
      case "get_client_settings":
        return loadClientSettings(this.options.appDataPath);
      case "list_themes":
        return listThemes(this.options.appDataPath, this.options.bundledThemesSource);
      case "import_theme":
        return importTheme(this.options.appDataPath, requiredString(args.path, "path"));
      case "remove_theme":
        await removeTheme(this.options.appDataPath, requiredString(args.id, "id"));
        return;
      case "save_client_settings":
        {
          const input = asObject(args.settings);
          const current = await loadClientSettings(this.options.appDataPath);
          const environmentPromptChanged =
            input.environmentPromptEnabled !== current.environmentPromptEnabled;
          const autoCompactionChanged =
            input.autoCompactEnabled !== current.autoCompactEnabled;
          const languagePacksChanged = JSON.stringify(input.disabledLanguagePacks ?? current.disabledLanguagePacks) !== JSON.stringify(current.disabledLanguagePacks);
          if ((environmentPromptChanged || languagePacksChanged) && pool.status().busy > 0)
            throw new Error("Wait for active Pi tasks and dialogs to finish before changing runtime capabilities");
          const manager = this.requireLocalModels();
          const requestedDisabledProviders = asArray(input.disabledModelProviders).filter((id): id is string => typeof id === "string");
          const disabledModelProviders = manager.snapshot().enabled
            ? requestedDisabledProviders.filter((id) => id !== LOCAL_MODEL_PROVIDER_ID)
            : [...new Set([...requestedDisabledProviders, LOCAL_MODEL_PROVIDER_ID])];
          const saved = await saveClientSettings(this.options.appDataPath, { ...input, disabledModelProviders });
          this.terminalCharset = saved.terminalCharset;
          for (const plugin of this.languagePacks.list()) await this.languagePacks.setEnabled(plugin.id, !saved.disabledLanguagePacks.includes(plugin.id));
          if (languagePacksChanged) pool.setLanguagePackSkills(await this.languagePacks.skillDirectories());
          if (environmentPromptChanged || autoCompactionChanged || languagePacksChanged) {
            try {
              if (autoCompactionChanged)
                await pool.setAutoCompaction(saved.autoCompactEnabled);
              if (environmentPromptChanged || languagePacksChanged)
                await pool.reload();
            } catch (cause) {
              await saveClientSettings(this.options.appDataPath, current);
              if (languagePacksChanged) {
                for (const plugin of this.languagePacks.list()) await this.languagePacks.setEnabled(plugin.id, !current.disabledLanguagePacks.includes(plugin.id));
                pool.setLanguagePackSkills(await this.languagePacks.skillDirectories());
                await pool.reload().catch(() => undefined);
              }
              if (autoCompactionChanged)
                await pool.setAutoCompaction(current.autoCompactEnabled).catch(() => undefined);
              throw cause;
            }
          }
          return saved;
        }
      case "list_browsers":
        return listBrowsers();
      case "open_external_url":
        return openExternalUrl(requiredString(args.url, "url"), requiredString(args.browserId, "browserId"));
      case "set_session_permission":
        return setSessionPermission(this.options.appDataPath, requiredString(args.sessionId, "sessionId"), args.allowed === true);
      case "save_model_provider":
        return saveModelProvider(args.provider as ProviderDraft);
      case "delete_model_provider":
        return deleteModelProvider(requiredString(args.providerId, "providerId"));
      case "get_provider_catalog":
        return providerCatalog(await pool.commandConnected(
          { type: "get_available_models" },
          homedir(),
          optionalString(args.runtimeId),
        ));
      case "save_provider_api_key":
        return saveProviderApiKey(requiredString(args.providerId, "providerId"), requiredString(args.apiKey, "apiKey"));
      case "logout_provider":
        return logoutProvider(requiredString(args.providerId, "providerId"));
      case "open_provider_login":
        return openProviderLogin(requiredString(args.providerId, "providerId"), this.requirePiLaunch());
      case "reload_pi_runtimes":
        try {
          const available = await pool.commandConnected(
            { type: "get_available_models" },
            homedir(),
          );
          const synchronization = await syncRemoteProviderModels(available);
          if (synchronization.errors.length) {
            this.options.emit({
              type: "model_catalog_sync_failed",
              message: synchronization.errors.join("\n"),
            });
          }
        } catch (cause) {
          this.options.emit({
            type: "model_catalog_sync_failed",
            message: errorMessage(cause),
          });
        }
        await pool.reload();
        await this.reloadLanguagePacks((await loadClientSettings(this.options.appDataPath)).disabledLanguagePacks);
        this.options.emit({ type: "model_catalog_changed" });
        return;
      case "get_pi_resources":
        return getPiResources(
          this.options.appDataPath,
          pool,
          requiredString(args.cwd, "cwd"),
          this.bundledExtensionsDirectory,
          this.bundledSkillsDirectory,
          this.options.firstPartyEditorExtensionsSource,
          optionalString(args.runtimeId),
        );
      case "get_file_format_plugins":
        return getFileFormatPlugins(
          this.options.appDataPath,
          requiredString(args.cwd, "cwd"),
          this.firstPartyEditorPlugins,
        );
      case "get_first_party_file_format_plugins":
        return this.firstPartyEditorPlugins;
      case "install_editor_plugin":
        return installUserFileFormatPlugin(requiredString(args.sourceDirectory, "sourceDirectory"), this.firstPartyEditorPlugins);
      case "get_editor_plugin_runtime":
        return getEditorPluginRuntime(
          this.options.appDataPath,
          requiredString(args.cwd, "cwd"),
          this.firstPartyEditorPlugins,
          requiredString(args.pluginId, "pluginId"),
        );
      case "get_editor_plugin_skill":
        return getEditorPluginSkill(
          this.options.appDataPath,
          requiredString(args.cwd, "cwd"),
          this.firstPartyEditorPlugins,
          requiredString(args.pluginId, "pluginId"),
        );
      case "get_editor_plugin_dependency": {
        const dependencyId = requiredString(args.dependencyId, "dependencyId");
        return getEditorPluginDependency(
          this.options.firstPartyEditorExtensionsSource,
          dependencyId,
        );
      }
      case "apply_pi_resource_changes":
        return applyPiResourceChanges(
          this.options.appDataPath,
          pool,
          requiredString(args.cwd, "cwd"),
          asArray(args.changes) as PiResourceChange[],
          args.reload === true,
        );
      case "preview_skill_hub":
        return previewSkillHub(requiredString(args.sourceUrl, "sourceUrl"));
      case "install_skill_hub": {
        const scope = requiredSkillHubScope(args.scope);
        return installSkillHub(
          requiredString(args.sourceUrl, "sourceUrl"),
          requiredString(args.hash, "hash"),
          scope,
          requiredString(args.cwd, "cwd"),
        );
      }
      case "detect_local_service":
        return detectLocalService(requiredString(args.baseUrl, "baseUrl"));
      case "discover_local_models":
        return discoverLocalModels(requiredString(args.baseUrl, "baseUrl"), args.ollama === true);
      case "infer_model_reasoning": {
        const settings = await loadClientSettings(this.options.appDataPath);
        const modelIds = asArray(args.modelIds)
          .map(asString)
          .filter((id): id is string => Boolean(id));
        return inferModelReasoning(modelIds, {
          defaultModel: settings.defaultModel,
          launch: this.requirePiLaunch(),
        });
      }
      case "local_models_list":
        await this.pool?.hasActiveAgentTasksVerified();
        return this.requireLocalModels().snapshot();
      case "local_models_search":
        return this.requireLocalModels().search(requiredLocalModelHub(args.source), requiredString(args.query, "query"));
      case "local_models_inspect":
        return this.requireLocalModels().inspectRepository(requiredLocalModelHub(args.source), requiredString(args.repository, "repository"));
      case "local_models_download":
        return this.requireLocalModels().enqueue(requiredLocalModelHub(args.source), requiredString(args.repository, "repository"), requiredString(args.file, "file"));
      case "local_models_download_pause":
        return this.requireLocalModels().pauseDownload(requiredString(args.id, "id"));
      case "local_models_download_resume":
        return this.requireLocalModels().resumeDownload(requiredString(args.id, "id"));
      case "local_models_download_cancel":
        return this.requireLocalModels().cancelDownload(requiredString(args.id, "id"));
      case "local_models_import":
        return this.requireLocalModels().importGguf(requiredString(args.path, "path"));
      case "local_models_verify":
        return this.requireLocalModels().verify(requiredString(args.id, "id"));
      case "local_models_activate":
        return this.requireLocalModels().activate(requiredString(args.id, "id"));
      case "local_models_run":
        return this.requireLocalModels().run(requiredString(args.id, "id"));
      case "local_models_set_enabled": {
        if (typeof args.enabled !== "boolean") throw new Error("enabled must be a boolean");
        const manager = this.requireLocalModels();
        const previous = manager.snapshot().enabled;
        await manager.setEnabled(args.enabled);
        let saved;
        try {
          const current = await loadClientSettings(this.options.appDataPath);
          const disabledModelProviders = args.enabled
            ? current.disabledModelProviders.filter((id) => id !== LOCAL_MODEL_PROVIDER_ID)
            : [...new Set([...current.disabledModelProviders, LOCAL_MODEL_PROVIDER_ID])];
          saved = await saveClientSettings(this.options.appDataPath, { ...current, disabledModelProviders });
        } catch (cause) {
          await manager.setEnabled(previous).catch(() => undefined);
          throw cause;
        }
        this.options.emit({ type: "client_settings_changed" });
        this.options.emit({ type: "local_models_changed" });
        if (args.enabled) {
          const id = manager.snapshot().activeModelId;
          if (id) await manager.run(id);
        }
        return saved;
      }
      case "local_models_stop":
        return this.requireLocalModels().stop();
      case "local_models_update":
        return this.requireLocalModels().updateConfig(requiredString(args.id, "id"), requiredLocalModelConfig(args.config));
      case "local_models_delete":
        return this.requireLocalModels().delete(requiredString(args.id, "id"));
      case "local_models_logs":
        return this.requireLocalModels().logsSnapshot();
      case "list_projects":
        return this.files.listProjects();
      case "add_workspace":
        return this.files.addWorkspace(requiredString(args.cwd, "cwd"));
      case "remove_workspace":
        return this.files.removeWorkspace(requiredString(args.cwd, "cwd"));
      case "session_messages":
        return this.files.sessionMessages(requiredString(args.path, "path"));
      case "hide_session":
        return this.files.hideSession(requiredString(args.path, "path"), args.hidden === true);
      case "delete_session":
        return this.files.deleteSession(requiredString(args.path, "path"));
      case "rename_session":
        return this.files.renameSession(
          requiredString(args.path, "path"),
          requiredString(args.name, "name"),
          requiredString(args.timestamp, "timestamp"),
        );
      case "spawn_pi_worker":
        return pool.spawn(requiredString(args.cwd, "cwd"));
      case "resize_pi_pool":
        return pool.resize(requiredNumber(args.size, "size"));
      case "get_worker_pool_status":
        return pool.status();
      case "connect_pi":
        return pool.connect(
          requiredString(args.cwd, "cwd"),
          optionalString(args.sessionPath),
          optionalString(args.runtimeId),
        );
      case "prepare_session":
        return pool.prepare(requiredString(args.cwd, "cwd"));
      case "create_session":
        return pool.createSession(requiredString(args.runtimeId, "runtimeId"));
      case "pi_command": {
        const piCommand = asObject(args.command);
        if (piCommand.type === "set_model" && piCommand.provider === LOCAL_MODEL_PROVIDER_ID) {
          const active = this.requireLocalModels().snapshot().activeModelId;
          if (typeof piCommand.modelId !== "string" || piCommand.modelId !== active)
            throw new Error("Local models can only be switched in Agent K Settings");
          try {
            return await pool.command(piCommand, optionalString(args.runtimeId));
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            if (!/^Model not found:\s*agent-k-llama-cpp\//i.test(message)) throw cause;
            // models.json is authoritative, but an already-running Pi process
            // can still hold the catalog loaded before the active local model
            // changed. Reload once and retry instead of exposing that transient
            // split-brain state to the conversation UI.
            await pool.reload();
            return pool.command(piCommand, optionalString(args.runtimeId));
          }
        }
        return pool.command(piCommand, optionalString(args.runtimeId));
      }
      case "pi_abort":
        return pool.abort(optionalString(args.runtimeId));
      case "close_pi_runtime":
        return pool.close(requiredString(args.runtimeId, "runtimeId"));
      case "pi_extension_ui_response":
        return pool.extensionResponse(asObject(args.response), optionalString(args.runtimeId));
      case "update_startup_progress":
        this.options.updateSplash(
          requiredString(args.message, "message"),
          requiredNumber(args.current, "current"),
          requiredNumber(args.total, "total"),
          optionalString(args.theme) ?? "light",
        );
        return;
      case "finish_startup":
        this.options.finishSplash();
        return;
      case "project_tree":
        return this.files.projectTree(requiredString(args.root, "root"));
      case "project_context":
        return this.files.projectContext(requiredString(args.root, "root"));
      case "directory_tree":
        return this.files.directoryTree(
          requiredString(args.root, "root"),
          requiredString(args.path, "path"),
          requiredDirectoryDepth(args.depth),
        );
      case "browse_directories": {
        const path = optionalString(args.path) ?? homedir();
        const entries = readdirSync(path, { withFileTypes: true });
        const drives = mountedVolumes();
        return { path, parent: dirname(path), directories: entries.filter((entry) => entry.isDirectory() && entry.name !== "node_modules").map((entry) => entry.name).sort((a, b) => a.localeCompare(b)), files: entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b)), drives };
      }
      case "create_browsed_directory": {
        const parent = requiredString(args.parent, "parent");
        const name = requiredString(args.name, "name").trim();
        if (!isAbsolute(parent)) throw new Error("Parent directory must be absolute");
        if (
          !name ||
          name === "." ||
          name === ".." ||
          /[<>:"/\\|?*\u0000-\u001f]/u.test(name) ||
          /[. ]$/u.test(name)
        )
          throw new Error("Invalid directory name");
        const target = join(parent, name);
        await mkdir(target, { recursive: false });
        return target;
      }
      case "read_text_file":
        return this.files.readText(requiredString(args.root, "root"), requiredString(args.path, "path"));
      case "read_binary_file":
        return this.files.readBinary(requiredString(args.root, "root"), requiredString(args.path, "path"));
      case "save_temp_attachment":
        return this.files.saveTempAttachment(requiredString(args.name, "name"), numberArray(args.data));
      case "start_workspace_preview":
        return this.files.startPreview(
          requiredString(args.root, "root"),
          requiredString(args.path, "path"),
          requiredString(args.content, "content"),
          args.appBridge === true,
        );
      case "start_web_project":
        return this.startWebProject(requiredString(args.root, "root"), requiredString(args.path, "path"));
      case "k_app_process_start":
        return this.kAppProcesses.start(
          requiredString(args.root, "root"),
          requiredString(args.directory, "directory"),
          requiredString(args.command, "command"),
          stringArray(args.args),
          optionalString(args.cwd) ?? ".",
        );
      case "k_app_process_list":
        return this.kAppProcesses.list(requiredString(args.root, "root"), requiredString(args.directory, "directory"));
      case "k_app_process_status":
        return this.kAppProcesses.status(requiredString(args.root, "root"), requiredString(args.directory, "directory"), requiredString(args.id, "id"));
      case "k_app_process_wait":
        return this.kAppProcesses.wait(requiredString(args.root, "root"), requiredString(args.directory, "directory"), requiredString(args.id, "id"));
      case "k_app_process_output":
        return this.kAppProcesses.output(
          requiredString(args.root, "root"),
          requiredString(args.directory, "directory"),
          requiredString(args.id, "id"),
          optionalNumber(args.stdoutCursor) ?? 0,
          optionalNumber(args.stderrCursor) ?? 0,
        );
      case "k_app_process_stop":
        return this.kAppProcesses.stop(requiredString(args.root, "root"), requiredString(args.directory, "directory"), requiredString(args.id, "id"));
      case "k_app_process_open":
        return this.kAppProcesses.open(
          requiredString(args.root, "root"),
          requiredString(args.directory, "directory"),
          requiredString(args.target, "target"),
          this.options.openPath,
        );
      case "list_language_packs":
        return this.languagePacks.list();
      case "preview_language_pack":
        return this.languagePacks.preview(requiredString(args.sourceDirectory, "sourceDirectory"));
      case "install_language_pack":
        {
          if (pool.status().busy > 0) throw new Error("Wait for active Pi tasks before installing a Language Pack");
          const installed = await this.languagePacks.install(requiredString(args.sourceDirectory, "sourceDirectory"), requiredString(args.approvalToken, "approvalToken"));
          pool.setLanguagePackSkills(await this.languagePacks.skillDirectories()); await pool.reload(); return installed;
        }
      case "uninstall_language_pack":
        if (pool.status().busy > 0) throw new Error("Wait for active Pi tasks before uninstalling a Language Pack");
        await this.languagePacks.uninstall(requiredString(args.id, "id")); pool.setLanguagePackSkills(await this.languagePacks.skillDirectories()); await pool.reload(); return;
      case "list_language_pack_projects":
        return this.languagePacks.listProjects();
      case "language_pack_call":
        return this.languagePacks.call(requiredString(args.id, "id"), requiredString(args.method, "method"), ...(Array.isArray(args.args) ? args.args : []));
      case "language_pack_invoke": {
        const packId = requiredString(args.packId, "packId"); const action = requiredString(args.action, "action");
        const cwd = resolve(requiredString(args.cwd, "cwd")); const arguments_ = asObject(args.arguments);
        const workspace = arguments_.workspace;
        if (workspace !== undefined) {
          if (typeof workspace !== "string" || isAbsolute(workspace)) throw new Error("Language Pack workspace must be relative");
          const absoluteWorkspace = resolve(cwd, workspace); const child = relative(cwd, absoluteWorkspace);
          if (child.startsWith("..") || isAbsolute(child)) throw new Error("Language Pack workspace escapes the current workspace");
          arguments_.workspace = absoluteWorkspace;
        }
        return this.languagePacks.invoke(packId, action, arguments_);
      }
      case "language_pack_request":
        return this.languagePacks.callForLanguage(requiredString(args.language, "language"), "lsp", requiredString(args.file, "file"), requiredString(args.method, "method"), args.params);
      case "language_pack_notify":
        return this.languagePacks.callForLanguage(requiredString(args.language, "language"), "notify", requiredString(args.file, "file"), requiredString(args.method, "method"), args.params);
      case "write_text_file":
        return this.files.writeText(requiredString(args.root, "root"), requiredString(args.path, "path"), requiredString(args.content, "content"));
      case "create_directory":
        return this.files.createDirectory(requiredString(args.root, "root"), requiredString(args.path, "path"));
      case "move_path":
        return this.files.move(requiredString(args.root, "root"), requiredString(args.from, "from"), requiredString(args.to, "to"));
      case "copy_path":
        return this.files.copy(requiredString(args.root, "root"), requiredString(args.from, "from"), requiredString(args.to, "to"));
      case "import_external_paths":
        return this.files.importPaths(
          requiredString(args.root, "root"),
          requiredString(args.targetDir, "targetDir"),
          stringArray(args.sources),
        );
      case "trash_path":
        return this.files.trash(requiredString(args.root, "root"), requiredString(args.path, "path"));
      case "open_terminal_at":
        return this.files.openTerminal(requiredString(args.root, "root"), requiredString(args.path, "path"));
      case "start_project_console":
        return this.startProjectConsole(
          requiredString(args.root, "root"),
          requiredNumber(args.cols, "cols"),
          requiredNumber(args.rows, "rows"),
        );
      case "write_project_console":
        return this.writeProjectConsole(
          requiredString(args.id, "id"),
          requiredString(args.data, "data"),
        );
      case "resize_project_console":
        return this.resizeProjectConsole(
          requiredString(args.id, "id"),
          requiredNumber(args.cols, "cols"),
          requiredNumber(args.rows, "rows"),
        );
      case "stop_project_console":
        return this.stopProjectConsole(requiredString(args.id, "id"));
      case "search_files":
        return this.files.search(requiredString(args.root, "root"), requiredString(args.query, "query"));
      case "advanced_search_files":
        { const root = requiredString(args.root, "root"); return this.files.advancedSearch(root, { caseSensitive: args.caseSensitive === true, directory: optionalString(args.directory), filePattern: optionalString(args.filePattern), query: requiredString(args.query, "query"), wholeWord: args.wholeWord === true }, (path, scanned, total) => this.options.emit({ type: "advanced_search_progress", root, path, scanned, total })); }
      case "watch_workspace":
        return this.watchWorkspace(optionalString(args.root));
      case "file_url":
        return this.files.fileUrl(requiredString(args.path, "path"));
      default:
        throw new Error(`Unknown desktop command: ${command}`);
    }
  }

  async shutdown(): Promise<void> {
    this.stopWorkspaceWatch();
    for (const id of this.projectConsoles.keys()) this.stopProjectConsole(id);
    for (const child of this.webProjects.values()) child.kill();
    this.webProjects.clear();
    this.kAppProcesses.shutdown();
    this.pool?.shutdown();
    await this.localModels?.shutdown();
    await this.languagePacks.shutdown();
    this.files.shutdown();
  }

  private stopWorkspaceWatch(): void {
    this.workspaceWatcher?.close(); this.workspaceWatcher = undefined; this.workspaceWatchRoot = undefined;
    for (const timer of this.workspaceWatchTimers.values()) clearTimeout(timer);
    this.workspaceWatchTimers.clear();
    this.workspaceWatchKinds.clear();
    if (this.workspaceLanguageChangeTimer) clearTimeout(this.workspaceLanguageChangeTimer);
    this.workspaceLanguageChangeTimer = undefined;
    this.workspaceLanguageChanges.clear();
  }

  private queueLanguageServerFileChange(change: WorkspaceFileChange): void {
    const previous = this.workspaceLanguageChanges.get(change.path);
    const merged = mergeWorkspaceFileChange(previous, change);
    if (merged) this.workspaceLanguageChanges.set(change.path, merged);
    else this.workspaceLanguageChanges.delete(change.path);
    if (this.workspaceLanguageChangeTimer) return;
    this.workspaceLanguageChangeTimer = setTimeout(() => {
      this.workspaceLanguageChangeTimer = undefined;
      const changes = [...this.workspaceLanguageChanges.values()];
      this.workspaceLanguageChanges.clear();
      this.languagePacks.workspaceFilesChanged(changes);
    }, 120);
  }

  private async watchWorkspace(rootInput?: string): Promise<void> {
    this.stopWorkspaceWatch();
    if (!rootInput) return;
    const root = await realpath(rootInput);
    this.workspaceWatchRoot = root;
    try {
      this.workspaceWatcher = watch(root, { recursive: true }, (kind, name) => {
        if (!name || !this.workspaceWatchRoot) return;
        const absolute = resolve(root, String(name));
        if (!isPathInside(root, absolute)) return;
        const path = relative(root, absolute).replaceAll("\\", "/");
        const mergedKind = mergeWorkspaceWatchKind(this.workspaceWatchKinds.get(path), kind);
        this.workspaceWatchKinds.set(path, mergedKind);
        const previous = this.workspaceWatchTimers.get(path); if (previous) clearTimeout(previous);
        this.workspaceWatchTimers.set(path, setTimeout(() => {
          this.workspaceWatchTimers.delete(path);
          const eventKind = this.workspaceWatchKinds.get(path) ?? kind;
          this.workspaceWatchKinds.delete(path);
          if (this.workspaceWatchRoot !== root) return;
          const changeType: WorkspaceFileChange["type"] = eventKind === "change"
            ? 2
            : existsSync(absolute) ? 1 : 3;
          this.options.emit({ type: "workspace_file_changed", root, path, kind: eventKind, changeType });
          this.queueLanguageServerFileChange({ path: absolute, type: changeType });
        }, 80));
      });
      this.workspaceWatcher.on("error", (cause) => this.options.emit({ type: "workspace_watch_error", root, error: String(cause) }));
    } catch (cause) {
      this.options.emit({ type: "workspace_watch_error", root, error: String(cause) });
    }
  }

  private async startWebProject(root: string, path: string): Promise<{ id: string; url: string }> {
    const workspaceRoot = resolve(root);
    const directory = resolve(workspaceRoot, path);
    if (!isPathInside(workspaceRoot, directory) && directory !== workspaceRoot)
      throw new Error("Web project path is outside the active workspace");
    const manifest = asObject(JSON.parse(await readFile(join(directory, "package.json"), "utf8")));
    const hasDevScript = typeof asObject(manifest.scripts).dev === "string";
    const hasViteConfig = ["vite.config.js", "vite.config.ts", "vite.config.mjs", "vite.config.cjs"]
      .some((name) => existsSync(join(directory, name)));
    if (!hasDevScript && !hasViteConfig)
      throw new Error("This project has neither an npm dev script nor a Vite config");
    // Windows cannot execute npm.cmd directly through CreateProcess. Invoke the
    // fixed command through cmd.exe instead; the project path remains `cwd`, so
    // no user-supplied value is interpolated into the command string.
    const environment = { ...process.env, BROWSER: "none", CI: "true", VITE_OPEN: "false" };
    const port = await new Promise<number>((resolvePort, rejectPort) => {
      const reservation = createServer();
      reservation.once("error", rejectPort);
      reservation.listen(0, "127.0.0.1", () => {
        const address = reservation.address();
        if (!address || typeof address === "string") {
          reservation.close();
          rejectPort(new Error("Unable to reserve a local web preview port"));
          return;
        }
        reservation.close((error) => error ? rejectPort(error) : resolvePort(address.port));
      });
    });
    // Ask compatible dev servers (Vite, Vue CLI, Next, etc.) for an ephemeral
    // port. Each preview then owns a distinct URL instead of accidentally
    // reusing an already-running project's common development port.
    const command = hasDevScript ? `npm run dev -- --host 127.0.0.1 --port ${port}` : `npm exec vite -- --host 127.0.0.1 --port ${port}`;
    const child = process.platform === "win32"
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], { cwd: directory, env: environment, shell: false, windowsHide: true })
      : spawn("npm", hasDevScript ? ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port)] : ["exec", "vite", "--", "--host", "127.0.0.1", "--port", String(port)], { cwd: directory, env: environment, shell: false, windowsHide: true });
    const id = randomId("web-"); this.webProjects.set(id, child);
    return await new Promise((resolve, reject) => {
      let output = ""; let settled = false;
      const done = (url?: string, error?: Error) => { if (settled) return; settled = true; clearTimeout(timeout); clearInterval(probeTimer); if (url) resolve({ id, url }); else { this.webProjects.delete(id); child.kill(); reject(error ?? new Error("Web development server did not report a local URL")); } };
      const scan = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-12000); const match = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+(?:\/[^\s]*)?/i.exec(output); if (match) done(match[0]); };
      const timeout = setTimeout(() => done(undefined, new Error("Timed out waiting for the web development server")), 20_000);
      const probeTimer = setInterval(() => {
        void fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(350) })
          .then((response) => { if (response.ok || response.status < 500) done(`http://127.0.0.1:${port}/`); })
          .catch(() => undefined);
      }, 300);
      child.stdout.on("data", scan); child.stderr.on("data", scan);
      child.once("error", (error) => done(undefined, error));
      child.once("exit", (code) => done(undefined, new Error(`Web development server exited (${code ?? "unknown"})`)));
    });
  }

  private startProjectConsole(root: string, cols: number, rows: number): string {
    const id = randomId();
    const isWindows = process.platform === "win32";
    const configuredShell = process.env.SHELL?.trim();
    const executable = isWindows
      ? "powershell.exe"
      : configuredShell && isAbsolute(configuredShell) && existsSync(configuredShell)
        ? configuredShell
        : existsSync("/bin/bash")
          ? "/bin/bash"
          : "/bin/sh";
    const args = isWindows
      ? ["-NoLogo", "-NoExit", "-Command", windowsTerminalInitialization(this.terminalCharset)]
      : basename(executable).toLocaleLowerCase("en-US") === "bash"
        ? ["--rcfile", this.terminalBashRcPath, "-i"]
        : [];
    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string",
      ),
    );
    const terminal = pty.spawn(executable, args, {
      cols: terminalDimension(cols, 80),
      rows: terminalDimension(rows, 24),
      cwd: root,
      env: {
        ...environment,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        TERM_PROGRAM: "AgentK",
        ...(isWindows ? {} : {
          AGENT_K_TERMINAL: "1",
          STARSHIP_CONFIG: this.terminalProfilePath,
        }),
      },
      name: "xterm-256color",
    });
    const consoleProcess = { root, terminal };
    this.projectConsoles.set(id, consoleProcess);
    terminal.onData((data) => {
      this.options.emitProjectConsole({ data, id, type: "project_console_output" });
    });
    let finished = false;
    const finish = (code: number, signal?: number) => {
      if (finished) return;
      finished = true;
      this.projectConsoles.delete(id);
      this.options.emitProjectConsole({ code, id, signal, type: "project_console_exit" });
    };
    terminal.onExit(({ exitCode, signal }) => finish(exitCode, signal));
    return id;
  }

  writeProjectConsole(id: string, data: string): void {
    if (data.length > 32_000) throw new Error("Console input is too long");
    const consoleProcess = this.projectConsoles.get(id);
    if (!consoleProcess) throw new Error("Console is not running");
    consoleProcess.terminal.write(data);
  }

  private resizeProjectConsole(id: string, cols: number, rows: number): void {
    const consoleProcess = this.projectConsoles.get(id);
    if (!consoleProcess) throw new Error("Console is not running");
    consoleProcess.terminal.resize(
      terminalDimension(cols, 80),
      terminalDimension(rows, 24),
    );
  }

  private stopProjectConsole(id: string): void {
    const consoleProcess = this.projectConsoles.get(id);
    if (!consoleProcess) return;
    consoleProcess.terminal.kill();
  }

  private async reloadLanguagePacks(disabled: readonly string[]): Promise<void> {
    await this.languagePacks.reload();
    const installed = new Set(this.languagePacks.list().map(({ id }) => id));
    for (const id of disabled) if (installed.has(id)) await this.languagePacks.setEnabled(id, false);
    this.options.emit({ type: "language_pack_registry_reloaded" });
  }

  private requirePool(): RpcPool {
    if (!this.pool) throw new Error("Desktop backend is not initialized");
    return this.pool;
  }

  private requireLocalModels(): LocalModelManager {
    if (!this.localModels) throw new Error("Local model manager is not initialized");
    return this.localModels;
  }

  private requirePiLaunch(): PiLaunch {
    if (!this.piLaunch) throw new Error("Pi runtime is not initialized");
    return this.piLaunch;
  }

  private async runtimeInfo(): Promise<JsonObject> {
    const launch = this.requirePiLaunch();
    const piVersion = await new Promise<string>((resolveVersion) => {
      const child = spawn(launch.executable, [...launch.args, "--version"], {
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        env: { ...process.env, ...launch.environment },
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.once("error", () => resolveVersion("unknown"));
      child.once("close", (code) => resolveVersion(code === 0 ? output.trim() || "unknown" : "unknown"));
    });
    return {
      piVersion,
      operatingSystem: process.platform,
      architecture: process.arch,
    };
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredLocalModelHub(value: unknown): Exclude<LocalModelSource, "import"> {
  if (value === "huggingface" || value === "modelscope") return value;
  throw new Error("source must be huggingface or modelscope");
}

function requiredLocalModelConfig(value: unknown): Partial<LocalModelRuntimeConfig> {
  const source = asObject(value);
  const result: Partial<LocalModelRuntimeConfig> = {};
  if (typeof source.backend === "string") result.backend = source.backend as LocalModelBackend;
  if (typeof source.contextSize === "number") result.contextSize = source.contextSize as LocalModelRuntimeConfig["contextSize"];
  if (typeof source.gpuLayers === "number") result.gpuLayers = source.gpuLayers;
  if (typeof source.threads === "number") result.threads = source.threads;
  if (typeof source.cacheTypeK === "string") result.cacheTypeK = source.cacheTypeK as LocalModelRuntimeConfig["cacheTypeK"];
  if (typeof source.cacheTypeV === "string") result.cacheTypeV = source.cacheTypeV as LocalModelRuntimeConfig["cacheTypeV"];
  if (typeof source.maxOutputTokens === "number") result.maxOutputTokens = source.maxOutputTokens;
  if (typeof source.reasoning === "boolean") result.reasoning = source.reasoning;
  return result;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${name} must be a number`);
  return value;
}

function requiredDirectoryDepth(value: unknown): 1 | 2 {
  if (value === 1 || value === 2) return value;
  throw new Error("depth must be 1 or 2");
}

function mergeWorkspaceFileChange(
  previous: WorkspaceFileChange | undefined,
  next: WorkspaceFileChange,
): WorkspaceFileChange | undefined {
  if (!previous) return next;
  // A short-lived file that was created and removed before the batch is
  // invisible to consumers. Delete+create is an atomic replacement/change.
  if (previous.type === 1 && next.type === 3) return undefined;
  if (previous.type === 3 && next.type === 1) return { ...next, type: 2 };
  if (previous.type === 1 && next.type === 2) return previous;
  if (next.type === 3) return next;
  return next;
}

function terminalDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(2, Math.min(1_000, Math.floor(value)));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error("Expected a string array");
  return value as string[];
}

function requiredSkillHubScope(value: unknown): SkillHubScope {
  if (value === "user" || value === "project") return value;
  throw new Error("scope must be user or project");
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number"))
    throw new Error("Expected a number array");
  return value as number[];
}
