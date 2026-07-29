import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve } from "node:path";

type DapRequest = { arguments?: unknown; command: string; seq: number; type: "request" };
type DapResponse = { body?: unknown; command?: string; message?: string; request_seq: number; success: boolean; type: "response" };
type DapEvent = { body?: unknown; event: string; type: "event" };
type DapMessage = DapResponse | DapEvent;

export type DebugBreakpoint = {
  condition?: string;
  enabled: boolean;
  file: string;
  hitCondition?: string;
  line: number;
  logMessage?: string;
  verified?: boolean;
  message?: string;
};
export type DebugVariable = { evaluateName?: string; memoryReference?: string; name: string; type?: string; value: string; variablesReference: number };
export type DebugEvaluation = { expression: string; memoryReference?: string; result: string; type?: string; variablesReference: number };
export type DebugExceptionBreakpointFilter = { default?: boolean; filter: string; label: string };
export type DebugFunctionBreakpoint = { condition?: string; hitCondition?: string; message?: string; name: string; verified?: boolean };
export type DebugScope = { expensive: boolean; name: string; presentationHint?: string; variables: DebugVariable[]; variablesReference: number };
export type DebugStackFrame = { column?: number; file?: string; id: number; instructionPointerReference?: string; line?: number; name: string; scopes: DebugScope[] };
export type DebugThread = { id: number; name: string; frames: DebugStackFrame[] };
export type DebugWatch = { expression: string; error?: string; memoryReference?: string; type?: string; value?: string; variablesReference?: number };
export type DebugInstruction = { address: string; column?: number; endColumn?: number; endLine?: number; instruction: string; instructionBytes?: string; line?: number; location?: { name?: string; path?: string }; symbol?: string };
export type DebugInstructionBreakpoint = { address: string; message?: string; verified?: boolean };
export type DebugMemory = { address: string; bytes: number[]; offset: number; unreadableBytes: number };
export type DebugMemoryWrite = DebugMemory & { bytesWritten: number };
export type DebugSnapshot = {
  adapter?: "lldb";
  breakpoints: DebugBreakpoint[];
  capabilities: Record<string, boolean>;
  error?: string;
  output: string;
  exceptionBreakpointFilters: DebugExceptionBreakpointFilter[];
  exceptionFilters: string[];
  functionBreakpoints: DebugFunctionBreakpoint[];
  instructionBreakpoints: DebugInstructionBreakpoint[];
  selectedFrameId?: number;
  selectedThreadId?: number;
  sessionKind: "live" | "dump";
  state: "idle" | "starting" | "running" | "stopped" | "terminated" | "failed";
  stopReason?: string;
  stopReasonKind?: string;
  threads: DebugThread[];
  watches: DebugWatch[];
};

export type DebugStartConfiguration = {
  args?: string[];
  cwd?: string;
  dumpPath?: string;
  mode?: "launch" | "attach" | "dump";
  processId?: number;
  program?: string;
  root: string;
  sourceMap?: Record<string, string>;
  stopOnEntry?: boolean;
  symbolPaths?: string[];
};

type Pending = { command: string; reject(error: Error): void; resolve(value: unknown): void; timeout: ReturnType<typeof setTimeout> };

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function commandExists(command: string): boolean {
  if (isAbsolute(command)) return existsSync(command);
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [command], { stdio: "ignore", windowsHide: true }).status === 0;
}

export type DebugAdapterLaunch = { adapter: "lldb"; args: string[]; command: string };

export function systemDebugAdapterLaunch(): DebugAdapterLaunch {
  if (process.platform === "win32") {
    for (const command of ["codelldb.exe", "codelldb"]) {
      if (commandExists(command)) return { adapter: "lldb", args: [], command };
    }
    throw new Error("CodeLLDB is unavailable. Retry to provision Agent K's private debugger cache.");
  }
  for (const command of ["lldb-dap", "lldb-vscode"]) {
    if (commandExists(command)) return { adapter: "lldb", args: [], command };
  }
  throw new Error("LLDB DAP adapter is unavailable. Install lldb-dap and place it on PATH.");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function visibleDebugOutput(value: string): string {
  return value.replace(
    /^(?:\[stderr\] )?warning: \([^)]+\) .+ No LZMA support found for reading \.gnu_debugdata section\r?\n?/gm,
    "",
  );
}

export function boundedDebugOutput(previous: string, value: string): string {
  const normalized = visibleDebugOutput(`${previous}${value}`);
  const parts = normalized.split("\n");
  const maximumParts = parts.at(-1) === "" ? 3_001 : 3_000;
  return (parts.length > maximumParts ? parts.slice(-maximumParts).join("\n") : normalized).slice(-200_000);
}

