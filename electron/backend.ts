import { spawn, type ChildProcess } from "node:child_process";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject, PiResourceChange, SkillHubScope } from "./types.js";
import { RpcPool } from "./agent/pool.js";
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
import { getFileFormatPlugins } from "./file-formats.js";
import { installSkillHub, previewSkillHub } from "./skill-hub.js";
import { asArray, asObject, asString, atomicWrite, errorMessage, randomId } from "./utils.js";

export interface DesktopBackendOptions {
  appDataPath: string;
  bundledExtensionsSource: string;
  bundledSkillsSource: string;
  bundledPiCli: string;
  cachePath: string;
  permissionExtensionSource: string;
  emit(event: JsonObject): void;
  updateSplash(message: string, current: number, total: number, theme: string): void;
  finishSplash(): void;
}

type ProjectConsoleProcess = {
  child: ChildProcess;
  stderrDecoder: TextDecoder;
  stdoutDecoder: TextDecoder;
};

export class DesktopBackend {
  private readonly options: DesktopBackendOptions;
  private readonly files: FileService;
  private readonly bundledExtensionsDirectory: string;
  private readonly bundledSkillsDirectory: string;
  private piLaunch?: PiLaunch;
  private pool?: RpcPool;
  private readonly projectConsoles = new Map<string, ProjectConsoleProcess>();

  constructor(options: DesktopBackendOptions) {
    this.options = options;
    this.files = new FileService(options.appDataPath, options.cachePath);
    this.bundledExtensionsDirectory = join(options.appDataPath, "bundled-extensions");
    this.bundledSkillsDirectory = join(options.appDataPath, "bundled-skills");
  }

  async initialize(): Promise<void> {
    await this.files.initialize();
    await migrateMisclassifiedVllm();
    await cp(this.options.bundledExtensionsSource, this.bundledExtensionsDirectory, {
      recursive: true,
      force: true,
    });
    await cp(this.options.bundledSkillsSource, this.bundledSkillsDirectory, {
      recursive: true,
      force: true,
    });
    const settings = await loadClientSettings(this.options.appDataPath);
    this.piLaunch = resolvePiLaunch(settings.piExecutable, this.options.bundledPiCli);
    this.pool = new RpcPool({
      appDataPath: this.options.appDataPath,
      bundledExtensionsDirectory: this.bundledExtensionsDirectory,
      bundledSkillsDirectory: this.bundledSkillsDirectory,
      launch: this.piLaunch,
      minimum: settings.workerPoolSize,
      permissionExtensionSource: this.options.permissionExtensionSource,
      emit: this.options.emit,
    });
    // Session grants intentionally last only for this desktop run.
    await atomicWrite(join(this.options.appDataPath, "permission-state.json"), "[]");
  }

