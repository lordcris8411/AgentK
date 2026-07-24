import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { JsonObject } from "../types.js";
import { asObject, asString, errorMessage } from "../utils.js";

type Pending = { resolve(value: JsonObject): void; reject(reason: Error): void };

/** A small, version-tolerant JSON-RPC client for Codex App Server. */
export class CodexBridge {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private closed = false;
  private readonly activeTurns = new Map<string, string>();

  private constructor(child: ChildProcessWithoutNullStreams, private readonly emit: (event: JsonObject) => void) {
    this.child = child;
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => this.onLine(line));
    child.stderr.resume();
    child.once("exit", () => this.close());
    child.once("error", () => this.close());
  }

  static async start(executable: string, emit: (event: JsonObject) => void): Promise<CodexBridge> {
    const child = spawn(executable || "codex", ["app-server"], {
      shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    const bridge = new CodexBridge(child, emit);
    await bridge.request("initialize", {
      clientInfo: { name: "Agent K", version: "0.1.0" }, capabilities: { experimentalApi: true },
    });
    return bridge;
  }

  async request(method: string, params: JsonObject): Promise<JsonObject> {
    if (this.closed) throw new Error("Codex App Server is not connected");
    const id = ++this.nextId;
    const value = await new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
    return value;
  }

  async startThread(cwd: string): Promise<JsonObject> {
    return this.request("thread/start", { cwd, experimentalRawEvents: false, persistFullHistory: false });
  }

  async resumeThread(threadId: string): Promise<JsonObject> {
    return this.request("thread/resume", { threadId });
  }

  async startTurn(threadId: string, text: string, cwd: string, model?: string): Promise<JsonObject> {
    const result = await this.request("turn/start", { threadId, cwd, input: [{ type: "text", text }], ...(model ? { model } : {}) });
    const turn = asObject(result.turn);
    const turnId = asString(turn.id);
    if (turnId) this.activeTurns.set(threadId, turnId);
    return result;
  }

  async models(): Promise<JsonObject> { return this.request("model/list", {}); }
  async plugins(cwd: string): Promise<JsonObject> { return this.request("plugin/list", { cwds: [cwd] }); }

  async forkThread(threadId: string, cwd: string, model?: string): Promise<JsonObject> {
    return this.request("thread/fork", { threadId, cwd, ...(model ? { model } : {}), persistFullHistory: false });
  }

  async setThreadName(threadId: string, name: string): Promise<JsonObject> {
    return this.request("thread/name/set", { threadId, name });
  }

  async archiveThread(threadId: string): Promise<JsonObject> {
    return this.request("thread/archive", { threadId });
  }

  async interrupt(threadId: string, turnId: string): Promise<JsonObject> {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  async interruptActive(threadId: string): Promise<JsonObject> {
    const turnId = this.activeTurns.get(threadId);
    if (!turnId) throw new Error("Codex has no active turn for this thread");
    return this.interrupt(threadId, turnId);
  }

  stop(): void {
    if (!this.closed) this.child.kill();
    this.close();
  }

  private onLine(line: string): void {
    let message: JsonObject;
    try { message = asObject(JSON.parse(line)); } catch { return; }
    const id = typeof message.id === "number" ? message.id : undefined;
    if (id !== undefined) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (message.error) pending.reject(new Error(asString(asObject(message.error).message) ?? "Codex App Server error"));
      else pending.resolve(asObject(message.result));
      return;
    }
    const params = asObject(message.params);
    const event = asString(params.type) ?? asString(message.method) ?? "codex_event";
    this.emit({ ...params, type: `codex_${event}`, backend: "codex" });
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) request.reject(new Error("Codex App Server connection closed"));
    this.pending.clear();
    this.emit({ type: "codex_bridge_closed", backend: "codex" });
  }
}
