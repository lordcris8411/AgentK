import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LanguagePackToolchainManager, type ResolvedSystemTool } from "./language-pack-toolchains.js";

function workerEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "ALL_PROXY", "ComSpec", "HTTP_PROXY", "HTTPS_PROXY", "LANG", "LOCALAPPDATA",
    "NO_PROXY", "PATH", "PATHEXT", "SystemDrive", "SystemRoot", "TEMP", "TMP",
    "TZ", "USERPROFILE", "WINDIR", "all_proxy", "http_proxy", "https_proxy", "no_proxy",
  ];
  if (process.env.AGENT_K_E2E === "1") allowed.push("AGENT_K_E2E", "AGENT_K_E2E_DEBUG_ADAPTER", "AGENT_K_E2E_SOURCE");
  return Object.fromEntries(allowed.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]])) as NodeJS.ProcessEnv;
}

/**
 * One trusted, hot-pluggable language family. The host only supervises the
 * worker and routes declared actions; language behavior stays in the pack.
 */
export type LanguagePackAction = {
  id: string;
  method: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type LanguagePackManifest = {
  apiVersion: 1;
  kind: "language-pack";
  displayName: string;
  id: string;
  version: string;
  platforms: NodeJS.Platform[];
  languages: string[];
  fileExtensions: string[];
  projectMarkers: string[];
  actions: LanguagePackAction[];
  permissions: {
    externalTools: string[];
    network: boolean;
    processes: boolean;
    workspaceWrite: boolean;
  };
  toolchains: Array<{
    id: string;
    system?: { commands: string[]; versionRange: string };
    fallback?: { version: string; platforms: Partial<Record<NodeJS.Platform, { sha256?: string; sha512?: string; url: string }>> };
  }>;
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
  worker: URL;
  debugServer?: {
    adapters: Array<{ command: string; platforms: NodeJS.Platform[] }>;
    prepareMethod?: string;
    providers: Array<{
      fileExtensions: string[];
      id: string;
      label: string;
      languages: string[];
      modes: Array<"attach" | "dump" | "launch">;
      priority: number;
      projectMarkers: string[];
    }>;
    protocol: "dap";
  };
};

type WorkerRequest = { args?: unknown[]; id: number; type: "request"; method: string };
type WorkerResponse = { error?: string; id: number; result?: unknown; type: "response" };
type WorkerEvent = { event: Record<string, unknown>; type: "event" };
type WorkerMessage = WorkerResponse | WorkerEvent;
export type WorkspaceFileChange = {
  path: string;
  type: 1 | 2 | 3;
};

function childExited(child: ChildProcess): boolean { return child.exitCode !== null || child.signalCode !== null; }

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const finish = (value: boolean) => { clearTimeout(timer); child.off("close", onClose); resolveExit(value); };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(childExited(child)), timeoutMs);
    child.once("close", onClose);
    if (childExited(child)) finish(true);
  });
}

/** Generic process supervisor and RPC broker for native language plugins. */
export class LanguagePackHost {
  private child?: ChildProcess;
  private initializing?: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<number, { reject(reason: Error): void; resolve(value: unknown): void }>();
  private systemTools: Record<string, ResolvedSystemTool> = {};
  private toolsPrepared = false;
  private closing = false;

  constructor(
    readonly manifest: LanguagePackManifest,
    private readonly cachePath: string,
    private readonly emit: (event: Record<string, unknown>) => void,
  ) {}

  async prepareToolchains(): Promise<void> {
    this.systemTools = await new LanguagePackToolchainManager(this.manifest).resolveSystemTools();
    this.toolsPrepared = true;
  }

  toolchainSources(): Array<{ command?: string; id: string; source: "private" | "system"; version: string }> {
    return this.manifest.toolchains.map((requirement) => this.systemTools[requirement.id]
      ? this.systemTools[requirement.id]!
      : { id: requirement.id, source: "private", version: requirement.fallback?.version ?? "unavailable" });
  }

