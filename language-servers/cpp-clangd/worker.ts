import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import extractZip from "extract-zip";
import {
  cachedCompilationDatabase,
  cmakeConfigurationSnapshot,
  describeCompilationDatabase,
  findProjectCompilationDatabase,
  isCMakeConfigurationPath,
  prepareClangdCompilationDatabase,
  privateClangdIndexDirectory,
  recordCompilationDatabase,
} from "./cmake-cache.js";
import { DEFAULT_VSWHERE_PATH, managedDebuggerArchive, managedDebuggerMarker, managedToolchainArchives, managedToolchainMarker, parseWindowsEnvironment, toolchainArchiveFormat } from "./toolchain.js";
import { selectWorkspaceSymbols, symbolLocation, type SkillLocation as LspLocation, type SkillRange as Range, type SkillSymbol as LspSymbol } from "./skill-symbols.js";
import { languageSkillStatusState, languageSkillUsable } from "./skill-status.js";
import { cmakeDebugTargets, cmakeProjectRoots, prioritizeCMakeProjectRoots, type CMakeDebugTarget } from "./cmake-debug.js";
import {
  systemDebugAdapterLaunch,
  type DebugAdapterLaunch,
  type DebugStartConfiguration,
} from "./debug-session.js";
import { DebugSessionManager, type ManagedDebugSnapshot } from "./debug-session-manager.js";

export type CppProjectStatus = "preparing" | "configuring" | "starting" | "indexing" | "ready" | "failed" | "stopped";
export type CppProject = { root: string; name: string; status: CppProjectStatus; error?: string; indexProgress?: string; cmake: boolean; compileCommands: boolean };
type CMakeBuildConfiguration = "Debug" | "Release" | "RelWithDebInfo" | "MinSizeRel";
const CMAKE_BUILD_CONFIGURATIONS = new Set<CMakeBuildConfiguration>(["Debug", "Release", "RelWithDebInfo", "MinSizeRel"]);
export type CppLspTrace = { elapsedMs?: number; error?: string; file?: string; method: string; phase: "rejected" | "request" | "response" | "sent" | "timeout" | "write-error"; timestamp: number; version?: number };
type PendingRequest = { file?: string; method: string; reject(reason: Error): void; resolve(value: unknown): void; startedAt: number; timeout: ReturnType<typeof setTimeout>; version?: number };
type Entry = CppProject & { child?: ChildProcessWithoutNullStreams; diagnostics: Map<string, unknown[]>; lastIndexProgressAt: number; nextId: number; openDocuments: Set<string>; pending: Map<number, PendingRequest>; stderrTail: string; writeQueue: Promise<void> };
type WorkspaceFileChange = { path: string; type: 1 | 2 | 3 };
export type CppSkillRequest = {
  action?: unknown;
  cwd?: unknown;
  file?: unknown;
  query?: unknown;
  symbol?: unknown;
  workspace?: unknown;
};
export type CppDebugSkillRequest = {
  action?: unknown;
  addresses?: unknown;
  args?: unknown;
  buildConfiguration?: unknown;
  bytes?: unknown;
  condition?: unknown;
  context?: unknown;
  count?: unknown;
  cwd?: unknown;
  dumpPath?: unknown;
  enabled?: unknown;
  exceptionFilters?: unknown;
  expression?: unknown;
  file?: unknown;
  frameId?: unknown;
  functionBreakpoints?: unknown;
  hitCondition?: unknown;
  instructionCount?: unknown;
  instructionOffset?: unknown;
  line?: unknown;
  lines?: unknown;
  logMessage?: unknown;
  memoryReference?: unknown;
  mode?: unknown;
  name?: unknown;
  offset?: unknown;
  processId?: unknown;
  program?: unknown;
  refresh?: unknown;
  sessionId?: unknown;
  sessionName?: unknown;
  sourceMap?: unknown;
  stopOnEntry?: unknown;
  symbolPaths?: unknown;
  targetId?: unknown;
  threadId?: unknown;
  value?: unknown;
  variablesReference?: unknown;
  workingDirectory?: unknown;
  workspace?: unknown;
};

const RESULT_LIMIT = 200;
const SKILL_ACTIONS = new Set([
  "declaration", "definition", "diagnostics", "document-symbols", "hover",
  "implementation", "incoming-calls", "load", "outgoing-calls", "references",
  "status", "subtypes", "supertypes", "symbols", "type-declaration", "unload",
]);
const DEBUG_SKILL_ACTIONS = new Set([
  "clear-breakpoints", "clear-output", "configurations", "continue", "detach", "disassemble", "evaluate",
  "locals", "next", "output", "pause", "processes", "read-memory", "registers", "select-frame",
  "set-breakpoints", "set-exception-filters", "set-function-breakpoints", "set-instruction-breakpoints",
  "set-variable", "stack", "start", "status", "step-in", "step-out", "stop", "variables", "write-memory",
]);

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} is required`);
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer of at least ${minimum}`);
  return value;
}

function stringList(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${name} must be an array of strings`);
  return value.map((item) => item.trim()).filter(Boolean);
}

function integerList(value: unknown, name: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || !Number.isInteger(item) || item < minimum || item > maximum))
    throw new Error(`${name} must be an array of integers between ${minimum} and ${maximum}`);
  return value;
}

function stringMap(value: unknown, name: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object containing string paths`);
  const entries = Object.entries(value).filter(([from, to]) => Boolean(from.trim()) && typeof to === "string" && Boolean(to.trim()));
  if (entries.length !== Object.keys(value).length) throw new Error(`${name} must contain only non-empty string paths`);
  return Object.fromEntries(entries) as Record<string, string>;
}

function debugSessionSummary(snapshot: ManagedDebugSnapshot): Record<string, unknown> {
  const selectedFrame = snapshot.threads.flatMap((thread) => thread.frames).find((frame) => frame.id === snapshot.selectedFrameId);
  return {
    sessionId: snapshot.sessionId,
    label: snapshot.sessionLabel,
    state: snapshot.state,
    kind: snapshot.sessionKind,
    ...(snapshot.adapter ? { adapter: snapshot.adapter } : {}),
    ...(snapshot.stopReason ? { stopReason: snapshot.stopReason } : {}),
    ...(snapshot.stopReasonKind ? { stopReasonKind: snapshot.stopReasonKind } : {}),
    ...(selectedFrame ? { selectedFrame: { id: selectedFrame.id, name: selectedFrame.name, ...(selectedFrame.file ? { file: selectedFrame.file } : {}), ...(selectedFrame.line ? { line: selectedFrame.line } : {}), ...(selectedFrame.column ? { column: selectedFrame.column } : {}), ...(selectedFrame.instructionPointerReference ? { instructionPointerReference: selectedFrame.instructionPointerReference } : {}) } } : {}),
    capabilities: snapshot.capabilities,
  };
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function presentLocation(location: LspLocation, symbol?: LspSymbol) {
  let path = location.uri;
  try { path = fileURLToPath(location.uri); } catch { /* Preserve non-file URIs. */ }
  return {
    ...(symbol?.name ? { name: symbol.name } : {}),
    ...(symbol?.containerName ? { container: symbol.containerName } : {}),
    ...(typeof symbol?.kind === "number" ? { kind: symbol.kind } : {}),
    path,
    line: location.range.start.line + 1,
    character: location.range.start.character + 1,
    endLine: location.range.end.line + 1,
    endCharacter: location.range.end.character + 1,
  };
}

function locationsFrom(value: unknown): LspLocation[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as { range?: Range; targetRange?: Range; targetSelectionRange?: Range; targetUri?: string; uri?: string };
    const uri = candidate.targetUri ?? candidate.uri;
    const range = candidate.targetSelectionRange ?? candidate.targetRange ?? candidate.range;
    return typeof uri === "string" && range ? [{ range, uri }] : [];
  });
}

