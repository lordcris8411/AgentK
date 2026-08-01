import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * A declarative native-language plugin. The host knows only how to launch the
 * worker and route messages; language-specific preparation stays in the
 * worker package.
 */
export type LanguageServerPluginManifest = {
  apiVersion: 1;
  displayName: string;
  id: string;
  languages: string[];
  projectMarkers: string[];
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
  skill?: { markdown: string; name: string };
  commands?: Array<{ id: string; title: string; kind: "project-manager" }>;
  worker: URL;
  debugServer?: {
    adapters: Array<{ command: string; platforms: NodeJS.Platform[] }>;
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

/** Generic process supervisor and RPC broker for native language plugins. */
export class LanguageServerHost {
  private child?: ChildProcess;
  private initializing?: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<number, { reject(reason: Error): void; resolve(value: unknown): void }>();

  constructor(
    readonly manifest: LanguageServerPluginManifest,
    private readonly cachePath: string,
    private readonly emit: (event: Record<string, unknown>) => void,
  ) {}

  async call<T>(method: string, ...args: unknown[]): Promise<T> {
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

  shutdown(): void {
    const child = this.child;
    this.child = undefined;
    this.initializing = undefined;
    // App shutdown is an expected cancellation boundary. Resolving outstanding
    // renderer requests prevents Electron from reporting a spurious IPC error
    // while the worker is deliberately being terminated.
    for (const pending of this.pending.values()) pending.resolve(undefined);
    this.pending.clear();
    if (!child) return;
    if (child.connected) child.send({ id: 0, method: "shutdown", type: "request" } satisfies WorkerRequest, () => undefined);
    child.disconnect();
    child.kill();
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
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
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
          this.emit({ ...message.event, languageServerId: this.manifest.id });
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
      child.send({ args: [this.cachePath], id, method: "initialize", type: "request" } satisfies WorkerRequest, (cause) => {
        if (!cause) return;
        const pending = this.pending.get(id); if (!pending) return;
        this.pending.delete(id); pending.reject(cause instanceof Error ? cause : new Error(String(cause)));
      });
    }).finally(() => { this.initializing = undefined; });
    return this.initializing;
  }
}
