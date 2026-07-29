import { basename } from "node:path";
import { DebugSession, type DebugAdapterLaunch, type DebugBreakpoint, type DebugSnapshot, type DebugStartConfiguration } from "./debug-session.ts";

export type ManagedDebugSnapshot = DebugSnapshot & { sessionId: string; sessionLabel: string };

export class DebugSessionManager {
  private readonly emit: (snapshot: DebugSnapshot | ManagedDebugSnapshot) => void;
  private readonly resolveAdapter: () => DebugAdapterLaunch;
  private readonly sessions = new Map<string, { label: string; session: DebugSession }>();
  private readonly template: DebugSession;
  private currentId?: string;
  private nextId = 1;

  constructor(emit: (snapshot: DebugSnapshot | ManagedDebugSnapshot) => void, resolveAdapter: () => DebugAdapterLaunch) {
    this.emit = emit;
    this.resolveAdapter = resolveAdapter;
    this.template = new DebugSession(() => undefined, resolveAdapter);
  }

  status(sessionId?: string): DebugSnapshot | ManagedDebugSnapshot {
    const entry = this.entry(sessionId, false);
    return entry ? this.managed(entry.id, entry.value) : this.template.snapshot();
  }

  list(): ManagedDebugSnapshot[] {
    return [...this.sessions].map(([id, value]) => this.managed(id, value));
  }

  select(sessionId: string): ManagedDebugSnapshot {
    const entry = this.entry(sessionId, true)!;
    this.currentId = entry.id;
    return this.managed(entry.id, entry.value);
  }

  async start(configuration: DebugStartConfiguration & { sessionName?: string }, trustedProgramRoots: string[] = []): Promise<ManagedDebugSnapshot> {
    const id = `debug-${this.nextId++}`;
    const label = configuration.sessionName?.trim() || (configuration.mode === "attach"
      ? `Process ${configuration.processId ?? "?"}`
      : configuration.mode === "dump" ? basename(configuration.dumpPath ?? "Dump") : basename(configuration.program ?? "Program"));
    let session!: DebugSession;
    session = new DebugSession((snapshot) => {
      if (this.sessions.get(id)?.session !== session) return;
      if (snapshot.state === "terminated") {
        this.sessions.delete(id);
        if (this.currentId === id) this.currentId = this.sessions.keys().next().value as string | undefined;
      }
      this.emit({ ...snapshot, sessionId: id, sessionLabel: label });
      if (snapshot.state === "terminated") queueMicrotask(() => session.shutdown());
    }, this.resolveAdapter);
    const value = { label, session };
    this.sessions.set(id, value);
    this.currentId = id;
    try {
      await this.applyTemplate(value.session);
      await value.session.start(configuration, trustedProgramRoots);
      return this.managed(id, value);
    } catch (cause) {
      value.session.shutdown();
      this.sessions.delete(id);
      this.currentId = this.sessions.keys().next().value as string | undefined;
      throw cause;
    }
  }

  async stop(sessionId?: string): Promise<ManagedDebugSnapshot> {
    const entry = this.entry(sessionId, true)!;
    await entry.value.session.stop();
    return this.managed(entry.id, entry.value);
  }

  async close(sessionId: string): Promise<DebugSnapshot | ManagedDebugSnapshot> {
    const entry = this.entry(sessionId, true)!;
    if (entry.value.session.snapshot().state !== "idle" && entry.value.session.snapshot().state !== "terminated")
      await entry.value.session.stop().catch(() => undefined);
    entry.value.session.shutdown();
    this.sessions.delete(entry.id);
    if (this.currentId === entry.id) this.currentId = this.sessions.keys().next().value as string | undefined;
    return this.status();
  }

  async detach(sessionId: string): Promise<DebugSnapshot | ManagedDebugSnapshot> {
    const entry = this.entry(sessionId, true)!;
    if (entry.value.session.snapshot().state !== "idle" && entry.value.session.snapshot().state !== "terminated")
      await entry.value.session.detach();
    entry.value.session.shutdown();
    this.sessions.delete(entry.id);
    if (this.currentId === entry.id) this.currentId = this.sessions.keys().next().value as string | undefined;
    return this.status();
  }

  command(command: "continue" | "pause" | "next" | "stepIn" | "stepOut", sessionId?: string) { return this.withSession(sessionId, (session) => session.command(command)); }
  selectFrame(threadId: number, frameId: number, sessionId?: string) { return this.withSession(sessionId, (session) => session.selectFrame(threadId, frameId)); }
  expandVariables(reference: number, sessionId?: string) { return this.requireSession(sessionId).expandVariables(reference); }
  evaluate(expression: string, context: "repl" | "watch", sessionId?: string) { return this.requireSession(sessionId).evaluate(expression, context); }
  setVariable(reference: number, name: string, value: string, sessionId?: string) { return this.withSession(sessionId, (session) => session.setVariable(reference, name, value)); }
  readMemory(reference: string, offset: number, count: number, sessionId?: string) { return this.requireSession(sessionId).readMemory(reference, offset, count); }
  writeMemory(reference: string, offset: number, bytes: number[], sessionId?: string) { return this.requireSession(sessionId).writeMemory(reference, offset, bytes); }
  disassemble(reference: string, instructionOffset: number, instructionCount: number, offset: number, sessionId?: string) { return this.requireSession(sessionId).disassemble(reference, instructionOffset, instructionCount, offset); }
  setInstructionBreakpoints(addresses: string[], sessionId?: string) { return this.withSession(sessionId, (session) => session.setInstructionBreakpoints(addresses)); }
  clearOutput(sessionId?: string) {
    const entry = this.entry(sessionId, true)!;
    entry.value.session.clearOutput();
    return this.managed(entry.id, entry.value);
  }