  async invoke(command: string, rawArgs: unknown): Promise<unknown> {
    const args = asObject(rawArgs);
    const pool = this.requirePool();
    switch (command) {
      case "get_runtime_info":
        return this.runtimeInfo();
      case "get_client_settings":
        return loadClientSettings(this.options.appDataPath);
      case "save_client_settings":
        return saveClientSettings(this.options.appDataPath, args.settings);
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
        return providerCatalog(await pool.command({ type: "get_available_models" }, optionalString(args.runtimeId)));
      case "save_provider_api_key":
        return saveProviderApiKey(requiredString(args.providerId, "providerId"), requiredString(args.apiKey, "apiKey"));
      case "logout_provider":
        return logoutProvider(requiredString(args.providerId, "providerId"));
      case "open_provider_login":
        return openProviderLogin(requiredString(args.providerId, "providerId"), this.requirePiLaunch());
      case "reload_pi_runtimes":
        return pool.reload();
      case "get_pi_resources":
        return getPiResources(
          this.options.appDataPath,
          pool,
          requiredString(args.cwd, "cwd"),
          this.bundledExtensionsDirectory,
          this.bundledSkillsDirectory,
          optionalString(args.runtimeId),
        );
      case "get_file_format_plugins":
        return getFileFormatPlugins(requiredString(args.cwd, "cwd"));
      case "apply_pi_resource_changes":
        return applyPiResourceChanges(
          this.options.appDataPath,
          pool,
          requiredString(args.cwd, "cwd"),
          asArray(args.changes) as PiResourceChange[],
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
        return this.files.listProjects();
      case "add_workspace":
        return this.files.addWorkspace(requiredString(args.cwd, "cwd"));
      case "session_messages":
        return this.files.sessionMessages(requiredString(args.path, "path"));
      case "hide_session":
        return this.files.hideSession(requiredString(args.path, "path"), args.hidden === true);
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
      case "pi_command":
        return pool.command(asObject(args.command), optionalString(args.runtimeId));
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
        return this.startProjectConsole(requiredString(args.root, "root"));
      case "write_project_console":
        return this.writeProjectConsole(
          requiredString(args.id, "id"),
          requiredString(args.data, "data"),
        );
      case "complete_project_console":
        return this.completeProjectConsole(
          requiredString(args.root, "root"),
          requiredString(args.input, "input"),
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
    for (const id of this.projectConsoles.keys()) this.stopProjectConsole(id);
    this.pool?.shutdown();
    this.files.shutdown();
  }

  private startProjectConsole(root: string): string {
    const id = randomId();
    const isWindows = process.platform === "win32";
    const executable = isWindows ? "powershell.exe" : "/bin/sh";
    const args = isWindows
      ? [
          "-NoLogo",
          "-NoProfile",
          "-NoExit",
          "-Command",
          "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding",
        ]
      : ["-i"];
    const child = spawn(executable, args, {
      cwd: root,
      env: { ...process.env, LANG: "zh_CN.UTF-8", LC_ALL: "zh_CN.UTF-8" },
      stdio: "pipe",
      windowsHide: true,
    });
    const consoleProcess = {
      child,
      stderrDecoder: new TextDecoder("utf-8"),
      stdoutDecoder: new TextDecoder("utf-8"),
    };
    this.projectConsoles.set(id, consoleProcess);
    const output = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const decoder = stream === "stdout" ? consoleProcess.stdoutDecoder : consoleProcess.stderrDecoder;
      this.options.emit({ id, stream, text: decoder.decode(chunk, { stream: true }), type: "project_console_output" });
    };
    child.stdout?.on("data", (chunk: Buffer) => output("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => output("stderr", chunk));
    let finished = false;
    const finish = (code: number | null, signal?: string) => {
      if (finished) return;
      finished = true;
      this.projectConsoles.delete(id);
      this.options.emit({ code, id, signal, type: "project_console_exit" });
    };
    child.once("error", (error) => {
      this.options.emit({ id, stream: "stderr", text: `${error.message}\n`, type: "project_console_output" });
      finish(null);
    });
    child.once("close", (code, signal) => finish(code, signal ?? undefined));
    return id;
  }

  private writeProjectConsole(id: string, data: string): void {
    if (data.length > 32_000) throw new Error("Console input is too long");
    const consoleProcess = this.projectConsoles.get(id);
    if (!consoleProcess?.child.stdin?.writable) throw new Error("Console is not running");
    consoleProcess.child.stdin.write(data, "utf8");
  }

  private async completeProjectConsole(
    root: string,
    input: string,
  ): Promise<Array<{ text: string; replacementIndex: number; replacementLength: number }>> {
    if (input.length > 32_000) throw new Error("Console input is too long");
    if (process.platform !== "win32") return [];
    const script = [
      "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
      "$line=$env:AGENT_K_CONSOLE_COMPLETION",
      "$result=TabExpansion2 -inputScript $line -cursorColumn $line.Length",
      "$result.CompletionMatches | ForEach-Object { [PSCustomObject]@{ text=$_.CompletionText; replacementIndex=$result.ReplacementIndex; replacementLength=$result.ReplacementLength } } | ConvertTo-Json -Compress",
    ].join("; ");
    return new Promise<Array<{ text: string; replacementIndex: number; replacementLength: number }>>((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
        cwd: root,
        env: { ...process.env, AGENT_K_CONSOLE_COMPLETION: input },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || "Console completion failed"));
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout.trim() || "[]");
          const values = Array.isArray(parsed) ? parsed : [parsed];
          resolve(
            values.flatMap((item) => {
              if (!item || typeof item !== "object") return [];
              const value = item as Record<string, unknown>;
              return typeof value.text === "string" &&
                typeof value.replacementIndex === "number" &&
                Number.isInteger(value.replacementIndex) &&
                typeof value.replacementLength === "number" &&
                Number.isInteger(value.replacementLength)
                ? [{
                    text: value.text,
                    replacementIndex: value.replacementIndex,
                    replacementLength: value.replacementLength,
                  }]
                : [];
            }),
          );
        } catch {
          resolve([]);
        }
      });
    });
  }

  private stopProjectConsole(id: string): void {
    const consoleProcess = this.projectConsoles.get(id);
    if (!consoleProcess) return;
    const { child } = consoleProcess;
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref();
      return;
    }
    child.kill("SIGTERM");
  }

  private requirePool(): RpcPool {
    if (!this.pool) throw new Error("Desktop backend is not initialized");
    return this.pool;
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

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${name} must be a number`);
  return value;
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
