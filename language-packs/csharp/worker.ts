import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import extractZip from "extract-zip";
import { DebugSessionManager } from "../shared/debug-session-manager.ts";
import type { DebugStartConfiguration } from "../shared/debug-session.ts";
import { stopChildProcess } from "../shared/child-process.ts";
import { fetchWithRetry, withNetworkRetry } from "../shared/download.ts";
import { listDebugProcesses } from "../shared/processes.ts";

export const DOTNET_SDK_VERSION = "10.0.302";
export const CSHARP_LS_VERSION = "0.26.0";
export const NETCOREDBG_VERSION = "3.2.0-1092";
const TOOLCHAIN_MARKER = `dotnet:${DOTNET_SDK_VERSION}\ncsharp-ls:${CSHARP_LS_VERSION}\nnetcoredbg:${NETCOREDBG_VERSION}\n`;

export type CSharpStatus = "preparing" | "starting" | "ready" | "failed" | "stopped";
export type CSharpProject = { error?: string; name: string; root: string; status: CSharpStatus };
export type CSharpTrace = { elapsedMs?: number; error?: string; file?: string; method: string; phase: "request" | "response" | "sent" | "rejected" | "timeout" | "write-error"; timestamp: number };
type Pending = { method: string; reject(error: Error): void; resolve(value: unknown): void; startedAt: number; timeout: ReturnType<typeof setTimeout> };
type Entry = CSharpProject & { child?: ChildProcessWithoutNullStreams; diagnostics: Map<string, unknown[]>; nextId: number; pending: Map<number, Pending>; stderrTail: string; writeQueue: Promise<void> };
type Archive = { asset: string; hash: string; hashAlgorithm: "sha256" | "sha512"; label: string; url: string };
type WorkspaceFileChange = { path: string; type: 1 | 2 | 3 };
type Toolchain = { csharpLs: string; debugger: string; dotnet: string; root: string };

function platformKey(platform: NodeJS.Platform, architecture: string): "linux-x64" | "win-x64" | undefined {
  if (architecture !== "x64") return undefined;
  if (platform === "linux") return "linux-x64";
  if (platform === "win32") return "win-x64";
  return undefined;
}

export function managedArchives(platform: NodeJS.Platform, architecture: string): { csharpLs: Archive; debugger: Archive; sdk: Archive } | undefined {
  const key = platformKey(platform, architecture);
  if (!key) return undefined;
  const sdk = key === "win-x64"
    ? {
        asset: `dotnet-sdk-${DOTNET_SDK_VERSION}-win-x64.zip`,
        hash: "7d170ed75fa9af34c00646621d92011dbd71943952e2787cd15df9be78e6452b55dadef34d7eff77b802e6af4959e071a55855ac649afeac70901c3a2a258716",
        hashAlgorithm: "sha512" as const,
        label: `.NET SDK ${DOTNET_SDK_VERSION}`,
        url: `https://builds.dotnet.microsoft.com/dotnet/Sdk/${DOTNET_SDK_VERSION}/dotnet-sdk-${DOTNET_SDK_VERSION}-win-x64.zip`,
      }
    : {
        asset: `dotnet-sdk-${DOTNET_SDK_VERSION}-linux-x64.tar.gz`,
        hash: "10069bec8783596484a610332f090d562802a41b9b40e3327a5a5688b572e10c296ae300f940d40461f23c157ed1b0843c2f8e6b3f20d8d8d9d83432d8143bac",
        hashAlgorithm: "sha512" as const,
        label: `.NET SDK ${DOTNET_SDK_VERSION}`,
        url: `https://builds.dotnet.microsoft.com/dotnet/Sdk/${DOTNET_SDK_VERSION}/dotnet-sdk-${DOTNET_SDK_VERSION}-linux-x64.tar.gz`,
      };
  return {
    sdk,
    debugger: key === "win-x64" ? {
      asset: "netcoredbg-win64.zip", hash: "3c410a45fa502415203a94fcb88654af65bf8e3dac158a5527a722e7a6b9274a", hashAlgorithm: "sha256", label: `netcoredbg ${NETCOREDBG_VERSION}`,
      url: `https://github.com/Samsung/netcoredbg/releases/download/${NETCOREDBG_VERSION}/netcoredbg-win64.zip`,
    } : {
      asset: "netcoredbg-linux-amd64.tar.gz", hash: "080eb3b2d2152465f599d3b33d1ee6e747794e11cc0a3773ec689f5e5f2c5afa", hashAlgorithm: "sha256", label: `netcoredbg ${NETCOREDBG_VERSION}`,
      url: `https://github.com/Samsung/netcoredbg/releases/download/${NETCOREDBG_VERSION}/netcoredbg-linux-amd64.tar.gz`,
    },
    csharpLs: {
      asset: `csharp-ls.${CSHARP_LS_VERSION}.nupkg`,
      hash: "2b03987aef07bb708bfe56a7bfb370364c7c8203e69aa677a37594bbe21a15b0",
      hashAlgorithm: "sha256",
      label: `csharp-ls ${CSHARP_LS_VERSION}`,
      url: `https://api.nuget.org/v3-flatcontainer/csharp-ls/${CSHARP_LS_VERSION}/csharp-ls.${CSHARP_LS_VERSION}.nupkg`,
    },
  };
}

function inside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
}

export async function directCSharpProjects(root: string): Promise<string[]> {
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && (/\.sln$/iu.test(entry.name) || /\.csproj$/iu.test(entry.name)))
    .map((entry) => join(root, entry.name))
    .sort((left, right) => Number(!/\.sln$/iu.test(left)) - Number(!/\.sln$/iu.test(right)) || left.localeCompare(right));
}

function projectKey(root: string): string {
  return createHash("sha256").update(root).digest("hex");
}

export type PrivateProjectPaths = {
  build: string;
  cliHome: string;
  index: string;
  logs: string;
  msbuildExtensions: string;
  nuget: string;
  obj: string;
  temp: string;
};

