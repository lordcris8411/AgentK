import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import extractZip from "extract-zip";
import { DebugSessionManager } from "../shared/debug-session-manager.ts";
import type { DebugStartConfiguration } from "../shared/debug-session.ts";
import { stopChildProcess } from "../shared/child-process.ts";
import { fetchWithRetry, withNetworkRetry } from "../shared/download.ts";
import { listDebugProcesses } from "../shared/processes.ts";

export const NODE_VERSION = "24.18.1";
export const TYPESCRIPT_LANGUAGE_SERVER_VERSION = "5.3.0";
export const TYPESCRIPT_VERSION = "6.0.3";
export const JS_DEBUG_VERSION = "1.117.0";
const JS_DEBUG_SHA256 = "ad8d04ede9d4b75cc290fd5438a65047a06f786d04f604b6112485b36f090772";
const LOCKFILE_SHA256 = "6eb5e90ea5b51e1a5c4cb4c9f634b2166b6fe404bc09527b1f63344ae53b004f";
const PACKAGE_JSON = `${JSON.stringify({ name: "agent-k-private-typescript-language-server", version: "1.0.0", private: true, dependencies: { typescript: TYPESCRIPT_VERSION, "typescript-language-server": TYPESCRIPT_LANGUAGE_SERVER_VERSION } }, undefined, 2)}\n`;
const PACKAGE_LOCK = `{
  "name": "agent-k-private-typescript-language-server",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "agent-k-private-typescript-language-server",
      "version": "1.0.0",
      "dependencies": {
        "typescript": "6.0.3",
        "typescript-language-server": "5.3.0"
      }
    },
    "node_modules/typescript": {
      "version": "6.0.3",
      "resolved": "https://registry.npmjs.org/typescript/-/typescript-6.0.3.tgz",
      "integrity": "sha512-y2TvuxSZPDyQakkFRPZHKFm+KKVqIisdg9/CZwm9ftvKXLP8NRWj38/ODjNbr43SsoXqNuAisEf1GdCxqWcdBw==",
      "license": "Apache-2.0",
      "bin": { "tsc": "bin/tsc", "tsserver": "bin/tsserver" },
      "engines": { "node": ">=14.17" }
    },
    "node_modules/typescript-language-server": {
      "version": "5.3.0",
      "resolved": "https://registry.npmjs.org/typescript-language-server/-/typescript-language-server-5.3.0.tgz",
      "integrity": "sha512-5puofxZHgFdAYtfNpmwCAvgtaYgg8wrUnH30m7Ze3QuguId5RNRadKASpOpyDxTyUdAF51FjhTdjntLw/EuWcQ==",
      "license": "Apache-2.0",
      "bin": { "typescript-language-server": "lib/cli.mjs" },
      "engines": { "node": ">=20" }
    }
  }
}
`;

type SupportedPlatform = "linux" | "win32";
export type NodeArchive = { asset: string; bytes?: number; executable: string; format: "tar.xz" | "zip"; platform: SupportedPlatform; sha256: string; topLevel: string; url: string };
export function nodeArchive(platform: NodeJS.Platform, arch: string): NodeArchive | undefined {
  if (arch !== "x64" || (platform !== "win32" && platform !== "linux")) return undefined;
  const topLevel = `node-v${NODE_VERSION}-${platform === "win32" ? "win-x64" : "linux-x64"}`;
  const asset = `${topLevel}.${platform === "win32" ? "zip" : "tar.xz"}`;
  return {
    asset,
    executable: join(topLevel, platform === "win32" ? "node.exe" : "bin/node"),
    format: platform === "win32" ? "zip" : "tar.xz",
    platform,
    sha256: platform === "win32" ? "ec56b84a7551893ab2324ebdfdc4ab974a63b4781162600b68a1293cc3e53765" : "d6c664df3f3f61458e8c277585571328522d705166723a7c7823a9253a4d15a0",
    topLevel,
    url: `https://nodejs.org/dist/v${NODE_VERSION}/${asset}`,
  };
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}
function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
async function fileHash(path: string): Promise<string> { return hash(await readFile(path)); }

export function systemTarExecutable(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env): string {
  if (platform === "win32") {
    const systemRoot = environment.SystemRoot ?? environment.WINDIR;
    if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("Windows system root is unavailable for the declared tar tool");
    const command = join(systemRoot, "System32", "tar.exe");
    if (!existsSync(command)) throw new Error(`Declared Windows tar tool is unavailable: ${command}`);
    return command;
  }
  for (const command of ["/usr/bin/tar", "/bin/tar"]) if (existsSync(command)) return command;
  throw new Error("Declared Linux tar tool is unavailable");
}

function linuxDecompressor(name: "gzip" | "xz"): string {
  const command = `/usr/bin/${name}`;
  if (!existsSync(command)) throw new Error(`Declared Linux ${name} tool is unavailable`);
  return command;
}

