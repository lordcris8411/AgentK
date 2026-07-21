import { readFileSync } from "node:fs";
import { basename, isAbsolute, normalize } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Settings = { locale?: "zh-CN" | "en-US"; permissionMode?: "ask" | "full" };

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
    if (!(["bash", "write", "edit"] as string[]).includes(event.toolName)) return;
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
