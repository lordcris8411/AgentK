import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { isPathInside, randomId } from "./utils.js";
import { loadKAppConfig } from "./k-app-config.js";

const OUTPUT_LIMIT = 1024 * 1024;
const RECORD_LIMIT = 50;

export type KAppProcessSnapshot = {
  args: string[];
  command: string;
  cwd: string;
  exitCode?: number;
  exitedAt?: number;
  id: string;
  pid?: number;
  signal?: string;
  startedAt: number;
  status: "running" | "exited" | "failed";
  successful?: boolean;
};

type ProcessRecord = KAppProcessSnapshot & {
  appDirectory: string;
  child: ChildProcessWithoutNullStreams;
  closed: boolean;
  scope: string;
  stderr: string;
  stderrBase: number;
  stdout: string;
  stdoutBase: number;
  waiters: Array<(value: KAppProcessSnapshot) => void>;
};

function appendOutput(record: ProcessRecord, stream: "stderr" | "stdout", value: Buffer): void {
  const base = stream === "stdout" ? "stdoutBase" : "stderrBase";
  record[stream] += value.toString("utf8");
  const excess = record[stream].length - OUTPUT_LIMIT;
  if (excess > 0) {
    record[stream] = record[stream].slice(excess);
    record[base] += excess;
  }
}

function snapshot(record: ProcessRecord): KAppProcessSnapshot {
  const { args, command, cwd, exitCode, exitedAt, id, pid, signal, startedAt, status } = record;
  return {
    args: [...args], command, cwd,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(exitedAt === undefined ? {} : { exitedAt }),
    id,
    ...(pid === undefined ? {} : { pid }),
    ...(signal === undefined ? {} : { signal }),
    startedAt,
    status,
    ...(status === "running" ? {} : { successful: status === "exited" && exitCode === 0 && !signal }),
  };
}

export class KAppProcessManager {
  private readonly processes = new Map<string, ProcessRecord>();