  async call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.closing) throw new Error(`${this.manifest.id} language worker is stopping`);
    await this.ensureWorker();
    const child = this.child;
    if (!child?.connected) throw new Error(`${this.manifest.id} language worker is unavailable`);
    const id = this.nextId++;
    return new Promise<T>((resolveRequest, rejectRequest) => {
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      child.send({ args, id, method, type: "request" } satisfies WorkerRequest, (cause) => {
        if (!cause) return;
        const pending = this.pending.get(id); if (!pending) return;
        this.pending.delete(id); pending.reject(cause instanceof Error ? cause : new Error(String(cause)));
      });
    });
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const graceful = child.connected ? this.call("shutdown").catch(() => undefined) : Promise.resolve();
    this.closing = true;
    try {
      await Promise.race([graceful, new Promise((resolveWait) => { const timer = setTimeout(resolveWait, 10_000); timer.unref(); })]);
    } finally {
      this.child = undefined;
      this.initializing = undefined;
      for (const pending of this.pending.values()) pending.reject(new Error(`${this.manifest.id} language worker stopped`));
      this.pending.clear();
      if (child.connected) child.disconnect();
      if (!await waitForChildExit(child, 1_000)) child.kill();
      if (!await waitForChildExit(child, 5_000)) child.kill("SIGKILL");
      const stopped = await waitForChildExit(child, 5_000);
      this.closing = false;
      if (!stopped) throw new Error(`${this.manifest.id} language worker did not exit`);
    }
  }

  workspaceFilesChanged(changes: WorkspaceFileChange[]): void {
    const child = this.child;
    if (!changes.length || !child?.connected) return;
    // File watching is an optional worker capability. A plugin that does not
    // consume this one-way message remains completely independent from the
    // implementations that do.
    try {
      child.send({ changes, type: "workspace-files-changed" }, () => undefined);
    } catch {
      // The worker may disconnect between the connected check and send while
      // a project is intentionally being unloaded or the app is shutting down.
    }
  }

  private async ensureWorker(): Promise<void> {
    if (this.child?.connected) return;
    this.initializing ??= new Promise<void>((resolveStart, rejectStart) => {
      const child = fork(fileURLToPath(this.manifest.worker), [], {
        env: { ...workerEnvironment(), ELECTRON_RUN_AS_NODE: "1" },
        // Workers must not inherit Electron/dev/test flags such as
        // --input-type, inspect ports, or renderer-specific switches.
        execArgv: [],
        silent: true,
      });
      this.child = child;
      let stderrTail = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderrTail = `${stderrTail}${chunk}`.slice(-8 * 1024);
      });
      const fail = (cause: unknown) => {
        if (this.child === child) this.child = undefined;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        rejectStart(error);
      };
      child.once("error", fail);
      child.once("exit", (code, signal) => {
        if (this.child === child) this.child = undefined;
        if (code !== 0 && signal !== "SIGTERM") {
          const detail = stderrTail.trim();
          fail(new Error(`${this.manifest.id} language worker exited (${code ?? signal ?? "unknown"})${detail ? `\n${detail}` : ""}`));
        }
      });
      child.on("message", (message: WorkerMessage) => {
        if (message.type === "event") {
          // Events cross the worker boundary as a plugin-neutral envelope.
          // Renderers must route by plugin id, never by a language-specific
          // event name or built-in implementation detail.
          this.emit({ ...message.event, packId: this.manifest.id });
          return;
        }
        const pending = this.pending.get(message.id); if (!pending) return;
        this.pending.delete(message.id);
        message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result);
      });
      // A worker is operational only after it has received its private cache
      // root. Keep this bootstrap protocol host-generic.
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: () => resolveStart(),
        reject: rejectStart,
      });
      void (this.toolsPrepared ? Promise.resolve(this.systemTools) : new LanguagePackToolchainManager(this.manifest).resolveSystemTools()).then((tools) => {
        this.systemTools = tools;
        this.toolsPrepared = true;
        child.send({ args: [this.cachePath, { systemTools: tools }], id, method: "initialize", type: "request" } satisfies WorkerRequest, (cause) => {
          if (!cause) return;
          const pending = this.pending.get(id); if (!pending) return;
          this.pending.delete(id); pending.reject(cause instanceof Error ? cause : new Error(String(cause)));
        });
      }).catch((cause) => {
        const pending = this.pending.get(id); if (!pending) return;
        this.pending.delete(id); pending.reject(cause instanceof Error ? cause : new Error(String(cause)));
      });
    }).finally(() => { this.initializing = undefined; });
    return this.initializing;
  }
}
