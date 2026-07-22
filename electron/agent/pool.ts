import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { JsonObject, WorkerPoolStatus } from "../types.js";
import type { PiLaunch } from "../pi-runtime.js";
import { asObject, asString, errorMessage, homeDirectory, randomId } from "../utils.js";
import { RpcBridge } from "./rpc.js";

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export interface RpcPoolOptions {
  appDataPath: string;
  bundledExtensionsDirectory: string;
  bundledSkillsDirectory: string;
  firstPartyEditorExtensions: Array<{ directory: string; id: string }>;
  launch: PiLaunch;
  minimum: number;
  permissionExtensionSource: string;
  emit(event: JsonObject): void;
}

export class RpcPool {
  private readonly options: RpcPoolOptions;
  private readonly workers = new Map<string, RpcBridge>();
  private activeRuntime?: string;
  private minimum: number;
  private starting = 0;
  private poolCwd?: string;
  private readonly reaper: NodeJS.Timeout;

  constructor(options: RpcPoolOptions) {
    this.options = options;
    this.minimum = Math.max(2, Math.min(4, options.minimum));
    this.reaper = setInterval(() => void this.maintain(), 2_000);
    this.reaper.unref();
  }

  status(): WorkerPoolStatus {
    this.removeClosed();
    const total = this.workers.size;
    const idle = [...this.workers.values()].filter((worker) =>
      worker.isAvailable(),
    ).length;
    return { total, idle, busy: total - idle, minimum: this.minimum };
  }

  async spawn(cwd: string): Promise<string> {
    this.starting += 1;
    try {
      const runtimeId = randomId("runtime-");
      const bridge = await RpcBridge.start({
        ...this.options,
        cwd,
        runtimeId,
      });
      try {
        await this.requestData(bridge, { type: "get_state" });
      } catch (cause) {
        bridge.stop();
        throw new Error(`Pi RPC did not become ready: ${errorMessage(cause)}`);
      }
      this.workers.set(runtimeId, bridge);
      this.poolCwd = cwd;
      return runtimeId;
    } finally {
      this.starting -= 1;
    }
  }

  async resize(size: number): Promise<WorkerPoolStatus> {
    if (!Number.isInteger(size) || size < 2 || size > 4)
      throw new Error("Pi worker pool size must be between 2 and 4");
    this.minimum = size;
    this.reap(true);
    const missing = Math.max(0, size - this.workers.size - this.starting);
    if (missing > 0) {
      const cwd = this.poolCwd ?? homeDirectory();
      await Promise.all(Array.from({ length: missing }, () => this.spawn(cwd)));
    }
    return this.status();
  }

  async connect(
    cwd: string,
    sessionPath?: string,
    requestedRuntime?: string,
  ): Promise<string> {
    if (requestedRuntime) {
      const bridge = this.workers.get(requestedRuntime);
      const matches = sessionPath
        ? bridge?.sessionFile() === sessionPath
        : bridge?.workspaceMatches(cwd);
      if (bridge && !bridge.isClosed() && matches) {
        bridge.touch();
        this.activeRuntime = requestedRuntime;
        return requestedRuntime;
      }
    }
    if (sessionPath) {
      const existing = [...this.workers.values()].find(
        (worker) => !worker.isClosed() && worker.sessionFile() === sessionPath,
      );
      if (existing) {
        existing.touch();
        this.activeRuntime = existing.runtimeId;
        return existing.runtimeId;
      }
    }

    let bridge = [...this.workers.values()].find(
      (worker) =>
        (Boolean(sessionPath) || worker.workspaceMatches(cwd)) &&
        worker.tryReserve(),
    );
    let newlyStarted = false;
    if (!bridge) {
      const runtimeId = await this.spawn(cwd);
      bridge = this.bridge(runtimeId);
      bridge.tryReserve();
      newlyStarted = true;
    }
    try {
      if (sessionPath) {
        await this.requestData(bridge, {
          type: "switch_session",
          sessionPath,
        });
        bridge.setSessionFile(sessionPath);
        bridge.setWorkspaceCwd(cwd);
        await this.requestData(bridge, { type: "get_state" });
      }
      this.activeRuntime = bridge.runtimeId;
      return bridge.runtimeId;
    } catch (cause) {
      if (newlyStarted) {
        this.workers.delete(bridge.runtimeId);
        bridge.stop();
      }
      throw cause;
    } finally {
      bridge.releaseReservation();
    }
  }

  async command(
    input: JsonObject,
    runtimeId?: string,
  ): Promise<unknown> {
    const command = await normalizeRpcImages(input);
    const commandType = asString(command.type) ?? "";
    const bridge = this.bridge(runtimeId);
    const previousSessionFile = bridge.sessionFile();
    const response = await this.requestData(bridge, command);
    const responseObject = asObject(response);
    if (
      responseObject.cancelled !== true &&
      ["new_session", "fork", "switch_session"].includes(commandType)
    ) {
      const state = asObject(
        await this.requestData(bridge, { type: "get_state" }),
      );
      const sessionFile = asString(state.sessionFile);
      if (sessionFile) {
        bridge.setSessionFile(sessionFile);
        this.options.emit({
          type: "session_changed",
          runtimeId: bridge.runtimeId,
          previousSessionFile,
          sessionFile,
          sessionId: state.sessionId ?? null,
        });
      }
    }
    return response;
  }

  abort(runtimeId?: string): void {
    this.bridge(runtimeId).sendNotification({ type: "abort" });
  }

  extensionResponse(response: JsonObject, runtimeId?: string): void {
    if (response.type !== "extension_ui_response" || typeof response.id !== "string")
      throw new Error("Invalid extension UI response");
    this.bridge(runtimeId).sendNotification(response);
  }

