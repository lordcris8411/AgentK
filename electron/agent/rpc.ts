import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { JsonObject, PiResource } from "../types.js";
import type { PiLaunch } from "../pi-runtime.js";
import { discoverTopLevelSkillNames } from "../resources.js";
import {
  asArray,
  asObject,
  asString,
  errorMessage,
  isPathInside,
  piAgentDirectory,
} from "../utils.js";

const BASH_ENVIRONMENT = `# Written by Agent K. Loaded by Pi's non-interactive Git Bash.\nif [[ -n "\${AGENT_K_ORIGINAL_BASH_ENV:-}" && -f "\${AGENT_K_ORIGINAL_BASH_ENV}" ]]; then\n  source "\${AGENT_K_ORIGINAL_BASH_ENV}"\nfi\nif command -v iconv >/dev/null 2>&1; then\n  cmd() {\n    command cmd.exe "\$@" 2>&1 | iconv -f GB18030 -t UTF-8\n    local command_status=\${PIPESTATUS[0]}\n    return "\$command_status"\n  }\n  cmd.exe() { cmd "\$@"; }\nfi\n`;

function piEnvironment(
  environment: NodeJS.ProcessEnv | undefined,
  bashEnvironment?: string,
): NodeJS.ProcessEnv {
  const merged = { ...process.env, ...environment };
  if (process.platform !== "win32") return merged;
  // Pi decodes Bash stdout as UTF-8. A desktop-launched Git Bash otherwise
  // inherits no locale from the user's terminal and may fall back to the
  // Windows ANSI code page, corrupting Chinese output before it reaches UI.
  return {
    ...merged,
    LANG: "zh_CN.UTF-8",
    LC_ALL: "zh_CN.UTF-8",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    ...(bashEnvironment
      ? {
          AGENT_K_ORIGINAL_BASH_ENV: merged.BASH_ENV,
          BASH_ENV: bashEnvironment,
        }
      : {}),
  };
}

