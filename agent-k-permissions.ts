import { readFileSync } from "node:fs";
import { basename, isAbsolute, join, normalize } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentLoopDetector, type AgentLoopDetection } from "./agent-loop-detector.ts";
import { requestFileOpen } from "./agent-file-editor.ts";

type Settings = {
  agentLoopDetectionEnabled?: boolean;
  environmentPromptEnabled?: boolean;
  locale?: "zh-CN" | "en-US";
  permissionMode?: "ask" | "full";
  disabledLanguageServerSkills?: string[];
};

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

export function environmentTimePrompt(
  now = new Date(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown",
  offsetMinutes = -now.getTimezoneOffset(),
): string {
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const localTime = `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())} ${twoDigits(now.getHours())}:${twoDigits(now.getMinutes())}:${twoDigits(now.getSeconds())}`;
  const utcOffset = `UTC${offsetSign}${twoDigits(Math.floor(absoluteOffset / 60))}:${twoDigits(absoluteOffset % 60)}`;
  return `Current system local time: ${localTime}\nHost time zone: ${timeZone} (${utcOffset})`;
}

const fileFormatActionPrefix = "agent-k-file-format-action:";
const providerRequestDumpPrefix = "agent-k-provider-request:";
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

const agentKTool = defineTool({
  name: "agent_k",
  label: "Agent K",
  description: "Execute an Agent K desktop capability after loading its matching Skill. Use capability file-editor, cpp-language-server, or native-debugger; copy the action and arguments contract exactly from that Skill or the active Agent K context.",
  parameters: Type.Object({
    capability: Type.String({ description: "Agent K capability named by the loaded Skill: file-editor, cpp-language-server, or native-debugger." }),
    action: Type.String({ description: "Capability action documented by the loaded Skill or active Agent K context." }),
    arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Action arguments documented by the loaded Skill; omit when the action has none." })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    if (!ctx.hasUI) return { content: [{ type: "text", text: "Agent K desktop UI bridge is unavailable." }] };
    const action = params.action.trim();
    const arguments_ = params.arguments ?? {};
    if (!action) throw new Error("Agent K requires a non-empty action.");
    if (params.capability !== "file-editor") {
      const settings = readJson<Settings>(process.env.AGENT_K_SETTINGS_PATH, {});
      if (settings.disabledLanguageServerSkills?.includes("cpp-clangd"))
        throw new Error("Agent K C++ project Skill is disabled.");
      const workspace = arguments_.workspace;
      if (typeof workspace !== "string" || !workspace.trim())
        throw new Error("Agent K requires a non-empty workspace.");
      const cwd = typeof (ctx as { cwd?: unknown }).cwd === "string"
        ? (ctx as { cwd: string }).cwd
        : process.cwd();
      const payload = { ...arguments_, action, workspace, cwd };
      const requestPrefix = params.capability === "cpp-language-server"
        ? cppLanguageServerRequestPrefix
        : params.capability === "native-debugger"
          ? nativeDebuggerRequestPrefix
          : undefined;
      if (!requestPrefix) throw new Error(`Unknown Agent K capability: ${params.capability}`);
      const response = await ctx.ui.input(`${requestPrefix}${JSON.stringify(payload)}`);
      if (!response) {
        const label = params.capability === "cpp-language-server" ? "C++ language service" : "native debugger";
        return { content: [{ type: "text", text: `Agent K ${label} request was cancelled.` }], details: { capability: params.capability, ...payload } };
      }
      let details: unknown = response;
      try { details = JSON.parse(response); } catch { /* Preserve a host error as text. */ }
      return { content: [{ type: "text", text: response }], details };
    }
    if (action === "get-preview-console") {
      const limit = typeof arguments_.limit === "number" ? Math.max(1, Math.min(200, Math.round(arguments_.limit))) : 80;
      const output = await ctx.ui.input(`agent-k-preview-console:${limit}`);
      return {
        content: [{ type: "text", text: output ?? "Preview console request was cancelled." }],
        details: { capability: params.capability, action, limit },
      };
    }
    const path = typeof arguments_.path === "string" ? arguments_.path : undefined;
    const screenshotPath = action === "capture-preview" ? previewScreenshotPath(ctx) : undefined;
    const payload = {
      action,
      ...(path ? { path } : {}),
      ...(typeof arguments_.preview === "boolean" ? { preview: arguments_.preview } : {}),
      ...(typeof arguments_.seconds === "number" ? { seconds: arguments_.seconds } : {}),
      ...(screenshotPath ? { outputPath: screenshotPath } : {}),
    };
    if (action === "open") {
      if (!path?.trim()) throw new Error("A workspace file path is required to open a file.");
      const cwd = typeof (ctx as { cwd?: unknown }).cwd === "string"
        ? normalize((ctx as { cwd: string }).cwd)
        : normalize(process.cwd());
      await requestFileOpen(cwd, path, payload, (request) => ctx.ui.input(request));
      return {
        content: [{ type: "text", text: `Opened in Agent K file editor: ${path}` }],
        details: { capability: params.capability, ...payload, ok: true },
      };
    }
    ctx.ui.notify(`${fileFormatActionPrefix}${JSON.stringify(payload)}`, "info");
    return {
      content: [{
        type: "text",
        text: screenshotPath
          ? `Preview screenshot will be saved to: ${screenshotPath}`
          : `Requested Agent K file editor action: ${action}.`,
      }],
      details: { capability: params.capability, ...payload },
    };
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
  if (tool === "agent_k") {
    const arguments_ = input.arguments && typeof input.arguments === "object"
      ? input.arguments as Record<string, unknown>
      : {};
    return `${String(input.capability ?? "Agent K")} ${String(input.action ?? "action")} ${String(arguments_.workspace ?? arguments_.path ?? "")}${typeof arguments_.sessionId === "string" ? ` (${arguments_.sessionId})` : ""}`.trim();
  }
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
  const environmentPrompts = new Map<string, string>();
  const loopDetectors = new Map<string, AgentLoopDetector>();
  const loopDetectionEnabled = new Map<string, boolean>();
  const detectorFor = (sessionId: string) => {
    let detector = loopDetectors.get(sessionId);
    if (!detector) {
      detector = new AgentLoopDetector();
      loopDetectors.set(sessionId, detector);
      if (loopDetectors.size > 100) loopDetectors.delete(loopDetectors.keys().next().value ?? "");
    }
    return detector;
  };
  const stopForLoop = (ctx: { abort(): void; ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }, detection: AgentLoopDetection) => {
    const english = readJson<Settings>(process.env.AGENT_K_SETTINGS_PATH, {}).locale === "en-US";
    ctx.ui.notify(
      english
        ? `A repetitive model loop was detected and stopped to avoid wasting resources. ${detection.detail}`
        : `检测到模型进入重复循环，已停止以避免继续消耗资源。${detection.detail}`,
      "warning",
    );
    ctx.abort();
  };
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
  pi.on("before_agent_start", (event, ctx) => {
    const settings = readJson<Settings>(process.env.AGENT_K_SETTINGS_PATH, {});
    const sessionId = ctx.sessionManager.getSessionId();
    loopDetectionEnabled.set(sessionId, settings.agentLoopDetectionEnabled !== false);
    detectorFor(sessionId).reset();
    const base = process.env.AGENT_K_ENVIRONMENT_PROMPT?.trim();
    if (!settings.environmentPromptEnabled || !base) return;
    let prompt = environmentPrompts.get(sessionId);
    if (!prompt) {
      const closingTag = "</agent_k_environment>";
      const promptBody = base.endsWith(closingTag)
        ? base.slice(0, -closingTag.length)
        : `${base}\n`;
      prompt = `${promptBody}${environmentTimePrompt()}\n${closingTag}`;
      environmentPrompts.set(sessionId, prompt);
      if (environmentPrompts.size > 100) environmentPrompts.delete(environmentPrompts.keys().next().value ?? "");
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
  });
  pi.on("before_provider_request", (event, ctx) => {
    ctx.ui.notify(`${providerRequestDumpPrefix}${JSON.stringify({
      capturedAt: Date.now(),
      payload: event.payload,
      sessionId: ctx.sessionManager.getSessionId(),
    })}`, "info");
  });
  pi.on("message_update", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!loopDetectionEnabled.get(sessionId)) return;
    const update = event.assistantMessageEvent;
    if (update.type === "text_start" || update.type === "thinking_start") {
      detectorFor(sessionId).resetStreamingContent();
      return;
    }
    if (update.type !== "text_delta" && update.type !== "thinking_delta") return;
    const detection = detectorFor(sessionId).addContent(update.delta);
    if (detection) stopForLoop(ctx, detection);
  });
  pi.registerTool(agentKTool);
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
    const sessionId = ctx.sessionManager.getSessionId();
    if (loopDetectionEnabled.get(sessionId)) {
      const detection = detectorFor(sessionId).addToolCall(event.toolName, event.input);
      if (detection) {
        stopForLoop(ctx, detection);
        return { block: true, reason: "Agent K stopped a repetitive model loop" };
      }
    }
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
    const debuggerAction = event.toolName === "agent_k" && event.input.capability === "native-debugger" && typeof event.input.action === "string"
      ? event.input.action
      : undefined;
    if (!(["bash", "write", "edit"] as string[]).includes(event.toolName) && !(debuggerAction && protectedDebuggerActions.has(debuggerAction))) return;
    const settings = readJson<Settings>(process.env.AGENT_K_SETTINGS_PATH, {});
    if (settings.permissionMode === "full") return;
    const grants = new Set(readJson<string[]>(process.env.AGENT_K_PERMISSION_STATE_PATH, []));
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
