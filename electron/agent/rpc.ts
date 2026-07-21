import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { JsonObject, PiResource } from "../types.js";
import {
  asArray,
  asObject,
  asString,
  errorMessage,
  isPathInside,
  piAgentDirectory,
} from "../utils.js";

type PendingRequest = {
  resolve(value: JsonObject): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

export interface RpcBridgeOptions {
  appDataPath: string;
  bundledSkillsDirectory: string;
  cwd: string;
  executable: string;
  permissionExtensionSource: string;
  runtimeId: string;
  emit(event: JsonObject): void;
}

async function bundledSkillPaths(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(join(directory, entry.name, "SKILL.md")),
      )
      .map((entry) => join(directory, entry.name))
      .sort();
  } catch {
    return [];
  }
}

async function installedPiPackagePaths(): Promise<string[]> {
  const npmDirectory = join(piAgentDirectory(), "npm");
  try {
    const manifest = JSON.parse(
      await readFile(join(npmDirectory, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, unknown> };
    return Object.keys(manifest.dependencies ?? {})
      .sort()
      .map((name) => join(npmDirectory, "node_modules", name))
      .filter(existsSync);
  } catch {
    return [];
  }
}

function enrichFileToolStart(value: JsonObject, cwd: string): void {
  if (value.type !== "tool_execution_start") return;
  if (value.toolName !== "write" && value.toolName !== "edit") return;
  const args = asObject(value.args);
  const supplied = asString(args.path);
  if (!supplied) return;
  const unresolved = isAbsolute(supplied) ? supplied : join(cwd, supplied);
  let target = resolve(unresolved);
  try {
    target = realpathSync(unresolved);
  } catch {
    // A write target is allowed not to exist yet.
  }
  if (!isPathInside(cwd, target)) return;
  try {
    args.oldContent = readFileSync(target, "utf8");
    args.fileExisted = true;
  } catch {
    args.fileExisted = false;
  }
  value.args = args;
}

export class RpcBridge {
  readonly runtimeId: string;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly emit: (event: JsonObject) => void;
  private pending = new Map<string, PendingRequest>();
  private sequence = 0;
  private closed = false;
  private agentRunning = false;
  private inFlight = 0;
  private pendingUi = new Set<string>();
  private reserved = false;
  private retireOnIdle = false;
  private lastUsed = Date.now();
  private currentSessionFile?: string;
  private currentCwd: string;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    options: RpcBridgeOptions,
  ) {
    this.child = child;
    this.runtimeId = options.runtimeId;
    this.emit = options.emit;
    this.currentCwd = resolve(options.cwd);

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    // Pi extensions are free to write diagnostics to stderr. Always drain the
    // stream so backpressure cannot stall JSONL RPC on stdout.
    child.stderr.resume();
    child.once("exit", () => this.handleExit());
    child.once("error", (error) => this.handleExit(error));
  }

  static async start(options: RpcBridgeOptions): Promise<RpcBridge> {
    await mkdir(options.appDataPath, { recursive: true });
    const installedExtension = join(options.appDataPath, "agent-k-permissions.ts");
    const extensionSource = await readFile(options.permissionExtensionSource);
    let needsWrite = true;
    try {
      needsWrite = !(
        await readFile(installedExtension)
      ).equals(extensionSource);
    } catch {
      // Install below.
    }
    if (needsWrite) await writeFile(installedExtension, extensionSource);

    const registry = await (async () => {
      try {
        return JSON.parse(
          await readFile(join(options.appDataPath, "pi-resources.json"), "utf8"),
        ) as PiResource[];
      } catch {
        return [];
      }
    })();
    const disabledPaths = registry
      .filter((resource) => resource.enabled === false)
      .map((resource) => resolve(resource.path));
    const args = ["--mode", "rpc", "--extension", installedExtension];
    for (const packagePath of await installedPiPackagePaths()) {
      if (disabledPaths.some((resource) => isPathInside(packagePath, resource)))
        continue;
      args.push("--extension", packagePath);
    }
    for (const skillPath of await bundledSkillPaths(
      options.bundledSkillsDirectory,
    )) {
      if (disabledPaths.some((resource) => isPathInside(skillPath, resource)))
        continue;
      args.push("--skill", skillPath);
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.executable, args, {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          AGENT_K_PERMISSION_STATE_PATH: join(
            options.appDataPath,
            "permission-state.json",
          ),
          AGENT_K_SETTINGS_PATH: join(options.appDataPath, "client-settings.json"),
        },
        shell: process.platform === "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (cause) {
      throw new Error(
        `Unable to start Pi RPC from '${options.executable}': ${errorMessage(cause)}. Install Pi or set AGENT_K_PI_EXECUTABLE`,
      );
    }
    return new RpcBridge(child, options);
  }

  isClosed(): boolean {
    return this.closed;
  }

  sessionFile(): string | undefined {
    return this.currentSessionFile;
  }

  setSessionFile(path: string | undefined): void {
    this.currentSessionFile = path;
    this.touch();
  }

  workspaceCwd(): string {
    return this.currentCwd;
  }

  workspaceMatches(cwd: string): boolean {
    return resolve(cwd) === this.currentCwd;
  }

  setWorkspaceCwd(cwd: string): void {
    this.currentCwd = resolve(cwd);
    this.touch();
  }

  isAvailable(): boolean {
    return (
      !this.closed &&
      !this.reserved &&
      !this.agentRunning &&
      this.inFlight === 0 &&
      this.pendingUi.size === 0
    );
  }

  tryReserve(): boolean {
    if (!this.isAvailable()) return false;
    this.reserved = true;
    return true;
  }

  releaseReservation(): void {
    this.reserved = false;
    this.touch();
  }

  markRetireOnIdle(retire: boolean): void {
    this.retireOnIdle = retire;
  }

  shouldRetire(): boolean {
    return this.retireOnIdle;
  }

  idleFor(): number {
    return Date.now() - this.lastUsed;
  }

  touch(): void {
    this.lastUsed = Date.now();
  }

  async request(command: JsonObject): Promise<JsonObject> {
    if (this.closed)
      throw new Error("Pi RPC connection is closed; reconnect and try again");
    const startsAgent = command.type === "prompt";
    if (startsAgent) this.agentRunning = true;
    this.touch();
    this.inFlight += 1;
    const id = `desktop-${++this.sequence}`;
    const request = { ...command, id };
    const timeout = command.type === "switch_session" ? 90_000 : 30_000;
    try {
      const response = await new Promise<JsonObject>((resolveRequest, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error("Pi RPC request timed out"));
        }, timeout);
        this.pending.set(id, { resolve: resolveRequest, reject, timer });
        this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          reject(new Error(`Unable to send Pi RPC request: ${error.message}`));
        });
      });
      if (startsAgent && response.success === false) this.agentRunning = false;
      return response;
    } finally {
      this.inFlight -= 1;
    }
  }

  sendNotification(command: JsonObject): void {
    if (this.closed)
      throw new Error("Pi RPC connection is closed; reconnect and try again");
    this.touch();
    if (command.type === "extension_ui_response" && typeof command.id === "string")
      this.pendingUi.delete(command.id);
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    if (this.child.pid) {
      if (process.platform === "win32") {
        const killer = spawn(
          "taskkill.exe",
          ["/PID", String(this.child.pid), "/T", "/F"],
          { stdio: "ignore", windowsHide: true },
        );
        killer.unref();
      } else {
        try {
          process.kill(-this.child.pid, "SIGTERM");
        } catch {
          this.child.kill("SIGTERM");
        }
      }
    }
    this.rejectPending(new Error("Pi RPC connection closed"));
  }

  private handleLine(line: string): void {
    let value: JsonObject;
    try {
      value = asObject(JSON.parse(line));
    } catch {
      return;
    }
    const data = asObject(value.data);
    const reportedSession = asString(value.sessionFile) ?? asString(data.sessionFile);
    if (reportedSession) this.currentSessionFile = reportedSession;
    const id = asString(value.id);
    if (id) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve(value);
        return;
      }
    }
    if (value.type === "agent_start") this.agentRunning = true;
    if (value.type === "agent_settled") this.agentRunning = false;
    if (
      value.type === "extension_ui_request" &&
      ["select", "confirm", "input", "editor"].includes(String(value.method)) &&
      typeof value.id === "string"
    ) {
      this.pendingUi.add(value.id);
    }
    enrichFileToolStart(value, this.currentCwd);
    this.emit({ ...value, runtimeId: this.runtimeId });
  }

  private handleExit(cause?: Error): void {
    const wasClosed = this.closed;
    this.closed = true;
    this.rejectPending(cause ?? new Error("Pi RPC connection closed"));
    if (!wasClosed)
      this.emit({ type: "bridge_closed", runtimeId: this.runtimeId });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