export function privateProjectPaths(cachePath: string, root: string): PrivateProjectPaths {
  const base = join(cachePath, "projects", projectKey(resolve(root)));
  return {
    build: join(base, "build"),
    cliHome: join(base, "dotnet-home"),
    index: join(base, "index"),
    logs: join(base, "logs"),
    msbuildExtensions: join(base, "msbuild", "$(MSBuildProjectName)", "extensions"),
    nuget: join(base, "nuget"),
    obj: join(base, "msbuild", "$(MSBuildProjectName)", "obj"),
    temp: join(base, "tmp"),
  };
}

export function privateChildEnvironment(toolchain: Toolchain, paths: PrivateProjectPaths, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const isolated = Object.fromEntries(Object.entries(inherited).filter(([key]) => !new Set(["PATH", "DOTNET_ROOT", "DOTNET_CLI_HOME", "NUGET_PACKAGES", "TEMP", "TMP", "TMPDIR"]).has(key.toLocaleUpperCase("en-US"))));
  return {
    ...isolated,
    PATH: toolchain.root,
    DOTNET_ROOT: toolchain.root,
    DOTNET_CLI_HOME: paths.cliHome,
    NUGET_PACKAGES: paths.nuget,
    DOTNET_MULTILEVEL_LOOKUP: "0",
    DOTNET_NOLOGO: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    DOTNET_CLI_USE_MSBUILD_SERVER: "0",
    MSBUILDDISABLENODEREUSE: "1",
    UseSharedCompilation: "false",
    BaseOutputPath: `${paths.build}${sep}`,
    BaseIntermediateOutputPath: `${paths.obj}${sep}`,
    MSBuildProjectExtensionsPath: `${paths.msbuildExtensions}${sep}`,
    CSHARPLS_CACHE_DIR: paths.index,
    CSHARPLS_LOG_DIR: paths.logs,
    XDG_CACHE_HOME: paths.index,
    TEMP: paths.temp,
    TMP: paths.temp,
    TMPDIR: paths.temp,
  };
}

function outputProperties(paths: PrivateProjectPaths): string[] {
  return [
    `/p:BaseOutputPath=${paths.build}${sep}`,
    `/p:BaseIntermediateOutputPath=${paths.obj}${sep}`,
    `/p:MSBuildProjectExtensionsPath=${paths.msbuildExtensions}${sep}`,
    "/p:UseSharedCompilation=false",
  ];
}

async function prepareProjectPaths(paths: PrivateProjectPaths): Promise<void> {
  await Promise.all(Object.values(paths).map((path) => mkdir(path.replaceAll("$(MSBuildProjectName)", "project"), { recursive: true })));
}

/** Trusted worker implementation. Every generated path is rooted in cachePath. */
export class CSharpService {
  private readonly projects = new Map<string, Entry>();
  private readonly traces: CSharpTrace[] = [];
  private readonly confirmations = new Map<string, { resolve(value: boolean): void; timeout: ReturnType<typeof setTimeout> }>();
  private nextConfirmation = 1;
  private provisioning?: Promise<Toolchain>;
  private provisionAbort?: AbortController;
  private activeCommand?: ReturnType<typeof spawn>;
  private cancellationRequested = false;
  private readonly cachePath: string;
  private readonly emit: (event: Record<string, unknown>) => void;
  private readonly systemDotnet?: string;
  private readonly debug: DebugSessionManager;