function deduplicateLocations(locations: LspLocation[]): LspLocation[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${location.uri}:${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Session-only clangd registry. Tool locations are deliberately private to app data. */
export class CppService {
  private readonly cachePath: string;
  private readonly emit: (event: Record<string, unknown>) => void;
  private readonly projects = new Map<string, Entry>();
  private provisioning?: Promise<string>;
  private provisionAbort?: AbortController;
  private debugProvisioning?: Promise<DebugAdapterLaunch>;
  private debugProvisionAbort?: AbortController;
  private managedDebugAdapter?: DebugAdapterLaunch;
  private activeCommand?: ReturnType<typeof spawn>;
  private cancellationRequested = false;
  private readonly traces: CppLspTrace[] = [];
  private readonly reconfigureTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly debug: DebugSessionManager;
  private readonly debugTargetDiscovery = new Map<string, Promise<{ bin: string; build: string; environment: NodeJS.ProcessEnv; targets: CMakeDebugTarget[] }>>();
  private readonly cmakeQueues = new Map<string, Promise<void>>();
  constructor(cachePath: string, emit: (event: Record<string, unknown>) => void) {
    this.cachePath = cachePath;
    this.emit = emit;
    this.debug = new DebugSessionManager(
      (snapshot) => this.emit({ type: "debug_session", ...("sessionId" in snapshot ? { sessionId: snapshot.sessionId } : {}), snapshot }),
      () => this.managedDebugAdapter ?? systemDebugAdapterLaunch(),
    );
  }
  private publish(entry: Entry) { this.emit({ type: "language_server_project", project: this.public(entry) }); }
  private public(entry: Entry): CppProject { const { root, name, status, error, indexProgress, cmake, compileCommands } = entry; return { root, name, status, ...(error ? { error } : {}), ...(indexProgress ? { indexProgress } : {}), cmake, compileCommands }; }
  list(): CppProject[] { return [...this.projects.values()].map((entry) => this.public(entry)); }
  trace(): CppLspTrace[] { return [...this.traces]; }
  private record(trace: CppLspTrace) { this.traces.push(trace); if (this.traces.length > 200) this.traces.splice(0, this.traces.length - 200); }
  private traceMetadata(params: unknown): Pick<CppLspTrace, "file" | "version"> {
    const value = params as { textDocument?: { uri?: unknown; version?: unknown } } | undefined;
    const uri = value?.textDocument?.uri; const version = value?.textDocument?.version;
    let file: string | undefined; if (typeof uri === "string") try { file = fileURLToPath(uri); } catch { /* URI is optional diagnostic metadata. */ }
    return { ...(file ? { file } : {}), ...(typeof version === "number" ? { version } : {}) };
  }
  projectFor(file: string): CppProject | undefined {
    const normalized = resolve(file).replaceAll("\\", "/").toLowerCase();
    return this.list().filter((p) => normalized === p.root.replaceAll("\\", "/").toLowerCase() || normalized.startsWith(`${p.root.replaceAll("\\", "/").toLowerCase()}/`)).sort((a, b) => b.root.length - a.root.length)[0];
  }
  async load(rootInput: string): Promise<CppProject> {
    const root = await realpath(rootInput); this.cancellationRequested = false; const existing = this.projects.get(root); if (existing) return this.public(existing);
    const cmake = existsSync(join(root, "CMakeLists.txt"));
    const entry: Entry = { root, name: basename(root), status: "preparing", cmake, compileCommands: false, diagnostics: new Map(), lastIndexProgressAt: 0, nextId: 1, openDocuments: new Set(), pending: new Map(), stderrTail: "", writeQueue: Promise.resolve() };
    this.projects.set(root, entry); this.publish(entry);
    try {
      const bin = await this.managedBin();
      let commandsDir = root;
      let buildEnvironment: NodeJS.ProcessEnv | undefined;
      if (cmake) {
        entry.status = "configuring"; this.publish(entry);
        const configured = await this.configure(root, bin);
        commandsDir = configured.commandsDir; buildEnvironment = configured.environment; entry.compileCommands = true;
      }
      await this.start(entry, join(bin, process.platform === "win32" ? "clangd.exe" : "clangd"), commandsDir, bin, buildEnvironment);
      return this.public(entry);
    } catch (cause) { await rm(`${join(this.cachePath, "cpp-toolchain", process.platform, process.arch)}.partial`, { recursive: true, force: true }); if (this.cancellationRequested) { this.projects.delete(root); this.emit({ type: "language_server_project_removed", root }); return { ...this.public(entry), status: "stopped" }; } entry.status = "failed"; entry.error = cause instanceof Error ? cause.message : String(cause); this.publish(entry); this.emit({ type: "language_server_progress", stage: "failed", error: entry.error, detail: entry.error }); return this.public(entry); }
  }
  async unload(root: string) { const entry = this.projects.get(await realpath(root)); if (!entry) return; const timer = this.reconfigureTimers.get(entry.root); if (timer) clearTimeout(timer); this.reconfigureTimers.delete(entry.root); this.clearDebugTargetDiscovery(entry.root); this.stop(entry); this.projects.delete(entry.root); this.emit({ type: "language_server_project_removed", root: entry.root }); }
  async restart(root: string) { await this.unload(root); return this.load(root); }
  shutdown() { this.debugProvisionAbort?.abort(); this.debug.shutdown(); this.debugTargetDiscovery.clear(); this.cmakeQueues.clear(); for (const timer of this.reconfigureTimers.values()) clearTimeout(timer); this.reconfigureTimers.clear(); for (const entry of this.projects.values()) this.stop(entry); this.projects.clear(); }
  cancel(): void { this.cancellationRequested = true; this.provisionAbort?.abort(); this.debugProvisionAbort?.abort(); this.activeCommand?.kill(); }
  debugStatus(sessionId?: string) { return this.debug.status(sessionId); }
  debugSessions() { return this.debug.list(); }
  debugSelectSession(sessionId: string) { return this.debug.select(sessionId); }
  debugCloseSession(sessionId: string) { return this.debug.close(sessionId); }
  debugDetachSession(sessionId: string) { return this.debug.detach(sessionId); }
  async debugTargets(rootInput: string, refresh = false, configurationInput: unknown = "Debug"): Promise<CMakeDebugTarget[]> {
    const workspace = await realpath(rootInput);
    const configuration = this.cmakeBuildConfiguration(configurationInput);
    const roots = await this.debugCmakeRoots(workspace);
    if (refresh) for (const root of roots) this.debugTargetDiscovery.delete(this.debugDiscoveryKey(root, configuration));
    const groups = await Promise.all(roots.map(async (root) => ({ root, targets: (await this.prepareDebugTargets(root, configuration)).targets })));
    return groups.flatMap(({ root, targets }) => targets.map((target) => this.debugTarget(workspace, root, target, roots.length > 1)));
  }
  async debugConfigurations(rootInput: string, contextFileInput: unknown, refresh = false, configurationInput: unknown = "Debug"): Promise<CMakeDebugTarget[]> {
    const workspace = await realpath(rootInput);
    const configuration = this.cmakeBuildConfiguration(configurationInput);
    const contextFile = typeof contextFileInput === "string" && isAbsolute(contextFileInput) ? resolve(contextFileInput) : undefined;
    const roots = await this.debugCmakeRoots(workspace);
    if (refresh) for (const root of roots) this.debugTargetDiscovery.delete(this.debugDiscoveryKey(root, configuration));
    const ordered = prioritizeCMakeProjectRoots(roots, contextFile);
    const groups = await Promise.all(ordered.map(async (root) => ({ root, targets: (await this.prepareDebugTargets(root, configuration)).targets })));
    return groups.flatMap(({ root, targets }) => targets.map((target) => this.debugTarget(workspace, root, target, roots.length > 1)));
  }
  async debugStart(configuration: DebugStartConfiguration & { buildConfiguration?: unknown; sessionName?: string; targetId?: string }) {
    this.managedDebugAdapter = await this.managedDebugger();
    if (!configuration.targetId) return this.debug.start(configuration);
    const workspace = await realpath(configuration.root);
    const buildConfiguration = this.cmakeBuildConfiguration(configuration.buildConfiguration);
    const roots = await this.debugCmakeRoots(workspace);
    let selected: { prepared: Awaited<ReturnType<CppService["prepareDebugTargets"]>>; root: string; target: CMakeDebugTarget } | undefined;
    for (const root of roots) {
      const prepared = await this.prepareDebugTargets(root, buildConfiguration);
      const target = prepared.targets.find((item) => this.debugTarget(workspace, root, item, roots.length > 1).id === configuration.targetId);
      if (target) { selected = { prepared, root, target }; break; }
    }
    if (!selected) throw new Error("The selected CMake executable target is unavailable");
    const { prepared, root, target } = selected;
    const cmake = join(prepared.bin, process.platform === "win32" ? "cmake.exe" : "cmake");
    const refreshed = await this.withCMake(root, async () => {
      await this.run(cmake, ["--build", prepared.build, "--config", buildConfiguration, "--target", target.name], root, prepared.bin, prepared.environment);
      return cmakeDebugTargets(prepared.build);
    });
    const built = refreshed.find((item) => item.id === target.id);
    if (!built?.built) throw new Error(`CMake target '${target.name}' did not produce its declared executable`);
    return this.debug.start({ ...configuration, program: built.program }, [prepared.build]);
  }
  debugStop(sessionId?: string) { return this.debug.stop(sessionId); }
  debugCommand(command: "continue" | "pause" | "next" | "stepIn" | "stepOut", sessionId?: string) {
    if (!["continue", "pause", "next", "stepIn", "stepOut"].includes(command)) throw new Error(`Unsupported debug command: ${command}`);
    return this.debug.command(command, sessionId);
  }
  debugSetBreakpoints(file: string, lines: number[]) { return this.debug.setBreakpoints(file, lines); }
  debugClearBreakpoints() { return this.debug.clearBreakpoints(); }
  debugSetFunctionBreakpoints(inputs: Array<{ condition?: string; hitCondition?: string; name: string }>) { return this.debug.setFunctionBreakpoints(inputs); }
  debugSetExceptionFilters(filters: string[]) { return this.debug.setExceptionFilters(filters); }
  debugUpdateBreakpoint(file: string, line: number, changes: Record<string, unknown>) {
    return this.debug.updateBreakpoint(file, line, {
      ...(typeof changes.condition === "string" ? { condition: changes.condition } : {}),
      ...(typeof changes.enabled === "boolean" ? { enabled: changes.enabled } : {}),
      ...(typeof changes.hitCondition === "string" ? { hitCondition: changes.hitCondition } : {}),
      ...(typeof changes.logMessage === "string" ? { logMessage: changes.logMessage } : {}),
    });
  }
  debugSetWatches(expressions: string[]) { return this.debug.setWatches(expressions); }
  debugSelectFrame(threadId: number, frameId: number, sessionId?: string) { return this.debug.selectFrame(threadId, frameId, sessionId); }
  debugVariables(variablesReference: number, sessionId?: string) { return this.debug.expandVariables(variablesReference, sessionId); }
  debugEvaluate(expression: string, context: "repl" | "watch", sessionId?: string) { return this.debug.evaluate(expression, context, sessionId); }
  debugSetVariable(variablesReference: number, name: string, value: string, sessionId?: string) { return this.debug.setVariable(variablesReference, name, value, sessionId); }
  debugReadMemory(memoryReference: string, offset: number, count: number, sessionId?: string) { return this.debug.readMemory(memoryReference, offset, count, sessionId); }
  debugWriteMemory(memoryReference: string, offset: number, bytes: number[], sessionId?: string) { return this.debug.writeMemory(memoryReference, offset, bytes, sessionId); }
  debugDisassemble(memoryReference: string, instructionOffset: number, instructionCount: number, offset: number, sessionId?: string) { return this.debug.disassemble(memoryReference, instructionOffset, instructionCount, offset, sessionId); }
  debugSetInstructionBreakpoints(addresses: string[], sessionId?: string) { return this.debug.setInstructionBreakpoints(addresses, sessionId); }
  debugClearOutput(sessionId?: string) { return this.debug.clearOutput(sessionId); }
  async debugProcesses(): Promise<Array<{ command: string; name: string; pid: number }>> {
    const command = process.platform === "win32" ? "powershell.exe" : "ps";
    const args = process.platform === "win32"
      ? ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Csv -NoTypeInformation"]
      : ["-axo", "pid=,comm=,args="];
    const output = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolveOutput(stdout) : reject(new Error(stderr.trim() || `Process discovery exited with code ${code}`)));
    });
    if (process.platform === "win32") {
      const csv = /(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g;
      return output.split(/\r?\n/).slice(1).flatMap((line) => {
        const fields: string[] = [];
        for (const match of line.matchAll(csv)) fields.push((match[1] ?? match[2] ?? "").replaceAll('""', '"'));
        const pid = Number(fields[0]);
        return Number.isInteger(pid) && pid > 0 ? [{ pid, name: fields[1] || `Process ${pid}`, command: fields[2] || fields[1] || "" }] : [];
      }).sort((a, b) => a.name.localeCompare(b.name));
    }
    return output.split(/\r?\n/).flatMap((line) => {
      const match = /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(line);
      if (!match) return [];
      const pid = Number(match[1]);
      return pid > 0 && pid !== process.pid ? [{ pid, name: match[2]!, command: match[3] || match[2]! }] : [];
    });
  }
  /** Structured native-debug operations exposed to Pi through Agent K's UI
   * bridge. Workspace and session ownership are checked here before any DAP
   * request reaches the adapter. */
  async debugSkill(input: CppDebugSkillRequest): Promise<Record<string, unknown>> {
    const action = requiredText(input.action, "action");
    if (!DEBUG_SKILL_ACTIONS.has(action)) throw new Error(`Unsupported Native Debug Skill action: ${action}`);
    const workspace = requiredText(input.workspace, "workspace");
    const cwd = requiredText(input.cwd, "cwd");
    const root = await this.resolveCmakeWorkspace(cwd, workspace);
    const sessions = () => this.debug.listForRoot(root);
    const sessionId = () => {
      const requested = optionalText(input.sessionId);
      const available = sessions();
      const selected = requested ?? (available.length === 1 ? available[0]?.sessionId : undefined);
      if (!selected) throw new Error(available.length ? "sessionId is required when the workspace has multiple debug sessions" : "The workspace has no active debug session");
      this.debug.assertSessionRoot(selected, root);
      return selected;
    };
    const snapshot = (id: string) => this.debug.status(id) as ManagedDebugSnapshot;
    const result = (value: Record<string, unknown> = {}) => ({ ok: true, action, workspace, ...value });

    if (action === "status") return result({
      sessions: sessions().map(debugSessionSummary),
      breakpoints: this.debug.configuredBreakpoints().filter((item) => isInside(root, item.file)),
    });
    if (action === "configurations") {
      const contextFile = optionalText(input.file);
      const file = contextFile ? await this.workspaceFile(root, contextFile) : undefined;
      const configurations = await this.debugConfigurations(root, file, input.refresh === true, input.buildConfiguration);
      return result({ configurations });
    }
    if (action === "processes") return result({ processes: await this.debugProcesses() });
    if (action === "start") {
      const mode = input.mode === "attach" || input.mode === "dump" ? input.mode : "launch";
      const configuration: DebugStartConfiguration & { buildConfiguration?: unknown; sessionName?: string; targetId?: string } = {
        root,
        mode,
        args: stringList(input.args, "args"),
        ...(optionalText(input.workingDirectory) ? { cwd: optionalText(input.workingDirectory) } : {}),
        ...(optionalText(input.program) ? { program: optionalText(input.program) } : {}),
        ...(optionalText(input.dumpPath) ? { dumpPath: optionalText(input.dumpPath) } : {}),
        ...(optionalText(input.targetId) ? { targetId: optionalText(input.targetId) } : {}),
        ...(optionalText(input.sessionName) ? { sessionName: optionalText(input.sessionName) } : {}),
        ...(input.processId === undefined ? {} : { processId: integer(input.processId, "processId", 1) }),
        ...(input.stopOnEntry === true ? { stopOnEntry: true } : {}),
        buildConfiguration: input.buildConfiguration,
        symbolPaths: stringList(input.symbolPaths, "symbolPaths"),
        sourceMap: stringMap(input.sourceMap, "sourceMap"),
      };
      const started = await this.debugStart(configuration);
      return result({ session: debugSessionSummary(started) });
    }
    if (action === "set-breakpoints") {
      const file = await this.workspaceFile(root, requiredText(input.file, "file"));
      const lines = input.lines === undefined ? [integer(input.line, "line", 1)] : integerList(input.lines, "lines", 1);
      await this.debugSetBreakpoints(file, lines);
      if (input.line !== undefined && (input.enabled !== undefined || input.condition !== undefined || input.hitCondition !== undefined || input.logMessage !== undefined))
        await this.debugUpdateBreakpoint(file, integer(input.line, "line", 1), {
          ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
          ...(typeof input.condition === "string" ? { condition: input.condition } : {}),
          ...(typeof input.hitCondition === "string" ? { hitCondition: input.hitCondition } : {}),
          ...(typeof input.logMessage === "string" ? { logMessage: input.logMessage } : {}),
        });
      return result({ file, breakpoints: this.debug.configuredBreakpoints().filter((item) => item.file === file) });
    }
    if (action === "clear-breakpoints") {
      const files = [...new Set(this.debug.configuredBreakpoints().filter((item) => isInside(root, item.file)).map((item) => item.file))];
      for (const file of files) await this.debugSetBreakpoints(file, []);
      return result({ clearedFiles: files });
    }
    if (action === "set-function-breakpoints") {
      if (!Array.isArray(input.functionBreakpoints)) throw new Error("functionBreakpoints must be an array");
      const values = input.functionBreakpoints.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each function breakpoint must be an object");
        const value = item as Record<string, unknown>;
        return { name: requiredText(value.name, "function breakpoint name"), ...(typeof value.condition === "string" ? { condition: value.condition } : {}), ...(typeof value.hitCondition === "string" ? { hitCondition: value.hitCondition } : {}) };
      });
      const next = await this.debugSetFunctionBreakpoints(values);
      return result({ functionBreakpoints: next.functionBreakpoints });
    }
    if (action === "set-exception-filters") {
      const next = await this.debugSetExceptionFilters(stringList(input.exceptionFilters, "exceptionFilters"));
      return result({ exceptionFilters: next.exceptionFilters, supported: next.exceptionBreakpointFilters });
    }

    const id = sessionId();
    if (action === "stop") {
      const targetTerminated = snapshot(id).sessionKind === "live";
      await this.debugCloseSession(id);
      return result({ sessionId: id, removed: true, targetTerminated });
    }
    if (action === "detach") { await this.debugDetachSession(id); return result({ sessionId: id, removed: true, targetTerminated: false }); }
    if (action === "continue" || action === "pause" || action === "next" || action === "step-in" || action === "step-out") {
      const command = action === "step-in" ? "stepIn" : action === "step-out" ? "stepOut" : action;
      const next = await this.debugCommand(command, id);
      return result({ session: debugSessionSummary(next) });
    }
    if (action === "select-frame") {
      const next = await this.debugSelectFrame(integer(input.threadId, "threadId"), integer(input.frameId, "frameId"), id);
      return result({ session: debugSessionSummary(next) });
    }
    if (action === "stack") return result({
      sessionId: id,
      threads: snapshot(id).threads.map((thread) => ({ id: thread.id, name: thread.name, frames: thread.frames.map(({ scopes: _scopes, ...frame }) => frame) })),
    });
    if (action === "locals" || action === "registers") {
      const current = snapshot(id);
      const frame = current.threads.flatMap((thread) => thread.frames).find((item) => item.id === current.selectedFrameId);
      if (!frame) throw new Error("The debug session has no selected stack frame");
      const registers = (name: string, hint?: string) => hint === "registers" || /register/i.test(name);
      const scopes = frame.scopes.filter((scope) => action === "registers" ? registers(scope.name, scope.presentationHint) : !registers(scope.name, scope.presentationHint));
      return result({ sessionId: id, frameId: frame.id, scopes });
    }
    if (action === "variables") return result({
      sessionId: id,
      variables: await this.debugVariables(integer(input.variablesReference, "variablesReference", 1), id),
    });
    if (action === "evaluate") return result({
      sessionId: id,
      evaluation: await this.debugEvaluate(requiredText(input.expression, "expression"), input.context === "repl" ? "repl" : "watch", id),
    });
    if (action === "set-variable") {
      const next = await this.debugSetVariable(integer(input.variablesReference, "variablesReference", 1), requiredText(input.name, "name"), requiredString(input.value, "value"), id);
      return result({ session: debugSessionSummary(next) });
    }
    if (action === "read-memory") return result({
      sessionId: id,
      memory: await this.debugReadMemory(requiredText(input.memoryReference, "memoryReference"), input.offset === undefined ? 0 : integer(input.offset, "offset", Number.MIN_SAFE_INTEGER), input.count === undefined ? 256 : integer(input.count, "count", 1), id),
    });
    if (action === "write-memory") return result({
      sessionId: id,
      memory: await this.debugWriteMemory(requiredText(input.memoryReference, "memoryReference"), input.offset === undefined ? 0 : integer(input.offset, "offset", Number.MIN_SAFE_INTEGER), integerList(input.bytes, "bytes", 0, 255), id),
    });
    if (action === "disassemble") return result({
      sessionId: id,
      instructions: await this.debugDisassemble(requiredText(input.memoryReference, "memoryReference"), input.instructionOffset === undefined ? -32 : integer(input.instructionOffset, "instructionOffset", Number.MIN_SAFE_INTEGER), input.instructionCount === undefined ? 64 : integer(input.instructionCount, "instructionCount", 1), input.offset === undefined ? 0 : integer(input.offset, "offset", Number.MIN_SAFE_INTEGER), id),
    });
    if (action === "set-instruction-breakpoints") {
      const next = await this.debugSetInstructionBreakpoints(stringList(input.addresses, "addresses"), id);
      return result({ sessionId: id, instructionBreakpoints: next.instructionBreakpoints });
    }
    if (action === "output") {
      const limit = input.count === undefined ? 200 : Math.min(3_000, integer(input.count, "count", 1));
      return result({ sessionId: id, output: snapshot(id).output.split("\n").slice(-limit).join("\n"), lineLimit: limit });
    }
    if (action === "clear-output") { this.debugClearOutput(id); return result({ sessionId: id, cleared: true }); }
    throw new Error(`Native Debug Skill action was not routed: ${action}`);
  }
  /** Declarative project action consumed by the generic terminal bridge. */
  async terminalCommand(rootInput: string, relativePath: string): Promise<string> {
    const root = await realpath(rootInput);
    const source = resolve(root, relativePath);
    if (source !== root && !source.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`))
      throw new Error("Project action path is outside the workspace");
    if (!existsSync(join(source, "CMakeLists.txt")))
      throw new Error("The selected directory is not a CMake project");
    const build = join(source, "build");
    const quote = process.platform === "win32"
      ? (value: string) => `'${value.replaceAll("'", "''")}'`
      : (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    return process.platform === "win32"
      ? `cmake -S ${quote(source)} -B ${quote(build)}; if ($LASTEXITCODE -eq 0) { cmake --build ${quote(build)} }\r`
      : `cmake -S ${quote(source)} -B ${quote(build)} && cmake --build ${quote(build)}\r`;
  }
  /** High-level, read-oriented clangd operations exposed to Pi by Agent K's
   * C++ Language Skill. Every semantic action is tied to a named, usable CMake
   * workspace; this never starts an implicit language service. */
  async skill(input: CppSkillRequest): Promise<Record<string, unknown>> {
    const action = requiredText(input.action, "action");
    if (!SKILL_ACTIONS.has(action)) throw new Error(`Unsupported C++ Language Skill action: ${action}`);
    const workspace = requiredText(input.workspace, "workspace");
    const cwd = requiredText(input.cwd, "cwd");
    const root = await this.resolveCmakeWorkspace(cwd, workspace);
    const existing = this.projects.get(root);

    if (action === "status") {
      return {
        ok: true,
        action,
        workspace,
        loaded: Boolean(existing),
        ready: existing?.status === "ready",
        ...languageSkillStatusState(existing?.status ?? "unloaded"),
        ...(existing ? { project: this.public(existing) } : {}),
      };
    }
    if (action === "load") {
      if (existing) return { ok: true, action, workspace, changed: false, loaded: true, project: this.public(existing), message: "The C++ workspace was already loaded; it was not loaded again.", ...languageSkillStatusState(existing.status) };
      const project = await this.load(root);
      return { ok: project.status === "ready" || project.status === "indexing", action, workspace, changed: true, loaded: true, project, ...languageSkillStatusState(project.status) };
    }
    if (action === "unload") {
      if (!existing) return { ok: true, action, workspace, changed: false, loaded: false, message: "The C++ workspace was already unloaded.", ...languageSkillStatusState("unloaded") };
      this.stop(existing);
      this.projects.delete(root);
      this.emit({ type: "language_server_project_removed", root });
      return { ok: true, action, workspace, changed: true, loaded: false, project: this.public(existing), ...languageSkillStatusState("unloaded") };
    }

    const entry = this.requireUsableWorkspace(root, workspace);
    const file = optionalText(input.file);
    if (action === "symbols") {
      const query = requiredText(input.query ?? input.symbol, "query");
      const raw = await this.request(entry, "workspace/symbol", { query });
      const symbols = Array.isArray(raw) ? raw.filter((item): item is LspSymbol => Boolean(item && typeof item === "object" && symbolLocation(item as LspSymbol))) : [];
      return this.skillResult(entry, action, workspace, query, symbols.map((symbol) => presentLocation(symbolLocation(symbol)!, symbol)));
    }
    if (action === "document-symbols" || action === "diagnostics") {
      const target = await this.workspaceFile(root, requiredText(file, "file"));
      const uri = pathToFileURL(target).href;
      const result = action === "diagnostics"
        ? entry.diagnostics.get(target) ?? []
        : await this.withSkillDocument(entry, uri, () => this.request(entry, "textDocument/documentSymbol", { textDocument: { uri } }));
      return { ok: true, action, workspace, file: target, result, ...this.skillIndexState(entry) };
    }

    const symbol = requiredText(input.symbol ?? input.query, "symbol");
    const targets = await this.symbolTargets(entry, symbol, file, action === "type-declaration");
    if (!targets.length) return {
      ok: true,
      action,
      workspace,
      query: symbol,
      count: 0,
      results: [],
      message: entry.status === "indexing"
        ? `No exact symbol named '${symbol}' is available in the partial index yet.`
        : `No exact symbol named '${symbol}' was found in the loaded C++ workspace.`,
      ...this.skillIndexState(entry),
    };

    if (action === "type-declaration") {
      const declared = targets.map(({ location, symbol: target }) => presentLocation(location, target));
      return this.skillResult(entry, action, workspace, symbol, declared);
    }
    const positions = targets.map(({ location }) => ({
      position: location.range.start,
      textDocument: { uri: location.uri },
    }));
    if (action === "references" || action === "definition" || action === "declaration" || action === "implementation") {
      const method = {
        declaration: "textDocument/declaration",
        definition: "textDocument/definition",
        implementation: "textDocument/implementation",
        references: "textDocument/references",
      }[action]!;
      const found: LspLocation[] = [];
      for (const position of positions) {
        const params = action === "references" ? { ...position, context: { includeDeclaration: true } } : position;
        found.push(...locationsFrom(await this.withSkillDocument(entry, position.textDocument.uri, () => this.request(entry, method, params))));
      }
      return this.skillResult(entry, action, workspace, symbol, deduplicateLocations(found).map((location) => presentLocation(location)));
    }
    if (action === "hover") {
      const position = positions[0]!;
      const result = await this.withSkillDocument(entry, position.textDocument.uri, () => this.request(entry, "textDocument/hover", position));
      return { ok: true, action, workspace, query: symbol, result, ...this.skillIndexState(entry) };
    }
    if (["incoming-calls", "outgoing-calls"].includes(action)) {
      const position = positions[0]!;
      const prepared = await this.withSkillDocument(entry, position.textDocument.uri, () => this.request(entry, "textDocument/prepareCallHierarchy", position));
      const items = Array.isArray(prepared) ? prepared : [];
      const method = action === "incoming-calls" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls";
      const results = (await Promise.all(items.map((item) => this.request(entry, method, { item })))).flatMap((value) => Array.isArray(value) ? value : []);
      return this.skillResult(entry, action, workspace, symbol, results);
    }
    if (["supertypes", "subtypes"].includes(action)) {
      const position = positions[0]!;
      const prepared = await this.withSkillDocument(entry, position.textDocument.uri, () => this.request(entry, "textDocument/prepareTypeHierarchy", position));
      const items = Array.isArray(prepared) ? prepared : [];
      const method = action === "supertypes" ? "typeHierarchy/supertypes" : "typeHierarchy/subtypes";
      const results = (await Promise.all(items.map((item) => this.request(entry, method, { item })))).flatMap((value) => Array.isArray(value) ? value : []);
      return this.skillResult(entry, action, workspace, symbol, results);
    }
    throw new Error(`C++ Language Skill action was not routed: ${action}`);
  }
  private async resolveCmakeWorkspace(cwdInput: string, workspace: string): Promise<string> {
    if (workspace === "." || workspace === ".." || workspace.includes("/") || workspace.includes("\\"))
      throw new Error("workspace must be a C++ workspace name, not a path");
    const cwd = await realpath(cwdInput);
    const normalized = workspace.toLocaleLowerCase("en-US");
    const loaded = [...this.projects.keys()].filter((root) => isInside(cwd, root) && basename(root).toLocaleLowerCase("en-US") === normalized);
    if (loaded.length > 1) throw new Error(`C++ workspace name '${workspace}' is ambiguous; ${loaded.length} loaded CMake folders use that name`);
    if (loaded[0]) return loaded[0];

    const direct = basename(cwd).toLocaleLowerCase("en-US") === normalized ? cwd : resolve(cwd, workspace);
    const directRoot = await realpath(direct).catch(() => undefined);
    if (directRoot && isInside(cwd, directRoot) && existsSync(join(directRoot, "CMakeLists.txt"))) return directRoot;

    const matches: string[] = [];
    const pending = [cwd];
    let cursor = 0;
    let visited = 0;
    while (cursor < pending.length) {
      const directory = pending[cursor++]!;
      if (++visited > 20_000) throw new Error(`C++ workspace search under ${cwd} exceeded 20,000 folders; use a unique top-level workspace name`);
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "build" || entry.name === "out" || entry.name === ".cache" || entry.name.startsWith("cmake-build-")) continue;
        const candidate = join(directory, entry.name);
        if (entry.name.toLocaleLowerCase("en-US") === normalized && existsSync(join(candidate, "CMakeLists.txt"))) matches.push(await realpath(candidate));
        pending.push(candidate);
      }
    }
    const unique = [...new Set(matches)];
    if (!unique.length) throw new Error(`'${workspace}' is not a C++ workspace under ${cwd}: no matching folder with CMakeLists.txt was found`);
    if (unique.length > 1) throw new Error(`C++ workspace name '${workspace}' is ambiguous; ${unique.length} CMake folders use that name under ${cwd}`);
    return unique[0]!;
  }
  private requireUsableWorkspace(root: string, workspace: string): Entry {
    const entry = this.projects.get(root);
    if (!entry) throw new Error(`C++ workspace '${workspace}' is not loaded. Check status and load it once before using clangd operations.`);
    if (!languageSkillUsable(entry.status, Boolean(entry.child)))
      throw new Error(`C++ workspace '${workspace}' is loaded but clangd is not usable (status: ${entry.status}).`);
    return entry;
  }
  private async workspaceFile(root: string, file: string): Promise<string> {
    const candidate = resolve(root, file);
    if (!isInside(root, candidate))
      throw new Error("file is outside the C++ workspace");
    let canonical: string;
    try { canonical = await realpath(candidate); }
    catch { throw new Error(`File does not exist in the C++ workspace: ${file}`); }
    if (!isInside(root, canonical)) throw new Error("file resolves outside the C++ workspace");
    return canonical;
  }
  private async symbolTargets(entry: Entry, query: string, file: string | undefined, typesOnly: boolean): Promise<Array<{ location: LspLocation; symbol: LspSymbol }>> {
    const result = await this.request(entry, "workspace/symbol", { query });
    let symbols = selectWorkspaceSymbols(result, query, typesOnly);
    if (file) {
      const target = await this.workspaceFile(entry.root, file);
      symbols = symbols.filter((symbol) => {
        const location = symbolLocation(symbol);
        if (!location) return false;
        try { return fileURLToPath(location.uri) === target; } catch { return false; }
      });
    }
    return symbols.flatMap((symbol) => {
      const location = symbolLocation(symbol);
      return location ? [{ location, symbol }] : [];
    });
  }
  private async withSkillDocument<T>(entry: Entry, uri: string, operation: () => Promise<T>): Promise<T> {
    if (entry.openDocuments.has(uri)) return operation();
    let file: string;
    try { file = await realpath(fileURLToPath(uri)); }
    catch { throw new Error(`clangd returned a symbol outside a readable file: ${uri}`); }
    if (!isInside(entry.root, file)) throw new Error("clangd returned a symbol outside the C++ workspace");
    const text = await readFile(file, "utf8");
    const opened = await this.enqueueNotification(entry, "textDocument/didOpen", {
      textDocument: { uri, languageId: "cpp", version: 0, text },
    });
    if (!opened) throw new Error(`Unable to open ${file} in clangd`);
    try {
      return await operation();
    } finally {
      await this.enqueueNotification(entry, "textDocument/didClose", { textDocument: { uri } });
    }
  }
  private skillIndexState(entry: Entry): Record<string, unknown> {
    return languageSkillStatusState(entry.status);
  }
  private skillResult(entry: Entry, action: string, workspace: string, query: string, values: unknown[]): Record<string, unknown> {
    return {
      ok: true,
      action,
      workspace,
      query,
      count: values.length,
      truncated: values.length > RESULT_LIMIT,
      results: values.slice(0, RESULT_LIMIT),
      ...this.skillIndexState(entry),
    };
  }
  async lsp(file: string, method: string, params: unknown): Promise<unknown> {
    const canonical = resolve(file); const project = this.projectFor(canonical);
    // Opening an ordinary C++ file must remain useful without first loading a
    // project. Treat its optional language-service calls as unavailable rather
    // than surfacing an IPC exception in Electron's console.
    if (!project) { this.record({ method, phase: "rejected", timestamp: Date.now(), ...this.traceMetadata(params), error: "file is outside loaded C++ projects" }); return undefined; }
    const entry = this.projects.get(project.root); if (!entry?.child || (entry.status !== "ready" && entry.status !== "indexing")) { this.record({ method, phase: "rejected", timestamp: Date.now(), ...this.traceMetadata(params), error: `clangd status is ${entry?.status ?? "unavailable"}` }); return undefined; }
    await entry.writeQueue;
    try { return await this.request(entry, method, params); }
    catch (cause) {
      // clangd versions differ in support for optional pull diagnostics and
      // semantic-token requests. It also cancels an in-flight query when a
      // didChange arrives first. Both are normal optional-service outcomes,
      // not Electron IPC errors.
      if (!(cause instanceof Error) || !/(method not found|request cancelled because the document was modified|clangd request timed out)/i.test(cause.message)) throw cause;
      if (method === "textDocument/completion") return { items: [] };
      if (method === "textDocument/definition") return [];
      if (method === "textDocument/diagnostic") return { items: [] };
      if (method === "textDocument/semanticTokens/full") return { data: [] };
      if (method === "textDocument/hover") return null;
      return undefined;
    }
  }
  async notify(file: string, method: string, params: unknown): Promise<boolean> {
    const canonical = resolve(file); const project = this.projectFor(canonical); const entry = project ? this.projects.get(project.root) : undefined;
    if (!entry) { this.record({ method, phase: "rejected", timestamp: Date.now(), ...this.traceMetadata(params), error: "file is outside loaded C++ projects" }); return false; }
    return this.enqueueNotification(entry, method, params);
  }
  workspaceFilesChanged(changes: WorkspaceFileChange[]): void {
    for (const entry of this.projects.values()) {
      const relevant = changes.filter((change) => isInside(entry.root, resolve(change.path)));
      if (!relevant.length) continue;
      if (entry.child && entry.status === "ready") {
        void this.enqueueNotification(entry, "workspace/didChangeWatchedFiles", {
          changes: relevant.map((change) => ({
            uri: pathToFileURL(resolve(change.path)).href,
            type: change.type,
          })),
        });
      }
      if (
        entry.cmake &&
        relevant.some((change) => isCMakeConfigurationPath(entry.root, resolve(change.path)))
      ) {
        this.clearDebugTargetDiscovery(entry.root);
        this.scheduleReconfigure(entry.root);
      }
    }
  }
  private scheduleReconfigure(root: string): void {
    const previous = this.reconfigureTimers.get(root);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.reconfigureTimers.delete(root);
      const entry = this.projects.get(root);
      if (!entry) return;
      if (["preparing", "configuring", "starting", "indexing"].includes(entry.status)) {
        this.scheduleReconfigure(root);
        return;
      }
      void this.restart(root).catch((cause) => {
        this.emit({
          type: "language_server_progress",
          stage: "failed",
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    }, 650);
    timer.unref();
    this.reconfigureTimers.set(root, timer);
  }
  private enqueueNotification(entry: Entry, method: string, params: unknown): Promise<boolean> {
    const metadata = this.traceMetadata(params);
    const document = params as { textDocument?: { uri?: unknown } } | undefined;
    const uri = typeof document?.textDocument?.uri === "string" ? document.textDocument.uri : undefined;
    const write = entry.writeQueue.catch(() => undefined).then(() => new Promise<boolean>((resolveWrite) => {
      if (!entry.child || entry.status === "failed" || entry.status === "stopped" || entry.child.killed || entry.child.stdin.destroyed || !entry.child.stdin.writable) { this.record({ method, phase: "rejected", timestamp: Date.now(), ...metadata, error: "clangd stdin is unavailable" }); resolveWrite(false); return; }
      const payload = JSON.stringify({ jsonrpc: "2.0", method, params }); entry.child.stdin.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`, (cause) => {
        if (!cause && uri) {
          if (method === "textDocument/didOpen") entry.openDocuments.add(uri);
          if (method === "textDocument/didClose") entry.openDocuments.delete(uri);
        }
        this.record({ method, phase: cause ? "write-error" : "sent", timestamp: Date.now(), ...metadata, ...(cause ? { error: String(cause) } : {}) }); resolveWrite(!cause);
      });
    }));
    entry.writeQueue = write.then(() => undefined);
    return write;
  }
  private stop(entry: Entry) {
    entry.status = "stopped";
    for (const pending of entry.pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error("clangd stopped")); }
    entry.pending.clear();
    entry.child?.stdin.destroy();
    if (entry.child && !entry.child.killed) entry.child.kill();
  }
  private async managedBin(): Promise<string> {
    const root = join(this.cachePath, "cpp-toolchain", process.platform, process.arch);
    const bin = join(root, "bin");
    const executable = process.platform === "win32" ? ".exe" : "";
    const candidates = ["clangd", "cmake", "ninja"];
    const platform = process.platform === "win32" || process.platform === "linux" ? process.platform : undefined;
    const marker = platform ? await readFile(join(root, ".agent-k-language-tools"), "utf8").catch(() => "") : "";
    if (platform && marker === managedToolchainMarker(platform) && candidates.every((name) => existsSync(join(bin, `${name}${executable}`)))) { this.emit({ type: "language_server_progress", stage: "preparing", detail: "Reusing cached C++ language tools" }); return bin; }
    this.provisionAbort ??= new AbortController(); this.provisioning ??= this.provision(bin, this.provisionAbort.signal).finally(() => { this.provisioning = undefined; this.provisionAbort = undefined; });
    return this.provisioning;
  }
  private async managedDebugger(): Promise<DebugAdapterLaunch> {
    const e2eAdapter = process.env.AGENT_K_E2E === "1" ? process.env.AGENT_K_E2E_DEBUG_ADAPTER : undefined;
    if (e2eAdapter) {
      const adapter = await realpath(e2eAdapter);
      return { adapter: process.platform === "win32" ? "windbg" : "lldb", args: [adapter], command: process.execPath };
    }
    const archive = managedDebuggerArchive(process.platform, process.arch);
    const markerValue = managedDebuggerMarker(process.platform, process.arch);
    if (!archive || !markerValue) return systemDebugAdapterLaunch();
    const root = join(this.cachePath, "cpp-debugger", process.platform, process.arch);
    const command = join(root, "extension", "adapter", "codelldb");
    const marker = await readFile(join(root, ".agent-k-debug-tools"), "utf8").catch(() => "");
    if (marker === markerValue && existsSync(command)) return { adapter: "lldb", args: [], command };
    this.debugProvisionAbort ??= new AbortController();
    this.debugProvisioning ??= this.provisionDebugger(root, archive, markerValue, this.debugProvisionAbort.signal)
      .finally(() => { this.debugProvisioning = undefined; this.debugProvisionAbort = undefined; });
    return this.debugProvisioning;
  }
  private async provisionDebugger(root: string, archive: ReturnType<typeof managedDebuggerArchive> & {}, marker: string, signal: AbortSignal): Promise<DebugAdapterLaunch> {
    const staging = `${root}.partial`;
    const archiveCache = join(this.cachePath, "cpp-debugger-downloads", process.platform, process.arch);
    await rm(staging, { recursive: true, force: true });
    await Promise.all([mkdir(staging, { recursive: true }), mkdir(archiveCache, { recursive: true })]);
    this.emit({ type: "language_server_progress", stage: "preparing", tool: "LLDB debugger", detail: "Preparing managed LLDB debugger" });
    await this.downloadRelease(archive.owner, archive.repository, archive.tag, archive.asset, staging, archiveCache, "LLDB debugger", archive.sha256, signal);
    const executable = await this.findExecutable(staging, "codelldb");
    if (!executable) throw new Error("Provisioned LLDB debugger is incomplete");
    await chmod(executable, 0o755);
    const relativeExecutable = relative(staging, executable);
    await writeFile(join(staging, ".agent-k-debug-tools"), marker, "utf8");
    await rm(root, { recursive: true, force: true });
    await rename(staging, root);
    const command = join(root, relativeExecutable);
    this.emit({ type: "language_server_progress", stage: "ready", tool: "LLDB debugger", detail: "Managed LLDB debugger is ready" });
    return { adapter: "lldb", args: [], command };
  }
  private cmakeBuildDirectory(root: string): string {
    const platform = process.platform as "linux" | "win32";
    const key = createHash("sha256").update(root).update("\0").update(managedToolchainMarker(platform)).digest("hex");
    return join(this.cachePath, "cpp-build", key);
  }
  private cmakeBuildConfiguration(value: unknown): CMakeBuildConfiguration {
    const configuration = typeof value === "string" ? value : "Debug";
    if (!CMAKE_BUILD_CONFIGURATIONS.has(configuration as CMakeBuildConfiguration))
      throw new Error(`Unsupported CMake build configuration: ${configuration}`);
    return configuration as CMakeBuildConfiguration;
  }
  private debugBuildDirectory(root: string, configuration: CMakeBuildConfiguration): string {
    const platform = process.platform as "linux" | "win32";
    const key = createHash("sha256").update(root).update("\0").update(managedToolchainMarker(platform)).digest("hex");
    return join(this.cachePath, "cpp-debug", key, configuration);
  }
  private debugDiscoveryKey(root: string, configuration: CMakeBuildConfiguration): string {
    return `${root}\0${configuration}`;
  }
  private clearDebugTargetDiscovery(root: string): void {
    for (const key of this.debugTargetDiscovery.keys())
      if (key.startsWith(`${root}\0`)) this.debugTargetDiscovery.delete(key);
  }
  private debugTarget(workspace: string, root: string, target: CMakeDebugTarget, qualify: boolean): CMakeDebugTarget {
    const prefix = createHash("sha256").update(root).digest("hex").slice(0, 12);
    const folder = relative(workspace, root).replaceAll("\\", "/") || ".";
    return { ...target, id: `${prefix}:${target.id}`, name: qualify ? `${folder} · ${target.name}` : target.name };
  }
  private async debugCmakeRoots(workspace: string): Promise<string[]> {
    return cmakeProjectRoots(workspace);
  }
  private async withCMake<T>(root: string, action: () => Promise<T>): Promise<T> {
    const previous = this.cmakeQueues.get(root) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(action);
    const completion = operation.then(() => undefined, () => undefined);
    this.cmakeQueues.set(root, completion);
    try { return await operation; }
    finally { if (this.cmakeQueues.get(root) === completion) this.cmakeQueues.delete(root); }
  }
  private prepareDebugTargets(root: string, configuration: CMakeBuildConfiguration): Promise<{ bin: string; build: string; environment: NodeJS.ProcessEnv; targets: CMakeDebugTarget[] }> {
    const discoveryKey = this.debugDiscoveryKey(root, configuration);
    const current = this.debugTargetDiscovery.get(discoveryKey);
    if (current) return current;
    const pending = (async () => {
      const bin = await this.managedBin();
      const build = this.debugBuildDirectory(root, configuration);
      const environment = await this.cmakeEnvironment(bin);
      const targets = await this.withCMake(root, async () => {
        const query = join(build, ".cmake", "api", "v1", "query");
        await mkdir(query, { recursive: true });
        await writeFile(join(query, "codemodel-v2"), "", "utf8");
        const cmake = join(bin, process.platform === "win32" ? "cmake.exe" : "cmake");
        if (!existsSync(cmake)) throw new Error("Managed CMake is unavailable");
        await this.run(cmake, ["-S", root, "-B", build, "-G", "Ninja", `-DCMAKE_BUILD_TYPE=${configuration}`, "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON"], root, bin, environment);
        return cmakeDebugTargets(build);
      });
      return { bin, build, environment, targets };
    })().then((result) => {
      // An empty result commonly means the File API query raced the project's
      // first configure. Do not make that transient state sticky.
      if (result.targets.length === 0) this.debugTargetDiscovery.delete(discoveryKey);
      return result;
    }, (cause: unknown) => {
      this.debugTargetDiscovery.delete(discoveryKey);
      throw cause;
    });
    this.debugTargetDiscovery.set(discoveryKey, pending);
    return pending;
  }
  private async provision(bin: string, signal: AbortSignal): Promise<string> {
    if (!((process.platform === "win32" || process.platform === "linux") && process.arch === "x64")) throw new Error("Automatic C++ toolchain installation supports Windows/Linux x64 only");
    const root = join(this.cachePath, "cpp-toolchain", process.platform, process.arch); const staging = `${root}.partial`; const archiveCache = join(this.cachePath, "cpp-toolchain-downloads", process.platform, process.arch);
    await rm(staging, { recursive: true, force: true }); await Promise.all([mkdir(staging, { recursive: true }), mkdir(archiveCache, { recursive: true })]);
    const platform = process.platform === "win32" ? "windows" : "linux";
    const archives = managedToolchainArchives(process.platform as "linux" | "win32");
    this.emit({ type: "language_server_progress", stage: "preparing", detail: `Preparing managed ${platform} language tools` });
    for (const [tool, archive] of Object.entries(archives))
      await this.downloadRelease(archive.owner, archive.repository, archive.tag, archive.asset, staging, archiveCache, tool, archive.sha256, signal);
    // Archives retain top-level directories. Preserve CMake's share tree and
    // the language package's lib tree next to their private executable set.
    const executable = process.platform === "win32" ? ".exe" : "";
    const candidates = ["clangd", "cmake", "ninja"];
    await mkdir(join(staging, "bin"), { recursive: true });
    const cmakeSource = await this.findExecutable(staging, `cmake${executable}`);
    const clangdSource = await this.findExecutable(staging, `clangd${executable}`);
    if (!cmakeSource || !clangdSource) throw new Error("Provisioned language tools are incomplete");
    const cmakeRoot = dirname(dirname(cmakeSource));
    if (existsSync(join(cmakeRoot, "share"))) await rename(join(cmakeRoot, "share"), join(staging, "share"));
    const languageRoot = dirname(dirname(clangdSource));
    const languageLib = join(languageRoot, "lib");
    const targetLib = join(staging, "lib");
    if (languageLib !== targetLib && existsSync(languageLib) && !existsSync(targetLib)) await rename(languageLib, targetLib);
    await this.moveDirectoryEntries(dirname(cmakeSource), join(staging, "bin"));
    await this.moveDirectoryEntries(dirname(clangdSource), join(staging, "bin"));
    for (const name of candidates) { const found = await this.findExecutable(staging, `${name}${executable}`); if (!found) throw new Error(`Provisioned ${name} is missing`); const target = join(staging, "bin", `${name}${executable}`); if (found !== target) await rename(found, target); }
    await writeFile(join(staging, ".agent-k-language-tools"), managedToolchainMarker(process.platform as "linux" | "win32"), "utf8");
    if (process.platform === "win32") await rm(join(archiveCache, "clang+llvm-22.1.6-x86_64-pc-windows-msvc.tar.xz"), { force: true });
    await rm(root, { recursive: true, force: true }); await rename(staging, root); this.emit({ type: "language_server_progress", stage: "ready", detail: "Managed C++ language tools are ready" }); return bin;
  }
  private async findExecutable(directory: string, name: string): Promise<string | undefined> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) { const full = join(directory, entry.name); if (entry.isFile() && entry.name === name) return full; if (entry.isDirectory()) { const found = await this.findExecutable(full, name); if (found) return found; } } return undefined;
  }
  private async moveDirectoryEntries(source: string, destination: string): Promise<void> {
    for (const entry of await readdir(source)) { const from = join(source, entry); const to = join(destination, entry); if (from !== to && !existsSync(to)) await rename(from, to); }
  }
  private environmentPath(environment: NodeJS.ProcessEnv): string {
    return Object.entries(environment).find(([key]) => key.toLocaleUpperCase("en-US") === "PATH")?.[1] ?? "";
  }
  private executableInPath(names: readonly string[], pathValue: string): string | undefined {
    for (const rawDirectory of pathValue.split(delimiter)) {
      const directory = rawDirectory.replace(/^"|"$/gu, "");
      if (!directory) continue;
      for (const name of names) { const candidate = join(directory, name); if (existsSync(candidate)) return candidate; }
    }
    return undefined;
  }
  private mergeWindowsEnvironment(base: NodeJS.ProcessEnv, additions: Record<string, string>): NodeJS.ProcessEnv {
    const merged = { ...base };
    for (const [key, value] of Object.entries(additions)) {
      const normalizedKey = key.toLocaleUpperCase("en-US") === "PATH" ? "PATH" : key;
      for (const existing of Object.keys(merged))
        if (existing !== normalizedKey && existing.toLocaleUpperCase("en-US") === normalizedKey.toLocaleUpperCase("en-US")) delete merged[existing];
      merged[normalizedKey] = value;
    }
    return merged;
  }
  private async capture(command: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<string> {
    return new Promise<string>((resolveCapture, reject) => {
      // Node normally escapes quotes while constructing a Windows command
      // line. cmd.exe then receives \"path with spaces\" literally for /c
      // commands and cannot execute VsDevCmd.bat. Let cmd.exe parse the raw
      // command tail itself; direct executable launches keep Node's escaping.
      const windowsVerbatimArguments = process.platform === "win32"
        && basename(command).toLocaleLowerCase("en-US") === "cmd.exe";
      const child = spawn(command, args, { cwd, windowsHide: true, windowsVerbatimArguments, env: environment });
      this.activeCommand = child; let stdout = ""; let stderr = "";
      child.stdout.on("data", (data) => { stdout += String(data); });
      child.stderr.on("data", (data) => { stderr += String(data); });
      child.once("error", reject);
      child.once("close", (code) => {
        if (this.activeCommand === child) this.activeCommand = undefined;
        code === 0 ? resolveCapture(stdout) : reject(new Error(stderr || `${command} exited with ${code}`));
      });
    });
  }
  private async cmakeEnvironment(bin: string): Promise<NodeJS.ProcessEnv> {
    const base: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}${delimiter}${this.environmentPath(process.env)}` };
    if (process.platform !== "win32") return base;
    if (base.CC || base.CXX || this.executableInPath(["cl.exe", "clang-cl.exe", "clang.exe", "gcc.exe", "g++.exe"], base.PATH ?? "")) return base;
    const programDirectories = [base["ProgramFiles(x86)"], base.ProgramFiles].filter((value): value is string => Boolean(value));
    const vswhere = this.executableInPath(["vswhere.exe"], base.PATH ?? "")
      ?? [
        ...programDirectories.map((directory) => join(directory, "Microsoft Visual Studio", "Installer", "vswhere.exe")),
        DEFAULT_VSWHERE_PATH,
      ].find((candidate) => existsSync(candidate));
    if (!vswhere) throw new Error("No Windows C/C++ compiler was found. Install Visual Studio Build Tools with Desktop development with C++, Clang, or MinGW.");
    const installation = (await this.capture(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath", "-utf8"], bin, base)).trim();
    if (!installation) throw new Error("Visual Studio Build Tools is installed without the Desktop development with C++ workload.");
    const developerCommand = join(installation.split(/\r?\n/u).at(-1) ?? installation, "Common7", "Tools", "VsDevCmd.bat");
    if (!existsSync(developerCommand)) throw new Error("Visual Studio C++ developer environment is incomplete: VsDevCmd.bat was not found.");
    const output = await this.capture("cmd.exe", ["/d", "/s", "/c", `chcp 65001 >nul && call "${developerCommand}" -no_logo -arch=x64 -host_arch=x64 >nul && set`], bin, base);
    const environment = this.mergeWindowsEnvironment(base, parseWindowsEnvironment(output));
    if (!this.executableInPath(["cl.exe"], this.environmentPath(environment))) throw new Error("Visual Studio C++ developer environment did not provide cl.exe.");
    this.emit({ type: "language_server_progress", stage: "configuring", detail: "Using Visual Studio C++ build environment" });
    return environment;
  }
  private async archiveMatches(path: string, expectedSha256: string): Promise<boolean> { if (!existsSync(path)) return false; try { const hash = createHash("sha256"); const { createReadStream } = await import("node:fs"); await pipeline(createReadStream(path), hash); return hash.digest("hex") === expectedSha256; } catch { return false; } }
  private async downloadRelease(owner: string, repo: string, tag: string, assetName: string, directory: string, archiveCache: string, tool: string, expectedSha256: string, signal: AbortSignal): Promise<void> {
    const archive = join(directory, assetName); const cachedArchive = join(archiveCache, assetName);
    if (await this.archiveMatches(cachedArchive, expectedSha256)) { const size = (await stat(cachedArchive)).size; this.emit({ type: "language_server_progress", stage: "downloading", tool, bytes: size, total: size, rate: 0, detail: `${assetName} (reused cache)` }); await copyFile(cachedArchive, archive); this.emit({ type: "language_server_progress", stage: "extracting", tool, detail: assetName }); await this.extract(archive, directory); await rm(archive, { force: true }); return; }
    await rm(cachedArchive, { force: true }); const api = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Agent-K" }, signal }); if (!api.ok) throw new Error(`Unable to locate ${tool} release (${api.status})`);
    const release = await api.json() as { assets?: Array<{ name: string; browser_download_url: string }> }; const asset = release.assets?.find((item) => item.name === assetName); if (!asset) throw new Error(`Release asset is unavailable for ${tool}`); const response = await fetch(asset.browser_download_url, { headers: { "User-Agent": "Agent-K" }, signal }); if (!response.ok || !response.body) throw new Error(`Unable to download ${tool} (${response.status})`);
    const total = Number(response.headers.get("content-length") ?? 0); let received = 0; const started = Date.now(); const reader = response.body.getReader(); const emit = this.emit;
    const cancellation = new Error("C++ project load cancelled");
    const stream = new Readable({ read() { void reader.read().then((next) => { if (next.done) this.push(null); else { received += next.value.byteLength; const seconds = Math.max(0.001, (Date.now() - started) / 1000); emit({ type: "language_server_progress", stage: "downloading", tool, bytes: received, total, rate: Math.round(received / seconds), detail: assetName }); this.push(Buffer.from(next.value)); } }).catch((cause) => this.destroy(cause)); } });
    const abortDownload = () => { void reader.cancel().catch(() => undefined); stream.destroy(cancellation); };
    if (signal.aborted) abortDownload(); else signal.addEventListener("abort", abortDownload, { once: true });
    try { await pipeline(stream, createWriteStream(archive)); } finally { signal.removeEventListener("abort", abortDownload); }
    if (!await this.archiveMatches(archive, expectedSha256)) throw new Error(`Checksum verification failed for ${tool}`); const cachedPartial = `${cachedArchive}.partial`; await rm(cachedPartial, { force: true }); await copyFile(archive, cachedPartial); await rename(cachedPartial, cachedArchive);
    this.emit({ type: "language_server_progress", stage: "extracting", tool, detail: assetName }); await this.extract(archive, directory); await rm(archive, { force: true });
  }
  private async extract(archive: string, directory: string): Promise<void> {
    if (toolchainArchiveFormat(archive) === "zip") {
      await extractZip(archive, { dir: directory });
      return;
    }
    await this.run(process.platform === "win32" ? "tar.exe" : "tar", ["-xf", archive, "-C", directory], directory, "");
  }
  private configure(root: string, bin: string): Promise<{ commandsDir: string; environment: NodeJS.ProcessEnv }> {
    return this.withCMake(root, () => this.configureUnlocked(root, bin));
  }
  private async configureUnlocked(root: string, bin: string): Promise<{ commandsDir: string; environment: NodeJS.ProcessEnv }> {
    const build = this.cmakeBuildDirectory(root);
    const snapshot = await cmakeConfigurationSnapshot(root);
    const projectCommands = await findProjectCompilationDatabase(root, snapshot);
    const cachedCommands = projectCommands ? undefined : await cachedCompilationDatabase(build, snapshot);
    const environment = await this.cmakeEnvironment(bin);
    let sourceCommands = projectCommands ?? cachedCommands;
    if (sourceCommands) {
      this.emit({
        type: "language_server_progress",
        stage: "configuring",
        detail: `Reusing compilation database from ${describeCompilationDatabase(root, sourceCommands)}\n`,
      });
    } else {
      await mkdir(build, { recursive: true }); const cmake = join(bin, process.platform === "win32" ? "cmake.exe" : "cmake");
      if (!existsSync(cmake)) throw new Error("Managed CMake is unavailable");
      await this.run(cmake, ["-S", root, "-B", build, "-G", "Ninja", "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON"], root, bin, environment);
      sourceCommands = join(build, "compile_commands.json");
      if (!existsSync(sourceCommands)) throw new Error("CMake did not generate compile_commands.json");
      // CMake writes -include-pch flags into its compilation database. This
      // feature configures without building, so a newly configured project has
      // no PCH yet. Retain an existing PCH by reference (never copy it); remove
      // only missing PCH inputs while keeping CMake's wrapper header (-include).
      await this.stripMissingPrecompiledHeaders(sourceCommands);
      await recordCompilationDatabase(sourceCommands, snapshot);
    }
    const prepared = await prepareClangdCompilationDatabase(root, sourceCommands, privateClangdIndexDirectory(this.cachePath, build));
    this.emit({
      type: "language_server_progress",
      stage: "configuring",
      detail: `Prepared ${prepared.included} project translation units${prepared.excluded ? `; excluded ${prepared.excluded} dependency units` : ""}\n`,
    });
    return { commandsDir: dirname(prepared.commands), environment };
  }
  private async stripMissingPrecompiledHeaders(commandsPath: string): Promise<void> {
    type Command = { arguments?: unknown; command?: unknown };
    let commands: Command[];
    try { const value = JSON.parse(await readFile(commandsPath, "utf8")) as unknown; if (!Array.isArray(value)) return; commands = value as Command[]; } catch { return; }
    let changed = false;
    for (const entry of commands) {
      if (typeof entry.command === "string") {
        const sanitized = entry.command.replace(/-Xclang\s+-include-pch\s+-Xclang\s+("[^"]+"|\S+)\s*/g, (match, rawPath: string) => {
          const pch = rawPath.startsWith('"') ? rawPath.slice(1, -1) : rawPath;
          return existsSync(pch) ? match : "";
        });
        changed ||= sanitized !== entry.command; entry.command = sanitized;
      }
      if (!Array.isArray(entry.arguments)) continue;
      const argumentsList = entry.arguments.filter((item): item is string => typeof item === "string"); const sanitized: string[] = [];
      for (let index = 0; index < argumentsList.length; index += 1) {
        const pch = argumentsList[index + 3];
        if (argumentsList[index] === "-Xclang" && argumentsList[index + 1] === "-include-pch" && argumentsList[index + 2] === "-Xclang" && typeof pch === "string" && !existsSync(pch)) { index += 3; changed = true; continue; }
        const argument = argumentsList[index]; if (argument !== undefined) sanitized.push(argument);
      }
      entry.arguments = sanitized;
    }
    if (changed) await writeFile(commandsPath, `${JSON.stringify(commands, undefined, 2)}\n`, "utf8");
  }
  private run(command: string, args: string[], cwd: string, bin: string, environment: NodeJS.ProcessEnv = process.env) { return new Promise<void>((resolveRun, reject) => { const child = spawn(command, args, { cwd, windowsHide: true, env: { ...environment, PATH: `${bin}${delimiter}${this.environmentPath(environment)}` } }); this.activeCommand = child; let log = ""; child.stdout.on("data", b => { log += b; this.emit({ type: "language_server_progress", stage: "configuring", detail: String(b) }); }); child.stderr.on("data", b => { log += b; this.emit({ type: "language_server_progress", stage: "configuring", detail: String(b) }); }); child.once("error", reject); child.once("close", code => { if (this.activeCommand === child) this.activeCommand = undefined; code === 0 ? resolveRun() : reject(new Error(log || `CMake exited with ${code}`)); }); }); }
  private async start(entry: Entry, clangd: string, commandsDir: string, bin: string, environment: NodeJS.ProcessEnv = process.env) {
    if (!existsSync(clangd)) throw new Error("Managed clangd is unavailable");
    entry.status = "starting"; this.publish(entry);
    // Keep background indexing, but make interactive completion/diagnostics
    // win on large projects. PCHs stay on disk rather than inflating the
    // long-lived language-service process.
    const child = spawn(clangd, ["--background-index", "--background-index-priority=background", "--pch-storage=disk", "-j", "2", `--compile-commands-dir=${commandsDir}`], { cwd: entry.root, windowsHide: true, stdio: "pipe", env: { ...environment, PATH: `${bin}${delimiter}${this.environmentPath(environment)}` } });
    entry.child = child; entry.status = "indexing"; this.publish(entry);
    let buffer = Buffer.alloc(0);
    const fail = (cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      entry.status = "failed"; entry.error = error.message; this.publish(entry);
      for (const pending of entry.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
      entry.pending.clear(); child.kill();
    };
    child.stdin.on("error", (cause) => { if (entry.status !== "stopped") fail(cause); });
    child.stderr.on("data", (data: Buffer) => {
      // clangd's stderr is diagnostic-only. Keep a bounded tail so a request
      // timeout can be investigated without altering its scheduling or I/O.
      entry.stderrTail = `${entry.stderrTail}${data.toString("utf8")}`.slice(-8_192);
    });
    child.stdout.on("data", (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      for (;;) {
        const headerEnd = buffer.indexOf("\r\n\r\n"); if (headerEnd < 0) break;
        const header = buffer.subarray(0, headerEnd).toString("ascii"); const length = /Content-Length: (\d+)/i.exec(header)?.[1];
        if (!length) { buffer = buffer.subarray(headerEnd + 4); continue; }
        const bodyStart = headerEnd + 4; const bodyEnd = bodyStart + Number(length); if (buffer.length < bodyEnd) break;
        const payload = buffer.subarray(bodyStart, bodyEnd).toString("utf8"); buffer = buffer.subarray(bodyEnd);
        try {
          const message = JSON.parse(payload) as { id?: number; method?: unknown; params?: { diagnostics?: unknown; token?: unknown; uri?: unknown; value?: { kind?: unknown; message?: unknown; percentage?: unknown } }; result?: unknown; error?: { message?: string } };
          if (message.method === "window/workDoneProgress/create" && typeof message.id === "number") {
            const response = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: null });
            child.stdin.write(`Content-Length: ${Buffer.byteLength(response)}\r\n\r\n${response}`);
            continue;
          }
          if (message.method === "$/progress" && message.params?.token === "backgroundIndexProgress") {
            const progress = message.params.value;
            if (progress?.kind === "report" && entry.status === "indexing" && typeof progress.message === "string") {
              entry.indexProgress = progress.message;
              const now = Date.now();
              if (now - entry.lastIndexProgressAt >= 250) {
                entry.lastIndexProgressAt = now;
                this.publish(entry);
              }
            }
            if (progress?.kind === "end" && entry.status === "indexing") {
              entry.indexProgress = undefined;
              entry.status = "ready";
              this.publish(entry);
            }
            continue;
          }
          if (message.method === "textDocument/publishDiagnostics" && typeof message.params?.uri === "string" && Array.isArray(message.params.diagnostics)) {
            try {
              const file = fileURLToPath(message.params.uri);
              entry.diagnostics.set(file, message.params.diagnostics);
              this.emit({ type: "language_server_diagnostics", file, diagnostics: message.params.diagnostics });
            } catch { /* Ignore malformed server URIs. */ }
            continue;
          }
          if (typeof message.id !== "number") continue;
          const pending = entry.pending.get(message.id); if (!pending) continue;
          entry.pending.delete(message.id); clearTimeout(pending.timeout); this.record({ method: pending.method, phase: "response", timestamp: Date.now(), ...(pending.file ? { file: pending.file } : {}), ...(pending.version === undefined ? {} : { version: pending.version }), elapsedMs: Date.now() - pending.startedAt, ...(message.error ? { error: message.error.message ?? "clangd error" } : {}) }); message.error ? pending.reject(new Error(message.error.message ?? "clangd error")) : pending.resolve(message.result);
        } catch (cause) { fail(new Error(`Invalid clangd response: ${cause instanceof Error ? cause.message : String(cause)}`)); return; }
      }
    });
    child.once("error", fail);
    child.once("close", () => {
      if (entry.status === "stopped" || entry.status === "failed") return;
      entry.status = "stopped";
      this.publish(entry);
    });
    await this.request(entry, "initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(entry.root).href,
      capabilities: {
        window: { workDoneProgress: true },
        workspace: {
          didChangeWatchedFiles: { dynamicRegistration: false },
          symbol: { resolveSupport: { properties: ["location.range"] } },
        },
        textDocument: {
          callHierarchy: {},
          declaration: { linkSupport: true },
          definition: { linkSupport: true },
          implementation: { linkSupport: true },
          publishDiagnostics: { relatedInformation: true },
          typeDefinition: { linkSupport: true },
          typeHierarchy: {},
          semanticTokens: { formats: ["relative"], multilineTokenSupport: false, overlappingTokenSupport: false, requests: { full: true }, tokenModifiers: ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"], tokenTypes: ["namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator"] },
        },
      },
    });
    const initialized = JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }); child.stdin.write(`Content-Length: ${Buffer.byteLength(initialized)}\r\n\r\n${initialized}`);
    const bootstrapUri = await this.openIndexBootstrapDocument(entry, commandsDir);
    if (bootstrapUri) await this.enqueueNotification(entry, "textDocument/didClose", { textDocument: { uri: bootstrapUri } });
    // Background indexing is not an editor- or Skill-readiness barrier:
    // clangd can already serve opened translation units and provisional
    // workspace queries. Keep the authoritative project status at "indexing"
    // so every Skill result can identify itself as partial.
    if (!bootstrapUri && entry.status === "indexing") { entry.status = "ready"; this.publish(entry); }
    // The progress dialog must track the authoritative service lifecycle, not
    // merely the load RPC's return. This also covers a renderer IPC response
    // arriving after CMake/clangd have already completed successfully.
    this.emit({ type: "language_server_progress", stage: "ready", detail: bootstrapUri ? "C++ language service is ready; project indexing continues in the background" : "C++ language service is ready" });
  }
  private async openIndexBootstrapDocument(entry: Entry, commandsDir: string): Promise<string | undefined> {
    type CompileCommand = { directory?: unknown; file?: unknown };
    let commands: CompileCommand[];
    try {
      const value = JSON.parse(await readFile(join(commandsDir, "compile_commands.json"), "utf8")) as unknown;
      commands = Array.isArray(value) ? value as CompileCommand[] : [];
    } catch { commands = []; }
    if (!commands.length) return undefined;
    for (const command of commands) {
      if (typeof command.file !== "string") continue;
      const file = isAbsolute(command.file)
        ? command.file
        : resolve(typeof command.directory === "string" ? command.directory : entry.root, command.file);
      let canonical: string;
      try { canonical = await realpath(file); }
      catch { continue; }
      if (!isInside(entry.root, canonical)) continue;
      const uri = pathToFileURL(canonical).href;
      const opened = await this.enqueueNotification(entry, "textDocument/didOpen", {
        textDocument: { uri, languageId: "cpp", version: 0, text: await readFile(canonical, "utf8") },
      });
      if (opened) return uri;
    }
    throw new Error("The C++ compilation database contains no readable project translation unit");
  }
  request(entry: Entry, method: string, params: unknown): Promise<unknown> {
    if (!entry.child || entry.child.killed || entry.child.stdin.destroyed || !entry.child.stdin.writable) return Promise.reject(new Error("clangd is not running"));
    const id = entry.nextId++; const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolveRequest, reject) => {
      const metadata = this.traceMetadata(params); const startedAt = Date.now();
      const rejectPending = (error: Error) => {
        const pending = entry.pending.get(id); if (!pending) return;
        entry.pending.delete(id); clearTimeout(pending.timeout); this.record({ method, phase: /timed out/i.test(error.message) ? "timeout" : "write-error", timestamp: Date.now(), ...metadata, elapsedMs: Date.now() - startedAt, error: error.message }); pending.reject(error);
      };
      const timeout = setTimeout(() => {
        const stderr = entry.stderrTail.trim();
        rejectPending(new Error(`clangd request timed out (${method})${stderr ? `\nclangd stderr tail:\n${stderr}` : ""}`));
      }, method === "initialize" ? 15_000 : 5_000);
      entry.pending.set(id, { resolve: resolveRequest, reject, timeout, method, startedAt, ...metadata }); this.record({ method, phase: "request", timestamp: startedAt, ...metadata });
      entry.child!.stdin.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`, (cause) => {
        if (cause) rejectPending(cause instanceof Error ? cause : new Error(String(cause)));
      });
    });
  }
}

// This module is the built-in cpp-clangd language-plugin worker when launched
// by LanguageServerHost. Keeping the protocol here makes the C++ lifecycle
// independent of Electron's backend: the backend only forks this process and
// forwards opaque method calls/events.
type WorkerRequest = { args?: unknown[]; changes?: unknown; id?: unknown; method?: unknown; type?: unknown };
type WorkerResponse = { error?: string; id: number; result?: unknown; type: "response" };

if (typeof process.send === "function") {
  let service: CppService | undefined;
  const reply = (response: WorkerResponse) => process.send?.(response);
  process.on("message", (message: WorkerRequest) => {
    if (message.type === "workspace-files-changed") {
      if (!service || !Array.isArray(message.changes)) return;
      const changes = message.changes.flatMap((change): WorkspaceFileChange[] => {
        if (!change || typeof change !== "object") return [];
        const value = change as { path?: unknown; type?: unknown };
        return typeof value.path === "string" &&
          (value.type === 1 || value.type === 2 || value.type === 3)
          ? [{ path: value.path, type: value.type }]
          : [];
      });
      service.workspaceFilesChanged(changes);
      return;
    }
    if (message.type !== "request" || typeof message.id !== "number" || typeof message.method !== "string") return;
    void (async () => {
      try {
        if (message.method === "initialize") {
          const cachePath = message.args?.[0];
          if (typeof cachePath !== "string") throw new Error("Language worker cache path is required");
          service = new CppService(cachePath, (event) => process.send?.({ event, type: "event" }));
          reply({ id: message.id, result: undefined, type: "response" });
          return;
        }
        if (!service) throw new Error("Language worker is not initialized");
        const args = message.args ?? [];
        let result: unknown;
        switch (message.method) {
          case "load": result = await service.load(String(args[0] ?? "")); break;
          case "list": result = service.list(); break;
          case "trace": result = service.trace(); break;
          case "unload": result = await service.unload(String(args[0] ?? "")); break;
          case "restart": result = await service.restart(String(args[0] ?? "")); break;
          case "cancel": service.cancel(); break;
          case "terminalCommand": result = await service.terminalCommand(String(args[0] ?? ""), String(args[1] ?? "")); break;
          case "skill": result = await service.skill((args[0] && typeof args[0] === "object" ? args[0] : {}) as CppSkillRequest); break;
          case "debugSkill": result = await service.debugSkill((args[0] && typeof args[0] === "object" ? args[0] : {}) as CppDebugSkillRequest); break;
          case "lsp": result = await service.lsp(String(args[0] ?? ""), String(args[1] ?? ""), args[2]); break;
          case "notify": result = await service.notify(String(args[0] ?? ""), String(args[1] ?? ""), args[2]); break;
          case "debugStatus": result = service.debugStatus(typeof args[0] === "string" ? args[0] : undefined); break;
          case "debugSessions": result = service.debugSessions(); break;
          case "debugSelectSession": result = service.debugSelectSession(String(args[0] ?? "")); break;
          case "debugCloseSession": result = await service.debugCloseSession(String(args[0] ?? "")); break;
          case "debugDetachSession": result = await service.debugDetachSession(String(args[0] ?? "")); break;
          case "debugTargets": result = await service.debugTargets(String(args[0] ?? ""), args[1] === true, args[2]); break;
          case "debugConfigurations": result = await service.debugConfigurations(String(args[0] ?? ""), args[1], args[2] === true, args[3]); break;
          case "debugStart": result = await service.debugStart((args[0] && typeof args[0] === "object" ? args[0] : {}) as DebugStartConfiguration); break;
          case "debugStop": result = await service.debugStop(typeof args[0] === "string" ? args[0] : undefined); break;
          case "debugCommand": result = await service.debugCommand(String(args[0] ?? "") as "continue" | "pause" | "next" | "stepIn" | "stepOut", typeof args[1] === "string" ? args[1] : undefined); break;
          case "debugSetBreakpoints": result = await service.debugSetBreakpoints(String(args[0] ?? ""), Array.isArray(args[1]) ? args[1].filter((value): value is number => typeof value === "number") : []); break;
          case "debugClearBreakpoints": result = await service.debugClearBreakpoints(); break;
          case "debugSetFunctionBreakpoints": result = await service.debugSetFunctionBreakpoints(Array.isArray(args[0]) ? args[0].flatMap((item): Array<{ condition?: string; hitCondition?: string; name: string }> => {
            if (!item || typeof item !== "object") return [];
            const value = item as Record<string, unknown>;
            return typeof value.name === "string" ? [{ name: value.name, ...(typeof value.condition === "string" ? { condition: value.condition } : {}), ...(typeof value.hitCondition === "string" ? { hitCondition: value.hitCondition } : {}) }] : [];
          }) : []); break;
          case "debugSetExceptionFilters": result = await service.debugSetExceptionFilters(Array.isArray(args[0]) ? args[0].filter((item): item is string => typeof item === "string") : []); break;
          case "debugUpdateBreakpoint": result = await service.debugUpdateBreakpoint(String(args[0] ?? ""), Number(args[1]), args[2] && typeof args[2] === "object" ? args[2] as Record<string, unknown> : {}); break;
          case "debugSetWatches": result = await service.debugSetWatches(Array.isArray(args[0]) ? args[0].filter((value): value is string => typeof value === "string") : []); break;
          case "debugSelectFrame": result = await service.debugSelectFrame(Number(args[0]), Number(args[1]), typeof args[2] === "string" ? args[2] : undefined); break;
          case "debugVariables": result = await service.debugVariables(Number(args[0]), typeof args[1] === "string" ? args[1] : undefined); break;
          case "debugEvaluate": result = await service.debugEvaluate(String(args[0] ?? ""), args[1] === "watch" ? "watch" : "repl", typeof args[2] === "string" ? args[2] : undefined); break;
          case "debugSetVariable": result = await service.debugSetVariable(Number(args[0]), String(args[1] ?? ""), String(args[2] ?? ""), typeof args[3] === "string" ? args[3] : undefined); break;
          case "debugReadMemory": result = await service.debugReadMemory(String(args[0] ?? ""), Number(args[1] ?? 0), Number(args[2] ?? 256), typeof args[3] === "string" ? args[3] : undefined); break;
          case "debugWriteMemory": result = await service.debugWriteMemory(String(args[0] ?? ""), Number(args[1] ?? 0), Array.isArray(args[2]) ? args[2].filter((value): value is number => typeof value === "number") : [], typeof args[3] === "string" ? args[3] : undefined); break;
          case "debugDisassemble": result = await service.debugDisassemble(String(args[0] ?? ""), Number(args[1] ?? -32), Number(args[2] ?? 64), Number(args[3] ?? 0), typeof args[4] === "string" ? args[4] : undefined); break;
          case "debugSetInstructionBreakpoints": result = await service.debugSetInstructionBreakpoints(Array.isArray(args[0]) ? args[0].filter((value): value is string => typeof value === "string") : [], typeof args[1] === "string" ? args[1] : undefined); break;
          case "debugClearOutput": result = service.debugClearOutput(typeof args[0] === "string" ? args[0] : undefined); break;
          case "debugProcesses": result = await service.debugProcesses(); break;
          case "shutdown": service.shutdown(); break;
          default: throw new Error(`Unknown language worker method: ${message.method}`);
        }
        reply({ id: message.id, result, type: "response" });
      } catch (cause) {
        reply({ error: cause instanceof Error ? cause.message : String(cause), id: message.id, type: "response" });
      }
    })();
  });
}