function lldbArgument(value: string): string {
  if (/\r|\n/.test(value)) throw new Error("Debugger paths cannot contain newlines");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export class DebugSession {
  private readonly emit: (snapshot: DebugSnapshot) => void;
  private readonly resolveAdapter: () => DebugAdapterLaunch;
  private child?: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextSequence = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly breakpoints = new Map<string, DebugBreakpoint[]>();
  private capabilities: Record<string, boolean> = {};
  private exceptionBreakpointFilters: DebugExceptionBreakpointFilter[] = [];
  private exceptionFilters: string[] = [];
  private exceptionFiltersConfigured = false;
  private functionBreakpoints: DebugFunctionBreakpoint[] = [];
  private instructionBreakpoints: DebugInstructionBreakpoint[] = [];
  private output = "";
  private selectedFrameId?: number;
  private selectedThreadId?: number;
  private state: DebugSnapshot["state"] = "idle";
  private stopRevision = 0;
  private stopReason?: string;
  private stopReasonKind?: string;
  private threads: DebugThread[] = [];
  private watches: string[] = [];
  private watchResults: DebugWatch[] = [];
  private adapter?: "lldb";
  private error?: string;
  private initialized?: { promise: Promise<void>; resolve(): void };
  private root?: string;
  private sessionKind: "live" | "dump" = "live";

  constructor(emit: (snapshot: DebugSnapshot) => void, resolveAdapter: () => DebugAdapterLaunch = systemDebugAdapterLaunch) {
    this.emit = emit;
    this.resolveAdapter = resolveAdapter;
  }

  snapshot(): DebugSnapshot {
    return {
      ...(this.adapter ? { adapter: this.adapter } : {}),
      breakpoints: [...this.breakpoints.values()].flat(),
      capabilities: { ...this.capabilities },
      ...(this.error ? { error: this.error } : {}),
      output: this.output,
      exceptionBreakpointFilters: this.exceptionBreakpointFilters,
      exceptionFilters: this.exceptionFilters,
      functionBreakpoints: this.functionBreakpoints,
      instructionBreakpoints: this.instructionBreakpoints,
      ...(this.selectedFrameId === undefined ? {} : { selectedFrameId: this.selectedFrameId }),
      ...(this.selectedThreadId === undefined ? {} : { selectedThreadId: this.selectedThreadId }),
      sessionKind: this.sessionKind,
      state: this.state,
      ...(this.stopReason ? { stopReason: this.stopReason } : {}),
      ...(this.stopReasonKind ? { stopReasonKind: this.stopReasonKind } : {}),
      threads: this.threads,
      watches: this.watchResults,
    };
  }

  async start(input: DebugStartConfiguration, trustedProgramRoots: string[] = []): Promise<DebugSnapshot> {
    if (this.child) await this.stop();
    const root = await realpath(input.root);
    this.root = root;
    for (const file of this.breakpoints.keys()) {
      if (!isInside(root, file)) this.breakpoints.delete(file);
    }
    const mode = input.mode ?? "launch";
    const cwd = await realpath(resolve(root, input.cwd ?? root));
    if (!isInside(root, cwd)) throw new Error("Debug working directory must stay inside the workspace");
    let program: string | undefined;
    let dumpPath: string | undefined;
    if (mode === "launch") {
      if (!input.program) throw new Error("A program is required for launch debugging");
      program = await realpath(resolve(root, input.program));
      const allowedRoots = [root, ...await Promise.all(trustedProgramRoots.map((path) => realpath(path)))];
      if (!allowedRoots.some((allowedRoot) => isInside(allowedRoot, program)))
        throw new Error("Debug program must stay inside the workspace or its trusted CMake build directory");
    } else if (mode === "attach" && (!Number.isInteger(input.processId) || (input.processId ?? 0) <= 0)) {
      throw new Error("A valid process id is required for attach debugging");
    } else if (mode === "dump") {
      if (!input.dumpPath) throw new Error("A dump file is required for dump debugging");
      dumpPath = await realpath(resolve(root, input.dumpPath));
    }

    const launch = this.resolveAdapter();
    this.adapter = launch.adapter;
    this.sessionKind = mode === "dump" ? "dump" : "live";
    this.instructionBreakpoints = [];
    if (mode === "dump") {
      if (!input.program) throw new Error("A matching executable is required for LLDB core debugging");
      program = await realpath(resolve(root, input.program));
    }
    const symbolPaths = await Promise.all((input.symbolPaths ?? []).map((path) => realpath(resolve(root, path))));
    const sourceMap = Object.fromEntries(Object.entries(input.sourceMap ?? {}).filter(([from, to]) => Boolean(from.trim()) && Boolean(to.trim())));
    this.error = undefined;
    this.output = "";
    this.stopReason = undefined;
    this.stopReasonKind = undefined;
    this.threads = [];
    this.watchResults = [];
    this.state = "starting";
    this.stopRevision += 1;
    let resolveInitialized = () => undefined;
    const initializedPromise = new Promise<void>((resolveEvent) => { resolveInitialized = resolveEvent; });
    this.initialized = { promise: initializedPromise, resolve: resolveInitialized };
    this.publish();
    const child = spawn(launch.command, launch.args, {
      cwd,
      env: { ...process.env, PATH: process.env.PATH?.split(delimiter).filter(Boolean).join(delimiter) },
      stdio: "pipe",
      windowsHide: true,
    });
    this.child = child;
    child.stdout.on("data", (data: Buffer) => this.consume(data));
    child.stderr.on("data", (data: Buffer) => this.appendOutput(data.toString("utf8")));
    child.once("error", (cause) => this.fail(cause));
    child.once("close", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.state !== "failed") this.state = "terminated";
      this.root = undefined;
      this.appendOutput(`\n[debug adapter exited: ${code ?? signal ?? "unknown"}]\n`);
      this.rejectPending(new Error("Debug adapter exited"));
      this.publish();
    });

    try {
      const initialized = record(await this.request("initialize", {
        adapterID: "lldb",
        clientID: "agent-k",
        clientName: "Agent K",
        columnsStartAt1: true,
        linesStartAt1: true,
        pathFormat: "path",
        supportsMemoryReferences: true,
        supportsRunInTerminalRequest: false,
        supportsVariablePaging: true,
        supportsVariableType: true,
      }, 15_000));
      this.capabilities = Object.fromEntries(Object.entries(initialized).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
      this.exceptionBreakpointFilters = (Array.isArray(initialized.exceptionBreakpointFilters) ? initialized.exceptionBreakpointFilters : []).flatMap((item): DebugExceptionBreakpointFilter[] => {
        const value = record(item);
        const filter = text(value.filter);
        const label = text(value.label);
        return filter && label ? [{ filter, label, ...(value.default === true ? { default: true } : {}) }] : [];
      });
      const supportedExceptionFilters = new Set(this.exceptionBreakpointFilters.map((item) => item.filter));
      if (this.exceptionFiltersConfigured)
        this.exceptionFilters = this.exceptionFilters.filter((filter) => supportedExceptionFilters.has(filter));
      else
        this.exceptionFilters = this.exceptionBreakpointFilters.filter((item) => item.default).map((item) => item.filter);
      const startCommand: "attach" | "launch" = mode === "attach" || mode === "dump" ? "attach" : "launch";
      const startArguments = mode === "launch"
        ? {
          args: input.args ?? [],
          cwd,
          expressions: "native",
          name: program?.split(/[\\/]/).pop() ?? "program",
          program,
          request: "launch",
          stopOnEntry: input.stopOnEntry === true,
          // Agent K talks to CodeLLDB directly and does not provide VS Code's
          // runInTerminal reverse request. Without an explicit console on
          // Windows the debuggee can inherit the adapter's DAP stdout pipe,
          // interleaving ordinary program output with protocol frames.
          terminal: "console",
        }
        : mode === "attach" ? {
          expressions: "native",
          pid: input.processId,
          processId: input.processId,
          request: "attach",
        } : {
          expressions: "native",
          initCommands: symbolPaths.length ? [`settings set target.debug-file-search-paths ${symbolPaths.map(lldbArgument).join(" ")}`] : [],
          processCreateCommands: [],
          program,
          request: "attach",
          sourceMap,
          targetCreateCommands: [`target create --core ${lldbArgument(dumpPath!)} ${lldbArgument(program!)}`],
        };
      const startRequest = this.request(startCommand, startArguments, 30_000);
      let initializedTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.initialized.promise,
          new Promise<never>((_, reject) => {
            initializedTimeout = setTimeout(() => reject(new Error("Debug adapter did not initialize the session")), 15_000);
          }),
        ]);
      } finally {
        if (initializedTimeout) clearTimeout(initializedTimeout);
      }
      await this.syncAllBreakpoints();
      await this.syncFunctionBreakpoints();
      await this.syncExceptionBreakpoints();
      await this.syncInstructionBreakpoints();
      if (this.capabilities.supportsConfigurationDoneRequest === true)
        await this.request("configurationDone", {}, 15_000);
      await startRequest;
      if (this.state === "starting") this.state = mode === "dump" || input.stopOnEntry ? "stopped" : "running";
      if (mode === "dump" && this.threads.length === 0) await this.refreshStoppedState();
      this.publish();
      return this.snapshot();
    } catch (cause) {
      this.fail(cause);
      throw cause;
    }
  }

  async stop(): Promise<DebugSnapshot> {
    return this.disconnect(this.sessionKind !== "dump");
  }

  async detach(): Promise<DebugSnapshot> {
    if (this.sessionKind === "dump") throw new Error("Dump sessions do not have a live process to detach");
    return this.disconnect(false);
  }

  private async disconnect(terminateDebuggee: boolean): Promise<DebugSnapshot> {
    const child = this.child;
    if (!child) {
      this.state = "terminated";
      this.root = undefined;
      this.publish();
      return this.snapshot();
    }
    try { await this.request("disconnect", { restart: false, terminateDebuggee }, 5_000); }
    catch { child.kill(); }
    if (this.child === child) {
      this.child = undefined;
      child.kill();
    }
    this.rejectPending(new Error("Debug session stopped"));
    this.state = "terminated";
    this.root = undefined;
    this.threads = [];
    this.publish();
    return this.snapshot();
  }

  async command(command: "continue" | "pause" | "next" | "stepIn" | "stepOut"): Promise<DebugSnapshot> {
    if (!this.child) throw new Error("No active debug session");
    if (this.sessionKind === "dump") throw new Error("Dump sessions are read-only and cannot continue or step");
    let threadId = this.selectedThreadId ?? this.threads[0]?.id;
    if (threadId === undefined && command === "pause") {
      const body = record(await this.request("threads", {}));
      const first = Array.isArray(body.threads) ? record(body.threads[0]) : {};
      threadId = number(first.id);
      this.selectedThreadId = threadId;
    }
    if (threadId === undefined) throw new Error("No debug thread is selected");
    await this.request(command, { singleThread: false, threadId });
    if (command !== "pause") {
      this.state = "running";
      this.stopReason = undefined;
      this.stopReasonKind = undefined;
      this.threads = [];
    }
    this.publish();
    return this.snapshot();
  }

  async setBreakpoints(file: string, lines: number[]): Promise<DebugSnapshot> {
    const canonical = existsSync(file) ? await realpath(file) : resolve(file);
    if (this.root && !isInside(this.root, canonical))
      throw new Error("Debug breakpoint must stay inside the active workspace");
    const normalized = [...new Set(lines.filter((line) => Number.isInteger(line) && line > 0))].sort((a, b) => a - b);
    const existing = this.breakpoints.get(canonical) ?? [];
    if (normalized.length) this.breakpoints.set(canonical, normalized.map((line) => existing.find((item) => item.line === line) ?? { enabled: true, file: canonical, line }));
    else this.breakpoints.delete(canonical);
    if (this.child) await this.syncBreakpoints(canonical, normalized);
    this.publish();
    return this.snapshot();
  }

  async updateBreakpoint(file: string, line: number, changes: Partial<Pick<DebugBreakpoint, "condition" | "enabled" | "hitCondition" | "logMessage">>): Promise<DebugSnapshot> {
    const canonical = existsSync(file) ? await realpath(file) : resolve(file);
    if (this.root && !isInside(this.root, canonical)) throw new Error("Debug breakpoint must stay inside the active workspace");
    const existing = this.breakpoints.get(canonical) ?? [];
    const index = existing.findIndex((item) => item.line === line);
    if (index < 0) throw new Error("The breakpoint no longer exists");
    const optional = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
    const current = existing[index]!;
    existing[index] = {
      enabled: typeof changes.enabled === "boolean" ? changes.enabled : current.enabled,
      file: canonical,
      line,
      ...(optional(changes.condition ?? current.condition) ? { condition: optional(changes.condition ?? current.condition) } : {}),
      ...(optional(changes.hitCondition ?? current.hitCondition) ? { hitCondition: optional(changes.hitCondition ?? current.hitCondition) } : {}),
      ...(optional(changes.logMessage ?? current.logMessage) ? { logMessage: optional(changes.logMessage ?? current.logMessage) } : {}),
    };
    this.breakpoints.set(canonical, existing);
    if (this.child) await this.syncBreakpoints(canonical, existing.map((item) => item.line));
    this.publish();
    return this.snapshot();
  }

  async clearBreakpoints(): Promise<DebugSnapshot> {
    const files = [...this.breakpoints.keys()];
    for (const file of files) {
      this.breakpoints.delete(file);
      if (this.child) await this.syncBreakpoints(file, []);
    }
    this.publish();
    return this.snapshot();
  }

  async setFunctionBreakpoints(inputs: Array<{ condition?: string; hitCondition?: string; name: string }>): Promise<DebugSnapshot> {
    this.functionBreakpoints = inputs.flatMap((input): DebugFunctionBreakpoint[] => {
      const name = input.name.trim();
      if (!name) return [];
      return [{
        name,
        ...(input.condition?.trim() ? { condition: input.condition.trim() } : {}),
        ...(input.hitCondition?.trim() ? { hitCondition: input.hitCondition.trim() } : {}),
      }];
    });
    if (this.child) await this.syncFunctionBreakpoints();
    this.publish();
    return this.snapshot();
  }

  async setExceptionFilters(filters: string[]): Promise<DebugSnapshot> {
    const supported = new Set(this.exceptionBreakpointFilters.map((item) => item.filter));
    this.exceptionFiltersConfigured = true;
    this.exceptionFilters = [...new Set(filters.map((filter) => filter.trim()).filter((filter) => filter && (!supported.size || supported.has(filter))))];
    if (this.child) await this.syncExceptionBreakpoints();
    this.publish();
    return this.snapshot();
  }

  async setWatches(expressions: string[]): Promise<DebugSnapshot> {
    this.watches = [...new Set(expressions.map((value) => value.trim()).filter(Boolean))];
    await this.refreshWatches();
    this.publish();
    return this.snapshot();
  }

  async selectFrame(threadId: number, frameId: number): Promise<DebugSnapshot> {
    this.selectedThreadId = threadId;
    this.selectedFrameId = frameId;
    await this.refreshFrameScopes();
    await this.refreshWatches();
    this.publish();
    return this.snapshot();
  }

  async expandVariables(variablesReference: number): Promise<DebugVariable[]> {
    if (this.state !== "stopped") throw new Error("Variables are only available while debugging is paused");
    if (!Number.isInteger(variablesReference) || variablesReference <= 0) throw new Error("Invalid variable reference");
    return this.variables(variablesReference);
  }

  async evaluate(expressionInput: string, context: "repl" | "watch" = "repl"): Promise<DebugEvaluation> {
    const expression = expressionInput.trim();
    if (!expression) throw new Error("An expression is required");
    if (this.state !== "stopped" || this.selectedFrameId === undefined)
      throw new Error("Expressions are only available while debugging is paused");
    try {
      const body = record(await this.request("evaluate", { context, expression, frameId: this.selectedFrameId }));
      const evaluation = {
        expression,
        ...(text(body.memoryReference) ? { memoryReference: text(body.memoryReference) } : {}),
        result: text(body.result) ?? "",
        ...(text(body.type) ? { type: text(body.type) } : {}),
        variablesReference: number(body.variablesReference) ?? 0,
      };
      if (context === "repl") this.appendOutput(`\n> ${expression}\n${evaluation.result}\n`);
      return evaluation;
    } catch (cause) {
      if (context === "repl") this.appendOutput(`\n> ${expression}\n${cause instanceof Error ? cause.message : String(cause)}\n`);
      throw cause;
    }
  }

  async setVariable(variablesReference: number, nameInput: string, value: string): Promise<DebugSnapshot> {
    const name = nameInput.trim();
    if (this.state !== "stopped") throw new Error("Variables can only be changed while debugging is paused");
    if (this.sessionKind === "dump") throw new Error("Dump sessions are read-only");
    if (this.capabilities.supportsSetVariable !== true) throw new Error("The active debugger does not support changing variables");
    if (!Number.isInteger(variablesReference) || variablesReference <= 0 || !name) throw new Error("Invalid variable assignment");
    await this.request("setVariable", { name, value, variablesReference });
    await this.refreshFrameScopes();
    await this.refreshWatches();
    this.publish();
    return this.snapshot();
  }

  async readMemory(memoryReferenceInput: string, offsetInput = 0, countInput = 256): Promise<DebugMemory> {
    const memoryReference = memoryReferenceInput.trim();
    const offset = Number.isInteger(offsetInput) ? offsetInput : 0;
    const count = Number.isInteger(countInput) ? Math.max(1, Math.min(65_536, countInput)) : 256;
    if (this.state !== "stopped") throw new Error("Memory is only available while debugging is paused");
    if (this.capabilities.supportsReadMemoryRequest !== true) throw new Error("The active debugger does not support reading memory");
    if (!memoryReference) throw new Error("A memory reference or address is required");
    const body = record(await this.request("readMemory", { count, memoryReference, offset }));
    const encoded = text(body.data) ?? "";
    let bytes: number[];
    try {
      if (encoded && (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0)) throw new Error("invalid base64");
      bytes = [...Buffer.from(encoded, "base64")];
    }
    catch { throw new Error("The debugger returned invalid memory data"); }
    return { address: text(body.address) ?? memoryReference, bytes, offset, unreadableBytes: number(body.unreadableBytes) ?? Math.max(0, count - bytes.length) };
  }

  async writeMemory(memoryReferenceInput: string, offsetInput: number, bytesInput: number[]): Promise<DebugMemoryWrite> {
    const memoryReference = memoryReferenceInput.trim();
    const offset = Number.isInteger(offsetInput) ? offsetInput : 0;
    const bytes = bytesInput.filter((value) => Number.isInteger(value) && value >= 0 && value <= 255);
    if (this.state !== "stopped") throw new Error("Memory can only be changed while debugging is paused");
    if (this.sessionKind === "dump") throw new Error("Dump sessions are read-only");
    if (this.capabilities.supportsWriteMemoryRequest !== true) throw new Error("The active debugger does not support writing memory");
    if (!memoryReference || !bytes.length || bytes.length !== bytesInput.length) throw new Error("Invalid memory write");
    const body = record(await this.request("writeMemory", { allowPartial: true, data: Buffer.from(bytes).toString("base64"), memoryReference, offset }));
    const bytesWritten = Math.max(0, Math.min(bytes.length, number(body.bytesWritten) ?? bytes.length));
    const refreshed = await this.readMemory(memoryReference, offset, bytes.length);
    return { ...refreshed, bytesWritten };
  }

  async disassemble(memoryReferenceInput: string, instructionOffsetInput = -32, instructionCountInput = 64, offsetInput = 0): Promise<DebugInstruction[]> {
    const memoryReference = memoryReferenceInput.trim();
    const instructionOffset = Number.isInteger(instructionOffsetInput) ? instructionOffsetInput : -32;
    const instructionCount = Number.isInteger(instructionCountInput) ? Math.max(1, Math.min(1_000, instructionCountInput)) : 64;
    const offset = Number.isInteger(offsetInput) ? offsetInput : 0;
    if (this.state !== "stopped") throw new Error("Disassembly is only available while debugging is paused");
    if (this.capabilities.supportsDisassembleRequest !== true) throw new Error("The active debugger does not support disassembly");
    if (!memoryReference) throw new Error("An instruction address is required");
    const body = record(await this.request("disassemble", { instructionCount, instructionOffset, memoryReference, offset, resolveSymbols: true }));
    return (Array.isArray(body.instructions) ? body.instructions : []).flatMap((item): DebugInstruction[] => {
      const value = record(item);
      const address = text(value.address);
      const instruction = text(value.instruction);
      if (!address || instruction === undefined) return [];
      const location = record(value.location);
      return [{
        address,
        ...(number(value.column) === undefined ? {} : { column: number(value.column) }),
        ...(number(value.endColumn) === undefined ? {} : { endColumn: number(value.endColumn) }),
        ...(number(value.endLine) === undefined ? {} : { endLine: number(value.endLine) }),
        instruction,
        ...(text(value.instructionBytes) ? { instructionBytes: text(value.instructionBytes) } : {}),
        ...(number(value.line) === undefined ? {} : { line: number(value.line) }),
        ...(Object.keys(location).length ? { location: { ...(text(location.name) ? { name: text(location.name) } : {}), ...(text(location.path) ? { path: text(location.path) } : {}) } } : {}),
        ...(text(value.symbol) ? { symbol: text(value.symbol) } : {}),
      }];
    });
  }

  async setInstructionBreakpoints(addressesInput: string[]): Promise<DebugSnapshot> {
    if (this.sessionKind === "dump") throw new Error("Dump sessions are read-only");
    if (this.capabilities.supportsInstructionBreakpoints !== true) throw new Error("The active debugger does not support instruction breakpoints");
    this.instructionBreakpoints = [...new Set(addressesInput.map((value) => value.trim()).filter(Boolean))].map((address) => ({ address }));
    if (this.child) await this.syncInstructionBreakpoints();
    this.publish();
    return this.snapshot();
  }

  clearOutput(): DebugSnapshot {
    this.output = "";
    this.publish();
    return this.snapshot();
  }

  shutdown(): void {
    const child = this.child;
    this.child = undefined;
    this.rejectPending(new Error("Debug service shut down"));
    child?.kill();
  }

  private publish(): void {
    this.emit(this.snapshot());
  }

  private appendOutput(value: string): void {
    this.output = boundedDebugOutput(this.output, value);
    this.publish();
  }

  private fail(cause: unknown): void {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    this.error = error.message;
    this.state = "failed";
    this.rejectPending(error);
    this.child?.kill();
    this.child = undefined;
    this.publish();
  }

  private rejectPending(error: Error): void {
    for (const item of this.pending.values()) {
      clearTimeout(item.timeout);
      item.reject(error);
    }
    this.pending.clear();
  }

  private request(command: string, args: unknown, timeoutMs = 10_000): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin.writable) return Promise.reject(new Error("Debug adapter is not running"));
    const seq = this.nextSequence++;
    const message: DapRequest = { arguments: args, command, seq, type: "request" };
    const json = JSON.stringify(message);
    return new Promise((resolveRequest, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`Debug adapter request timed out: ${command}`));
      }, timeoutMs);
      this.pending.set(seq, { command, reject, resolve: resolveRequest, timeout });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`, (cause) => {
        if (!cause) return;
        const pending = this.pending.get(seq);
        if (!pending) return;
        this.pending.delete(seq);
        clearTimeout(pending.timeout);
        pending.reject(cause);
      });
    });
  }

  private consume(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
      if (!Number.isFinite(length)) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const start = headerEnd + 4;
      let payloadStart = start;
      // Some Windows adapters may still allow a debuggee to write into the
      // adapter pipe. Recover when that output lands between a DAP header and
      // its JSON body instead of treating the user's stdout as malformed JSON.
      if (this.buffer[payloadStart] !== 0x7b) {
        const candidate = this.buffer.indexOf(0x7b, payloadStart);
        if (candidate < 0 || this.buffer.length < candidate + length) return;
        payloadStart = candidate;
      }
      const end = payloadStart + length;
      if (this.buffer.length < end) return;
      if (payloadStart > start) this.appendOutput(this.buffer.subarray(start, payloadStart).toString("utf8"));
      const json = this.buffer.subarray(payloadStart, end).toString("utf8");
      this.buffer = this.buffer.subarray(end);
      try { this.handle(JSON.parse(json) as DapMessage); }
      catch (cause) { this.fail(new Error(`Invalid debug adapter response: ${String(cause)}`)); }
    }
  }

  private handle(message: DapMessage): void {
    if (message.type === "response") {
      const pending = this.pending.get(message.request_seq);
      if (!pending) return;
      this.pending.delete(message.request_seq);
      clearTimeout(pending.timeout);
      if (message.success) pending.resolve(message.body);
      else pending.reject(new Error(message.message ?? `${pending.command} failed`));
      return;
    }
    const body = record(message.body);
    if (message.event === "output") {
      const category = text(body.category);
      const prefix = category && category !== "stdout" && category !== "console" ? `[${category}] ` : "";
      this.appendOutput(`${prefix}${text(body.output) ?? ""}`);
      return;
    }
    if (message.event === "initialized") {
      this.initialized?.resolve();
      return;
    }
    if (message.event === "continued") {
      if (this.sessionKind === "dump" || this.state === "failed" || this.state === "terminated") return;
      this.stopRevision += 1;
      this.state = "running";
      this.error = undefined;
      this.stopReason = undefined;
      this.stopReasonKind = undefined;
      this.threads = [];
      this.publish();
      return;
    }
    if (message.event === "breakpoint") {
      const changed = record(body.breakpoint);
      const source = record(changed.source);
      const file = text(source.path);
      const line = number(changed.line);
      if (file && line !== undefined) {
        const existing = this.breakpoints.get(file);
        if (existing?.length) {
          const index = existing.findIndex((item) => item.line === line);
          if (index >= 0) existing[index] = {
            ...existing[index]!,
            file,
            line,
            ...(changed.verified === true || changed.verified === false ? { verified: changed.verified } : {}),
            ...(text(changed.message) ? { message: text(changed.message) } : {}),
          };
          this.publish();
        }
      }
      return;
    }
    if (message.event === "stopped") {
      if (this.state === "failed" || this.state === "terminated") return;
      const revision = ++this.stopRevision;
      this.state = "stopped";
      this.error = undefined;
      this.stopReasonKind = text(body.reason) ?? "paused";
      this.stopReason = text(body.description) ?? this.stopReasonKind;
      this.selectedThreadId = number(body.threadId);
      void this.refreshStoppedState(revision).catch((cause) => {
        // CodeLLDB cancels stack/variable requests when execution resumes.
        // Such a response belongs to the previous pause and must never kill
        // the adapter or overwrite the new running state.
        if (revision !== this.stopRevision || this.state !== "stopped") return;
        const message = cause instanceof Error ? cause.message : String(cause);
        if (/^<?cancel+ed>?$/iu.test(message.trim())) return;
        this.error = message;
        this.publish();
      });
      return;
    }
    if (message.event === "terminated" || message.event === "exited") {
      this.stopRevision += 1;
      this.state = "terminated";
      this.root = undefined;
      this.threads = [];
      this.publish();
      return;
    }
  }

  private async syncAllBreakpoints(): Promise<void> {
    for (const [file, breakpoints] of this.breakpoints) await this.syncBreakpoints(file, breakpoints.map((item) => item.line));
  }

  private async syncFunctionBreakpoints(): Promise<void> {
    const body = record(await this.request("setFunctionBreakpoints", {
      breakpoints: this.functionBreakpoints.map((item) => ({
        name: item.name,
        ...(item.condition ? { condition: item.condition } : {}),
        ...(item.hitCondition ? { hitCondition: item.hitCondition } : {}),
      })),
    }));
    const values = Array.isArray(body.breakpoints) ? body.breakpoints : [];
    this.functionBreakpoints = this.functionBreakpoints.map((item, index) => {
      const value = record(values[index]);
      return {
        ...item,
        ...(value.verified === true || value.verified === false ? { verified: value.verified } : {}),
        ...(text(value.message) ? { message: text(value.message) } : {}),
      };
    });
  }

  private async syncExceptionBreakpoints(): Promise<void> {
    await this.request("setExceptionBreakpoints", { filters: this.exceptionFilters });
  }

  private async syncInstructionBreakpoints(): Promise<void> {
    if (this.capabilities.supportsInstructionBreakpoints !== true) return;
    const body = record(await this.request("setInstructionBreakpoints", { breakpoints: this.instructionBreakpoints.map((item) => ({ instructionReference: item.address })) }));
    const values = Array.isArray(body.breakpoints) ? body.breakpoints : [];
    this.instructionBreakpoints = this.instructionBreakpoints.map((item, index) => {
      const value = record(values[index]);
      return { ...item, ...(value.verified === true || value.verified === false ? { verified: value.verified } : {}), ...(text(value.message) ? { message: text(value.message) } : {}) };
    });
  }

  private async syncBreakpoints(file: string, lines: number[]): Promise<void> {
    const configured = this.breakpoints.get(file) ?? lines.map((line) => ({ enabled: true, file, line }));
    const enabled = configured.filter((item) => item.enabled);
    const body = record(await this.request("setBreakpoints", {
      breakpoints: enabled.map((item) => ({
        line: item.line,
        ...(item.condition ? { condition: item.condition } : {}),
        ...(item.hitCondition ? { hitCondition: item.hitCondition } : {}),
        ...(item.logMessage ? { logMessage: item.logMessage } : {}),
      })),
      lines: enabled.map((item) => item.line),
      source: { name: file.split(/[\\/]/).pop(), path: file },
      sourceModified: false,
    }));
    const values = Array.isArray(body.breakpoints) ? body.breakpoints : [];
    let responseIndex = 0;
    const synchronized = configured.map((item) => {
      if (!item.enabled) return { ...item, verified: false, message: "Disabled" };
      const value = record(values[responseIndex++]);
      return {
        ...item,
        line: number(value.line) ?? item.line,
        ...(value.verified === true || value.verified === false ? { verified: value.verified } : {}),
        ...(text(value.message) ? { message: text(value.message) } : {}),
      };
    });
    if (synchronized.length) this.breakpoints.set(file, synchronized);
    else this.breakpoints.delete(file);
  }

  private async refreshStoppedState(revision?: number): Promise<void> {
    const current = (): boolean => revision === undefined || (revision === this.stopRevision && this.state === "stopped");
    const body = record(await this.request("threads", {}));
    if (!current()) return;
    const values = Array.isArray(body.threads) ? body.threads : [];
    this.threads = values.flatMap((item): DebugThread[] => {
      const value = record(item);
      const id = number(value.id);
      return id === undefined ? [] : [{ id, name: text(value.name) ?? `Thread ${id}`, frames: [] }];
    });
    this.selectedThreadId ??= this.threads[0]?.id;
    await Promise.all(this.threads.map(async (thread) => {
      const stack = record(await this.request("stackTrace", { levels: 40, startFrame: 0, threadId: thread.id }));
      if (!current()) return;
      thread.frames = (Array.isArray(stack.stackFrames) ? stack.stackFrames : []).flatMap((item): DebugStackFrame[] => {
        const value = record(item);
        const id = number(value.id);
        if (id === undefined) return [];
        const source = record(value.source);
        return [{
          ...(number(value.column) === undefined ? {} : { column: number(value.column) }),
          ...(text(source.path) ? { file: text(source.path) } : {}),
          id,
          ...(text(value.instructionPointerReference) ? { instructionPointerReference: text(value.instructionPointerReference) } : {}),
          ...(number(value.line) === undefined ? {} : { line: number(value.line) }),
          name: text(value.name) ?? `Frame ${id}`,
          scopes: [],
        }];
      });
    }));
    if (!current()) return;
    const selectedThread = this.threads.find((thread) => thread.id === this.selectedThreadId) ?? this.threads[0];
    this.selectedThreadId = selectedThread?.id;
    this.selectedFrameId = selectedThread?.frames[0]?.id;
    await this.refreshFrameScopes(revision);
    if (!current()) return;
    await this.refreshWatches(revision);
    if (current()) this.publish();
  }

  private async refreshFrameScopes(revision?: number): Promise<void> {
    const current = (): boolean => revision === undefined || (revision === this.stopRevision && this.state === "stopped");
    if (this.selectedFrameId === undefined) return;
    const frame = this.threads.flatMap((thread) => thread.frames).find((item) => item.id === this.selectedFrameId);
    if (!frame) return;
    const body = record(await this.request("scopes", { frameId: frame.id }));
    if (!current()) return;
    const scopes = Array.isArray(body.scopes) ? body.scopes : [];
    const nextScopes = await Promise.all(scopes.flatMap((item): Array<Promise<DebugScope>> => {
      const value = record(item);
      const variablesReference = number(value.variablesReference);
      if (variablesReference === undefined) return [];
      return [(async () => ({
        expensive: value.expensive === true,
        name: text(value.name) ?? "Variables",
        ...(text(value.presentationHint) ? { presentationHint: text(value.presentationHint) } : {}),
        variables: await this.variables(variablesReference),
        variablesReference,
      }))()];
    }));
    if (current()) frame.scopes = nextScopes;
  }

  private async variables(variablesReference: number): Promise<DebugVariable[]> {
    const body = record(await this.request("variables", { count: 500, start: 0, variablesReference }));
    return (Array.isArray(body.variables) ? body.variables : []).flatMap((item): DebugVariable[] => {
      const value = record(item);
      const name = text(value.name);
      const display = text(value.value);
      if (!name || display === undefined) return [];
      return [{
        ...(text(value.evaluateName) ? { evaluateName: text(value.evaluateName) } : {}),
        ...(text(value.memoryReference) ? { memoryReference: text(value.memoryReference) } : {}),
        name,
        ...(text(value.type) ? { type: text(value.type) } : {}),
        value: display,
        variablesReference: number(value.variablesReference) ?? 0,
      }];
    });
  }

  private async refreshWatches(revision?: number): Promise<void> {
    const current = (): boolean => revision === undefined || (revision === this.stopRevision && this.state === "stopped");
    if (this.state !== "stopped" || this.selectedFrameId === undefined) {
      if (!current()) return;
      this.watchResults = this.watches.map((expression) => ({ expression }));
      return;
    }
    const nextResults = await Promise.all(this.watches.map(async (expression): Promise<DebugWatch> => {
      try {
        const body = record(await this.request("evaluate", { context: "watch", expression, frameId: this.selectedFrameId }));
        return {
          expression,
          ...(text(body.memoryReference) ? { memoryReference: text(body.memoryReference) } : {}),
          ...(text(body.type) ? { type: text(body.type) } : {}),
          value: text(body.result) ?? "",
          variablesReference: number(body.variablesReference) ?? 0,
        };
      } catch (cause) {
        return { expression, error: cause instanceof Error ? cause.message : String(cause) };
      }
    }));
    if (current()) this.watchResults = nextResults;
  }
}