  constructor(cachePath: string, emit: (event: Record<string, unknown>) => void, systemTools: Record<string, { command?: unknown }> = {}) {
    this.cachePath = cachePath;
    this.emit = emit;
    this.systemDotnet = typeof systemTools.dotnet?.command === "string" ? systemTools.dotnet.command : undefined;
    this.debug = new DebugSessionManager((snapshot) => this.emit({ type: "language_pack_debug", snapshot }), () => {
      const tools = this.toolchainAt(this.toolchainRoot());
      const command = tools.debugger;
      if (!existsSync(command)) throw new Error("netcoredbg is unavailable. Prepare the C# Language Pack first.");
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !new Set(["PATH", "DOTNET_ROOT", "DOTNET_MULTILEVEL_LOOKUP"]).has(key.toLocaleUpperCase("en-US"))));
      const platformPath = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin";
      return { adapter: "coreclr", args: ["--interpreter=vscode"], command, env: { ...inherited, DOTNET_ROOT: tools.root, DOTNET_MULTILEVEL_LOOKUP: "0", PATH: `${tools.root}${delimiter}${platformPath}` } };
    });
  }

  private public(entry: Entry): CSharpProject {
    return { root: entry.root, name: entry.name, status: entry.status, ...(entry.error ? { error: entry.error } : {}) };
  }
  private publish(entry: Entry): void { this.emit({ type: "language_pack_project", project: this.public(entry) }); }
  private record(item: CSharpTrace): void { this.traces.push(item); if (this.traces.length > 200) this.traces.splice(0, this.traces.length - 200); }
  list(): CSharpProject[] { return [...this.projects.values()].map((entry) => this.public(entry)); }
  trace(): CSharpTrace[] { return [...this.traces]; }

  async status(rootInput?: string): Promise<CSharpProject | CSharpProject[]> {
    if (!rootInput) return this.list();
    const root = await realpath(rootInput).catch(() => resolve(rootInput));
    const entry = this.projects.get(root);
    return entry ? this.public(entry) : { root, name: basename(root), status: "stopped" };
  }

  private entryFor(file: string): Entry | undefined {
    const canonical = resolve(file);
    return [...this.projects.values()].filter((entry) => inside(entry.root, canonical)).sort((a, b) => b.root.length - a.root.length)[0];
  }

  async load(rootInput: string): Promise<CSharpProject> {
    const root = await realpath(rootInput);
    const existing = this.projects.get(root);
    if (existing) return this.public(existing);
    const markers = await directCSharpProjects(root);
    if (!markers.length) throw new Error("C# project root must contain a .sln or .csproj direct child");
    const entry: Entry = { root, name: basename(root), status: "preparing", diagnostics: new Map(), nextId: 1, pending: new Map(), stderrTail: "", writeQueue: Promise.resolve() };
    this.projects.set(root, entry);
    this.cancellationRequested = false;
    this.publish(entry);
    try {
      const toolchain = await this.managedToolchain();
      const paths = privateProjectPaths(this.cachePath, root);
      await prepareProjectPaths(paths);
      await this.start(entry, toolchain, paths, markers[0]!);
      return this.public(entry);
    } catch (cause) {
      if (this.cancellationRequested) {
        this.projects.delete(root);
        this.emit({ type: "language_pack_project_removed", root });
        return { root, name: basename(root), status: "stopped" };
      }
      entry.status = "failed";
      entry.error = cause instanceof Error ? cause.message : String(cause);
      this.publish(entry);
      this.emit({ type: "language_pack_progress", stage: "failed", error: entry.error, detail: entry.error });
      return this.public(entry);
    }
  }

  async unload(rootInput: string): Promise<void> {
    const root = await realpath(rootInput).catch(() => resolve(rootInput));
    const entry = this.projects.get(root);
    if (!entry) return;
    await this.stop(entry);
    this.projects.delete(root);
    this.emit({ type: "language_pack_project_removed", root });
  }
  async restart(root: string): Promise<CSharpProject> { await this.unload(root); return this.load(root); }

  cancel(): void {
    this.cancellationRequested = true;
    this.rejectConfirmations();
    this.provisionAbort?.abort();
    this.activeCommand?.kill();
  }

  respondConfirmation(id: string, confirmed: boolean): boolean {
    const pending = this.confirmations.get(id);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    this.confirmations.delete(id);
    pending.resolve(confirmed);
    return true;
  }

  async build(rootInput: string, relativePathInput?: string): Promise<Record<string, unknown>> {
    const workspace = await realpath(rootInput);
    const selected = relativePathInput ? resolve(workspace, relativePathInput) : workspace;
    if (!inside(workspace, selected)) throw new Error("C# build path is outside the workspace");
    const root = await realpath(selected);
    if (!inside(workspace, root)) throw new Error("C# build path resolves outside the workspace");
    const markers = await directCSharpProjects(root);
    if (!markers.length) throw new Error("C# build root must contain a .sln or .csproj direct child");
    const toolchain = await this.managedToolchain();
    const paths = privateProjectPaths(this.cachePath, root);
    await prepareProjectPaths(paths);
    const args = ["build", markers[0]!, "--nologo", "--disable-build-servers", ...outputProperties(paths)];
    const started = Date.now(); const result = await this.run(toolchain.dotnet, args, root, privateChildEnvironment(toolchain, paths), "building");
    return { private: true, command: toolchain.dotnet, args, cwd: root, ...result, artifacts: [paths.build], durationMs: Date.now() - started, cancelled: this.cancellationRequested, outputPath: paths.build, intermediateOutputPath: paths.obj, nugetPackages: paths.nuget };
  }

  async agent(input: Record<string, unknown>): Promise<unknown> {
    const action = String(input.action ?? ""); const workspace = typeof input.workspace === "string" ? input.workspace : undefined;
    if (action === "project.list") return this.list();
    if (action === "debug.stop") return this.debug.stop(typeof input.sessionId === "string" ? input.sessionId : undefined);
    if (!workspace && action !== "project.list") throw new Error("workspace is required");
    if (action === "project.load") return this.load(workspace!);
    if (action === "project.status") return this.status(workspace);
    if (action === "project.restart") return this.restart(workspace!);
    if (action === "project.unload") return this.unload(workspace!);
    if (action === "build" || action === "test" || action === "run") return this.dotnetAction(workspace!, action, typeof input.project === "string" ? input.project : undefined);
    if (action === "debug.configurations") return this.debugConfigurations(workspace!);
    if (action === "debug.start" || action === "debug.attach") return this.debugStart({ root: workspace!, mode: action === "debug.attach" ? "attach" : "launch", ...(typeof input.processId === "number" ? { processId: input.processId } : {}), ...(typeof input.program === "string" ? { program: resolve(workspace!, input.program) } : {}), args: Array.isArray(input.args) ? input.args.filter((item): item is string => typeof item === "string") : [] });
    if (!action.startsWith("language.")) throw new Error(`Unsupported C# Language Pack action: ${action}`);
    const entry = this.projects.get(resolve(workspace!));
    if (!entry || entry.status !== "ready") throw new Error("C# project is not ready");
    if (action === "language.diagnostics") return [...entry.diagnostics.entries()].map(([file, diagnostics]) => ({ file, diagnostics }));
    const file = typeof input.file === "string" ? resolve(workspace!, input.file) : undefined;
    const uri = file ? pathToFileURL(file).href : undefined; const position = input.position;
    const textDocument = uri ? { uri } : undefined;
    const methods: Record<string, [string, unknown]> = {
      "language.definition": ["textDocument/definition", { textDocument, position }],
      "language.references": ["textDocument/references", { textDocument, position, context: { includeDeclaration: true } }],
      "language.hover": ["textDocument/hover", { textDocument, position }],
      "language.completion": ["textDocument/completion", { textDocument, position }],
      "language.rename": ["textDocument/rename", { textDocument, position, newName: input.newName }],
      "language.format": ["textDocument/formatting", { textDocument, options: { insertSpaces: true, tabSize: 4 } }],
      "language.symbols": file ? ["textDocument/documentSymbol", { textDocument }] : ["workspace/symbol", { query: typeof input.query === "string" ? input.query : "" }],
    };
    const target = methods[action]; if (!target) throw new Error(`Unsupported C# semantic action: ${action}`);
    return this.lsp(file ?? join(workspace!, "__workspace__.cs"), target[0], target[1]);
  }

  private async dotnetAction(rootInput: string, action: "build" | "run" | "test", relativePathInput?: string): Promise<Record<string, unknown>> {
    if (action === "build") return this.build(rootInput, relativePathInput);
    const root = await realpath(rootInput); const selected = relativePathInput ? resolve(root, relativePathInput) : root;
    if (!inside(root, selected)) throw new Error("C# action path is outside the workspace");
    const markers = await directCSharpProjects(selected); if (!markers.length) throw new Error("C# action root must contain a .sln or .csproj direct child");
    const toolchain = await this.managedToolchain(); const paths = privateProjectPaths(this.cachePath, selected); await prepareProjectPaths(paths);
    const args = [action, markers[0]!, "--nologo", ...(action === "test" ? ["--disable-build-servers"] : []), ...outputProperties(paths)]; const started = Date.now();
    const result = await this.run(toolchain.dotnet, args, selected, privateChildEnvironment(toolchain, paths), action === "test" ? "testing" : "running");
    return { private: true, command: toolchain.dotnet, args, cwd: selected, ...result, artifacts: [paths.build], durationMs: Date.now() - started, cancelled: this.cancellationRequested };
  }

  async lsp(file: string, method: string, params: unknown): Promise<unknown> {
    const entry = this.entryFor(file);
    if (!entry?.child || entry.status !== "ready") {
      this.record({ file, method, phase: "rejected", timestamp: Date.now(), error: `csharp-ls status is ${entry?.status ?? "unavailable"}` });
      return undefined;
    }
    await entry.writeQueue;
    try { return await this.request(entry, method, params); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!/(method not found|request cancelled)/iu.test(message)) throw cause;
      if (method === "textDocument/completion") return { items: [] };
      if (method === "textDocument/definition" || method === "textDocument/references") return [];
      if (method === "textDocument/hover") return null;
      return undefined;
    }
  }

  notify(file: string, method: string, params: unknown): Promise<boolean> {
    const entry = this.entryFor(file);
    if (!entry) { this.record({ file, method, phase: "rejected", timestamp: Date.now(), error: "file is outside loaded C# projects" }); return Promise.resolve(false); }
    return this.notification(entry, method, params);
  }

  async debugPrepare(): Promise<void> { await this.managedToolchain(); }
  debugStatus(sessionId?: string) { return this.debug.status(sessionId); }
  debugSessions() { return this.debug.list(); }
  debugSelectSession(sessionId: string) { return this.debug.select(sessionId); }
  debugCloseSession(sessionId: string) { return this.debug.close(sessionId); }
  debugDetachSession(sessionId: string) { return this.debug.detach(sessionId); }
  async debugConfigurations(rootInput: string): Promise<Array<{ built: true; id: string; name: string; program: string }>> {
    const root = await realpath(rootInput);
    await this.build(root);
    const output = privateProjectPaths(this.cachePath, root).build;
    const files = await readdir(output, { recursive: true });
    return files.filter((file) => typeof file === "string" && /\.dll$/iu.test(file) && !/(?:^|[\\/])(?:ref|refint)(?:[\\/]|$)|testhost|\.resources\.dll$/iu.test(file))
      .map((file) => ({ built: true as const, id: file.replaceAll("\\", "/"), name: basename(file, ".dll"), program: join(output, file) }));
  }
  async debugStart(configuration: DebugStartConfiguration & { targetId?: string; sessionName?: string }) {
    await this.debugPrepare();
    const root = await realpath(configuration.root);
    let program = configuration.program;
    if (configuration.mode !== "attach" && configuration.targetId) {
      const target = (await this.debugConfigurations(root)).find(({ id }) => id === configuration.targetId);
      if (!target) throw new Error("The selected .NET debug target is unavailable");
      program = target.program;
    }
    return this.debug.start({ ...configuration, root, ...(program ? { program } : {}) }, [privateProjectPaths(this.cachePath, root).build]);
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

  workspaceFilesChanged(changes: WorkspaceFileChange[]): void {
    for (const entry of this.projects.values()) {
      const relevant = changes.filter((change) => inside(entry.root, resolve(change.path)));
      if (!relevant.length || entry.status !== "ready") continue;
      void this.notification(entry, "workspace/didChangeWatchedFiles", { changes: relevant.map((change) => ({ uri: pathToFileURL(resolve(change.path)).href, type: change.type })) });
    }
  }

  async shutdown(): Promise<void> {
    this.cancel();
    this.debug.shutdown();
    await Promise.all([...this.projects.values()].map((entry) => this.stop(entry)));
    this.projects.clear();
  }

  private async stop(entry: Entry): Promise<void> {
    const child = entry.child;
    if (!child) { entry.status = "stopped"; return; }
    try { await Promise.race([this.request(entry, "shutdown", null), new Promise((resolveWait) => setTimeout(resolveWait, 1_000))]); } catch { /* force termination below */ }
    await this.notification(entry, "exit", null).catch(() => false);
    entry.status = "stopped";
    for (const pending of entry.pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error("csharp-ls stopped")); }
    entry.pending.clear();
    await stopChildProcess(child, "csharp-ls");
    if (entry.child === child) entry.child = undefined;
  }

  private notification(entry: Entry, method: string, params: unknown): Promise<boolean> {
    const write = entry.writeQueue.catch(() => undefined).then(() => new Promise<boolean>((resolveWrite) => {
      if (!entry.child || entry.child.killed || !entry.child.stdin.writable) { this.record({ method, phase: "rejected", timestamp: Date.now(), error: "csharp-ls stdin is unavailable" }); resolveWrite(false); return; }
      const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
      entry.child.stdin.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`, (cause) => {
        this.record({ method, phase: cause ? "write-error" : "sent", timestamp: Date.now(), ...(cause ? { error: String(cause) } : {}) });
        resolveWrite(!cause);
      });
    }));
    entry.writeQueue = write.then(() => undefined);
    return write;
  }

  private request(entry: Entry, method: string, params: unknown): Promise<unknown> {
    if (!entry.child || entry.child.killed || !entry.child.stdin.writable) return Promise.reject(new Error("csharp-ls is not running"));
    const id = entry.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const startedAt = Date.now();
    return new Promise((resolveRequest, reject) => {
      const timeout = setTimeout(() => {
        entry.pending.delete(id);
        const error = `csharp-ls request timed out (${method})${entry.stderrTail ? `\n${entry.stderrTail}` : ""}`;
        this.record({ method, phase: "timeout", timestamp: Date.now(), elapsedMs: Date.now() - startedAt, error });
        reject(new Error(error));
      }, method === "initialize" ? 30_000 : 10_000);
      entry.pending.set(id, { method, reject, resolve: resolveRequest, startedAt, timeout });
      this.record({ method, phase: "request", timestamp: startedAt });
      entry.child!.stdin.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`, (cause) => {
        if (!cause) return;
        clearTimeout(timeout); entry.pending.delete(id);
        this.record({ method, phase: "write-error", timestamp: Date.now(), error: String(cause) });
        reject(cause);
      });
    });
  }

  private async start(entry: Entry, toolchain: Toolchain, paths: PrivateProjectPaths, marker: string): Promise<void> {
    entry.status = "starting"; this.publish(entry);
    const environment = privateChildEnvironment(toolchain, paths);
    const args = [toolchain.csharpLs, ...(/\.sln$/iu.test(marker) ? ["--solution", marker] : [])];
    const child = spawn(toolchain.dotnet, args, { cwd: entry.root, env: environment, stdio: "pipe", windowsHide: true });
    entry.child = child;
    let buffer = Buffer.alloc(0);
    const fail = (cause: unknown) => {
      if (entry.status === "stopped" || entry.status === "failed") return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      entry.status = "failed"; entry.error = error.message; this.publish(entry);
      for (const pending of entry.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
      entry.pending.clear(); child.kill();
    };
    child.stderr.on("data", (data: Buffer) => { entry.stderrTail = `${entry.stderrTail}${data.toString("utf8")}`.slice(-16_384); });
    child.stdout.on("data", (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      for (;;) {
        const headerEnd = buffer.indexOf("\r\n\r\n"); if (headerEnd < 0) break;
        const lengthText = /Content-Length:\s*(\d+)/iu.exec(buffer.subarray(0, headerEnd).toString("ascii"))?.[1];
        if (!lengthText) { buffer = buffer.subarray(headerEnd + 4); continue; }
        const start = headerEnd + 4; const end = start + Number(lengthText); if (buffer.length < end) break;
        const body = buffer.subarray(start, end).toString("utf8"); buffer = buffer.subarray(end);
        try { this.handleMessage(entry, JSON.parse(body) as Record<string, unknown>); }
        catch (cause) { fail(new Error(`Invalid csharp-ls response: ${cause instanceof Error ? cause.message : String(cause)}`)); }
      }
    });
    child.once("error", fail);
    child.once("close", (code) => { if (entry.status !== "stopped" && entry.status !== "failed") fail(new Error(`csharp-ls exited with code ${code}`)); });
    await this.request(entry, "initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(entry.root).href,
      workspaceFolders: [{ name: entry.name, uri: pathToFileURL(entry.root).href }],
      capabilities: {
        workspace: { symbol: {}, workspaceFolders: true, didChangeWatchedFiles: { dynamicRegistration: false } },
        textDocument: {
          completion: { completionItem: { snippetSupport: true } },
          definition: { linkSupport: true }, references: {}, hover: {}, documentSymbol: {}, publishDiagnostics: { relatedInformation: true },
          rename: { prepareSupport: true }, formatting: {}, rangeFormatting: {},
        },
      },
      initializationOptions: { cacheDirectory: paths.index, logDirectory: paths.logs },
    });
    await this.notification(entry, "initialized", {});
    entry.status = "ready"; this.publish(entry);
    this.emit({ type: "language_pack_progress", stage: "ready", detail: "C# language service is ready" });
  }

  private handleMessage(entry: Entry, message: Record<string, unknown>): void {
    const method = typeof message.method === "string" ? message.method : undefined;
    const params = message.params && typeof message.params === "object" ? message.params as Record<string, unknown> : undefined;
    if (method === "textDocument/publishDiagnostics" && typeof params?.uri === "string" && Array.isArray(params.diagnostics)) {
      try { const file = fileURLToPath(params.uri); entry.diagnostics.set(file, params.diagnostics); this.emit({ type: "language_pack_diagnostics", file, diagnostics: params.diagnostics }); } catch { /* reject malformed URI */ }
      return;
    }
    if (typeof message.id === "number" && method) {
      const items = method === "workspace/configuration" && Array.isArray(params?.items) ? params.items : [];
      const result = method === "workspace/configuration"
        ? items.map(() => ({}))
        : method === "workspace/workspaceFolders"
          ? [{ name: entry.name, uri: pathToFileURL(entry.root).href }]
          : null;
      const response = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
      entry.child?.stdin.write(`Content-Length: ${Buffer.byteLength(response)}\r\n\r\n${response}`);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = entry.pending.get(message.id); if (!pending) return;
    entry.pending.delete(message.id); clearTimeout(pending.timeout);
    const error = message.error && typeof message.error === "object" ? String((message.error as { message?: unknown }).message ?? "csharp-ls error") : undefined;
    this.record({ method: pending.method, phase: "response", timestamp: Date.now(), elapsedMs: Date.now() - pending.startedAt, ...(error ? { error } : {}) });
    error ? pending.reject(new Error(error)) : pending.resolve(message.result);
  }

  private toolchainRoot(): string { return join(this.cachePath, "toolchains", platformKey(process.platform, process.arch) ?? "unsupported", `${DOTNET_SDK_VERSION}-csharp-ls-${CSHARP_LS_VERSION}`); }
  private toolchainAt(root: string): Toolchain {
    const dotnet = this.systemDotnet ?? join(root, "dotnet", process.platform === "win32" ? "dotnet.exe" : "dotnet");
    return { root: dirname(dotnet), dotnet, csharpLs: join(root, "csharp-ls", "tools", "net10.0", "any", "CSharpLanguageServer.dll"), debugger: join(root, "netcoredbg", "netcoredbg", process.platform === "win32" ? "netcoredbg.exe" : "netcoredbg") };
  }
  private toolchainMarker(): string { return `${TOOLCHAIN_MARKER}source=${this.systemDotnet ? `system:${this.systemDotnet}` : "private"}\n`; }
  private async toolchainFilesUsable(root: string): Promise<boolean> {
    const tools = this.toolchainAt(root);
    return await readFile(join(root, ".agent-k-csharp-tools"), "utf8").catch(() => "") === this.toolchainMarker() && existsSync(tools.dotnet) && existsSync(tools.csharpLs) && existsSync(tools.debugger);
  }

  private async managedToolchain(): Promise<Toolchain> {
    const root = this.toolchainRoot();
    if (await this.toolchainFilesUsable(root)) return this.toolchainAt(root);
    this.provisionAbort ??= new AbortController();
    this.provisioning ??= this.provision(root, this.provisionAbort.signal).finally(() => { this.provisioning = undefined; this.provisionAbort = undefined; });
    return this.provisioning;
  }

  private async provision(root: string, signal: AbortSignal): Promise<Toolchain> {
    const archives = managedArchives(process.platform, process.arch);
    if (!archives) throw new Error("Automatic C# toolchain installation supports Windows x64 and Linux x64 only");
    const archiveDirectory = join(this.cachePath, "archives");
    await mkdir(archiveDirectory, { recursive: true });
    const missing: Archive[] = [];
    const requiredArchives = this.systemDotnet ? [archives.csharpLs, archives.debugger] : [archives.sdk, archives.csharpLs, archives.debugger];
    for (const archive of requiredArchives) if (!await this.archiveMatches(join(archiveDirectory, archive.asset), archive)) missing.push(archive);
    if (missing.length && !await this.confirmDownload(missing)) { this.cancellationRequested = true; throw new Error("C# toolchain download was not approved"); }
    signal.throwIfAborted();
    for (const archive of requiredArchives) await this.download(archive, archiveDirectory, signal);

    const staging = `${root}.staging-${process.pid}-${Date.now()}`;
    await mkdir(dirname(root), { recursive: true });
    await rm(staging, { recursive: true, force: true });
    await Promise.all([mkdir(join(staging, "dotnet"), { recursive: true }), mkdir(join(staging, "csharp-ls"), { recursive: true }), mkdir(join(staging, "netcoredbg"), { recursive: true })]);
    if (!this.systemDotnet) { this.emit({ type: "language_pack_progress", stage: "extracting", detail: `Extracting .NET SDK ${DOTNET_SDK_VERSION}` }); await this.extract(join(archiveDirectory, archives.sdk.asset), join(staging, "dotnet")); }
    this.emit({ type: "language_pack_progress", stage: "extracting", detail: `Extracting csharp-ls ${CSHARP_LS_VERSION}` });
    await extractZip(join(archiveDirectory, archives.csharpLs.asset), { dir: join(staging, "csharp-ls") });
    this.emit({ type: "language_pack_progress", stage: "extracting", detail: `Extracting netcoredbg ${NETCOREDBG_VERSION}` });
    await this.extract(join(archiveDirectory, archives.debugger.asset), join(staging, "netcoredbg"));
    const staged = this.toolchainAt(staging);
    if (!existsSync(staged.dotnet) || !existsSync(staged.csharpLs) || !existsSync(staged.debugger)) throw new Error("Provisioned C# toolchain is incomplete");
    if (process.platform !== "win32") { if (!this.systemDotnet) await chmod(staged.dotnet, 0o755); await chmod(staged.debugger, 0o755); }
    await writeFile(join(staging, ".agent-k-csharp-tools"), this.toolchainMarker(), "utf8");

    // No runtime process is started from staging. Switch first, then construct
    // a fresh environment using only final paths and run both final probes.
    const previous = existsSync(root) ? `${root}.previous-${Date.now()}` : undefined;
    if (previous) await rename(root, previous);
    await rename(staging, root);
    try {
      const finalTools = this.toolchainAt(root);
      await this.probe(finalTools, ["--version"], DOTNET_SDK_VERSION);
      await this.probe(finalTools, [finalTools.csharpLs, "--version"], CSHARP_LS_VERSION);
      const debugProbe = await this.run(finalTools.debugger, ["--version"], this.cachePath, privateChildEnvironment(finalTools, privateProjectPaths(this.cachePath, join(this.cachePath, "probe"))), "preparing");
      if (debugProbe.code !== 0 || !`${debugProbe.stdout}\n${debugProbe.stderr}`.includes("3.2.0")) throw new Error("netcoredbg version probe failed");
      this.emit({ type: "language_pack_progress", stage: "ready", detail: `${this.systemDotnet ? "Compatible system" : "Private"} .NET ${DOTNET_SDK_VERSION} and private csharp-ls ${CSHARP_LS_VERSION} are ready` });
      return finalTools;
    } catch (cause) {
      const failed = `${root}.failed-${Date.now()}`;
      await rename(root, failed).catch(() => undefined);
      if (previous) await rename(previous, root);
      throw new Error(`Post-switch C# toolchain probe failed; previous toolchain restored: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  private async probe(toolchain: Toolchain, args: string[], expected: string): Promise<void> {
    const paths = privateProjectPaths(this.cachePath, join(this.cachePath, "probe"));
    await prepareProjectPaths(paths);
    const result = await this.run(toolchain.dotnet, args, this.cachePath, privateChildEnvironment(toolchain, paths), "preparing");
    if (result.code !== 0 || !`${result.stdout}\n${result.stderr}`.includes(expected)) throw new Error(`Version probe did not report ${expected}`);
  }

  private async confirmDownload(archives: Archive[]): Promise<boolean> {
    const requestId = `csharp-toolchain-${this.nextConfirmation++}`;
    return new Promise<boolean>((resolveConfirmation) => {
      const timeout = setTimeout(() => { this.confirmations.delete(requestId); resolveConfirmation(false); }, 120_000);
      this.confirmations.set(requestId, { resolve: resolveConfirmation, timeout });
      this.emit({
        type: "language_pack_confirmation_request", requestId,
        title: "Download private C# tools",
        message: `Agent K needs ${archives.map((archive) => archive.label).join(" and ")}. Downloads, tools, NuGet packages, indexes, logs, temporary files, and build output stay below the Agent K language cache. Nothing is installed globally.`,
      });
    });
  }
  private rejectConfirmations(): void { for (const pending of this.confirmations.values()) { clearTimeout(pending.timeout); pending.resolve(false); } this.confirmations.clear(); }

  private async archiveMatches(path: string, archive: Archive): Promise<boolean> {
    if (!existsSync(path)) return false;
    try { const hash = createHash(archive.hashAlgorithm); await pipeline(createReadStream(path), hash); return hash.digest("hex") === archive.hash; } catch { return false; }
  }

  private async download(archive: Archive, directory: string, signal: AbortSignal): Promise<void> {
    const target = join(directory, archive.asset);
    if (await this.archiveMatches(target, archive)) { const bytes = (await stat(target)).size; this.emit({ type: "language_pack_progress", stage: "downloading", tool: archive.label, bytes, total: bytes, rate: 0, detail: `${archive.asset} (verified cache)` }); return; }
    await rm(target, { force: true });
    const partial = `${target}.partial`;
    await withNetworkRetry(async () => {
      await rm(partial, { force: true });
      const response = await fetchWithRetry(archive.url, { headers: { "User-Agent": "Agent-K" }, signal });
      if (!response.ok || !response.body) throw new Error(`Unable to download ${archive.label} (${response.status})`);
      const total = Number(response.headers.get("content-length") ?? 0); let bytes = 0; const started = Date.now();
      const reader = response.body.getReader();
      const stream = new Readable({ read() { void reader.read().then((next) => { if (next.done) this.push(null); else { bytes += next.value.byteLength; const seconds = Math.max(0.001, (Date.now() - started) / 1_000); this.push(Buffer.from(next.value)); } }).catch((cause) => this.destroy(cause)); } });
      const progress = setInterval(() => this.emit({ type: "language_pack_progress", stage: "downloading", tool: archive.label, bytes, total, rate: Math.round(bytes / Math.max(0.001, (Date.now() - started) / 1_000)), detail: archive.asset }), 250);
      const abort = () => { void reader.cancel().catch(() => undefined); stream.destroy(new Error("C# project load cancelled")); };
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      try { await pipeline(stream, createWriteStream(partial)); } finally { clearInterval(progress); signal.removeEventListener("abort", abort); }
      if (!await this.archiveMatches(partial, archive)) { await rm(partial, { force: true }); throw new Error(`Pinned digest verification failed for ${archive.label}`); }
      await rename(partial, target);
    }, signal);
  }

  private async extract(archive: string, destination: string): Promise<void> {
    if (/\.zip$/iu.test(archive)) { await extractZip(archive, { dir: destination }); return; }
    const result = await this.run("/usr/bin/tar", ["-I", "/usr/bin/gzip", "-xf", archive, "-C", destination], destination, { PATH: "/usr/bin:/bin", LANG: process.env.LANG ?? "C" }, "extracting");
    if (result.code !== 0) throw new Error(result.stderr || "Unable to extract .NET SDK archive");
  }

  private run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, stage: string): Promise<{ code: number; stderr: string; stdout: string }> {
    return new Promise((resolveRun, reject) => {
      const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      this.activeCommand = child;
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (data: Buffer) => { stdout += data.toString("utf8"); this.emit({ type: "language_pack_progress", stage, detail: data.toString("utf8") }); });
      child.stderr.on("data", (data: Buffer) => { stderr += data.toString("utf8"); this.emit({ type: "language_pack_progress", stage, detail: data.toString("utf8") }); });
      child.once("error", reject);
      child.once("close", (code) => { if (this.activeCommand === child) this.activeCommand = undefined; resolveRun({ code: code ?? -1, stdout, stderr }); });
    });
  }
}

type WorkerRequest = { args?: unknown[]; changes?: unknown; id?: unknown; method?: unknown; type?: unknown };
type WorkerResponse = { error?: string; id: number; result?: unknown; type: "response" };

if (typeof process.send === "function") {
  let service: CSharpService | undefined;
  const reply = (response: WorkerResponse) => process.send?.(response);
  process.on("message", (message: WorkerRequest) => {
    if (message.type === "workspace-files-changed") {
      if (!service || !Array.isArray(message.changes)) return;
      service.workspaceFilesChanged(message.changes.flatMap((change): WorkspaceFileChange[] => {
        if (!change || typeof change !== "object") return [];
        const value = change as { path?: unknown; type?: unknown };
        return typeof value.path === "string" && (value.type === 1 || value.type === 2 || value.type === 3) ? [{ path: value.path, type: value.type }] : [];
      }));
      return;
    }
    if (message.type !== "request" || typeof message.id !== "number" || typeof message.method !== "string") return;
    void (async () => {
      try {
        if (message.method === "initialize") {
          const cachePath = message.args?.[0]; if (typeof cachePath !== "string") throw new Error("Language worker cache path is required");
          const options = message.args?.[1] as { systemTools?: Record<string, { command?: unknown }> } | undefined;
          service = new CSharpService(cachePath, (event) => process.send?.({ type: "event", event }), options?.systemTools);
          reply({ type: "response", id: message.id, result: undefined }); return;
        }
        if (!service) throw new Error("Language worker is not initialized");
        const args = message.args ?? []; let result: unknown;
        switch (message.method) {
          case "list": result = service.list(); break;
          case "load": result = await service.load(String(args[0] ?? "")); break;
          case "status": result = await service.status(typeof args[0] === "string" ? args[0] : undefined); break;
          case "unload": result = await service.unload(String(args[0] ?? "")); break;
          case "restart": result = await service.restart(String(args[0] ?? "")); break;
          case "cancel": service.cancel(); break;
          case "trace": result = service.trace(); break;
          case "respondConfirmation": result = service.respondConfirmation(String(args[0] ?? ""), args[1] === true); break;
          case "build": result = await service.build(String(args[0] ?? ""), typeof args[1] === "string" ? args[1] : undefined); break;
          case "agent": result = await service.agent((args[0] && typeof args[0] === "object" ? args[0] : {}) as Record<string, unknown>); break;
          case "lsp": result = await service.lsp(String(args[0] ?? ""), String(args[1] ?? ""), args[2]); break;
          case "notify": result = await service.notify(String(args[0] ?? ""), String(args[1] ?? ""), args[2]); break;
          case "debugPrepare": result = await service.debugPrepare(); break;
          case "debugStatus": result = service.debugStatus(typeof args[0] === "string" ? args[0] : undefined); break;
          case "debugSessions": result = service.debugSessions(); break;
          case "debugSelectSession": result = service.debugSelectSession(String(args[0] ?? "")); break;
          case "debugCloseSession": result = await service.debugCloseSession(String(args[0] ?? "")); break;
          case "debugDetachSession": result = await service.debugDetachSession(String(args[0] ?? "")); break;
          case "debugConfigurations": result = await service.debugConfigurations(String(args[0] ?? "")); break;
          case "debugStart": result = await service.debugStart((args[0] && typeof args[0] === "object" ? args[0] : {}) as DebugStartConfiguration); break;
          case "debugStop": result = await service.debugStop(typeof args[0] === "string" ? args[0] : undefined); break;
          case "debugCommand": result = await service.debugCommand(String(args[0] ?? "") as "continue" | "pause" | "next" | "stepIn" | "stepOut", typeof args[1] === "string" ? args[1] : undefined); break;
          case "debugSetBreakpoints": result = await service.debugSetBreakpoints(String(args[0] ?? ""), Array.isArray(args[1]) ? args[1].filter((item): item is number => typeof item === "number") : []); break;
          case "debugClearBreakpoints": result = await service.debugClearBreakpoints(); break;
          case "debugSetFunctionBreakpoints": result = await service.debugSetFunctionBreakpoints(Array.isArray(args[0]) ? args[0].flatMap((item): Array<{ condition?: string; hitCondition?: string; name: string }> => { const value = item && typeof item === "object" ? item as Record<string, unknown> : {}; return typeof value.name === "string" ? [{ name: value.name, ...(typeof value.condition === "string" ? { condition: value.condition } : {}), ...(typeof value.hitCondition === "string" ? { hitCondition: value.hitCondition } : {}) }] : []; }) : []); break;
          case "debugSetExceptionFilters": result = await service.debugSetExceptionFilters(Array.isArray(args[0]) ? args[0].filter((item): item is string => typeof item === "string") : []); break;
          case "debugUpdateBreakpoint": result = await service.debugUpdateBreakpoint(String(args[0] ?? ""), Number(args[1]), args[2] && typeof args[2] === "object" ? args[2] as Record<string, unknown> : {}); break;
          case "debugSetWatches": result = await service.debugSetWatches(Array.isArray(args[0]) ? args[0].filter((item): item is string => typeof item === "string") : []); break;
          case "debugSelectFrame": result = await service.debugSelectFrame(Number(args[0]), Number(args[1]), typeof args[2] === "string" ? args[2] : undefined); break;
          case "debugVariables": result = await service.debugVariables(Number(args[0]), typeof args[1] === "string" ? args[1] : undefined); break;
          case "debugEvaluate": result = await service.debugEvaluate(String(args[0] ?? ""), args[1] === "watch" ? "watch" : "repl", typeof args[2] === "string" ? args[2] : undefined); break;
          case "debugSetVariable": result = await service.debugSetVariable(Number(args[0]), String(args[1] ?? ""), String(args[2] ?? ""), typeof args[3] === "string" ? args[3] : undefined); break;
          case "debugReadMemory": result = await service.debugReadMemory(String(args[0] ?? ""), Number(args[1] ?? 0), Number(args[2] ?? 256), typeof args[3] === "string" ? args[3] : undefined); break;
          case "debugWriteMemory": result = await service.debugWriteMemory(String(args[0] ?? ""), Number(args[1] ?? 0), Array.isArray(args[2]) ? args[2].filter((item): item is number => typeof item === "number") : [], typeof args[3] === "string" ? args[3] : undefined); break;
          case "debugDisassemble": result = await service.debugDisassemble(String(args[0] ?? ""), Number(args[1] ?? -32), Number(args[2] ?? 64), Number(args[3] ?? 0), typeof args[4] === "string" ? args[4] : undefined); break;
          case "debugSetInstructionBreakpoints": result = await service.debugSetInstructionBreakpoints(Array.isArray(args[0]) ? args[0].filter((item): item is string => typeof item === "string") : [], typeof args[1] === "string" ? args[1] : undefined); break;
          case "debugClearOutput": result = service.debugClearOutput(typeof args[0] === "string" ? args[0] : undefined); break;
          case "debugProcesses": result = service.debugProcesses(); break;
          case "shutdown": result = await service.shutdown(); break;
          default: throw new Error(`Unknown language worker method: ${message.method}`);
        }
        reply({ type: "response", id: message.id, result });
      } catch (cause) { reply({ type: "response", id: message.id, error: cause instanceof Error ? cause.message : String(cause) }); }
    })();
  });
}