type PendingRequest = {
  resolve(value: JsonObject): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

export interface RpcBridgeOptions {
  appDataPath: string;
  bundledExtensionsDirectory: string;
  bundledSkillsDirectory: string;
  firstPartyEditorExtensions: Array<{ directory: string; id: string }>;
  cwd: string;
  launch: PiLaunch;
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

async function bundledExtensionPaths(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(join(directory, entry.name, "index.ts")),
      )
      .map((entry) => join(directory, entry.name, "index.ts"))
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
  private readonly options: RpcBridgeOptions;
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
  private namingStarted = false;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    options: RpcBridgeOptions,
  ) {
    this.child = child;
    this.options = options;
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
    const bashEnvironment = join(options.appDataPath, "agent-k-bash-env.sh");
    await writeFile(bashEnvironment, BASH_ENVIRONMENT, "utf8");

    const [registry, clientSettings] = await Promise.all([
      (async () => {
        try {
          return JSON.parse(
            await readFile(join(options.appDataPath, "pi-resources.json"), "utf8"),
          ) as PiResource[];
        } catch {
          return [];
        }
      })(),
      (async () => {
        try {
          return asObject(JSON.parse(
            await readFile(join(options.appDataPath, "client-settings.json"), "utf8"),
          ));
        } catch {
          return {};
        }
      })(),
    ]);
    const disabledPaths = registry
      .filter((resource) => resource.enabled === false)
      .map((resource) => resolve(resource.path));
    const args = ["--mode", "rpc", "--extension", installedExtension];
    for (const extensionPath of await bundledExtensionPaths(
      options.bundledExtensionsDirectory,
    )) {
      if (disabledPaths.some((resource) => isPathInside(extensionPath, resource)))
        continue;
      args.push("--extension", extensionPath);
    }
    for (const packagePath of await installedPiPackagePaths()) {
      if (disabledPaths.some((resource) => isPathInside(packagePath, resource)))
        continue;
      args.push("--extension", packagePath);
    }
    const topLevelSkillNames = await discoverTopLevelSkillNames(options.cwd);
    for (const skillPath of await bundledSkillPaths(
      options.bundledSkillsDirectory,
    )) {
      // Pi discovers top-level user/project skills itself. Treat AgentK's
      // bundled copy as a fallback when a skill with the same name exists.
      const skillName = basename(skillPath).toLocaleLowerCase("en-US");
      if (topLevelSkillNames.has(skillName)) continue;
      if (disabledPaths.some((resource) => isPathInside(skillPath, resource)))
        continue;
      args.push("--skill", skillPath);
    }
    const disabledEditorSkills = new Set([
      ...asArray(clientSettings.disabledFileEditors),
      ...asArray(clientSettings.disabledFileEditorSkills),
    ].filter((id): id is string => typeof id === "string"));
    for (const editorExtension of options.firstPartyEditorExtensions) {
      if (disabledEditorSkills.has(editorExtension.id)) continue;
      args.push("--skill", editorExtension.directory);
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.launch.executable, [...options.launch.args, ...args], {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        env: {
          ...piEnvironment(options.launch.environment, bashEnvironment),
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
        `Unable to start Pi RPC from '${options.launch.executable}': ${errorMessage(cause)}`,
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
    if (value.type === "agent_settled") {
      this.agentRunning = false;
      void this.nameUnnamedSession();
    }
    if (
      value.type === "extension_ui_request" &&
      ["select", "confirm", "input", "editor"].includes(String(value.method)) &&
      typeof value.id === "string"
    ) {
      this.pendingUi.add(value.id);
    }
    enrichFileToolStart(value, this.currentCwd);
    this.emit({
      ...value,
      runtimeId: this.runtimeId,
      ...(this.currentSessionFile ? { sessionFile: this.currentSessionFile } : {}),
    });
  }

  private handleExit(cause?: Error): void {
    const wasClosed = this.closed;
    this.closed = true;
    this.rejectPending(cause ?? new Error("Pi RPC connection closed"));
    if (!wasClosed)
      this.emit({ type: "bridge_closed", runtimeId: this.runtimeId });
  }

  private async nameUnnamedSession(): Promise<void> {
    if (this.namingStarted || this.closed || this.agentRunning) return;
    this.namingStarted = true;
    try {
      const state = asObject((await this.request({ type: "get_state" })).data);
      if (asString(state.sessionName)) return;
      const model = asObject(state.model);
      const provider = asString(model.provider);
      const modelId = asString(model.id);
      if (!provider || !modelId) return;
      const messages = asArray(asObject((await this.request({ type: "get_messages" })).data).messages);
      const firstUserMessage = messages
        .map(asObject)
        .find((message) => message.role === "user");
      const prompt = firstUserMessage ? messageText(firstUserMessage) : undefined;
      if (!prompt) return;
      const name = await generateSessionName(this.options, provider, modelId, prompt, this.currentCwd);
      if (!name) return;
      const latestState = asObject((await this.request({ type: "get_state" })).data);
      if (asString(latestState.sessionName) || latestState.isStreaming === true) return;
      await this.request({ type: "set_session_name", name });
    } catch {
      // Naming is supplementary and must never affect the active conversation.
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function messageText(message: JsonObject): string | undefined {
  const content = message.content;
  const text = typeof content === "string"
    ? content
    : asArray(content)
      .map(asObject)
      .filter((block) => block.type === "text")
      .map((block) => asString(block.text) ?? "")
      .join(" ");
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function normalizedSessionName(value: string): string | undefined {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^(?:title|标题)\s*[:：]\s*/i, "")
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim();
  if (!firstLine) return undefined;
  return [...firstLine].slice(0, 96).join("").trim() || undefined;
}

async function generateSessionName(
  options: RpcBridgeOptions,
  provider: string,
  modelId: string,
  firstMessage: string,
  cwd: string,
): Promise<string | undefined> {
  const instruction = [
    "Create a concise title for this coding-agent session from the first user message.",
    "Use the same language as the user. Return only the title, with no quotes, label, markdown, or ending punctuation.",
    "Keep it under 96 characters.",
    "First user message:",
    [...firstMessage].slice(0, 4_000).join(""),
  ].join("\n\n");
  return new Promise((resolveName) => {
    const child = spawn(
      options.launch.executable,
      [
        ...options.launch.args,
        "--print",
        "--no-session",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--provider",
        provider,
        "--model",
        `${provider}/${modelId}`,
        instruction,
      ],
      {
        cwd,
        env: piEnvironment(options.launch.environment),
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    let output = "";
    const timeout = setTimeout(() => child.kill(), 45_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("error", () => {
      clearTimeout(timeout);
      resolveName(undefined);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveName(code === 0 ? normalizedSessionName(output) : undefined);
    });
  });
}