  async setBreakpoints(file: string, lines: number[]): Promise<DebugSnapshot | ManagedDebugSnapshot> {
    await this.template.setBreakpoints(file, lines);
    await Promise.all([...this.sessions.values()].map((value) => value.session.setBreakpoints(file, lines)));
    this.emit(this.template.snapshot());
    return this.status();
  }

  async updateBreakpoint(file: string, line: number, changes: Partial<Pick<DebugBreakpoint, "condition" | "enabled" | "hitCondition" | "logMessage">>): Promise<DebugSnapshot | ManagedDebugSnapshot> {
    await this.template.updateBreakpoint(file, line, changes);
    await Promise.all([...this.sessions.values()].map((value) => value.session.updateBreakpoint(file, line, changes)));
    this.emit(this.template.snapshot());
    return this.status();
  }

  async clearBreakpoints(): Promise<DebugSnapshot | ManagedDebugSnapshot> {
    await this.template.clearBreakpoints();
    await Promise.all([...this.sessions.values()].map((value) => value.session.clearBreakpoints()));
    this.emit(this.template.snapshot());
    return this.status();
  }

  async setFunctionBreakpoints(inputs: Array<{ condition?: string; hitCondition?: string; name: string }>): Promise<DebugSnapshot | ManagedDebugSnapshot> {
    await this.template.setFunctionBreakpoints(inputs);
    await Promise.all([...this.sessions.values()].map((value) => value.session.setFunctionBreakpoints(inputs)));
    this.emit(this.template.snapshot());
    return this.status();
  }

  async setExceptionFilters(filters: string[]): Promise<DebugSnapshot | ManagedDebugSnapshot> {
    await this.template.setExceptionFilters(filters);
    await Promise.all([...this.sessions.values()].map((value) => value.session.setExceptionFilters(filters)));
    this.emit(this.template.snapshot());
    return this.status();
  }

  async setWatches(expressions: string[]): Promise<DebugSnapshot | ManagedDebugSnapshot> {
    await this.template.setWatches(expressions);
    await Promise.all([...this.sessions.values()].map((value) => value.session.setWatches(expressions)));
    this.emit(this.template.snapshot());
    return this.status();
  }

  shutdown(): void {
    this.template.shutdown();
    for (const value of this.sessions.values()) value.session.shutdown();
    this.sessions.clear();
  }

  private async applyTemplate(session: DebugSession): Promise<void> {
    const snapshot = this.template.snapshot();
    const byFile = new Map<string, DebugBreakpoint[]>();
    for (const breakpoint of snapshot.breakpoints) byFile.set(breakpoint.file, [...(byFile.get(breakpoint.file) ?? []), breakpoint]);
    for (const [file, breakpoints] of byFile) {
      await session.setBreakpoints(file, breakpoints.map((item) => item.line));
      for (const breakpoint of breakpoints)
        if (!breakpoint.enabled || breakpoint.condition || breakpoint.hitCondition || breakpoint.logMessage)
          await session.updateBreakpoint(file, breakpoint.line, breakpoint);
    }
    await session.setFunctionBreakpoints(snapshot.functionBreakpoints);
    await session.setExceptionFilters(snapshot.exceptionFilters);
    await session.setWatches(snapshot.watches.map((watch) => watch.expression));
  }

  private managed(id: string, value: { label: string; session: DebugSession }): ManagedDebugSnapshot {
    return { ...value.session.snapshot(), sessionId: id, sessionLabel: value.label };
  }

  private entry(sessionId?: string, required = true): { id: string; value: { label: string; session: DebugSession } } | undefined {
    const id = sessionId || this.currentId;
    const value = id ? this.sessions.get(id) : undefined;
    if (!value) {
      if (required) throw new Error("No active debug session");
      return undefined;
    }
    return { id: id!, value };
  }

  private requireSession(sessionId?: string): DebugSession { return this.entry(sessionId, true)!.value.session; }

  private async withSession(sessionId: string | undefined, action: (session: DebugSession) => Promise<DebugSnapshot>): Promise<ManagedDebugSnapshot> {
    const entry = this.entry(sessionId, true)!;
    this.currentId = entry.id;
    await action(entry.value.session);
    return this.managed(entry.id, entry.value);
  }
}