  close(runtimeId: string): void {
    const bridge = this.workers.get(runtimeId);
    this.workers.delete(runtimeId);
    bridge?.stop();
    if (this.activeRuntime === runtimeId) this.activeRuntime = undefined;
  }

  async prepare(cwd: string): Promise<string> {
    return this.connect(cwd);
  }

  async createSession(runtimeId: string): Promise<unknown> {
    const bridge = this.bridge(runtimeId);
    await this.requestData(bridge, { type: "new_session" });
    return this.requestData(bridge, { type: "get_state" });
  }

  async reload(cwdFilter?: string): Promise<void> {
    const plans = [...this.workers.values()].filter(
      (worker) => !worker.isClosed() && (!cwdFilter || worker.workspaceMatches(cwdFilter)),
    );
    if (plans.some((worker) => !worker.isAvailable()))
      throw new Error(
        "Wait for active Pi tasks and dialogs to finish before reloading configuration",
      );
    let completed = 0;
    this.options.emit({ type: "pi_reload_progress", completed, total: plans.length });
    const results = await Promise.allSettled(
      plans.map(async (old) => {
        try {
          const replacement = await RpcBridge.start({
            ...this.options,
            cwd: old.workspaceCwd(),
            runtimeId: old.runtimeId,
          });
          try {
            const sessionFile = old.sessionFile();
            if (sessionFile) {
              await this.requestData(replacement, {
                type: "switch_session",
                sessionPath: sessionFile,
              });
              replacement.setSessionFile(sessionFile);
            }
            await this.requestData(replacement, { type: "get_state" });
            return { old, replacement };
          } catch (cause) {
            replacement.stop();
            throw new Error(
              `Unable to restore Pi runtime after configuration reload: ${errorMessage(cause)}`,
            );
          }
        } finally {
          completed += 1;
          this.options.emit({
            type: "pi_reload_progress",
            completed,
            total: plans.length,
          });
        }
      }),
    );
    const replacements = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) {
      for (const { replacement } of replacements) replacement.stop();
      throw failure.reason;
    }
    for (const { old, replacement } of replacements) {
      this.workers.set(replacement.runtimeId, replacement);
      old.stop();
    }
  }

  shutdown(): void {
    clearInterval(this.reaper);
    for (const worker of this.workers.values()) worker.stop();
    this.workers.clear();
  }

  private bridge(runtimeId?: string): RpcBridge {
    const id = runtimeId ?? this.activeRuntime;
    if (!id) throw new Error("Pi RPC is not connected");
    const bridge = this.workers.get(id);
    if (!bridge || bridge.isClosed())
      throw new Error(`Pi runtime is not connected: ${id}`);
    return bridge;
  }

  private async requestData(
    bridge: RpcBridge,
    command: JsonObject,
  ): Promise<unknown> {
    const response = await bridge.request(command);
    if (response.success === false)
      throw new Error(asString(response.error) ?? "Pi RPC error");
    return response.data ?? null;
  }

  private removeClosed(): void {
    for (const [id, worker] of this.workers) {
      if (worker.isClosed()) this.workers.delete(id);
    }
  }

  private reap(force: boolean): void {
    this.removeClosed();
    const excess = Math.max(0, this.workers.size - this.minimum);
    if (!excess) {
      for (const worker of this.workers.values()) worker.markRetireOnIdle(false);
      return;
    }
    const candidates = [...this.workers.values()]
      .filter(
        (worker) =>
          worker.runtimeId !== this.activeRuntime && worker.isAvailable(),
      )
      .sort((left, right) => right.idleFor() - left.idleFor());
    let removed = 0;
    for (const worker of candidates) {
      if (removed >= excess) break;
      if (force || worker.shouldRetire() || worker.idleFor() >= 5 * 60_000) {
        this.workers.delete(worker.runtimeId);
        worker.stop();
        removed += 1;
      }
    }
    if (force && this.workers.size > this.minimum) {
      const remaining = this.workers.size - this.minimum;
      [...this.workers.values()]
        .filter((worker) => !worker.isAvailable())
        .sort((left, right) => right.idleFor() - left.idleFor())
        .slice(0, remaining)
        .forEach((worker) => worker.markRetireOnIdle(true));
    }
  }

  private async maintain(): Promise<void> {
    this.reap(false);
    if (!this.poolCwd) return;
    const missing = Math.max(
      0,
      this.minimum - this.workers.size - this.starting,
    );
    await Promise.allSettled(
      Array.from({ length: missing }, () => this.spawn(this.poolCwd as string)),
    );
  }
}

async function normalizeRpcImages(input: JsonObject): Promise<JsonObject> {
  const command = { ...input };
  const imagePaths = Array.isArray(command.imagePaths)
    ? command.imagePaths
    : undefined;
  delete command.imagePaths;
  if (!imagePaths) return command;
  if (imagePaths.length > 10)
    throw new Error("A Pi request can contain at most 10 images");
  const images = Array.isArray(command.images) ? [...command.images] : [];
  for (const value of imagePaths) {
    if (typeof value !== "string") throw new Error("Image path must be a string");
    const metadata = await stat(value);
    if (!metadata.isFile() || metadata.size > 20 * 1024 * 1024)
      throw new Error(`Image is not a file or exceeds 20 MiB: ${value}`);
    const mimeType = IMAGE_MIME_TYPES[extname(value).toLowerCase()];
    if (!mimeType) throw new Error(`Unsupported image type: ${value}`);
    images.push({
      type: "image",
      data: (await readFile(value)).toString("base64"),
      mimeType,
    });
  }
  command.images = images;
  return command;
}
