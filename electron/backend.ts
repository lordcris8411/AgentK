import { spawn } from "node:child_process";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject, PiResourceChange } from "./types.js";
import { RpcPool } from "./agent/pool.js";
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
import { asArray, asObject, asString, atomicWrite, errorMessage } from "./utils.js";

export interface DesktopBackendOptions {
  appDataPath: string;
  bundledSkillsSource: string;
  cachePath: string;
  permissionExtensionSource: string;
  piExecutable: string;
  emit(event: JsonObject): void;
  updateSplash(message: string, current: number, total: number, theme: string): void;
  finishSplash(): void;
}

export class DesktopBackend {
  private readonly options: DesktopBackendOptions;
  private readonly files: FileService;
  private readonly bundledSkillsDirectory: string;
  private pool?: RpcPool;

  constructor(options: DesktopBackendOptions) {
    this.options = options;
    this.files = new FileService(options.appDataPath, options.cachePath);
    this.bundledSkillsDirectory = join(options.appDataPath, "bundled-skills");
  }

  async initialize(): Promise<void> {
    await this.files.initialize();
    await migrateMisclassifiedVllm();
    await cp(this.options.bundledSkillsSource, this.bundledSkillsDirectory, {
      recursive: true,
      force: true,
    });
    const settings = await loadClientSettings(this.options.appDataPath);
    this.pool = new RpcPool({
      appDataPath: this.options.appDataPath,
      bundledSkillsDirectory: this.bundledSkillsDirectory,
      executable: this.options.piExecutable,
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
        return openProviderLogin(requiredString(args.providerId, "providerId"), this.options.piExecutable);
      case "reload_pi_runtimes":
        return pool.reload();
      case "get_pi_resources":
        return getPiResources(
          this.options.appDataPath,
          pool,
          requiredString(args.cwd, "cwd"),
          this.bundledSkillsDirectory,
          optionalString(args.runtimeId),
        );
      case "apply_pi_resource_changes":
        return applyPiResourceChanges(
          this.options.appDataPath,
          pool,
          requiredString(args.cwd, "cwd"),
          asArray(args.changes) as PiResourceChange[],
        );
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
    this.pool?.shutdown();
    this.files.shutdown();
  }

  private requirePool(): RpcPool {
    if (!this.pool) throw new Error("Desktop backend is not initialized");
    return this.pool;
  }

  private async runtimeInfo(): Promise<JsonObject> {
    const piVersion = await new Promise<string>((resolveVersion) => {
      const child = spawn(this.options.piExecutable, ["--version"], {
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
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

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number"))
    throw new Error("Expected a number array");
  return value as number[];
}
