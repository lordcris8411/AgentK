import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { cp, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type {
  FileFormatPluginResource,
  JsonObject,
  PiResourceChange,
  SkillHubScope,
} from "./types.js";
import { RpcPool } from "./agent/pool.js";
import { CodexBridge } from "./agent/codex.js";
import { ConversationStore } from "./conversations.js";
import { resolvePiLaunch, type PiLaunch } from "./pi-runtime.js";
import { FileService } from "./files.js";
import {
  deleteModelProvider,
  detectLocalService,
  discoverLocalModels,
  listBrowsers,
  loadClientSettings,
  logoutProvider,
  openExternalUrl,
  openProviderLogin,
  providerCatalog,
  saveClientSettings,
  saveModelProvider,
  saveProviderApiKey,
  setSessionPermission,
  migrateMisclassifiedVllm,
  type ProviderDraft,
} from "./settings.js";
import { applyPiResourceChanges, getPiResources } from "./resources.js";
import {
  getEditorPluginDependency,
  getEditorPluginRuntime,
  getFileFormatPlugins,
  loadFirstPartyFileFormatPlugins,
} from "./file-formats.js";
import { installSkillHub, previewSkillHub } from "./skill-hub.js";
import { asArray, asObject, asString, atomicWrite, isPathInside, randomId } from "./utils.js";

export interface DesktopBackendOptions {
  appDataPath: string;
  bundledExtensionsSource: string;
  firstPartyEditorExtensionsSource: string;
  bundledSkillsSource: string;
  bundledPiCli: string;
  cachePath: string;
  permissionExtensionSource: string;
  emit(event: JsonObject): void;
  emitProjectConsole(event: JsonObject): void;
  updateSplash(message: string, current: number, total: number, theme: string): void;
  finishSplash(): void;
}

type ProjectConsoleProcess = {
  root: string;
  terminal: IPty;
};

export class DesktopBackend {
  private readonly options: DesktopBackendOptions;
  private readonly files: FileService;
  private readonly conversations: ConversationStore;
  private readonly bundledExtensionsDirectory: string;
  private readonly bundledSkillsDirectory: string;
  private firstPartyEditorPlugins: FileFormatPluginResource[] = [];
  private piLaunch?: PiLaunch;
  private pool?: RpcPool;
  private codex?: CodexBridge;
  private readonly projectConsoles = new Map<string, ProjectConsoleProcess>();
  private readonly webProjects = new Map<string, ReturnType<typeof spawn>>();

  constructor(options: DesktopBackendOptions) {
    this.options = options;
    this.files = new FileService(options.appDataPath, options.cachePath);
    this.conversations = new ConversationStore(options.appDataPath);
    this.bundledExtensionsDirectory = join(options.appDataPath, "bundled-extensions");
    this.bundledSkillsDirectory = join(options.appDataPath, "bundled-skills");
  }

  async initialize(): Promise<void> {
    const settings = await loadClientSettings(this.options.appDataPath);
    const startupTheme = settings.theme;
    const startupText = (english: string, chinese: string) =>
      settings.locale === "en-US" ? english : chinese;
    await this.files.initialize();
    await this.conversations.initialize();
    await migrateMisclassifiedVllm();
    await cp(this.options.bundledExtensionsSource, this.bundledExtensionsDirectory, {
      recursive: true,
      force: true,
    });
    await cp(this.options.bundledSkillsSource, this.bundledSkillsDirectory, {
      recursive: true,
      force: true,
    });
    this.options.updateSplash(
      startupText("Configuring Editor plugins…", "配置编辑器插件…"),
      0,
      1,
      startupTheme,
    );
    this.firstPartyEditorPlugins = await loadFirstPartyFileFormatPlugins(
      this.options.firstPartyEditorExtensionsSource,
    );
    if (settings.piEnabled) this.piLaunch = resolvePiLaunch(settings.piExecutable, this.options.bundledPiCli);
    if (this.piLaunch) this.pool = new RpcPool({
      appDataPath: this.options.appDataPath,
      bundledExtensionsDirectory: this.bundledExtensionsDirectory,
      bundledSkillsDirectory: this.bundledSkillsDirectory,
      firstPartyEditorExtensions: this.firstPartyEditorPlugins.map((plugin) => ({
        directory: dirname(plugin.path),
        id: plugin.id,
      })),
      launch: this.piLaunch,
      minimum: settings.workerPoolSize,
      permissionExtensionSource: this.options.permissionExtensionSource,
      emit: this.options.emit,
    });
    if (settings.codexEnabled) this.codex = await CodexBridge.start(settings.codexExecutable, this.options.emit);
    // Session grants intentionally last only for this desktop run.
    await atomicWrite(join(this.options.appDataPath, "permission-state.json"), "[]");
  }

  async invoke(command: string, rawArgs: unknown): Promise<unknown> {
    const args = asObject(rawArgs);
    switch (command) {
      case "get_runtime_info":
        return this.runtimeInfo();
      case "get_client_settings":
        return loadClientSettings(this.options.appDataPath);
      case "save_client_settings":
        return saveClientSettings(this.options.appDataPath, args.settings);
      case "get_backend_status":
        return { pi: Boolean(this.pool), codex: Boolean(this.codex) };
      case "reload_backends":
        return this.reloadBackends();
      case "codex_start_thread":
        return this.requireCodex().startThread(requiredString(args.cwd, "cwd"));
      case "codex_resume_thread":
        return this.requireCodex().resumeThread(requiredString(args.threadId, "threadId"));
      case "codex_start_turn":
        return this.requireCodex().startTurn(requiredString(args.threadId, "threadId"), requiredString(args.text, "text"), requiredString(args.cwd, "cwd"), optionalString(args.model));
      case "codex_models":
        return this.requireCodex().models();
      case "codex_plugins":
        return this.requireCodex().plugins(requiredString(args.cwd, "cwd"));
      case "codex_fork_thread":
        return this.requireCodex().forkThread(requiredString(args.threadId, "threadId"), requiredString(args.cwd, "cwd"), optionalString(args.model));
      case "codex_interrupt":
        return this.requireCodex().interrupt(requiredString(args.threadId, "threadId"), requiredString(args.turnId, "turnId"));
      case "codex_interrupt_active":
        return this.requireCodex().interruptActive(requiredString(args.threadId, "threadId"));
      case "create_mirror_session":
        return this.createMirrorSession(requiredBackend(args.backend), requiredString(args.cwd, "cwd"));
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
        if (!this.pool || !optionalString(args.runtimeId)) return [];
        return providerCatalog(await this.pool.command({ type: "get_available_models" }, optionalString(args.runtimeId)));
      case "save_provider_api_key":
        return saveProviderApiKey(requiredString(args.providerId, "providerId"), requiredString(args.apiKey, "apiKey"));
      case "logout_provider":
        return logoutProvider(requiredString(args.providerId, "providerId"));
      case "open_provider_login":
        return openProviderLogin(requiredString(args.providerId, "providerId"), this.requirePiLaunch());
      case "reload_pi_runtimes":
        return this.requirePool().reload();
      case "get_pi_resources":
        if (!this.pool || !optionalString(args.runtimeId)) return [];
        return getPiResources(
          this.options.appDataPath,
          this.pool,
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
      case "get_editor_plugin_runtime":
        return getEditorPluginRuntime(
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
          this.requirePool(),
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
      case "list_projects":
        return this.conversations.listProjects();
      case "add_workspace":
        return this.addWorkspace(requiredString(args.cwd, "cwd"));
      case "register_conversation":
        return this.conversations.register(asObject(args.conversation) as unknown as import("./conversations.js").StoredConversation);
      case "session_messages":
        return this.sessionMessages(requiredString(args.path, "path"));
      case "append_conversation_message":
        return this.conversations.appendMessage(requiredString(args.path, "path"), asObject(args.message));
      case "hide_session":
        return this.conversations.hide(requiredString(args.path, "path"), args.hidden === true);
      case "delete_session":
        return this.deleteConversation(requiredString(args.path, "path"));
      case "rename_session":
        return this.renameConversation(requiredString(args.path, "path"), requiredString(args.name, "name"), requiredString(args.timestamp, "timestamp"));
      case "spawn_pi_worker":
        return this.requirePool().spawn(requiredString(args.cwd, "cwd"));
      case "resize_pi_pool":
        return this.requirePool().resize(requiredNumber(args.size, "size"));
      case "get_worker_pool_status":
        return this.requirePool().status();
      case "connect_pi":
        return this.requirePool().connect(
          requiredString(args.cwd, "cwd"),
          optionalString(args.sessionPath),
          optionalString(args.runtimeId),
        );
      case "prepare_session":
        return this.requirePool().prepare(requiredString(args.cwd, "cwd"));
      case "create_session":
        return this.requirePool().createSession(requiredString(args.runtimeId, "runtimeId"));
      case "pi_command":
        return this.requirePool().command(asObject(args.command), optionalString(args.runtimeId));
      case "pi_abort":
        return this.requirePool().abort(optionalString(args.runtimeId));
      case "close_pi_runtime":
        return this.requirePool().close(requiredString(args.runtimeId, "runtimeId"));
      case "pi_extension_ui_response":
        return this.requirePool().extensionResponse(asObject(args.response), optionalString(args.runtimeId));
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
        return this.files.directoryTree(requiredString(args.root, "root"), requiredString(args.path, "path"));
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
        );
      case "start_web_project":
        return this.startWebProject(requiredString(args.root, "root"), requiredString(args.path, "path"));
      case "compile_cmake_project":
        return this.compileCmakeProject(
          requiredString(args.root, "root"),
          requiredString(args.path, "path"),
          requiredString(args.terminalId, "terminalId"),
        );
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
      case "open_in_file_manager":
        return this.files.openInFileManager(requiredString(args.root, "root"), requiredString(args.path, "path"));
      case "search_files":
        return this.files.search(requiredString(args.root, "root"), requiredString(args.query, "query"));
      case "file_url":
        return this.files.fileUrl(requiredString(args.path, "path"));
      default:
        throw new Error(`Unknown desktop command: ${command}`);
    }
  }

  shutdown(): void {
    this.codex?.stop();
    for (const id of this.projectConsoles.keys()) this.stopProjectConsole(id);
    for (const child of this.webProjects.values()) child.kill();
    this.webProjects.clear();
    this.pool?.shutdown();
    this.files.shutdown();
  }

  private async compileCmakeProject(
    root: string,
    path: string,
    terminalId: string,
  ): Promise<void> {
    const projectDirectory = await this.files.cmakeProjectDirectory(root, path);
    const consoleProcess = this.projectConsoles.get(terminalId);
    if (!consoleProcess) throw new Error("Project console is not running");
    const requestedRoot = resolve(root);
    const consoleRoot = resolve(consoleProcess.root);
    const sameRoot = process.platform === "win32"
      ? requestedRoot.toLocaleLowerCase("en-US") === consoleRoot.toLocaleLowerCase("en-US")
      : requestedRoot === consoleRoot;
    if (!sameRoot)
      throw new Error("Project console belongs to a different workspace");
    const buildDirectory = join(projectDirectory, "build");
    if (/[\r\n]/.test(projectDirectory) || /[\r\n]/.test(buildDirectory))
      throw new Error("CMake project paths cannot contain line breaks");
    const quote = process.platform === "win32"
      ? (value: string) => `'${value.replaceAll("'", "''")}'`
      : (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const source = quote(projectDirectory);
    const build = quote(buildDirectory);
    const command = process.platform === "win32"
      ? `cmake -S ${source} -B ${build}; if ($LASTEXITCODE -eq 0) { cmake --build ${build} }\r`
      : `cmake -S ${source} -B ${build} && cmake --build ${build}\r`;
    consoleProcess.terminal.write(command);
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
    const args = isWindows ? ["-NoLogo"] : [];
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

  private requirePool(): RpcPool {
    if (!this.pool) throw new Error("Desktop backend is not initialized");
    return this.pool;
  }

  private requireCodex(): CodexBridge {
    if (!this.codex) throw new Error("Codex backend is disabled or unavailable");
    return this.codex;
  }

  private async addWorkspace(cwd: string): Promise<string> {
    const selected = await this.files.addWorkspace(cwd);
    await this.conversations.addWorkspace(selected);
    return selected;
  }

  private async reloadBackends(): Promise<void> {
    this.codex?.stop();
    this.codex = undefined;
    this.pool?.shutdown();
    this.pool = undefined;
    this.piLaunch = undefined;
    const settings = await loadClientSettings(this.options.appDataPath);
    if (settings.piEnabled) {
      this.piLaunch = resolvePiLaunch(settings.piExecutable, this.options.bundledPiCli);
      this.pool = new RpcPool({
        appDataPath: this.options.appDataPath,
        bundledExtensionsDirectory: this.bundledExtensionsDirectory,
        bundledSkillsDirectory: this.bundledSkillsDirectory,
        firstPartyEditorExtensions: this.firstPartyEditorPlugins.map((plugin) => ({ directory: dirname(plugin.path), id: plugin.id })),
        launch: this.piLaunch,
        minimum: settings.workerPoolSize,
        permissionExtensionSource: this.options.permissionExtensionSource,
        emit: this.options.emit,
      });
    }
    if (settings.codexEnabled) this.codex = await CodexBridge.start(settings.codexExecutable, this.options.emit);
  }

  private async renameConversation(path: string, name: string, timestamp: string): Promise<void> {
    const record = this.conversations.find(path);
    if (record?.backend === "pi") await this.files.renameSession(path, name, timestamp);
    if (record?.backend === "codex" && record.codexThreadId)
      await this.requireCodex().setThreadName(record.codexThreadId, name);
    if (record) await this.conversations.rename(path, name);
  }

  private async deleteConversation(path: string): Promise<void> {
    const record = await this.conversations.remove(path);
    if (record?.backend === "pi") await this.files.deleteSession(path);
    if (record?.backend === "codex" && record.codexThreadId)
      await this.requireCodex().archiveThread(record.codexThreadId);
  }

  private async sessionMessages(path: string): Promise<JsonObject[]> {
    const record = this.conversations.find(path);
    return record?.backend === "codex" ? this.conversations.messages(path) : this.files.sessionMessages(path);
  }

  private async createMirrorSession(backend: "pi" | "codex", cwd: string): Promise<JsonObject> {
    if (backend === "codex") {
      const result = await this.requireCodex().startThread(cwd);
      const thread = asObject(result.thread);
      const threadId = asString(thread.id);
      if (!threadId) throw new Error("Codex did not return a thread ID");
      return { backend, threadId };
    }
    const pool = this.requirePool();
    const runtimeId = await pool.prepare(cwd);
    const state = asObject(await pool.createSession(runtimeId));
    const sessionFile = asString(state.sessionFile);
    const sessionId = asString(state.sessionId);
    if (!sessionFile || !sessionId) throw new Error("Pi did not return a session");
    return { backend, sessionFile, sessionId };
  }

  private requirePiLaunch(): PiLaunch {
    if (!this.piLaunch) throw new Error("Pi runtime is not initialized");
    return this.piLaunch;
  }

  private async runtimeInfo(): Promise<JsonObject> {
    const launch = this.piLaunch;
    if (!launch) return {
      piVersion: "disabled",
      operatingSystem: process.platform,
      architecture: process.arch,
    };
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

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${name} must be a number`);
  return value;
}

function requiredBackend(value: unknown): "pi" | "codex" {
  if (value === "pi" || value === "codex") return value;
  throw new Error("backend must be pi or codex");
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
