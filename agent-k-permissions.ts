import { readFileSync } from "node:fs";
import { basename, isAbsolute, join, normalize } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Settings = {
  locale?: "zh-CN" | "en-US";
  permissionMode?: "ask" | "full";
  disabledLanguageServerSkills?: string[];
};

const fileFormatActionPrefix = "agent-k-file-format-action:";
const cppLanguageServerRequestPrefix = "agent-k-cpp-language-server:";
const nativeDebuggerRequestPrefix = "agent-k-native-debugger:";
const protectedDebuggerActions = new Set([
  "clear-breakpoints", "clear-output", "continue", "detach", "evaluate", "next", "pause", "select-frame", "set-breakpoints",
  "set-exception-filters", "set-function-breakpoints", "set-instruction-breakpoints", "set-variable", "start", "step-in",
  "step-out", "stop", "write-memory",
]);

function previewScreenshotPath(ctx: unknown): string {
  const cwd = typeof (ctx as { cwd?: unknown }).cwd === "string"
    ? (ctx as { cwd: string }).cwd
    : process.cwd();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(cwd, "screenshot", `preview-${timestamp}-${process.pid}.png`);
}

const fileFormatTool = defineTool({
  name: "agent_k_file_editor",
  label: "Agent K file editor",
  description: "Open a workspace file in Agent K's right-side editor, run a web project with an npm dev script in Agent K's preview, capture the currently visible HTML or web-project preview as a PNG, read console output from the current web-project preview, or control the active file-format editor. The built-in open and run-web-project actions accept a workspace path; capture-preview and get-preview-console act on the current preview; other actions must be advertised in the current file-format context.",
  parameters: Type.Object({
    action: Type.String({ description: "Use open to show a workspace file, run-web-project to start a web project with an npm dev script in Agent K, capture-preview to save the current HTML or web-project preview as a PNG, get-preview-console to read the current web-project preview's console output, or an advertised capability such as play, pause, or seek." }),
    path: Type.Optional(Type.String({ description: "A workspace-relative or absolute workspace path. Required for open and run-web-project; use the active path for editor capabilities." })),
    preview: Type.Optional(Type.Boolean({ description: "For open, show the file in its preview mode when supported." })),
    seconds: Type.Optional(Type.Number({ description: "Seek offset in seconds; positive is forward and negative is backward." })),
    limit: Type.Optional(Type.Number({ description: "For get-preview-console, maximum number of recent log entries to return (1-200; default 80)." })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    if (!ctx.hasUI) {
      return { content: [{ type: "text", text: "Agent K file editor UI is unavailable." }] };
    }
    const action = typeof params.action === "string" ? params.action : "";
    if (!action) return { content: [{ type: "text", text: "Missing file editor action." }] };
    if (action === "get-preview-console") {
      const limit = typeof params.limit === "number" ? Math.max(1, Math.min(200, Math.round(params.limit))) : 80;
      const output = await ctx.ui.input(`agent-k-preview-console:${limit}`);
      return {
        content: [{ type: "text", text: output ?? "Preview console request was cancelled." }],
        details: { action, limit },
      };
    }
    const screenshotPath = action === "capture-preview" ? previewScreenshotPath(ctx) : undefined;
    const payload = {
      action,
      ...(typeof params.path === "string" ? { path: params.path } : {}),
      ...(typeof params.preview === "boolean" ? { preview: params.preview } : {}),
      ...(typeof params.seconds === "number" ? { seconds: params.seconds } : {}),
      ...(screenshotPath ? { outputPath: screenshotPath } : {}),
    };
    ctx.ui.notify(`${fileFormatActionPrefix}${JSON.stringify(payload)}`, "info");
    return {
      content: [{
        type: "text",
        text: screenshotPath
          ? `Preview screenshot will be saved to: ${screenshotPath}`
          : `Requested Agent K file editor action: ${action}.`,
      }],
      details: payload,
    };
  },
});

const cppLanguageServerTool = defineTool({
  name: "agent_k_cpp_language_server",
  label: "Agent K C++ language service",
  description: "Primary tool for semantic C++ queries in a named CMake workspace. Always call status first. When the workspace is loaded and ready, use this tool before shell text search for references, definitions, declarations, types, hover, implementations, symbols, diagnostics, call hierarchy, and type hierarchy. Shell remains appropriate for builds, tests, execution, Git, and explicitly textual searches. Loading and unloading are explicit lifecycle actions: keep a useful workspace loaded and never cycle it merely to run another query.",
  parameters: Type.Object({
    action: Type.String({ description: "One of: status, references, definition, declaration, type-declaration, implementation, hover, symbols, document-symbols, diagnostics, incoming-calls, outgoing-calls, supertypes, subtypes, load, unload." }),
    workspace: Type.String({ description: "Unique C++ workspace folder name under the current Agent K workspace. The folder must contain CMakeLists.txt; do not pass a path." }),
    symbol: Type.Optional(Type.String({ description: "Exact variable, function, enum, type, method, or other C++ symbol name. Qualified names such as Namespace::Type are supported." })),
    query: Type.Optional(Type.String({ description: "Workspace-symbol search text. Used by the symbols action; symbol may be supplied instead." })),
    file: Type.Optional(Type.String({ description: "Optional workspace-relative file used to disambiguate a symbol. Required by document-symbols and diagnostics." })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    if (!ctx.hasUI) return { content: [{ type: "text", text: "Agent K C++ language service UI bridge is unavailable." }] };
    const cwd = typeof (ctx as { cwd?: unknown }).cwd === "string"
      ? (ctx as { cwd: string }).cwd
      : process.cwd();
    const payload = {
      action: params.action,
      workspace: params.workspace,
      ...(typeof params.symbol === "string" ? { symbol: params.symbol } : {}),
      ...(typeof params.query === "string" ? { query: params.query } : {}),
      ...(typeof params.file === "string" ? { file: params.file } : {}),
      cwd,
    };
    const response = await ctx.ui.input(`${cppLanguageServerRequestPrefix}${JSON.stringify(payload)}`);
    if (!response) return { content: [{ type: "text", text: "Agent K C++ language service request was cancelled." }], details: payload };
    let details: unknown = response;
    try { details = JSON.parse(response); } catch { /* Preserve a host error as text. */ }
    return { content: [{ type: "text", text: response }], details };
  },
});

const nativeDebuggerTool = defineTool({
  name: "agent_k_native_debugger",
  label: "Agent K native debugger",
  description: "Control Agent K's managed LLDB/WinDbg DAP debugger for a named CMake workspace. Supports launch, attach, dump analysis, multiple sessions, breakpoints, execution control, stacks, locals, registers, expressions, memory, disassembly, and bounded output. Call status first and pass sessionId whenever more than one session exists.",
  parameters: Type.Object({
    action: Type.String({ description: "One of: status, configurations, processes, start, stop, detach, continue, pause, next, step-in, step-out, select-frame, stack, locals, registers, variables, evaluate, set-variable, set-breakpoints, clear-breakpoints, set-function-breakpoints, set-exception-filters, read-memory, write-memory, disassemble, set-instruction-breakpoints, output, clear-output." }),
    workspace: Type.String({ description: "Unique CMake workspace folder name under the current Agent K workspace; do not pass a path." }),
    sessionId: Type.Optional(Type.String({ description: "Debug session identifier returned by start or status. Required when the workspace has multiple sessions." })),
    mode: Type.Optional(Type.String({ description: "For start: launch, attach, or dump." })),
    targetId: Type.Optional(Type.String({ description: "CMake executable target ID returned by configurations." })),
    buildConfiguration: Type.Optional(Type.String({ description: "CMake configuration: Debug, Release, RelWithDebInfo, or MinSizeRel." })),
    program: Type.Optional(Type.String({ description: "Workspace-relative executable path for manual launch or matching executable for a dump." })),
    args: Type.Optional(Type.Array(Type.String(), { description: "Program arguments for launch." })),
    workingDirectory: Type.Optional(Type.String({ description: "Workspace-relative working directory for launch." })),
    processId: Type.Optional(Type.Number({ description: "Positive process ID for attach." })),
    dumpPath: Type.Optional(Type.String({ description: "Core/minidump path for dump analysis." })),
    sessionName: Type.Optional(Type.String({ description: "Human-readable session label." })),
    stopOnEntry: Type.Optional(Type.Boolean({ description: "Pause at the program entry point." })),
    symbolPaths: Type.Optional(Type.Array(Type.String(), { description: "Symbol search directories." })),
    sourceMap: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Debugger source-prefix to local-path mapping." })),
    refresh: Type.Optional(Type.Boolean({ description: "Refresh CMake target discovery for configurations." })),
    file: Type.Optional(Type.String({ description: "Workspace-relative source file for configurations or source breakpoints." })),
    line: Type.Optional(Type.Number({ description: "One-based source line for a breakpoint." })),
    lines: Type.Optional(Type.Array(Type.Number(), { description: "Complete one-based source breakpoint line list for the file." })),
    enabled: Type.Optional(Type.Boolean({ description: "Whether the source breakpoint at line is enabled." })),
    condition: Type.Optional(Type.String({ description: "Source breakpoint condition." })),
    hitCondition: Type.Optional(Type.String({ description: "Source/function breakpoint hit condition." })),
    logMessage: Type.Optional(Type.String({ description: "Source breakpoint log message." })),
    functionBreakpoints: Type.Optional(Type.Array(Type.Object({
      name: Type.String(),
      condition: Type.Optional(Type.String()),
      hitCondition: Type.Optional(Type.String()),
    }), { description: "Complete function-breakpoint list." })),
    exceptionFilters: Type.Optional(Type.Array(Type.String(), { description: "Complete supported exception-filter ID list." })),
    threadId: Type.Optional(Type.Number({ description: "Thread ID for select-frame." })),
    frameId: Type.Optional(Type.Number({ description: "Stack frame ID for select-frame." })),
    variablesReference: Type.Optional(Type.Number({ description: "DAP variable container reference for variables or set-variable." })),
    expression: Type.Optional(Type.String({ description: "Expression for evaluate." })),
    context: Type.Optional(Type.String({ description: "Evaluate context: watch (default) or repl." })),
    name: Type.Optional(Type.String({ description: "Variable name for set-variable." })),
    value: Type.Optional(Type.String({ description: "New variable value for set-variable." })),
    memoryReference: Type.Optional(Type.String({ description: "DAP memory reference or address for memory/disassembly actions." })),
    offset: Type.Optional(Type.Number({ description: "Signed byte offset for memory, or signed address offset for disassembly." })),
    count: Type.Optional(Type.Number({ description: "Byte count for read-memory or recent line count for output." })),
    bytes: Type.Optional(Type.Array(Type.Number(), { description: "Byte values (0-255) for write-memory." })),
    instructionOffset: Type.Optional(Type.Number({ description: "Signed instruction offset for disassembly." })),
    instructionCount: Type.Optional(Type.Number({ description: "Instruction count for disassembly." })),
    addresses: Type.Optional(Type.Array(Type.String(), { description: "Complete instruction-breakpoint address list." })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    if (!ctx.hasUI) return { content: [{ type: "text", text: "Agent K native debugger UI bridge is unavailable." }] };
    const cwd = typeof (ctx as { cwd?: unknown }).cwd === "string"
      ? (ctx as { cwd: string }).cwd
      : process.cwd();
    const payload = { ...params, cwd };
    const response = await ctx.ui.input(`${nativeDebuggerRequestPrefix}${JSON.stringify(payload)}`);
    if (!response) return { content: [{ type: "text", text: "Agent K native debugger request was cancelled." }], details: payload };
    let details: unknown = response;
    try { details = JSON.parse(response); } catch { /* Preserve a host error as text. */ }
    return { content: [{ type: "text", text: response }], details };
  },
});

function readJson<T>(path: string | undefined, fallback: T): T {
  if (!path) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function summary(tool: string, input: Record<string, unknown>) {
  if (tool === "bash") return String(input.command ?? "").slice(0, 600);
  if (tool === "agent_k_native_debugger") return `${String(input.action ?? "debug")} ${String(input.workspace ?? "")}${typeof input.sessionId === "string" ? ` (${input.sessionId})` : ""}`;
  return String(input.path ?? "unknown file");
}

function messageText(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "";
  const message = (entry as { message?: unknown }).message;
  if (!message || typeof message !== "object") return "";
  const value = message as { role?: string; content?: unknown };
  if (value.role !== "user") return "";
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return "";
  return value.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        Boolean(
          part &&
            typeof part === "object" &&
            (part as { type?: unknown }).type === "text" &&
            typeof (part as { text?: unknown }).text === "string",
        ),
    )
    .map((part) => part.text)
    .join("\n");
}

/**
 * Extensions commonly ask the model to write an artifact to an exact path and
 * then wait for that path to appear. Small models sometimes silently omit a
 * directory segment (for example `.pi/agent/plans` -> `.pi/plans`), leaving
 * the extension waiting forever even though a similarly named file exists.
 * Honor the latest explicit output-path contract when the filename matches.
 */
function declaredOutputPath(ctx: {
  sessionManager: { getEntries(): readonly unknown[] };
}): string | undefined {
  const entries = ctx.sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index--) {
    const text = messageText(entries[index]);
    if (!text) continue;
    const match =
      /\b(?:write|save)\b[^\r\n:]{0,100}\b(?:to|at)\s*:\s*([^\r\n]+)/i.exec(
        text,
      ) ?? /(?:写入|保存)(?:文件)?(?:到|至|路径)\s*[：:]\s*([^\r\n]+)/.exec(text);
    const path = match?.[1]
      ?.trim()
      .replace(/^[`"']+|[`"']+$/g, "")
      .trim();
    return path && isAbsolute(path) ? normalize(path) : undefined;
  }
  return undefined;
}

export default function agentKPermissions(pi: ExtensionAPI) {
  const updateContextStatus = (ctx: { ui: { setStatus(key: string, text?: string): void }; getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined }) => {
    const english = readJson<Settings>(process.env.AGENT_K_SETTINGS_PATH, {}).locale === "en-US";
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null || usage.percent === null) {
      ctx.ui.setStatus("agent-k-context", english
        ? "Context usage will be available after the next model response"
        : "上下文用量将在下一次模型响应后显示");
      return undefined;
    }
    const compact = (tokens: number) => tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}k` : String(tokens);
    ctx.ui.setStatus(
      "agent-k-context",
      english
        ? `Context ${compact(usage.tokens)} / ${compact(usage.contextWindow)} (${usage.percent.toFixed(1)}%)`
        : `上下文 ${compact(usage.tokens)} / ${compact(usage.contextWindow)}（${usage.percent.toFixed(1)}%）`,
    );
    return usage;
  };
  pi.on("agent_end", (_event, ctx) => {
    updateContextStatus(ctx);
  });
  pi.registerTool(fileFormatTool);
  const startupSettings = readJson<Settings>(process.env.AGENT_K_SETTINGS_PATH, {});
  if (!startupSettings.disabledLanguageServerSkills?.includes("cpp-clangd")) {
    pi.registerTool(cppLanguageServerTool);
    pi.registerTool(nativeDebuggerTool);
  }
  pi.registerCommand("agent-k-internal-navigate-tree", {
    description: "Agent K internal same-session tree navigation",
    handler: async (args, ctx) => {
      const entryId = args.trim();
      if (!entryId || /\s/.test(entryId)) {
        throw new Error("Agent K tree navigation requires one entry ID");
      }
      await ctx.navigateTree(entryId);
    },
  });
  pi.on("tool_call", async (event, ctx) => {
    if ((["write", "edit"] as string[]).includes(event.toolName)) {
      const requested = declaredOutputPath(ctx);
      const actual = typeof event.input.path === "string" ? event.input.path : undefined;
      if (
        requested &&
        actual &&
        basename(normalize(actual)).toLocaleLowerCase() ===
          basename(requested).toLocaleLowerCase() &&
        normalize(actual) !== requested
      ) {
        event.input.path = requested;
      }
    }
    const debuggerAction = event.toolName === "agent_k_native_debugger" && typeof event.input.action === "string" ? event.input.action : undefined;
    if (!(["bash", "write", "edit"] as string[]).includes(event.toolName) && !(debuggerAction && protectedDebuggerActions.has(debuggerAction))) return;
    const settings = readJson<Settings>(process.env.AGENT_K_SETTINGS_PATH, {});
    if (settings.permissionMode === "full") return;
    const grants = new Set(readJson<string[]>(process.env.AGENT_K_PERMISSION_STATE_PATH, []));
    const sessionId = ctx.sessionManager.getSessionId();
    if (grants.has(sessionId)) return;
    if (!ctx.hasUI) return { block: true, reason: "Agent K permission confirmation is unavailable" };

    const chinese = settings.locale !== "en-US";
    const title = `agent-k-permission:${event.toolName}:${sessionId}\n${summary(event.toolName, event.input)}`;
    const options = chinese
      ? ["拒绝", "仅允许本次", "本次 session 不再提醒", "完全访问"]
      : ["Deny", "Allow once", "Allow for this session", "Full access"];
    const choice = await ctx.ui.select(title, options);
    if (choice === options[0] || !choice) return { block: true, reason: "Blocked by user" };
    return undefined;
  });
}