export async function runProcess(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeout?: number }): Promise<{ stderr: string; stdout: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, signal: options.signal, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (data: Buffer) => { stdout = `${stdout}${data}`.slice(-32_768); });
    child.stderr.on("data", (data: Buffer) => { stderr = `${stderr}${data}`.slice(-32_768); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${basename(command)} timed out`)); }, options.timeout ?? 120_000);
    child.once("error", (cause) => { clearTimeout(timer); reject(cause); });
    child.once("close", (code) => {
      clearTimeout(timer);
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      code === 0 ? resolveRun({ stdout, stderr }) : reject(new Error(`${basename(command)} exited with ${code}${detail ? `:\n${detail}` : ""}`));
    });
  });
}

/** Extract and validate the official archive layout; never infer success from the extractor exit code. */
export async function extractOfficialNodeArchive(archivePath: string, destination: string, archive: NodeArchive, signal?: AbortSignal): Promise<string> {
  await mkdir(destination, { recursive: true });
  if (archive.format === "zip") await extractZip(archivePath, { dir: resolve(destination) });
  else {
    // A relative slash path avoids GNU tar interpreting a Windows drive colon
    // as a remote archive while remaining valid for native Linux tar.
    const localArchive = relative(destination, resolve(archivePath)).replaceAll("\\", "/");
    await runProcess(systemTarExecutable(archive.platform), ["-I", linuxDecompressor("xz"), "-xf", localArchive, "-C", "."], { cwd: destination, env: { ...process.env }, signal });
  }
  const entries = await readdir(destination, { withFileTypes: true });
  const top = entries.find((entry) => entry.isDirectory() && entry.name === archive.topLevel);
  if (!top) throw new Error(`Node ${NODE_VERSION} archive is missing expected top-level directory '${archive.topLevel}'`);
  const executable = join(destination, archive.executable);
  if (!existsSync(executable) || !(await stat(executable)).isFile())
    throw new Error(`Node ${NODE_VERSION} archive is missing expected executable '${archive.executable}'`);
  if (archive.platform === "linux") await chmod(executable, 0o755);
  return executable;
}

async function atomicReplace(staging: string, target: string): Promise<void> {
  const previous = `${target}.previous-${process.pid}-${Date.now()}`;
  const hadPrevious = existsSync(target);
  if (hadPrevious) await rename(target, previous);
  try { await rename(staging, target); }
  catch (cause) { if (hadPrevious && existsSync(previous) && !existsSync(target)) await rename(previous, target); throw cause; }
  if (hadPrevious) await rm(previous, { recursive: true, force: true }).catch(() => undefined);
}

type Status = "preparing" | "starting" | "ready" | "failed" | "stopped";
type Pending = { method: string; reject(error: Error): void; resolve(value: unknown): void; timer: ReturnType<typeof setTimeout>; started: number };
type Project = { root: string; name: string; status: Status; error?: string; child?: ChildProcessWithoutNullStreams; diagnostics: Map<string, unknown[]>; nextId: number; pending: Map<number, Pending>; queue: Promise<void>; stderr: string };
type Trace = { timestamp: number; method: string; phase: "request" | "response" | "notification" | "rejected"; elapsedMs?: number; error?: string; file?: string };
type Change = { path: string; type: 1 | 2 | 3 };

export function packageScriptForAction(
  packageJson: unknown,
  action: "build" | "run" | "test",
): string | undefined {
  if (!packageJson || typeof packageJson !== "object") return undefined;
  const scripts = (packageJson as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return undefined;
  const names = action === "run" ? ["start"] : [action];
  return names.find((name) => {
    const value = (scripts as Record<string, unknown>)[name];
    return typeof value === "string" && value.trim().length > 0;
  });
}

export function isolatedRuntimePath(
  runtimeNode: string | undefined,
  systemNpm: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  const paths = platform === "win32" ? win32 : posix;
  return [runtimeNode ? paths.dirname(runtimeNode) : undefined, systemNpm ? paths.dirname(systemNpm) : undefined]
    .filter((value): value is string => Boolean(value))
    .join(platform === "win32" ? ";" : ":");
}

export function npmScriptShell(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return platform === "win32"
    ? environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe"
    : "/bin/sh";
}

export class TypeScriptService {
  private readonly projects = new Map<string, Project>();
  private readonly traces: Trace[] = [];
  private confirmations = new Map<string, { resolve(value: boolean): void; timer: ReturnType<typeof setTimeout> }>();
  private nextConfirmation = 1;
  private provisioning?: Promise<string>;
  private abort?: AbortController;
  private readonly cachePath: string;
  private readonly emit: (event: Record<string, unknown>) => void;
  private readonly systemNode?: string;
  private readonly systemNpm?: string;
  private readonly debug: DebugSessionManager;
  constructor(cachePath: string, emit: (event: Record<string, unknown>) => void, systemTools: Record<string, { command?: unknown }> = {}) { this.cachePath = cachePath; this.emit = emit; const node = typeof systemTools.node?.command === "string" ? systemTools.node.command : undefined; const npm = typeof systemTools.npm?.command === "string" ? systemTools.npm.command : undefined; this.systemNode = node && npm ? node : undefined; this.systemNpm = node && npm ? npm : undefined; this.debug = new DebugSessionManager((snapshot) => this.emit({ type: "language_pack_debug", snapshot }), () => { const root = this.toolchainRoot(); const command = this.nodeExecutable(root); const script = join(root, "js-debug", "src", "dapDebugServer.js"); if (!existsSync(command) || !existsSync(script)) throw new Error("JavaScript DAP adapter is unavailable. Prepare the Language Pack first."); const port = 40_000 + Math.floor(Math.random() * 20_000); return { adapter: "pwa-node", command, args: [script, String(port), "127.0.0.1"], env: this.environment(join(this.cachePath, "home"), command), transport: { kind: "tcp", host: "127.0.0.1", port } }; }); }
  private public(entry: Project) { return { root: entry.root, name: entry.name, status: entry.status, ...(entry.error ? { error: entry.error } : {}) }; }
  private publish(entry: Project) { this.emit({ type: "language_pack_project", project: this.public(entry) }); }
  private record(trace: Trace) { this.traces.push(trace); if (this.traces.length > 200) this.traces.splice(0, this.traces.length - 200); }
  list() { return [...this.projects.values()].map((entry) => this.public(entry)); }
  status(root?: string) { if (!root) return this.list(); const entry = this.projects.get(resolve(root)); return entry ? this.public(entry) : { root: resolve(root), name: basename(resolve(root)), status: "stopped" as const }; }
  trace() { return [...this.traces]; }
  respondConfirmation(id: string, confirmed: boolean): boolean { const pending = this.confirmations.get(id); if (!pending) return false; clearTimeout(pending.timer); this.confirmations.delete(id); pending.resolve(confirmed); return true; }
  cancel() { this.abort?.abort(); for (const [id, pending] of this.confirmations) { clearTimeout(pending.timer); pending.resolve(false); this.confirmations.delete(id); } }

  async load(requestedRoot: string) {
    const root = resolve(requestedRoot);
    const rootStat = await stat(root).catch(() => undefined);
    if (!rootStat?.isDirectory()) throw new Error(`TypeScript/JavaScript project directory does not exist: ${root}`);
    const markers = ["tsconfig.json", "jsconfig.json", "package.json"];
    if (!markers.some((marker) => existsSync(join(root, marker)))) throw new Error(`Project must contain ${markers.join(", ")}`);
    const existing = this.projects.get(root);
    if (existing?.status === "ready") return this.public(existing);
    if (existing) await this.stop(existing);
    const entry: Project = { root, name: basename(root), status: "preparing", diagnostics: new Map(), nextId: 1, pending: new Map(), queue: Promise.resolve(), stderr: "" };
    this.projects.set(root, entry); this.publish(entry);
    try { const toolchain = await this.managedToolchain(); await this.start(entry, toolchain); return this.public(entry); }
    catch (cause) { entry.status = "failed"; entry.error = cause instanceof Error ? cause.message : String(cause); this.publish(entry); throw cause; }
  }
  async unload(requestedRoot: string) { const entry = this.projects.get(resolve(requestedRoot)); if (!entry) return false; await this.stop(entry); this.projects.delete(entry.root); this.publish(entry); return true; }
  async restart(root: string) { await this.unload(root); return this.load(root); }
  async shutdown() { this.cancel(); this.debug.shutdown(); await Promise.all([...this.projects.values()].map((entry) => this.stop(entry))); this.projects.clear(); }

  async agent(input: Record<string, unknown>): Promise<unknown> {
    const action = String(input.action ?? ""); const workspace = typeof input.workspace === "string" ? resolve(input.workspace) : undefined;
    if (action === "project.list") return this.list();
    if (action === "debug.stop") return this.debug.stop(typeof input.sessionId === "string" ? input.sessionId : undefined);
    if (!workspace) throw new Error("workspace is required");
    if (action === "project.load") return this.load(workspace);
    if (action === "project.status") return this.status(workspace);
    if (action === "project.restart") return this.restart(workspace);
    if (action === "project.unload") return this.unload(workspace);
    if (action === "build" || action === "run" || action === "test") return this.executeProjectAction(workspace, action, input);
    if (action === "debug.configurations") return this.debugConfigurations(workspace);
    if (action === "debug.start" || action === "debug.attach") return this.debugStart({ root: workspace, mode: action === "debug.attach" ? "attach" : "launch", ...(typeof input.processId === "number" ? { processId: input.processId } : {}), ...(typeof input.program === "string" ? { program: resolve(workspace, input.program) } : {}), args: Array.isArray(input.args) ? input.args.filter((item): item is string => typeof item === "string") : [] });
    if (!action.startsWith("language.")) throw new Error(`Unsupported TypeScript/JavaScript Language Pack action: ${action}`);
    const entry = this.projects.get(workspace); if (!entry || entry.status !== "ready") throw new Error("TypeScript/JavaScript project is not ready");
    if (action === "language.diagnostics") return [...entry.diagnostics.entries()].map(([file, diagnostics]) => ({ file, diagnostics }));
    const file = typeof input.file === "string" ? resolve(workspace, input.file) : undefined;
    if (file && !inside(workspace, file)) throw new Error("Language action file escapes the workspace");
    const uri = file ? pathToFileURL(file).href : undefined; const textDocument = uri ? { uri } : undefined; const position = input.position;
    const methods: Record<string, [string, unknown]> = {
      "language.definition": ["textDocument/definition", { textDocument, position }],
      "language.references": ["textDocument/references", { textDocument, position, context: { includeDeclaration: true } }],
      "language.hover": ["textDocument/hover", { textDocument, position }],
      "language.completion": ["textDocument/completion", { textDocument, position }],
      "language.rename": ["textDocument/rename", { textDocument, position, newName: input.newName }],
      "language.format": ["textDocument/formatting", { textDocument, options: { insertSpaces: true, tabSize: 2 } }],
      "language.organize-imports": ["textDocument/codeAction", { textDocument, range: input.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, context: { diagnostics: [], only: ["source.organizeImports"] } }],
      "language.symbols": file ? ["textDocument/documentSymbol", { textDocument }] : ["workspace/symbol", { query: typeof input.query === "string" ? input.query : "" }],
    };
    const target = methods[action]; if (!target) throw new Error(`Unsupported TypeScript/JavaScript semantic action: ${action}`);
    return this.lsp(file ?? join(workspace, "__workspace__.ts"), target[0], target[1]);
  }

  private async executeProjectAction(workspace: string, action: "build" | "run" | "test", input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const toolchain = await this.managedToolchain(); const node = this.nodeExecutable(toolchain);
    const output = join(this.cachePath, "build", hash(workspace).slice(0, 16)); await mkdir(output, { recursive: true });
    const packagePath = join(workspace, "package.json");
    const packageJson = existsSync(packagePath)
      ? JSON.parse(await readFile(packagePath, "utf8")) as unknown
      : undefined;
    const packageScript = packageScriptForAction(packageJson, action);
    let args: string[]; let cwd = output; let artifacts: string[] = [];
    if (packageScript && !(action === "run" && typeof input.file === "string")) {
      args = [this.npmCli(toolchain), "run", packageScript];
      cwd = workspace;
    } else if (action === "build") {
      const config = ["tsconfig.json", "jsconfig.json"].find((name) => existsSync(join(workspace, name)));
      if (!config) throw new Error("JavaScript package does not declare a 'build' script in package.json and has no tsconfig.json or jsconfig.json");
      args = [join(toolchain, "packages", "node_modules", "typescript", "bin", "tsc"), "-p", join(workspace, config), "--outDir", output, "--incremental", "--tsBuildInfoFile", join(output, "tsconfig.tsbuildinfo")];
      artifacts = [output];
    } else if (action === "test") args = ["--test", typeof input.file === "string" ? resolve(workspace, input.file) : workspace];
    else { if (typeof input.file !== "string") throw new Error("run requires a workspace-relative file or a package.json 'start' script"); const file = resolve(workspace, input.file); if (!inside(workspace, file)) throw new Error("Run file escapes the workspace"); args = [file, ...(Array.isArray(input.args) ? input.args.filter((value): value is string => typeof value === "string") : [])]; }
    const started = Date.now();
    try {
      const result = await runProcess(node, args, { cwd, env: this.environment(join(this.cachePath, "home"), node), timeout: 300_000 });
      if (action === "build" && packageScript) artifacts = ["dist", "build", "out"].map((name) => join(workspace, name)).filter(existsSync);
      return { code: 0, ...result, command: node, args, cwd, artifacts, durationMs: Date.now() - started, cancelled: false };
    }
    catch (cause) { return { code: 1, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause), command: node, args, cwd, artifacts: [], durationMs: Date.now() - started, cancelled: false }; }
  }
  async debugPrepare() { await this.managedToolchain(); }
  debugStatus(sessionId?: string) { return this.debug.status(sessionId); }
  debugSessions() { return this.debug.list(); }
  debugSelectSession(sessionId: string) { return this.debug.select(sessionId); }
  debugCloseSession(sessionId: string) { return this.debug.close(sessionId); }
  debugDetachSession(sessionId: string) { return this.debug.detach(sessionId); }
  async debugConfigurations(rootInput: string): Promise<Array<{ built: boolean; id: string; name: string; program: string }>> {
    const root = resolve(rootInput); const output = join(this.cachePath, "build", hash(root).slice(0, 16));
    await this.executeProjectAction(root, "build", {}).catch(() => undefined);
    const privateFiles = existsSync(output) ? await readdir(output, { recursive: true }) : [];
    const workspaceFiles = await readdir(root, { recursive: true });
    const candidates = privateFiles.filter((file) => typeof file === "string" && /\.(?:c|m)?js$/iu.test(file)).map((file) => ({ built: true, id: `build:${file.replaceAll("\\", "/")}`, name: basename(file), program: join(output, file) }));
    if (candidates.length) return candidates;
    return workspaceFiles.filter((file) => typeof file === "string" && /\.(?:c|m)?js$/iu.test(file) && !/(?:^|[\\/])(?:node_modules|dist|build)(?:[\\/]|$)/iu.test(file))
      .map((file) => ({ built: false, id: `source:${file.replaceAll("\\", "/")}`, name: basename(file), program: join(root, file) }));
  }
  async debugStart(configuration: DebugStartConfiguration & { targetId?: string; sessionName?: string }) {
    const toolchain = await this.managedToolchain(); const root = resolve(configuration.root); let program = configuration.program;
    if (configuration.mode !== "attach" && configuration.targetId) { const target = (await this.debugConfigurations(root)).find(({ id }) => id === configuration.targetId); if (!target) throw new Error("The selected JavaScript debug target is unavailable"); program = target.program; }
    return this.debug.start({ ...configuration, root, runtimeExecutable: this.nodeExecutable(toolchain), ...(program ? { program } : {}) }, [join(this.cachePath, "build", hash(root).slice(0, 16))]);
  }
  debugStop(sessionId?: string) { return this.debug.stop(sessionId); }
  debugCommand(command: "continue" | "pause" | "next" | "stepIn" | "stepOut", sessionId?: string) { return this.debug.command(command, sessionId); }
  debugSetBreakpoints(file: string, lines: number[]) { return this.debug.setBreakpoints(file, lines); }
  debugClearBreakpoints() { return this.debug.clearBreakpoints(); }
  debugSetFunctionBreakpoints(inputs: Array<{ condition?: string; hitCondition?: string; name: string }>) { return this.debug.setFunctionBreakpoints(inputs); }
  debugSetExceptionFilters(filters: string[]) { return this.debug.setExceptionFilters(filters); }
  debugUpdateBreakpoint(file: string, line: number, changes: Record<string, unknown>) { return this.debug.updateBreakpoint(file, line, changes); }
  debugSetWatches(expressions: string[]) { return this.debug.setWatches(expressions); }
  debugSelectFrame(threadId: number, frameId: number, sessionId?: string) { return this.debug.selectFrame(threadId, frameId, sessionId); }
  debugVariables(reference: number, sessionId?: string) { return this.debug.expandVariables(reference, sessionId); }
  debugEvaluate(expression: string, context: "repl" | "watch", sessionId?: string) { return this.debug.evaluate(expression, context, sessionId); }
  debugSetVariable(reference: number, name: string, value: string, sessionId?: string) { return this.debug.setVariable(reference, name, value, sessionId); }
  debugReadMemory(reference: string, offset: number, count: number, sessionId?: string) { return this.debug.readMemory(reference, offset, count, sessionId); }
  debugWriteMemory(reference: string, offset: number, bytes: number[], sessionId?: string) { return this.debug.writeMemory(reference, offset, bytes, sessionId); }
  debugDisassemble(reference: string, instructionOffset: number, instructionCount: number, offset: number, sessionId?: string) { return this.debug.disassemble(reference, instructionOffset, instructionCount, offset, sessionId); }
  debugSetInstructionBreakpoints(addresses: string[], sessionId?: string) { return this.debug.setInstructionBreakpoints(addresses, sessionId); }
  debugClearOutput(sessionId?: string) { return this.debug.clearOutput(sessionId); }
  debugProcesses() { return listDebugProcesses(); }
  private projectFor(file: string): Project | undefined { const target = resolve(file); return [...this.projects.values()].filter((entry) => inside(entry.root, target)).sort((a, b) => b.root.length - a.root.length)[0]; }
  private async stop(entry: Project) {
    const child = entry.child;
    if (!child) { entry.status = "stopped"; return; }
    try { await Promise.race([this.request(entry, "shutdown", null), new Promise((resolveWait) => setTimeout(resolveWait, 1_000))]); } catch { /* force termination below */ }
    await this.send(entry, "exit", null).catch(() => undefined);
    entry.status = "stopped";
    for (const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("TypeScript language server stopped")); }
    entry.pending.clear();
    await stopChildProcess(child, "typescript-language-server");
    if (entry.child === child) entry.child = undefined;
  }

  private async confirmDownload(archive: NodeArchive): Promise<boolean> {
    const requestId = `typescript-toolchain-${this.nextConfirmation++}`;
    return new Promise((resolveConfirmation) => {
      const timer = setTimeout(() => { this.confirmations.delete(requestId); resolveConfirmation(false); }, 120_000);
      this.confirmations.set(requestId, { resolve: resolveConfirmation, timer });
      this.emit({ type: "language_pack_confirmation_request", requestId, title: "Download TypeScript/JavaScript tools", message: `Download pinned Node.js ${NODE_VERSION} LTS (${archive.asset}), then privately install typescript-language-server ${TYPESCRIPT_LANGUAGE_SERVER_VERSION} and TypeScript ${TYPESCRIPT_VERSION}? Files stay in the Agent K cache and lifecycle scripts are disabled.` });
    });
  }
  private environment(home: string, runtimeNode = this.systemNode): NodeJS.ProcessEnv { const isolated = Object.fromEntries(Object.entries(process.env).filter(([key]) => !new Set(["PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR"]).has(key.toLocaleUpperCase("en-US")))); return { ...isolated, PATH: isolatedRuntimePath(runtimeNode, this.systemNpm), HOME: home, USERPROFILE: home, TMP: join(this.cachePath, "temp"), TEMP: join(this.cachePath, "temp"), TMPDIR: join(this.cachePath, "temp"), npm_config_cache: join(this.cachePath, "package-cache"), npm_config_audit: "false", npm_config_fund: "false", npm_config_ignore_scripts: "true", npm_config_script_shell: npmScriptShell(), NODE_REPL_HISTORY: join(this.cachePath, "logs", "node_repl_history") }; }
  private marker() { return `node=${NODE_VERSION}\nnode-source=${this.systemNode ? `system:${this.systemNode}` : "private"}\ntypescript-language-server=${TYPESCRIPT_LANGUAGE_SERVER_VERSION}\ntypescript=${TYPESCRIPT_VERSION}\njs-debug=${JS_DEBUG_VERSION}\nlock=${LOCKFILE_SHA256}\n`; }
  private nodeExecutable(root: string): string { return this.systemNode ?? join(root, nodeArchive(process.platform, process.arch)!.executable); }
  private npmCli(root: string): string {
    if (this.systemNpm) {
      if (process.platform === "win32" && this.systemNpm.toLowerCase().endsWith(".cmd"))
        return join(dirname(this.systemNpm), "node_modules", "npm", "bin", "npm-cli.js");
      return this.systemNpm;
    }
    const archive = nodeArchive(process.platform, process.arch)!;
    const nodeRoot = join(root, archive.topLevel);
    return archive.platform === "win32"
      ? join(nodeRoot, "node_modules", "npm", "bin", "npm-cli.js")
      : join(nodeRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  }
  private toolchainRoot(): string { return join(this.cachePath, "tools", process.platform, process.arch, `node-${NODE_VERSION}-tls-${TYPESCRIPT_LANGUAGE_SERVER_VERSION}-ts-${TYPESCRIPT_VERSION}-js-debug-${JS_DEBUG_VERSION}`); }
  private async managedToolchain(): Promise<string> {
    const archive = nodeArchive(process.platform, process.arch);
    if (!archive) throw new Error("Automatic TypeScript toolchain installation supports Windows x64 and Linux x64 only");
    const root = this.toolchainRoot();
    const executable = this.nodeExecutable(root);
    const cli = join(root, "packages", "node_modules", "typescript-language-server", "lib", "cli.mjs");
    const tsserver = join(root, "packages", "node_modules", "typescript", "lib", "tsserver.js");
    const debuggerScript = join(root, "js-debug", "src", "dapDebugServer.js");
    if (await readFile(join(root, ".complete"), "utf8").catch(() => "") === this.marker() && [executable, cli, tsserver, debuggerScript].every(existsSync)) return root;
    this.abort ??= new AbortController();
    this.provisioning ??= this.provision(root, archive, this.abort.signal).finally(() => { this.provisioning = undefined; this.abort = undefined; });
    return this.provisioning;
  }
  private async provision(root: string, archive: NodeArchive, signal: AbortSignal): Promise<string> {
    const downloads = join(this.cachePath, "archives"); const archivePath = join(downloads, archive.asset); const sumsPath = join(downloads, `SHASUMS256-${NODE_VERSION}.txt`); const debugAsset = `js-debug-dap-v${JS_DEBUG_VERSION}.tar.gz`; const debugArchive = join(downloads, debugAsset);
    await Promise.all([mkdir(downloads, { recursive: true }), mkdir(join(this.cachePath, "package-cache"), { recursive: true }), mkdir(join(this.cachePath, "indexes"), { recursive: true }), mkdir(join(this.cachePath, "logs"), { recursive: true }), mkdir(join(this.cachePath, "build"), { recursive: true }), mkdir(join(this.cachePath, "temp"), { recursive: true }), mkdir(join(this.cachePath, "home"), { recursive: true })]);
    // A completed toolchain returned before entering provisioning. Every
    // incomplete installation can still contact npm even when Node's archive
    // is cached, so confirmation is mandatory before any provisioning network.
    if (!await this.confirmDownload(archive)) throw new Error("TypeScript toolchain download was not approved");
    signal.throwIfAborted();
    if (!existsSync(debugArchive) || await fileHash(debugArchive) !== JS_DEBUG_SHA256) await this.download(`https://github.com/microsoft/vscode-js-debug/releases/download/v${JS_DEBUG_VERSION}/${debugAsset}`, debugArchive, signal, "JavaScript debugger");
    if (await fileHash(debugArchive) !== JS_DEBUG_SHA256) { await rm(debugArchive, { force: true }); throw new Error("JavaScript debugger SHA-256 mismatch"); }
    if (!this.systemNode) {
      if (!existsSync(sumsPath)) await this.download(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`, sumsPath, signal, "Node.js checksums");
      const upstreamDigest = (await readFile(sumsPath, "utf8")).split(/\r?\n/).map((line) => line.trim().split(/\s+/)).find((parts) => parts[1] === archive.asset)?.[0];
      if (upstreamDigest !== archive.sha256) throw new Error(`Official Node SHASUMS256 digest mismatch for ${archive.asset}: expected ${archive.sha256}, received ${upstreamDigest ?? "missing entry"}`);
      if (!existsSync(archivePath) || await fileHash(archivePath) !== archive.sha256) await this.download(archive.url, archivePath, signal, "Node.js archive");
      const actual = await fileHash(archivePath); if (actual !== archive.sha256) { await rm(archivePath, { force: true }); throw new Error(`Node archive SHA-256 mismatch for ${archive.asset}: expected ${archive.sha256}, received ${actual}`); }
    }
    const staging = `${root}.staging-${process.pid}-${Date.now()}`; await rm(staging, { recursive: true, force: true }); await mkdir(staging, { recursive: true });
    try {
      this.emit({ type: "language_pack_progress", stage: "preparing", detail: `Extracting ${archive.asset}` });
      const stagedNode = this.systemNode ?? await extractOfficialNodeArchive(archivePath, staging, archive, signal);
      const env = this.environment(join(this.cachePath, "home"), stagedNode);
      const version = (await runProcess(stagedNode, ["--version"], { cwd: staging, env, signal, timeout: 30_000 })).stdout.trim();
      if (version !== `v${NODE_VERSION}`) throw new Error(`Extracted private Node version mismatch: expected v${NODE_VERSION}, received ${version || "no output"}`);
      const packageRoot = join(staging, "packages"); await mkdir(packageRoot, { recursive: true });
      await runProcess(systemTarExecutable(), process.platform === "linux" ? ["-I", linuxDecompressor("gzip"), "-xf", debugArchive, "-C", staging] : ["-xzf", debugArchive, "-C", staging], { cwd: staging, env, signal, timeout: 60_000 });
      if (!existsSync(join(staging, "js-debug", "src", "dapDebugServer.js"))) throw new Error("JavaScript debugger archive layout is invalid");
      if (hash(PACKAGE_LOCK) !== LOCKFILE_SHA256) throw new Error("Embedded npm lockfile integrity check failed");
      await Promise.all([writeFile(join(packageRoot, "package.json"), PACKAGE_JSON, "utf8"), writeFile(join(packageRoot, "package-lock.json"), PACKAGE_LOCK, "utf8")]);
      const nodeRoot = join(staging, archive.topLevel);
      const npmCli = this.systemNpm
        ? process.platform === "win32" && this.systemNpm.toLowerCase().endsWith(".cmd") ? join(dirname(this.systemNpm), "node_modules", "npm", "bin", "npm-cli.js") : this.systemNpm
        : archive.platform === "win32" ? join(nodeRoot, "node_modules", "npm", "bin", "npm-cli.js") : join(nodeRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js");
      if (!existsSync(npmCli)) throw new Error(`Extracted Node archive is missing private npm CLI: ${relative(staging, npmCli)}`);
      this.emit({ type: "language_pack_progress", stage: "configuring", detail: "Installing pinned TypeScript packages with npm lifecycle scripts disabled" });
      await runProcess(stagedNode, [npmCli, "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", "--cache", join(this.cachePath, "package-cache")], { cwd: packageRoot, env, signal, timeout: 300_000 });
      const cli = join(packageRoot, "node_modules", "typescript-language-server", "lib", "cli.mjs"); const tsserver = join(packageRoot, "node_modules", "typescript", "lib", "tsserver.js");
      if (![cli, tsserver].every(existsSync)) throw new Error("Private npm install completed without the pinned language server or TypeScript server");
      await writeFile(join(staging, ".complete"), this.marker(), "utf8");
      await atomicReplace(staging, root);
      this.emit({ type: "language_pack_progress", stage: "ready", detail: "Private TypeScript toolchain is ready" });
      return root;
    } catch (cause) { await rm(staging, { recursive: true, force: true }); throw cause; }
  }
  private async download(url: string, target: string, signal: AbortSignal, tool: string): Promise<void> {
    const partial = `${target}.partial`;
    await withNetworkRetry(async () => {
      await rm(partial, { force: true });
      const response = await fetchWithRetry(url, { redirect: "follow", signal }); if (!response.ok || !response.body) throw new Error(`Unable to download ${url}: HTTP ${response.status}`);
      const total = Number(response.headers.get("content-length") ?? 0); let received = 0;
      const progress = new TransformStream<Uint8Array, Uint8Array>({ transform: (chunk, controller) => { received += chunk.byteLength; this.emit({ type: "language_pack_progress", stage: "downloading", tool, received, ...(total ? { total } : {}) }); controller.enqueue(chunk); } });
      try { await pipeline(Readable.fromWeb(response.body.pipeThrough(progress) as never), createWriteStream(partial), { signal }); await rename(partial, target); }
      catch (cause) { await rm(partial, { force: true }); throw cause; }
    }, signal);
  }

  private async start(entry: Project, toolchain: string): Promise<void> {
    const node = this.nodeExecutable(toolchain); const cli = join(toolchain, "packages", "node_modules", "typescript-language-server", "lib", "cli.mjs"); const tsserver = join(toolchain, "packages", "node_modules", "typescript", "lib", "tsserver.js");
    if (![node, cli, tsserver].every(existsSync)) throw new Error("Completed private TypeScript toolchain is incomplete");
    entry.status = "starting"; this.publish(entry);
    const env = this.environment(join(this.cachePath, "home"), node);
    const child = spawn(node, [cli, "--stdio"], { cwd: entry.root, env, windowsHide: true, stdio: "pipe" }); entry.child = child;
    let buffer = Buffer.alloc(0); const fail = (cause: unknown) => { const error = cause instanceof Error ? cause : new Error(String(cause)); if (entry.status !== "stopped") { entry.status = "failed"; entry.error = error.message; this.publish(entry); } for (const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } entry.pending.clear(); };
    child.stderr.on("data", (data: Buffer) => { entry.stderr = `${entry.stderr}${data}`.slice(-16_384); void writeFile(join(this.cachePath, "logs", `${hash(entry.root).slice(0, 16)}.log`), entry.stderr, "utf8"); });
    child.stdout.on("data", (data: Buffer) => { buffer = Buffer.concat([buffer, data]); for (;;) { const end = buffer.indexOf("\r\n\r\n"); if (end < 0) break; const length = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString("ascii"))?.[1]; if (!length) { buffer = buffer.subarray(end + 4); continue; } const start = end + 4; const bodyEnd = start + Number(length); if (buffer.length < bodyEnd) break; const body = buffer.subarray(start, bodyEnd).toString("utf8"); buffer = buffer.subarray(bodyEnd); try { this.handleServerMessage(entry, JSON.parse(body) as Record<string, unknown>); } catch (cause) { fail(new Error(`Invalid TypeScript language server response: ${cause instanceof Error ? cause.message : String(cause)}`)); } } });
    child.once("error", fail); child.once("close", (code) => { if (entry.status !== "stopped" && entry.status !== "failed") fail(new Error(`TypeScript language server exited with ${code}`)); });
    await this.request(entry, "initialize", { processId: process.pid, rootUri: pathToFileURL(entry.root).href, workspaceFolders: [{ uri: pathToFileURL(entry.root).href, name: entry.name }], capabilities: { workspace: { workspaceFolders: true, symbol: {} }, textDocument: { completion: { completionItem: { snippetSupport: true } }, definition: { linkSupport: true }, references: {}, hover: { contentFormat: ["markdown", "plaintext"] }, documentSymbol: {}, publishDiagnostics: { relatedInformation: true }, rename: { prepareSupport: true }, formatting: {}, rangeFormatting: {}, codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ["source.organizeImports", "source.fixAll", "quickfix", "refactor"] } } } } }, initializationOptions: { hostInfo: "Agent K", tsserver: { path: tsserver }, preferences: { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true } } });
    await this.send(entry, "initialized", {}); entry.status = "ready"; this.publish(entry); this.emit({ type: "language_pack_progress", stage: "ready", detail: "TypeScript/JavaScript language service is ready" });
  }
  private handleServerMessage(entry: Project, message: Record<string, unknown>) {
    const method = message.method; const params = message.params as Record<string, unknown> | undefined;
    if (method === "textDocument/publishDiagnostics" && typeof params?.uri === "string" && Array.isArray(params.diagnostics)) { try { const file = fileURLToPath(params.uri); entry.diagnostics.set(file, params.diagnostics); this.emit({ type: "language_pack_diagnostics", file, diagnostics: params.diagnostics }); } catch { /* invalid URI */ } return; }
    if (typeof message.id === "number" && typeof method === "string") { void this.respondToServer(entry, message.id, method, params); return; }
    if (typeof message.id !== "number") return; const pending = entry.pending.get(message.id); if (!pending) return; entry.pending.delete(message.id); clearTimeout(pending.timer); const error = message.error as { message?: string } | undefined; this.record({ timestamp: Date.now(), method: pending.method, phase: "response", elapsedMs: Date.now() - pending.started, ...(error ? { error: error.message ?? "LSP error" } : {}) }); error ? pending.reject(new Error(error.message ?? "TypeScript language server error")) : pending.resolve(message.result);
  }
  private async respondToServer(entry: Project, id: number, method: string, params?: Record<string, unknown>) { const result = method === "workspace/configuration" ? (Array.isArray(params?.items) ? params.items.map(() => ({ insertSpaces: true, tabSize: 2 })) : []) : method === "window/workDoneProgress/create" ? null : method === "workspace/workspaceFolders" ? [{ uri: pathToFileURL(entry.root).href, name: entry.name }] : null; await this.write(entry, { jsonrpc: "2.0", id, result }); }
  private write(entry: Project, value: Record<string, unknown>): Promise<void> { const body = JSON.stringify(value); const operation = entry.queue.catch(() => undefined).then(() => new Promise<void>((resolveWrite, reject) => { if (!entry.child?.stdin.writable) { reject(new Error("TypeScript language server stdin is unavailable")); return; } entry.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, (cause) => cause ? reject(cause) : resolveWrite()); })); entry.queue = operation.catch(() => undefined); return operation; }
  private async send(entry: Project, method: string, params: unknown) { await this.write(entry, { jsonrpc: "2.0", method, params }); this.record({ timestamp: Date.now(), method, phase: "notification" }); }
  private request(entry: Project, method: string, params: unknown): Promise<unknown> { const id = entry.nextId++; const started = Date.now(); this.record({ timestamp: started, method, phase: "request" }); return new Promise((resolveRequest, reject) => { const timer = setTimeout(() => { entry.pending.delete(id); reject(new Error(`TypeScript language server request timed out (${method})${entry.stderr ? `: ${entry.stderr.trim()}` : ""}`)); }, method === "initialize" ? 30_000 : 10_000); entry.pending.set(id, { method, resolve: resolveRequest, reject, timer, started }); void this.write(entry, { jsonrpc: "2.0", id, method, params }).catch((cause) => { clearTimeout(timer); entry.pending.delete(id); reject(cause); }); }); }
  async lsp(file: string, method: string, params: unknown) { const entry = this.projectFor(file); if (!entry || entry.status !== "ready") { this.record({ timestamp: Date.now(), method, file, phase: "rejected", error: "file is outside a ready TypeScript/JavaScript project" }); return undefined; } return this.request(entry, method, params); }
  async notify(file: string, method: string, params: unknown) { const entry = this.projectFor(file); if (!entry || entry.status !== "ready") { this.record({ timestamp: Date.now(), method, file, phase: "rejected", error: "file is outside a ready TypeScript/JavaScript project" }); return false; } await this.send(entry, method, params); return true; }
  workspaceFilesChanged(changes: Change[]) { for (const entry of this.projects.values()) { const relevant = changes.filter((change) => inside(entry.root, resolve(change.path))); if (entry.status === "ready" && relevant.length) void this.send(entry, "workspace/didChangeWatchedFiles", { changes: relevant.map((change) => ({ uri: pathToFileURL(resolve(change.path)).href, type: change.type })) }); } }
}

type WorkerRequest = { args?: unknown[]; changes?: unknown; id?: unknown; method?: unknown; type?: unknown };
type WorkerResponse = { error?: string; id: number; result?: unknown; type: "response" };
if (typeof process.send === "function") {
  let service: TypeScriptService | undefined; const reply = (response: WorkerResponse) => process.send?.(response);
  process.on("message", (message: WorkerRequest) => {
    if (message.type === "workspace-files-changed") { if (service && Array.isArray(message.changes)) service.workspaceFilesChanged(message.changes.flatMap((item): Change[] => { const value = item as { path?: unknown; type?: unknown }; return typeof value?.path === "string" && (value.type === 1 || value.type === 2 || value.type === 3) ? [{ path: value.path, type: value.type }] : []; })); return; }
    if (message.type !== "request" || typeof message.id !== "number" || typeof message.method !== "string") return;
    if (message.method === "shutdown") {
      void (async () => {
        try { if (service) await service.shutdown(); reply({ id: message.id as number, type: "response" }); }
        catch (cause) { reply({ id: message.id as number, error: cause instanceof Error ? cause.message : String(cause), type: "response" }); }
      })();
      return;
    }
    void (async () => { try { if (message.method === "initialize") { const cache = message.args?.[0]; if (typeof cache !== "string") throw new Error("Language worker cache path is required"); const options = message.args?.[1] as { systemTools?: Record<string, { command?: unknown }> } | undefined; service = new TypeScriptService(resolve(cache), (event) => process.send?.({ type: "event", event }), options?.systemTools); reply({ id: message.id, type: "response" }); return; } if (!service) throw new Error("Language worker is not initialized"); const args = message.args ?? []; let result: unknown; switch (message.method) { case "list": result = service.list(); break; case "status": result = service.status(typeof args[0] === "string" ? args[0] : undefined); break; case "load": result = await service.load(String(args[0] ?? "")); break; case "unload": result = await service.unload(String(args[0] ?? "")); break; case "restart": result = await service.restart(String(args[0] ?? "")); break; case "agent": result = await service.agent((args[0] && typeof args[0] === "object" ? args[0] : {}) as Record<string, unknown>); break; case "cancel": service.cancel(); break; case "trace": result = service.trace(); break; case "respondConfirmation": result = service.respondConfirmation(String(args[0] ?? ""), args[1] === true); break; case "lsp": result = await service.lsp(String(args[0] ?? ""), String(args[1] ?? ""), args[2]); break; case "notify": result = await service.notify(String(args[0] ?? ""), String(args[1] ?? ""), args[2]); break; case "debugPrepare": result = await service.debugPrepare(); break; case "debugStatus": result = service.debugStatus(typeof args[0] === "string" ? args[0] : undefined); break; case "debugSessions": result = service.debugSessions(); break; case "debugSelectSession": result = service.debugSelectSession(String(args[0] ?? "")); break; case "debugCloseSession": result = await service.debugCloseSession(String(args[0] ?? "")); break; case "debugDetachSession": result = await service.debugDetachSession(String(args[0] ?? "")); break; case "debugConfigurations": result = await service.debugConfigurations(String(args[0] ?? "")); break; case "debugStart": result = await service.debugStart((args[0] && typeof args[0] === "object" ? args[0] : {}) as DebugStartConfiguration); break; case "debugStop": result = await service.debugStop(typeof args[0] === "string" ? args[0] : undefined); break; case "debugCommand": result = await service.debugCommand(String(args[0] ?? "") as "continue" | "pause" | "next" | "stepIn" | "stepOut", typeof args[1] === "string" ? args[1] : undefined); break; case "debugSetBreakpoints": result = await service.debugSetBreakpoints(String(args[0] ?? ""), Array.isArray(args[1]) ? args[1].filter((item): item is number => typeof item === "number") : []); break; case "debugClearBreakpoints": result = await service.debugClearBreakpoints(); break; case "debugSetFunctionBreakpoints": result = await service.debugSetFunctionBreakpoints(Array.isArray(args[0]) ? args[0].flatMap((item): Array<{ condition?: string; hitCondition?: string; name: string }> => { const value = item && typeof item === "object" ? item as Record<string, unknown> : {}; return typeof value.name === "string" ? [{ name: value.name, ...(typeof value.condition === "string" ? { condition: value.condition } : {}), ...(typeof value.hitCondition === "string" ? { hitCondition: value.hitCondition } : {}) }] : []; }) : []); break; case "debugSetExceptionFilters": result = await service.debugSetExceptionFilters(Array.isArray(args[0]) ? args[0].filter((item): item is string => typeof item === "string") : []); break; case "debugUpdateBreakpoint": result = await service.debugUpdateBreakpoint(String(args[0] ?? ""), Number(args[1]), args[2] && typeof args[2] === "object" ? args[2] as Record<string, unknown> : {}); break; case "debugSetWatches": result = await service.debugSetWatches(Array.isArray(args[0]) ? args[0].filter((item): item is string => typeof item === "string") : []); break; case "debugSelectFrame": result = await service.debugSelectFrame(Number(args[0]), Number(args[1]), typeof args[2] === "string" ? args[2] : undefined); break; case "debugVariables": result = await service.debugVariables(Number(args[0]), typeof args[1] === "string" ? args[1] : undefined); break; case "debugEvaluate": result = await service.debugEvaluate(String(args[0] ?? ""), args[1] === "watch" ? "watch" : "repl", typeof args[2] === "string" ? args[2] : undefined); break; case "debugSetVariable": result = await service.debugSetVariable(Number(args[0]), String(args[1] ?? ""), String(args[2] ?? ""), typeof args[3] === "string" ? args[3] : undefined); break; case "debugReadMemory": result = await service.debugReadMemory(String(args[0] ?? ""), Number(args[1] ?? 0), Number(args[2] ?? 256), typeof args[3] === "string" ? args[3] : undefined); break; case "debugWriteMemory": result = await service.debugWriteMemory(String(args[0] ?? ""), Number(args[1] ?? 0), Array.isArray(args[2]) ? args[2].filter((item): item is number => typeof item === "number") : [], typeof args[3] === "string" ? args[3] : undefined); break; case "debugDisassemble": result = await service.debugDisassemble(String(args[0] ?? ""), Number(args[1] ?? -32), Number(args[2] ?? 64), Number(args[3] ?? 0), typeof args[4] === "string" ? args[4] : undefined); break; case "debugSetInstructionBreakpoints": result = await service.debugSetInstructionBreakpoints(Array.isArray(args[0]) ? args[0].filter((item): item is string => typeof item === "string") : [], typeof args[1] === "string" ? args[1] : undefined); break; case "debugClearOutput": result = service.debugClearOutput(typeof args[0] === "string" ? args[0] : undefined); break; case "debugProcesses": result = service.debugProcesses(); break; case "shutdown": service.shutdown(); break; default: throw new Error(`Unknown language worker method: ${message.method}`); } reply({ id: message.id, result, type: "response" }); } catch (cause) { reply({ id: message.id as number, error: cause instanceof Error ? cause.message : String(cause), type: "response" }); } })();
  });
}