  async start(root: string, directory: string, command: string, args: string[], cwd = "."): Promise<KAppProcessSnapshot> {
    if (!command.trim()) throw new Error("k-app process command must not be empty");
    const executableName = basename(command).toLocaleLowerCase("en-US").replace(/\.exe$/u, "");
    if (process.platform === "win32" && ["explore", "explorer", "taskmgr"].includes(executableName))
      throw new Error(`${basename(command)} is a Windows shell application; use AgentK.processes.open() instead`);
    if (args.length > 256 || args.some((argument) => typeof argument !== "string"))
      throw new Error("k-app process arguments must be an array of at most 256 strings");
    const appDirectory = await this.resolveKApp(root, directory);
    const processDirectory = await this.resolveChildDirectory(appDirectory, cwd);
    this.prune();
    const child = spawn(command, args, {
      cwd: processDirectory,
      env: { ...process.env },
      shell: false,
      stdio: "pipe",
      windowsHide: true,
    });
    const id = randomId("k-app-process-");
    const record: ProcessRecord = {
      appDirectory,
      args: [...args],
      child,
      closed: false,
      command,
      cwd: processDirectory,
      id,
      pid: child.pid,
      scope: this.scope(root, appDirectory),
      startedAt: Date.now(),
      status: "running",
      stderr: "",
      stderrBase: 0,
      stdout: "",
      stdoutBase: 0,
      waiters: [],
    };
    this.processes.set(id, record);
    child.stdout.on("data", (chunk: Buffer) => appendOutput(record, "stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => appendOutput(record, "stderr", chunk));
    child.once("exit", (code, signal) => {
      record.exitCode = code ?? undefined;
      record.exitedAt = Date.now();
      record.signal = signal ?? undefined;
      record.status = "exited";
    });
    child.once("close", () => {
      record.closed = true;
      const terminal = snapshot(record);
      record.waiters.splice(0).forEach((resolveWaiter) => resolveWaiter(terminal));
    });
    await new Promise<void>((resolveStart, rejectStart) => {
      child.once("spawn", resolveStart);
      child.once("error", (error) => {
        record.exitedAt = Date.now();
        record.status = "failed";
        appendOutput(record, "stderr", Buffer.from(String(error)));
        rejectStart(error);
      });
    });
    record.pid = child.pid;
    return snapshot(record);
  }

  async list(root: string, directory: string): Promise<KAppProcessSnapshot[]> {
    const appDirectory = await this.resolveKApp(root, directory);
    const scope = this.scope(root, appDirectory);
    return [...this.processes.values()]
      .filter((record) => record.scope === scope)
      .map(snapshot);
  }

  async open(
    root: string,
    directory: string,
    target: string,
    openPath: (path: string) => Promise<string>,
  ): Promise<{ opened: true }> {
    const appDirectory = await this.resolveKApp(root, directory);
    const requested = target.trim();
    if (!requested) throw new Error("k-app open target must not be empty");
    // Relative files and directories remain scoped to the k-app. A bare name
    // (for example taskmgr.exe) is intentionally passed to the OS shell so it
    // can apply normal registered-application and single-instance semantics.
    const resolvedTarget = isAbsolute(requested)
      ? requested
      : requested.includes("/") || requested.includes("\\") || requested.startsWith(".")
        ? resolve(appDirectory, requested)
        : requested;
    if (!isAbsolute(requested) && resolvedTarget !== requested && !isPathInside(appDirectory, resolvedTarget))
      throw new Error("k-app open target escapes the app directory");
    const error = await openPath(resolvedTarget);
    if (error) throw new Error(error);
    return { opened: true };
  }

  async status(root: string, directory: string, id: string): Promise<KAppProcessSnapshot> {
    return snapshot(await this.owned(root, directory, id));
  }

  async wait(root: string, directory: string, id: string): Promise<KAppProcessSnapshot> {
    const record = await this.owned(root, directory, id);
    if (record.closed) return snapshot(record);
    return new Promise((resolveWaiter) => record.waiters.push(resolveWaiter));
  }

  async output(root: string, directory: string, id: string, stdoutCursor: number, stderrCursor: number): Promise<{ stderr: string; stderrCursor: number; stdout: string; stdoutCursor: number }> {
    const record = await this.owned(root, directory, id);
    const safeStdoutCursor = Math.max(record.stdoutBase, Math.floor(stdoutCursor));
    const safeStderrCursor = Math.max(record.stderrBase, Math.floor(stderrCursor));
    return {
      stdout: record.stdout.slice(safeStdoutCursor - record.stdoutBase),
      stdoutCursor: record.stdoutBase + record.stdout.length,
      stderr: record.stderr.slice(safeStderrCursor - record.stderrBase),
      stderrCursor: record.stderrBase + record.stderr.length,
    };
  }

  async stop(root: string, directory: string, id: string): Promise<KAppProcessSnapshot> {
    const record = await this.owned(root, directory, id);
    if (record.status === "running") {
      await new Promise<void>((resolveStop) => {
        const timeout = setTimeout(resolveStop, 2_000);
        record.child.once("close", () => {
          clearTimeout(timeout);
          resolveStop();
        });
        record.child.kill();
      });
    }
    return snapshot(record);
  }

  shutdown(): void {
    for (const record of this.processes.values()) {
      if (record.status === "running") record.child.kill();
    }
    this.processes.clear();
  }

  private async owned(root: string, directory: string, id: string): Promise<ProcessRecord> {
    const appDirectory = await this.resolveKApp(root, directory);
    const record = this.processes.get(id);
    if (!record || record.scope !== this.scope(root, appDirectory))
      throw new Error("Unknown k-app process");
    return record;
  }

  private async resolveKApp(root: string, directory: string): Promise<string> {
    if (!isAbsolute(root)) throw new Error("k-app workspace root must be absolute");
    if (isAbsolute(directory)) throw new Error("k-app directory must be relative to the workspace");
    const workspaceRoot = await realpath(resolve(root));
    const appDirectory = await realpath(resolve(workspaceRoot, directory));
    if (!isPathInside(workspaceRoot, appDirectory)) throw new Error("k-app directory escapes the workspace");
    try {
      await loadKAppConfig(appDirectory);
    } catch (cause) {
      throw new Error(`Process access requires a valid k-app directory: ${String(cause)}`);
    }
    return appDirectory;
  }

  private async resolveChildDirectory(appDirectory: string, cwd: string): Promise<string> {
    if (isAbsolute(cwd)) throw new Error("k-app process cwd must be relative");
    const target = await realpath(resolve(appDirectory, cwd));
    if (!isPathInside(appDirectory, target)) throw new Error("k-app process cwd escapes the app directory");
    return target;
  }

  private scope(root: string, appDirectory: string): string {
    const value = `${resolve(root)}\0${appDirectory}`;
    return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
  }

  private prune(): void {
    if (this.processes.size < RECORD_LIMIT) return;
    for (const [id, record] of this.processes) {
      if (record.status === "running") continue;
      this.processes.delete(id);
      if (this.processes.size < RECORD_LIMIT) return;
    }
    if (this.processes.size >= RECORD_LIMIT) throw new Error("Too many active k-app processes");
  }
}
