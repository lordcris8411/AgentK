export type DebugBreakpoint = { condition?: string; enabled: boolean; file: string; hitCondition?: string; line: number; logMessage?: string; verified?: boolean; message?: string };
export type DebugVariable = { evaluateName?: string; memoryReference?: string; name: string; type?: string; value: string; variablesReference: number };
export type DebugEvaluation = { expression: string; memoryReference?: string; result: string; type?: string; variablesReference: number };
export type DebugExceptionBreakpointFilter = { default?: boolean; filter: string; label: string };
export type DebugFunctionBreakpoint = { condition?: string; hitCondition?: string; message?: string; name: string; verified?: boolean };
export type DebugProcess = { command: string; name: string; pid: number };
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
  sessionId?: string;
  sessionLabel?: string;
  state: "idle" | "starting" | "running" | "stopped" | "terminated" | "failed";
  stopReason?: string;
  stopReasonKind?: string;
  threads: DebugThread[];
  watches: DebugWatch[];
};

export const emptyDebugSnapshot = (): DebugSnapshot => ({
  breakpoints: [],
  capabilities: {},
  exceptionBreakpointFilters: [],
  exceptionFilters: [],
  functionBreakpoints: [],
  instructionBreakpoints: [],
  output: "",
  sessionKind: "live",
  state: "idle",
  threads: [],
  watches: [],
});
