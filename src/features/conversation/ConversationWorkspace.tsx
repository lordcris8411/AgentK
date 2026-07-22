import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { SessionSummary } from "../../lib/desktop";
import { desktop } from "../../lib/desktop";
import { stopDampedScrolling } from "../../lib/dampedScrolling";
import { desktopWindow, platform } from "../../lib/platform";
import type { ReviewCall } from "./ReviewPanel";
import { useSettings } from "../settings/SettingsContext";
import {
  AnsiText,
  plainUiText,
  useExtensionUi,
} from "../extensions/ExtensionUiContext";

type ToolCall = { id?: string; name: string; args: Record<string, unknown> };
type ModelOption = {
  provider: string;
  id: string;
  name?: string;
  input?: string[];
};
type SlashCommand = {
  name: string;
  description?: string;
  source: "builtin" | "extension" | "prompt" | "skill";
  sourceInfo?: {
    path?: string;
    source?: string;
    scope?: string;
  };
};
type CommandPicker = {
  kind: "fork" | "tree";
  options: Array<{ entryId: string; text: string }>;
};
type MessageContextMenu = {
  item: Item;
  x: number;
  y: number;
};
type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};
type AttachmentKind = "image" | "document" | "text";
type ComposerAttachment = {
  id: string;
  kind: AttachmentKind;
  name: string;
  path: string;
  previewUrl?: string;
};
type ResearchProgress = { stage: string; text: string };
type Item = {
  id: string;
  role: string;
  display?: boolean;
  customType?: string;
  content: string;
  occurredAt?: number;
  modelId?: string;
  modelName?: string;
  modelProvider?: string;
  thinking?: string;
  thinkingActive?: boolean;
  tool?: string;
  toolCallId?: string;
  toolActive?: boolean;
  toolError?: boolean;
  researchProgress?: ResearchProgress[];
  toolCalls?: ToolCall[];
  images?: ImageContent[];
  localImageUrls?: string[];
  localFiles?: Array<{ kind: "document" | "text"; name: string }>;
};
function messageParts(
  message: Record<string, unknown>,
): Pick<Item, "content" | "thinking" | "toolCalls" | "images"> {
  const content = message.content;
  if (typeof content === "string") return { content };
  if (!Array.isArray(content)) return { content: "" };
  const blocks = content.filter(
    (
      block,
    ): block is {
      type: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      arguments?: Record<string, unknown>;
      data?: string;
      mimeType?: string;
    } => typeof block === "object" && block !== null && "type" in block,
  );
  return {
    content: blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join(""),
    thinking:
      blocks
        .filter((block) => block.type === "thinking")
        .map((block) => block.thinking ?? "")
        .join("\n") || undefined,
    toolCalls: blocks
      .filter((block) => block.type === "toolCall" && block.name)
      .map((block) => ({
        id: typeof block.id === "string" ? block.id : undefined,
        name: block.name!,
        args: block.arguments ?? {},
      })),
    images: blocks
      .filter(
        (block) =>
          block.type === "image" &&
          typeof block.data === "string" &&
          typeof block.mimeType === "string",
      )
      .map((block) => ({
        type: "image" as const,
        data: block.data!,
        mimeType: block.mimeType!,
      })),
  };
}

const documentExtensions = new Set([
  "pdf", "doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "ppt", "pptx", "odp",
]);
const textExtensions = new Set([
  "txt", "md", "markdown", "log", "csv", "tsv", "json", "jsonc", "yaml", "yml", "toml", "xml",
  "ini", "cfg", "conf", "env", "properties", "py", "pyw", "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "rs", "go", "java", "c", "cc", "cpp", "h", "hpp", "cs", "sh", "bash", "zsh", "ps1", "bat", "cmd",
  "html", "htm", "css", "scss", "sass", "less", "vue", "svelte", "php", "rb", "swift", "kt", "kts",
  "dart", "lua", "r", "sql", "graphql", "gql",
]);
function attachmentKind(path: string): AttachmentKind | undefined {
  const name = fileName(path).toLowerCase();
  const extension = name.includes(".") ? name.split(".").pop() ?? "" : "";
  if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) return "image";
  if (documentExtensions.has(extension)) return "document";
  if (
    textExtensions.has(extension) ||
    ["dockerfile", "makefile", "license", "readme", ".gitignore", ".gitattributes", ".editorconfig"].includes(name)
  ) return "text";
  return undefined;
}
function linkifyFileReferences(markdown: string) {
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(
            /@((?:[\w.-]+[\\/])*[\w.-]+\.[\w.-]+):(\d+)/g,
            (_match, path: string, line: string) =>
              `[@${path}:${line}](#agent-k-file=${encodeURIComponent(path)}&line=${line})`,
          ),
    )
    .join("");
}
const inlineFileReferencePattern = /@((?:[\w.-]+[\\/])*[\w.-]+\.[\w.-]+):(\d+)/g;
function createInlineFileReference(path: string, line: number) {
  const token = document.createElement("span");
  token.className = "composer-inline-file-reference";
  token.contentEditable = "false";
  token.dataset.line = String(line);
  token.dataset.path = path;
  token.textContent = `@${path}:${line}`;
  return token;
}
function populateComposer(element: HTMLElement, value: string) {
  element.replaceChildren();
  let offset = 0;
  for (const match of value.matchAll(inlineFileReferencePattern)) {
    if (match.index! > offset)
      element.append(document.createTextNode(value.slice(offset, match.index)));
    element.append(createInlineFileReference(match[1], Number(match[2])));
    offset = match.index! + match[0].length;
  }
  if (offset < value.length)
    element.append(document.createTextNode(value.slice(offset)));
}
function serializeComposer(element: HTMLElement) {
  const read = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof HTMLElement)) return "";
    if (node.matches(".composer-inline-file-reference"))
      return `@${node.dataset.path}:${node.dataset.line}`;
    if (node.tagName === "BR") return "\n";
    const content = Array.from(node.childNodes).map(read).join("");
    return node !== element && ["DIV", "P"].includes(node.tagName)
      ? `${content}\n`
      : content;
  };
  return read(element).replace(/\n$/, "");
}
function placeCaretAtEnd(element: HTMLElement | null) {
  if (!element) return;
  element.focus();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function fuzzyCommandScore(query: string, command: SlashCommand) {
  const needle = query.toLowerCase();
  const haystack = command.name.toLowerCase();
  if (!needle) return 0;
  if (needle === haystack) return -1000;
  if (haystack.startsWith(needle)) return -500 + haystack.length;
  const substring = haystack.indexOf(needle);
  if (substring >= 0) return -250 + substring * 2 + haystack.length;
  let queryIndex = 0;
  let lastMatch = -1;
  let score = 0;
  for (let index = 0; index < haystack.length && queryIndex < needle.length; index++) {
    if (haystack[index] !== needle[queryIndex]) continue;
    score += lastMatch < 0 ? index : index - lastMatch - 1;
    if (index === 0 || /[-_./:]/.test(haystack[index - 1] ?? "")) score -= 4;
    lastMatch = index;
    queryIndex++;
  }
  return queryIndex === needle.length ? score : undefined;
}

function filterSlashCommands(commands: SlashCommand[], query: string) {
  return commands
    .map((command, order) => ({
      command,
      order,
      score: fuzzyCommandScore(query, command),
    }))
    .filter((entry) => entry.score !== undefined)
    .sort(
      (left, right) =>
        (left.score ?? 0) - (right.score ?? 0) || left.order - right.order,
    )
    .map((entry) => entry.command);
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function toolResultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const content = (value as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const block = part as { type?: string; text?: string };
        if (block.type === "text" && typeof block.text === "string")
          return block.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function researchProgress(value: string): ResearchProgress | undefined {
  const match = /^\[pipeline:([^\]]+)\]\s*(.*)$/s.exec(value.trim());
  if (!match) return undefined;
  return { stage: match[1], text: match[2] };
}

function displayUserContent(role: unknown, content: string) {
  if (role !== "user") return content;
  const plan = /^Analyze the codebase and create a detailed plan for: ([\s\S]+?)\n\nWrite the plan to: [\s\S]+?\n\nUse this format:/u.exec(
    content,
  );
  return plan ? `/plan ${plan[1].trim()}` : content;
}

function researchStageLabel(stage: string, en: boolean) {
  const labels: Record<string, [string, string]> = {
    plan: ["规划", "Plan"],
    followup: ["补充规划", "Follow-up"],
    search: ["搜索", "Search"],
    fetch: ["读取来源", "Read sources"],
    synthesis: ["综合结果", "Synthesis"],
  };
  return labels[stage]?.[en ? 1 : 0] ?? stage;
}

function itemOf(message: Record<string, unknown>, id: string): Item {
  const rawTimestamp = message.timestamp;
  const occurredAt =
    typeof rawTimestamp === "number"
      ? rawTimestamp
      : typeof rawTimestamp === "string"
        ? Date.parse(rawTimestamp)
        : undefined;
  const rawModel = message.model;
  const modelRecord =
    typeof rawModel === "object" && rawModel !== null
      ? (rawModel as Record<string, unknown>)
      : undefined;
  const parts = messageParts(message);
  return {
    id,
    role: String(message.role),
    display: typeof message.display === "boolean" ? message.display : undefined,
    customType:
      typeof message.customType === "string" ? message.customType : undefined,
    occurredAt:
      typeof occurredAt === "number" && Number.isFinite(occurredAt)
        ? occurredAt
        : undefined,
    modelId:
      typeof rawModel === "string"
        ? rawModel
        : typeof modelRecord?.id === "string"
          ? modelRecord.id
          : undefined,
    modelName:
      typeof message.modelName === "string"
        ? message.modelName
        : typeof modelRecord?.name === "string"
          ? modelRecord.name
          : undefined,
    modelProvider:
      typeof message.provider === "string"
        ? message.provider
        : typeof modelRecord?.provider === "string"
          ? modelRecord.provider
          : undefined,
    ...parts,
    content: displayUserContent(message.role, parts.content),
    tool:
      message.role === "toolResult"
        ? String(message.toolName ?? "tool")
        : undefined,
    toolCallId:
      typeof message.toolCallId === "string"
        ? message.toolCallId
        : undefined,
  };
}
function toItems(messages: Array<Record<string, unknown>>, offset = 0): Item[] {
  return messages.map((message, index) =>
    itemOf(message, String(message.id ?? `${offset + index}`)),
  );
}
function toolPath(args: Record<string, unknown>) {
  return [args.path, args.filePath, args.file_path, args.to].find(
    (value): value is string => typeof value === "string",
  );
}
function previewTools(turn: Item[]): ToolCall[] {
  const seen = new Set<string>();
  return turn
    .flatMap((item) => item.toolCalls ?? [])
    .filter((call) => {
      const key = `${call.name}:${toolPath(call.args) ?? JSON.stringify(call.args)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
function toolLabel(call: ToolCall) {
  const path = toolPath(call.args);
  if (call.name === "agent_k_file_editor") {
    const action = typeof call.args.action === "string" ? call.args.action : "";
    const name = path?.split(/[\\/]/).pop() ?? "文件";
    if (action === "open") return `预览：${name}`;
    if (action === "run-web-project") return `运行网站：${name}`;
    if (action === "capture-preview") return "抓取预览图像";
    if (action === "get-preview-console") return "读取网站控制台";
  }
  if (path && call.name === "read") return `读取 ${path}`;
  if (path && ["write", "edit"].includes(call.name)) return `修改 ${path}`;
  if (path && ["copy", "move", "delete"].includes(call.name))
    return `变更 ${path}`;
  return `工具调用：${call.name}`;
}
type ConversationNavigationEntry = {
  item: Item;
  answer?: string;
  tools: ToolCall[];
};
function conversationNavigation(items: Item[]): ConversationNavigationEntry[] {
  const navigation: ConversationNavigationEntry[] = [];
  let user: Item | undefined;
  let answer: string | undefined;
  let turn: Item[] = [];
  const flush = () => {
    if (user) navigation.push({ item: user, answer, tools: previewTools(turn) });
  };
  for (const item of items) {
    if (item.role === "user") {
      flush();
      user = item;
      answer = undefined;
      turn = [];
      continue;
    }
    if (!user) continue;
    turn.push(item);
    if (item.role === "assistant" && item.content.trim()) answer = item.content;
  }
  flush();
  return navigation;
}
const ConversationMinimap = memo(function ConversationMinimap({
  en,
  entries,
  onJump,
}: {
  en: boolean;
  entries: ConversationNavigationEntry[];
  onJump(id: string): void;
}) {
  const [previewId, setPreviewId] = useState<string>();
  const previewIndex = previewId
    ? entries.findIndex((entry) => entry.item.id === previewId)
    : -1;
  if (entries.length === 0) return null;
  return (
    <nav
      aria-label={en ? "Sent message navigation" : "已发送消息导航"}
      className="conversation-minimap"
      onMouseLeave={() => setPreviewId(undefined)}
    >
      {entries.map(({ item, answer, tools }, index) => {
        const distance = previewIndex < 0 ? -1 : Math.abs(index - previewIndex);
        const level = distance === 0
          ? " is-preview"
          : distance === 1
            ? " is-near"
            : distance === 2
              ? " is-far"
              : "";
        return (
          <span className="minimap-entry" key={item.id}>
            <button
              aria-label={en ? "Jump to your message" : "跳转到你的消息"}
              className={`minimap-marker is-user${level}`}
              onClick={() => onJump(item.id)}
              onFocus={() => setPreviewId(item.id)}
              onMouseEnter={() => setPreviewId(item.id)}
              type="button"
            />
            {previewId === item.id && (
              <aside className="minimap-preview" role="tooltip">
                <div className="preview-user">
                  {((item.images?.length ?? 0) > 0 ||
                    (item.localImageUrls?.length ?? 0) > 0) && (
                    <span className="preview-image-count">
                      <i aria-hidden="true" className="fa-regular fa-image" />
                      {(item.images?.length ?? 0) +
                        (item.localImageUrls?.length ?? 0)}
                    </span>
                  )}
                  <ReactMarkdown
                    rehypePlugins={[rehypeKatex]}
                    remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
                  >
                    {item.content}
                  </ReactMarkdown>
                </div>
                {answer && (
                  <div className="preview-agent">
                    <ReactMarkdown
                      rehypePlugins={[rehypeKatex]}
                      remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
                    >
                      {answer}
                    </ReactMarkdown>
                  </div>
                )}
                {tools.length > 0 && (
                  <div className="preview-tools">
                    {tools.map((call, toolIndex) => (
                      <div
                        className="preview-tool"
                        key={`${call.name}-${toolIndex}`}
                      >
                        <span>
                          {["read", "write", "edit", "copy", "move", "delete"].includes(call.name)
                            ? "▧"
                            : "⌘"}
                        </span>
                        {toolLabel(call)}
                      </div>
                    ))}
                  </div>
                )}
              </aside>
            )}
          </span>
        );
      })}
    </nav>
  );
});
function activityLabel(item: Item) {
  return item.tool === "bash" ? "运行结果" : `调用结果 ${item.tool}`;
}
function callActivityLabel(call: ToolCall) {
  const path = toolPath(call.args);
  if (path && call.name === "write")
    return `已创建 ${path.split(/[\\/]/).pop() ?? path}`;
  if (path && call.name === "edit")
    return `已编辑 ${path.split(/[\\/]/).pop() ?? path}`;
  return `发起调用 ${call.name}`;
}
function changedLines(value: unknown) {
  return typeof value === "string" && value.length
    ? value.replace(/\r\n/g, "\n").split("\n").length
    : 0;
}
function changedLineCounts(oldText: unknown, newText: unknown) {
  const before = typeof oldText === "string" ? oldText : "";
  const after = typeof newText === "string" ? newText : "";
  if (before === after) return { added: 0, removed: 0 };
  const beforeLines = before.replace(/\r\n/g, "\n").split("\n");
  const afterLines = after.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  while (
    start < beforeLines.length &&
    start < afterLines.length &&
    beforeLines[start] === afterLines[start]
  )
    start += 1;
  let beforeEnd = beforeLines.length;
  let afterEnd = afterLines.length;
  while (
    beforeEnd > start &&
    afterEnd > start &&
    beforeLines[beforeEnd - 1] === afterLines[afterEnd - 1]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return {
    added: changedLines(afterLines.slice(start, afterEnd).join("\n")),
    removed: changedLines(beforeLines.slice(start, beforeEnd).join("\n")),
  };
}
function applyToolEdits(content: string, call: ToolCall) {
  if (call.name === "write")
    return typeof call.args.content === "string" ? call.args.content : content;
  const edits = Array.isArray(call.args.edits)
    ? call.args.edits
    : [{ oldText: call.args.oldText, newText: call.args.newText }];
  return edits.reduce((current, rawEdit) => {
    const edit = rawEdit as Record<string, unknown>;
    const oldText = edit.oldText;
    const newText = edit.newText;
    if (
      typeof oldText !== "string" ||
      typeof newText !== "string" ||
      !current.includes(oldText)
    )
      return current;
    return current.replace(oldText, newText);
  }, content);
}
function aggregateFileCall(call: ToolCall): ToolCall {
  const original =
    typeof call.args.oldContent === "string"
      ? call.args.oldContent
      : call.args.fileExisted === false
        ? ""
        : undefined;
  const modified =
    original === undefined ? undefined : applyToolEdits(original, call);
  const counts = fileChange(call);
  return {
    ...call,
    args: {
      ...call.args,
      aggregateOriginal: original,
      aggregateModified: modified,
      aggregateAdded: counts.added,
      aggregateRemoved: counts.removed,
    },
  };
}
/** Collapse adjacent writes/edits to the same path into one final file diff. */
function mergeConsecutiveFileCalls(calls: ToolCall[]) {
  const merged: ToolCall[] = [];
  for (const source of calls) {
    const call = aggregateFileCall(source);
    const previous = merged.at(-1);
    const path = toolPath(call.args);
    const previousPath = previous && toolPath(previous.args);
    if (!previous || !path || !previousPath || path.toLocaleLowerCase() !== previousPath.toLocaleLowerCase()) {
      merged.push(call);
      continue;
    }
    const original = previous.args.aggregateOriginal;
    const previousModified = previous.args.aggregateModified;
    const nextBase =
      typeof call.args.oldContent === "string"
        ? call.args.oldContent
        : typeof previousModified === "string"
          ? previousModified
          : undefined;
    const modified =
      nextBase === undefined ? undefined : applyToolEdits(nextBase, call);
    const exactCounts =
      typeof original === "string" && typeof modified === "string"
        ? changedLineCounts(original, modified)
        : undefined;
    const added =
      exactCounts?.added ??
      Number(previous.args.aggregateAdded ?? 0) +
        Number(call.args.aggregateAdded ?? 0);
    const removed =
      exactCounts?.removed ??
      Number(previous.args.aggregateRemoved ?? 0) +
        Number(call.args.aggregateRemoved ?? 0);
    const initialFileExisted = previous.args.fileExisted;
    const name = initialFileExisted === false ? "write" : "edit";
    merged[merged.length - 1] = {
      id: `${previous.id ?? "change"}:${call.id ?? merged.length}`,
      name,
      args: {
        ...call.args,
        path,
        fileExisted: initialFileExisted,
        oldContent: original,
        aggregateOriginal: original,
        aggregateModified: modified,
        aggregateAdded: added,
        aggregateRemoved: removed,
        ...(name === "write"
          ? { content: modified }
          : {
              edits:
                typeof original === "string" && typeof modified === "string"
                  ? [{ oldText: original, newText: modified }]
                  : call.args.edits,
              oldText: original,
              newText: modified,
            }),
      },
    };
  }
  return merged;
}
function fileChange(call: ToolCall) {
  const path = toolPath(call.args) ?? "文件";
  if (
    typeof call.args.aggregateAdded === "number" &&
    typeof call.args.aggregateRemoved === "number"
  )
    return {
      path,
      added: call.args.aggregateAdded,
      removed: call.args.aggregateRemoved,
    };
  if (call.name === "write")
    return { path, added: changedLines(call.args.content), removed: 0 };
  const edits = Array.isArray(call.args.edits)
    ? call.args.edits
    : [{ oldText: call.args.oldText, newText: call.args.newText }];
  return {
    path,
    added: edits.reduce(
      (count, edit) =>
        count +
        changedLineCounts(
          (edit as Record<string, unknown>).oldText,
          (edit as Record<string, unknown>).newText,
        ).added,
      0,
    ),
    removed: edits.reduce(
      (count, edit) =>
        count +
        changedLineCounts(
          (edit as Record<string, unknown>).oldText,
          (edit as Record<string, unknown>).newText,
        ).removed,
      0,
    ),
  };
}
function FileChangeSummary({
  call,
  onReview,
}: {
  call: ToolCall;
  onReview(): void;
}) {
  const en = useSettings().settings.locale === "en-US";
  const change = fileChange(call);
  const name = change.path.split(/[\\/]/).pop() ?? change.path;
  return (
    <div className="file-change-summary">
      <span className="file-change-icon">▣</span>
      <div>
        <strong>
          {call.name === "write" ? (en ? "Created" : "已创建") : (en ? "Edited" : "已编辑")} {name}
        </strong>
        <small>
          {change.added > 0 && <em>+{change.added}</em>}
          {change.removed > 0 && <i>-{change.removed}</i>}
        </small>
      </div>
      <button className="review-change-button" onClick={onReview} type="button">
        审阅
      </button>
    </div>
  );
}
type TimelineEntry =
  | { type: "message"; item: Item }
  | { type: "activity"; items: Item[] }
  | { type: "file-changes"; calls: ToolCall[] }
  | {
      type: "response-actions";
      item: Item;
      query: string;
      calls: ToolCall[];
    };
function isFileCall(call: ToolCall) {
  return call.name === "write" || call.name === "edit";
}
function timeline(items: Item[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let pending: Item[] = [];
  let pendingChanges: ToolCall[] = [];
  let turnChanges: ToolCall[] = [];
  let turnQuery = "";
  const changeIndexes = new Map<string, number>();
  const turnChangeIndexes = new Map<string, number>();
  const changeKey = (call: ToolCall) =>
    `${call.name}:${toolPath(call.args) ?? ""}:${JSON.stringify({ ...call.args, oldContent: undefined, fileExisted: undefined })}`;
  const flush = () => {
    if (pending.length) entries.push({ type: "activity", items: pending });
    pending = [];
  };
  const flushChanges = () => {
    if (pendingChanges.length)
      entries.push({
        type: "file-changes",
        calls: mergeConsecutiveFileCalls(pendingChanges),
      });
    pendingChanges = [];
    changeIndexes.clear();
  };
  for (let index = 0; index < items.length; index += 1) {
    const source = items[index];
    const next = items[index + 1];
    // Some providers stream a large write payload before the final `path`
    // property has arrived. Do not build a file card from that incomplete
    // object: its identity changes on every delta and it produces a transient
    // nameless card with a rapidly changing line count.
    const fileCalls = (source.toolCalls ?? []).filter(
      (call) => isFileCall(call) && Boolean(toolPath(call.args)),
    );
    for (const call of fileCalls) {
      const key = changeKey(call);
      const existing = changeIndexes.get(key);
      if (existing === undefined) {
        changeIndexes.set(key, pendingChanges.length);
        pendingChanges.push(call);
      } else if (typeof call.args.oldContent === "string")
        pendingChanges[existing] = call;
      const turnExisting = turnChangeIndexes.get(key);
      if (turnExisting === undefined) {
        turnChangeIndexes.set(key, turnChanges.length);
        turnChanges.push(call);
      } else if (
        typeof call.args.oldContent === "string" ||
        call.args.fileExisted === false
      )
        turnChanges[turnExisting] = call;
    }
    const item = source;
    // Session history can finish loading while a live tool is running. In that
    // case Pi's persisted toolResult and our live placeholder may both be in
    // the list with different React ids. toolCallId is the stable correlation
    // key, so retain only the newest result row for that invocation.
    if (
      item.tool &&
      item.toolCallId &&
      items
        .slice(index + 1)
        .some(
          (candidate) =>
            candidate.tool && candidate.toolCallId === item.toolCallId,
        )
    )
      continue;
    if (item.role === "user") {
      flush();
      flushChanges();
      turnChanges = [];
      turnChangeIndexes.clear();
      turnQuery = item.content;
      entries.push({ type: "message", item });
      continue;
    }
    if (
      item.role === "assistant" &&
      !item.content.trim() &&
      !item.thinking &&
      !item.toolCalls?.length
    )
      continue;
    if (item.role === "assistant" && item.thinking) {
      pending.push({ ...item, content: "", toolCalls: item.toolCalls });
      const startsToolStep = Boolean(next?.tool || item.toolCalls?.length);
      if (item.content.trim() && !startsToolStep) {
        flush();
        entries.push({
          type: "message",
          item: { ...item, thinking: undefined },
        });
        flushChanges();
        entries.push({
          type: "response-actions",
          item,
          query: turnQuery,
          calls: [...turnChanges],
        });
      }
      continue;
    }
    if (
      item.role === "assistant" &&
      item.toolCalls?.length &&
      !item.content.trim()
    ) {
      pending.push(item);
      continue;
    }
    if (item.tool) {
      pending.push(item);
      continue;
    }
    flush();
    entries.push({ type: "message", item });
    if (item.role === "assistant") {
      flushChanges();
      entries.push({
        type: "response-actions",
        item,
        query: turnQuery,
        calls: [...turnChanges],
      });
    }
  }
  flush();
  flushChanges();
  return entries;
}
function isFollowedByAnswer(entries: TimelineEntry[], index: number) {
  const next = entries[index + 1];
  return next?.type === "message" && next.item.role === "assistant";
}
function activityDuration(
  entries: TimelineEntry[],
  index: number,
  liveNow?: number,
  liveStartedAt?: number,
) {
  const before = entries
    .slice(0, index)
    .reverse()
    .find((entry) => entry.type === "message" && entry.item.role === "user");
  const after = entries
    .slice(index + 1)
    .find(
      (entry) => entry.type === "message" && entry.item.role === "assistant",
    );
  if (before?.type !== "message" || !before.item.occurredAt) {
    if (liveNow !== undefined && liveStartedAt !== undefined)
      return Math.max(0, liveNow - liveStartedAt);
    return;
  }
  if (after?.type === "message" && after.item.occurredAt)
    return Math.max(0, after.item.occurredAt - before.item.occurredAt);
  if (liveNow !== undefined)
    return Math.max(0, liveNow - before.item.occurredAt);
}
function formatDuration(durationMs?: number) {
  if (durationMs === undefined) return "";
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
function formatMessageTime(timestamp?: number) {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}
function ActivityRow({ item }: { item: Item }) {
  const en = useSettings().settings.locale === "en-US";
  const calls = item.toolCalls ?? [];
  const fileCalls = calls.filter(
    (call) => isFileCall(call) && Boolean(toolPath(call.args)),
  );
  const pendingFileCalls = calls.filter(
    (call) => isFileCall(call) && !toolPath(call.args),
  );
  const otherCalls = calls.filter((call) => !isFileCall(call));
  const matchingCall = item.tool
    ? otherCalls.find((call) => call.name === item.tool)
    : undefined;
  const remainingCalls = matchingCall
    ? otherCalls.filter((call) => call !== matchingCall)
    : otherCalls;
  const hiddenResult =
    item.tool && ["write", "edit"].includes(item.tool) && calls.length === 0;
  const isFileTool = item.tool === "write" || item.tool === "edit";
  return (
    <>
      {item.thinking && (
        <details className="thinking-block" open={item.thinkingActive}>
          <summary>
            <span>{item.thinkingActive ? "◌" : "✦"}</span>{" "}
            {item.thinkingActive ? (en ? "Thinking" : "正在思考") : (en ? "Thought process" : "思考过程")}
            <span aria-hidden="true" className="activity-chevron" />
          </summary>
          <pre>{item.thinking}</pre>
        </details>
      )}
      {item.tool && !hiddenResult && !isFileTool && (
        <details className="tool-card" open>
          <summary>
            <span className="tool-icon">⌘</span>
            <span>
              {item.toolActive
                ? (en ? `Running ${item.tool}` : `正在调用 ${item.tool}`)
                : item.toolError
                  ? (en ? `${item.tool} failed` : `${item.tool} 调用失败`)
                  : matchingCall
                    ? (en ? `Called ${matchingCall.name}` : `已调用 ${matchingCall.name}`)
                    : activityLabel(item)}
            </span>
            <span aria-hidden="true" className="activity-chevron" />
          </summary>
          {item.researchProgress?.length ? (
            <div className="research-progress">
              {item.researchProgress.map((progress) => (
                <div key={progress.stage}>
                  <span>{researchStageLabel(progress.stage, en)}</span>
                  <p>{progress.text}</p>
                </div>
              ))}
            </div>
          ) : null}
          {item.content || !item.researchProgress?.length ? (
            <pre>
              {item.content || (matchingCall
                ? JSON.stringify(matchingCall.args, null, 2)
                : (en ? "Waiting for tool result…" : "等待工具结果…"))}
            </pre>
          ) : null}
        </details>
      )}
      {fileCalls.map((call, index) => {
        const change = fileChange(call);
        return (
          <div
            className="file-change-activity"
            key={`activity-file-${call.name}-${index}`}
          >
            <span>⌑</span>
            <span>{callActivityLabel(call)}</span>
            <small>
              {change.added > 0 && <em>+{change.added}</em>}
              {change.removed > 0 && <i>-{change.removed}</i>}
            </small>
          </div>
        );
      })}
      {pendingFileCalls.map((call, index) => (
        <div
          className="file-change-activity is-pending"
          key={`pending-file-${call.id ?? call.name}-${index}`}
        >
          <span>⌑</span>
          <span>
            {en
              ? `Preparing ${call.name}…`
              : `正在准备${call.name === "write" ? "创建文件" : "编辑文件"}…`}
          </span>
        </div>
      ))}
      {remainingCalls.map((call, index) => (
        <details className="tool-card" key={`${call.name}-${index}`} open>
          <summary>
            <span className="tool-icon">⌘</span>
            <span>{callActivityLabel(call)}</span>
            <span aria-hidden="true" className="activity-chevron" />
          </summary>
          <pre>{JSON.stringify(call.args, null, 2)}</pre>
        </details>
      ))}
    </>
  );
}
const ActivityGroup = memo(function ActivityGroup({
  items,
  open,
  durationMs,
}: {
  items: Item[];
  open: boolean;
  durationMs?: number;
}) {
  const en = useSettings().settings.locale === "en-US";
  const seenFiles = new Set<string>();
  const fileLabels = items
    .flatMap((item) => item.toolCalls ?? [])
    .filter(isFileCall)
    .filter((call) => {
      const key = `${call.name}:${toolPath(call.args) ?? ""}:${JSON.stringify({ ...call.args, oldContent: undefined })}`;
      if (seenFiles.has(key)) return false;
      seenFiles.add(key);
      return true;
    })
    .map(callActivityLabel);
  const summary = fileLabels.length
    ? ` · ${fileLabels.slice(0, 2).join("、")}${fileLabels.length > 2 ? ` 等 ${fileLabels.length} 个文件` : ""}`
    : "";
  seenFiles.clear();
  return (
    <article className="message message-activity">
      <details className="activity-group" open={open}>
        <summary>
          <span className="activity-group-icon">✧</span> {en ? `Processed ${items.length} steps` : `已处理 ${items.length} 个步骤`}
          {durationMs !== undefined ? (
            <span className="activity-duration">
              · {formatDuration(durationMs)}
            </span>
          ) : null}
          <span className="activity-summary-files">{summary}</span>
          <span aria-hidden="true" className="activity-chevron" />
        </summary>
        <div className="activity-group-items">
          {items.map((item) => {
            const calls = item.toolCalls?.filter((call) => {
              if (!isFileCall(call)) return true;
              const key = `${call.name}:${toolPath(call.args) ?? ""}:${JSON.stringify({ ...call.args, oldContent: undefined })}`;
              if (seenFiles.has(key)) return false;
              seenFiles.add(key);
              return true;
            });
            return (
              <ActivityRow
                item={calls ? { ...item, toolCalls: calls } : item}
                key={item.id}
              />
            );
          })}
        </div>
      </details>
    </article>
  );
});

const ConversationMessage = memo(function ConversationMessage({
  en,
  item,
  onContextMenu,
  onError,
}: {
  en: boolean;
  item: Item;
  onContextMenu(event: React.MouseEvent, item: Item): void;
  onError(message: string | undefined): void;
}) {
  const browserId = useSettings().settings.browserId;
  return (
    <article
      className={`message message-${item.role}`}
      id={`message-${item.id}`}
      onContextMenu={item.role === "user" ? (event) => onContextMenu(event, item) : undefined}
    >
      <div className="message-content">
        {((item.images?.length ?? 0) > 0 ||
          (item.localImageUrls?.length ?? 0) > 0) && (
          <div className="message-images">
            {(item.images ?? []).map((image, imageIndex) => (
              <img
                alt={en ? `Attached image ${imageIndex + 1}` : `附件图片 ${imageIndex + 1}`}
                key={`${item.id}-image-${imageIndex}`}
                loading="lazy"
                src={`data:${image.mimeType};base64,${image.data}`}
              />
            ))}
            {(item.localImageUrls ?? []).map((url, imageIndex) => (
              <img
                alt={en ? `Attached image ${imageIndex + 1}` : `附件图片 ${imageIndex + 1}`}
                key={`${item.id}-local-image-${imageIndex}`}
                src={url}
              />
            ))}
          </div>
        )}
        {(item.localFiles?.length ?? 0) > 0 && (
          <div className="message-files">
            {item.localFiles?.map((file, fileIndex) => (
              <span key={`${item.id}-file-${fileIndex}`}>
                <i
                  aria-hidden="true"
                  className={
                    file.kind === "document"
                      ? "fa-regular fa-file-lines"
                      : "fa-regular fa-file-code"
                  }
                />
                {file.name}
              </span>
            ))}
          </div>
        )}
        {item.thinking && (
          <ActivityRow item={{ ...item, content: "", toolCalls: [] }} />
        )}
        {item.content && (
          <ReactMarkdown
            components={{
              a: ({ children, href, ...props }) => {
                if (href?.startsWith("#agent-k-file=")) {
                  const parameters = new URLSearchParams(href.slice(1));
                  const path = parameters.get("agent-k-file");
                  const line = Number(parameters.get("line"));
                  return (
                    <a
                      {...props}
                      className="file-line-reference"
                      href={href}
                      onClick={(event) => {
                        event.preventDefault();
                        if (!path || !Number.isFinite(line)) return;
                        window.dispatchEvent(
                          new CustomEvent("agent-k-open-file-line", {
                            detail: { line, path },
                          }),
                        );
                      }}
                    >
                      <i aria-hidden="true" className="fa-regular fa-file-code" />
                      {children}
                    </a>
                  );
                }
                if (href && /^https?:\/\//i.test(href)) {
                  return (
                    <a
                      {...props}
                      href={href}
                      onClick={(event) => {
                        event.preventDefault();
                        void desktop
                          .openExternalUrl(href, browserId)
                          .catch((cause) => onError(String(cause)));
                      }}
                    >
                      {children}
                    </a>
                  );
                }
                return <a {...props} href={href}>{children}</a>;
              },
            }}
            rehypePlugins={[rehypeKatex]}
            remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
          >
            {linkifyFileReferences(item.content)}
          </ReactMarkdown>
        )}
      </div>
      {item.role === "user" && item.occurredAt ? (
        <footer className="user-message-time">
          <time
            dateTime={new Date(item.occurredAt).toISOString()}
            title={new Date(item.occurredAt).toLocaleString()}
          >
            {formatMessageTime(item.occurredAt)}
          </time>
        </footer>
      ) : null}
    </article>
  );
});
export function ConversationWorkspace({
  session,
  connected,
  connecting,
  error,
  initialMessages,
  onHistoryReady,
  onError,
  onUserMessage,
  beforeSend,
  onContinueInNewSession,
  onReview,
}: {
  session?: SessionSummary;
  connected: boolean;
  connecting: boolean;
  error?: string;
  initialMessages?: Array<Record<string, unknown>>;
  onHistoryReady(path: string): void;
  onError(message?: string): void;
  onUserMessage(message: string): void;
  beforeSend(message: string): Promise<string | false>;
  onContinueInNewSession(query: string): Promise<string | false>;
  onReview(calls: ReviewCall[]): void;
}) {
  const { settings, update: updateSettings, t } = useSettings();
  const {
    cancelPending: cancelExtensionUi,
    clearSessionUi,
    editorTextUpdate,
    pushNotification,
    statuses,
    widgets,
  } = useExtensionUi();
  const en = settings.locale === "en-US";
  const dismissError = () => {
    if (!error) return;
    pushNotification(error, "error", { read: true, showToast: false });
    onError(undefined);
  };
  const [items, setItems] = useState<Item[]>([]);
  // The RPC listener is intentionally installed once, but the active session
  // changes without remounting this workspace. Keep its routing key live;
  // capturing `session` in the [] effect would permanently retain the first
  // (usually runtime-less draft) session and accept events from every worker.
  const activeRuntimeIdRef = useRef(session?.runtimeId);
  activeRuntimeIdRef.current = session?.runtimeId;
  const [draft, setDraftState] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [pendingSteer, setPendingSteer] = useState<{
    attachments: ComposerAttachment[];
    value: string;
  }>();
  const [composerDragActive, setComposerDragActive] = useState(false);
  const [running, setRunning] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState<number>();
  const [stopping, setStopping] = useState(false);
  const [liveNow, setLiveNow] = useState(() => Date.now());
  const [submitting, setSubmitting] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [modelName, setModelName] = useState(en ? "No model selected" : "未选择模型");
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [currentModelKey, setCurrentModelKey] = useState("");
  const [modelMenu, setModelMenu] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [commandRevision, setCommandRevision] = useState(0);
  const [commandPicker, setCommandPicker] = useState<CommandPicker>();
  const [messageContextMenu, setMessageContextMenu] = useState<MessageContextMenu>();
  const [pendingMessageDelete, setPendingMessageDelete] = useState<Item>();
  const [deletingMessage, setDeletingMessage] = useState(false);
  const [slashSelection, setSlashSelection] = useState(0);
  const [dismissedSlashDraft, setDismissedSlashDraft] = useState<string>();
  const [switchingModel, setSwitchingModel] = useState(false);
  const [reverting, setReverting] = useState<string>();
  const [branching, setBranching] = useState<string>();
  const [accessMenu, setAccessMenu] = useState(false);
  const [sessionGranted, setSessionGranted] = useState(false);
  const [fileFormatContext, setFileFormatContext] = useState<{
    capabilities: Array<{ id: string; description: string; parameters?: Record<string, string> }>;
    name: string;
    path: string;
  }>();
  const streamingId = useRef<string | undefined>(undefined);
  const messageListRef = useRef<HTMLElement | null>(null);
  const scrollbarRef = useRef<HTMLDivElement | null>(null);
  const conversationLayoutRef = useRef<HTMLDivElement | null>(null);
  const composerShellRef = useRef<HTMLFormElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const draftValueRef = useRef("");
  const draftCommitTimer = useRef<number | undefined>(undefined);
  const slashMenuRef = useRef<HTMLDivElement | null>(null);
  const modelControlRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const autoScrollFrame = useRef<number | undefined>(undefined);
  const scrollMetricsFrame = useRef<number | undefined>(undefined);
  const scrollbarDragRef = useRef<{
    maxScroll: number;
    pointerId: number;
    top: number;
    trackHeight: number;
  } | undefined>(undefined);
  const scrollbarDragFrame = useRef<number | undefined>(undefined);
  const scrollbarDragTarget = useRef(0);
  const commitDraft = useCallback((value: string) => {
    if (draftCommitTimer.current !== undefined) {
      window.clearTimeout(draftCommitTimer.current);
      draftCommitTimer.current = undefined;
    }
    draftValueRef.current = value;
    setDraftState(value);
  }, []);
  const openMessageContextMenu = useCallback((event: React.MouseEvent, item: Item) => {
    event.preventDefault();
    setMessageContextMenu({ item, x: event.clientX, y: event.clientY });
  }, []);
  const queueDraftCommit = useCallback((value: string) => {
    draftValueRef.current = value;
    if (draftCommitTimer.current !== undefined)
      window.clearTimeout(draftCommitTimer.current);
    // contentEditable already painted the keystroke. Delay the expensive
    // conversation render until typing pauses so the renderer main thread
    // remains available to the native editor and IME.
    draftCommitTimer.current = window.setTimeout(() => {
      draftCommitTimer.current = undefined;
      setDraftState(draftValueRef.current);
    }, 350);
  }, []);
  useEffect(
    () => () => {
      if (draftCommitTimer.current !== undefined)
        window.clearTimeout(draftCommitTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (!running) return;
    setLiveNow(Date.now());
    const timer = window.setInterval(() => setLiveNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  useEffect(() => {
    const refresh = () => setCommandRevision((revision) => revision + 1);
    window.addEventListener("agent-k-resources-changed", refresh);
    return () => window.removeEventListener("agent-k-resources-changed", refresh);
  }, []);
  useEffect(() => {
    const updateFileFormatContext = (event: Event) => {
      const detail = (event as CustomEvent<{
        capabilities?: Array<{ id?: unknown; description?: unknown; parameters?: unknown }>;
        name?: unknown;
        path?: unknown;
        skillEnabled?: unknown;
      }>).detail;
      if (!detail || typeof detail.name !== "string" || typeof detail.path !== "string") {
        setFileFormatContext(undefined);
        return;
      }
      const capabilities = (detail.capabilities ?? []).flatMap((capability) =>
        typeof capability.id === "string" && typeof capability.description === "string"
          ? [{
              id: capability.id,
              description: capability.description,
              ...(capability.parameters && typeof capability.parameters === "object"
                ? { parameters: capability.parameters as Record<string, string> }
                : {}),
            }]
          : [],
      );
      setFileFormatContext(
        detail.skillEnabled === true
          ? { capabilities, name: detail.name, path: detail.path }
          : undefined,
      );
    };
    window.addEventListener("agent-k-file-format-capabilities", updateFileFormatContext);
    return () => window.removeEventListener("agent-k-file-format-capabilities", updateFileFormatContext);
  }, []);
  const builtinCommands = useMemo<SlashCommand[]>(() => [
    { name: "settings", description: en ? "Open Agent K settings" : "打开 Agent K 设置", source: "builtin" },
    { name: "skills", description: en ? "Manage Pi skills" : "管理 Pi Skills", source: "builtin" },
    { name: "extensions", description: en ? "Manage Pi extensions" : "管理 Pi Extensions", source: "builtin" },
    { name: "editors", description: en ? "Manage Editor extensions" : "管理 Editor 扩展", source: "builtin" },
    { name: "model", description: en ? "Select or change the current model" : "选择或切换当前模型", source: "builtin" },
    { name: "compact", description: en ? "Compact the current session context" : "压缩当前会话上下文", source: "builtin" },
    { name: "new", description: en ? "Start a new Pi session" : "新建 Pi 会话", source: "builtin" },
    { name: "fork", description: en ? "Fork from a previous user message" : "从历史问题创建分支", source: "builtin" },
    { name: "tree", description: en ? "Navigate the session tree" : "导航会话树", source: "builtin" },
    { name: "name", description: en ? "Set the session name" : "设置会话名称", source: "builtin" },
    { name: "session", description: en ? "Show session information and statistics" : "显示会话信息与统计", source: "builtin" },
    { name: "reload", description: en ? "Reload Pi resources and configuration" : "重新加载 Pi 资源和配置", source: "builtin" },
  ], [en]);
  useEffect(() => {
    let cancelled = false;
    if (!connected || !session?.runtimeId) {
      setSlashCommands(builtinCommands);
      setSlashCommandsLoading(false);
      return;
    }
    setSlashCommandsLoading(true);
    void desktop
      .command({ type: "get_commands" }, session?.runtimeId)
      .then((result) => {
        if (cancelled) return;
        const commands = (result as { commands?: SlashCommand[] }).commands ?? [];
        setSlashCommands([
          ...builtinCommands,
          ...commands.filter(
            (command) =>
              Boolean(command?.name) &&
              ["extension", "prompt", "skill"].includes(command.source),
          ),
        ]);
      })
      .catch(() => {
        if (!cancelled) setSlashCommands(builtinCommands);
      })
      .finally(() => {
        if (!cancelled) setSlashCommandsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [builtinCommands, commandRevision, connected, session?.path, session?.runtimeId]);
  const slashMatch = /^\/([^\s]*)$/.exec(draft);
  const filteredSlashCommands = slashMatch
    ? filterSlashCommands(slashCommands, slashMatch[1])
    : [];
  const slashMenuVisible = Boolean(
    slashMatch && dismissedSlashDraft !== draft && connected && session,
  );
  const activeSlashIndex = Math.min(
    slashSelection,
    Math.max(0, filteredSlashCommands.length - 1),
  );
  useEffect(() => {
    setSlashSelection(0);
  }, [draft, slashCommands]);
  useEffect(() => {
    if (!slashMenuVisible) return;
    slashMenuRef.current
      ?.querySelector<HTMLElement>("[aria-selected='true']")
      ?.scrollIntoView({ block: "nearest" });
  }, [activeSlashIndex, slashMenuVisible]);
  useLayoutEffect(() => {
    let cancelled = false;
    setAttachments([]);
    setPendingSteer(undefined);
    if (!session || session.path === "__new__") {
      setItems([]);
      return;
    }
    if (initialMessages) {
      setItems(toItems(initialMessages));
      const path = session.path;
      // Two animation frames ensure both the synchronous history conversion
      // and the resulting Markdown/DOM layout have reached a paint boundary.
      let secondFrame = 0;
      const firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(() => onHistoryReady(path));
      });
      return () => {
        window.cancelAnimationFrame(firstFrame);
        if (secondFrame) window.cancelAnimationFrame(secondFrame);
      };
    }
    setItems([]);
    // Read the complete JSONL immediately. Once Pi has switched, replace it
    // with the complete authoritative context (including active tree state).
    const history = connected
      ? desktop.command({ type: "get_messages" }, session.runtimeId).then((raw) =>
          (raw as { messages?: Array<Record<string, unknown>> }).messages ?? [],
        )
      : desktop.sessionMessages(session.path);
    void history
      .then((messages) => {
        if (cancelled) return;
        setItems((current) => {
          const persisted = toItems(messages);
          const liveTools = current.filter(
            (item) =>
              item.tool &&
              item.toolCallId &&
              (item.toolActive || item.researchProgress?.length),
          );
          const merged = persisted.map((item) => {
            if (!item.toolCallId) return item;
            const live = liveTools.find(
              (candidate) => candidate.toolCallId === item.toolCallId,
            );
            return live
              ? {
                  ...item,
                  toolActive: live.toolActive,
                  toolError: live.toolError,
                  researchProgress: live.researchProgress,
                }
              : item;
          });
          for (const live of liveTools) {
            if (!merged.some((item) => item.toolCallId === live.toolCallId))
              merged.push(live);
          }
          return merged;
        });
      })
      .catch((cause) => {
        if (!cancelled) onError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [session?.path, connected, initialMessages, onError, onHistoryReady]);
  useEffect(() => {
    let cancelled = false;
    if (!connected || !session?.runtimeId) {
      setModelName(en ? "Connecting…" : "正在连接…");
      setAvailableModels([]);
      setCurrentModelKey("");
      return;
    }
    const refreshModelName = () => {
      void Promise.all([
        desktop.command({ type: "get_state" }, session?.runtimeId),
        desktop.command({ type: "get_available_models" }, session?.runtimeId),
      ])
        .then(([state, available]) => {
          const model = (
            state as {
              model?: { provider?: string; id?: string; name?: string };
              isStreaming?: boolean;
            }
          ).model;
          const isStreaming = (state as { isStreaming?: boolean }).isStreaming;
          const models = (
            available as {
              models?: ModelOption[];
            }
          ).models ?? [];
          const listed = models?.find(
            (entry) =>
              entry.provider === model?.provider && entry.id === model?.id,
          );
          if (!cancelled) {
            setRunning(isStreaming === true);
            setAvailableModels(models);
            setCurrentModelKey(
              model?.provider && model?.id
                ? `${model.provider}/${model.id}`
                : "",
            );
            setModelName(
              listed?.name ??
                model?.name ??
                model?.id ??
                model?.provider ??
                (en ? "No model selected" : "未选择模型"),
            );
          }
        })
        .catch(() => {
          if (!cancelled)
            setModelName(en ? "No model selected" : "未选择模型");
        });
    };
    refreshModelName();
    window.addEventListener("agent-k-model-changed", refreshModelName);
    return () => {
      cancelled = true;
      window.removeEventListener("agent-k-model-changed", refreshModelName);
    };
  }, [connected, en, session?.runtimeId]);
  useEffect(() => {
    if (!modelMenu) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!modelControlRef.current?.contains(event.target as Node))
        setModelMenu(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [modelMenu]);

  const selectModel = async (model: ModelOption) => {
    if (switchingModel || running) return;
    setSwitchingModel(true);
    try {
      await desktop.command(
        {
          type: "set_model",
          provider: model.provider,
          modelId: model.id,
        },
        session?.runtimeId,
      );
      setCurrentModelKey(`${model.provider}/${model.id}`);
      setModelName(model.name ?? model.id);
      setModelMenu(false);
      window.dispatchEvent(new Event("agent-k-model-changed"));
    } catch (cause) {
      onError(String(cause));
    } finally {
      setSwitchingModel(false);
    }
  };
  const selectedModel = availableModels.find(
    (model) => `${model.provider}/${model.id}` === currentModelKey,
  );
  const modelSupportsImages = Boolean(selectedModel?.input?.includes("image"));
  const addAttachmentPaths = (paths: string[]) => {
    if (!paths.length) return;
    const availableSlots = Math.max(0, 10 - attachments.length);
    if (!availableSlots) {
      onError(en ? "Up to 10 files can be attached." : "一次最多附加 10 个文件。");
      return false;
    }
    try {
      const existing = new Set(attachments.map((attachment) => attachment.path.toLowerCase()));
      const next = paths
        .filter((path) => !existing.has(path.toLowerCase()))
        .slice(0, availableSlots)
        .map((path) => {
        const kind = attachmentKind(path);
        if (!kind) {
          throw new Error(
            en
              ? `${fileName(path)}: unsupported attachment format`
              : `${fileName(path)}：不支持的附件格式`,
          );
        }
        if (kind === "image" && !modelSupportsImages)
          throw new Error(
            en
              ? "The current model does not support image input. Switch to a vision model first."
              : "当前模型不支持图片输入，请先切换到视觉模型。",
          );
        return {
          id: crypto.randomUUID(),
          kind,
          name: fileName(path),
          path,
          previewUrl: kind === "image" ? platform.fileUrl(path) : undefined,
        };
      });
      setAttachments((current) => [...current, ...next]);
      onError(undefined);
      return true;
    } catch (cause) {
      onError(String(cause));
      return false;
    }
  };
  const chooseImages = async () => {
    const selected = await platform.openDialog({
      filters: [
        {
          name: en ? "Images" : "图片",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"],
        },
      ],
      multiple: true,
      title: en ? "Attach images" : "添加图片",
    });
    if (!selected) return;
    addAttachmentPaths(Array.isArray(selected) ? selected : [selected]);
  };
  const importAttachmentFiles = async (files: File[]) => {
    if (!files.length) return;
    try {
      const paths: string[] = [];
      for (const file of files) {
        if (!attachmentKind(file.name))
          throw new Error(
            en
              ? `${file.name}: unsupported attachment format`
              : `${file.name}：不支持的附件格式`,
          );
        paths.push(
          await desktop.saveTempAttachment(
            file.name,
            Array.from(new Uint8Array(await file.arrayBuffer())),
          ),
        );
      }
      addAttachmentPaths(paths);
    } catch (cause) {
      onError(String(cause));
    }
  };
  useEffect(() => {
    const overComposer = (position: { x: number; y: number }) => {
      return Boolean(
        document
          .elementFromPoint(position.x, position.y)
          ?.closest(".composer"),
      );
    };
    const dragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      const isOver = overComposer({ x: event.clientX, y: event.clientY });
      setComposerDragActive(isOver);
      if (isOver) event.preventDefault();
    };
    const dragLeave = (event: DragEvent) => {
      if (!event.relatedTarget) setComposerDragActive(false);
    };
    const drop = (event: DragEvent) => {
      const isOver = overComposer({ x: event.clientX, y: event.clientY });
      if (!isOver || !event.dataTransfer?.files.length) return;
      event.preventDefault();
      setComposerDragActive(false);
      addAttachmentPaths(
        Array.from(event.dataTransfer.files)
          .map(platform.pathForFile)
          .filter(Boolean),
      );
    };
    window.addEventListener("dragover", dragOver);
    window.addEventListener("dragleave", dragLeave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", dragOver);
      window.removeEventListener("dragleave", dragLeave);
      window.removeEventListener("drop", drop);
    };
  }, [attachments.length, en, modelSupportsImages, session?.cwd]);
  useEffect(() => {
    const addFromWorkspace = (event: Event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path;
      if (path) addAttachmentPaths([path]);
    };
    window.addEventListener("agent-k-add-attachment", addFromWorkspace);
    return () =>
      window.removeEventListener("agent-k-add-attachment", addFromWorkspace);
  }, [attachments, en, modelSupportsImages]);
  useEffect(() => {
    const addLineReference = (event: Event) => {
      const detail = (event as CustomEvent<{ line?: number; path?: string }>).detail;
      if (!detail?.path || !detail.line) return;
      const path = detail.path.replaceAll("\\", "/");
      const editor = composerRef.current;
      if (!editor) {
        const current = draftValueRef.current;
        commitDraft(
          `${current}${current && !/\s$/.test(current) ? " " : ""}@${path}:${detail.line}`,
        );
        return;
      }
      const token = createInlineFileReference(path, detail.line);
      const selection = window.getSelection();
      const selectionInside = Boolean(
        selection?.rangeCount &&
          selection.anchorNode &&
          editor.contains(selection.anchorNode),
      );
      const range = selectionInside
        ? selection!.getRangeAt(0)
        : document.createRange();
      if (!selectionInside) {
        range.selectNodeContents(editor);
        range.collapse(false);
      }
      range.deleteContents();
      range.insertNode(token);
      const spacer = document.createTextNode(" ");
      token.after(spacer);
      range.setStartAfter(spacer);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
      commitDraft(serializeComposer(editor));
      editor.focus();
    };
    window.addEventListener("agent-k-add-line-reference", addLineReference);
    return () =>
      window.removeEventListener("agent-k-add-line-reference", addLineReference);
  }, [commitDraft]);
  useEffect(() => {
    const editor = composerRef.current;
    if (editor && serializeComposer(editor) !== draft)
      populateComposer(editor, draft);
  }, [draft]);
  useEffect(() => {
    if (!editorTextUpdate) return;
    commitDraft(editorTextUpdate.text);
    requestAnimationFrame(() => placeCaretAtEnd(composerRef.current));
  }, [commitDraft, editorTextUpdate]);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void desktop
      .onEvent((event) => {
        const activeRuntimeId = activeRuntimeIdRef.current;
        if (!activeRuntimeId || event.runtimeId !== activeRuntimeId) return;
        const type = String(event.type ?? "");
        if (type === "agent_start") {
          setRunning(true);
          setRunStartedAt(Date.now());
        }
        if (type === "agent_settled") {
          // Pi may settle without a final message_end event.  Treat either event as
          // the completion boundary for the streamed thinking block.
          setItems((current) =>
            current.map((item) =>
              item.thinkingActive ? { ...item, thinkingActive: false } : item,
            ),
          );
          setRunning(false);
          setRunStartedAt(undefined);
          setSubmitting(false);
          streamingId.current = undefined;
        }
        if (type === "session_info_changed" && typeof event.name === "string") {
          window.dispatchEvent(new CustomEvent("agent-k-session-name", {
            detail: { name: event.name },
          }));
        }
        if (type === "extension_error") {
          const detail = String(event.error ?? "Unknown extension error");
          const source = event.extensionPath
            ? ` (${String(event.extensionPath)})`
            : "";
          onError(`${en ? "Extension failed" : "扩展执行失败"}${source}: ${detail}`);
        }
        if (type === "bridge_closed") {
          setRunning(false);
          setRunStartedAt(undefined);
          setSubmitting(false);
          setStopping(false);
          streamingId.current = undefined;
          setItems((current) =>
            current.map((item) => ({
              ...item,
              thinkingActive: false,
              toolActive: false,
            })),
          );
          onError(en ? "Pi RPC connection closed" : "Pi RPC 连接已关闭");
        }
        if (
          type === "message_update" &&
          event.message &&
          typeof event.message === "object"
        ) {
          const message = event.message as Record<string, unknown>;
          if (message.role === "assistant") {
            const id = streamingId.current ?? crypto.randomUUID();
            streamingId.current = id;
            setItems((current) => {
              const parsed = itemOf(message, id);
              // Pi streams the assistant message as one aggregate payload.  When
              // normal answer text starts arriving, the reasoning phase is over
              // even on providers that omit the final lifecycle event.
              const item = {
                ...parsed,
                thinkingActive:
                  Boolean(parsed.thinking) && !parsed.content.trim(),
              };
              const index = current.findIndex((entry) => entry.id === id);
              return index < 0
                ? [...current, item]
                : current.map((entry) => (entry.id === id ? item : entry));
            });
          }
        }
        if (
          type === "message_end" &&
          event.message &&
          typeof event.message === "object"
        ) {
          const message = event.message as Record<string, unknown>;
          if (message.role === "user") return;
          if (message.role === "assistant" && streamingId.current) {
            const id = streamingId.current;
            streamingId.current = undefined;
            setItems((current) =>
              current.map((entry) =>
                entry.id === id
                  ? { ...itemOf(message, id), thinkingActive: false }
                  : entry,
              ),
            );
          } else if (message.role === "toolResult" && message.toolCallId) {
            const id = String(message.toolCallId);
            setItems((current) => {
              const existing = current.find(
                (entry) =>
                  entry.tool &&
                  (entry.id === id || entry.toolCallId === id),
              );
              const parsed = itemOf(message, id);
              if (!existing) return [...current, parsed];
              return current.map((entry) =>
                entry === existing
                  ? {
                      ...parsed,
                      id: existing.id,
                      toolCallId: id,
                      toolActive: false,
                      toolCalls: existing.toolCalls,
                      researchProgress: existing.researchProgress,
                    }
                  : entry,
              );
            });
          } else {
            setItems((current) => [
              ...current,
              itemOf(message, crypto.randomUUID()),
            ]);
          }
        }
        if (type === "tool_execution_start") {
          const id = String(event.toolCallId);
          const name = String(event.toolName);
          const args = (event.args as Record<string, unknown>) ?? {};
          const call = { name, args };
          setItems((current) => {
            const item: Item = {
              id,
              role: "tool",
              tool: name,
              toolCallId: id,
              toolActive: true,
              content: "",
              occurredAt: Date.now(),
              toolCalls: [call],
            };
            const existing = current.find(
              (entry) =>
                entry.tool &&
                (entry.id === id || entry.toolCallId === id),
            );
            return existing
              ? current.map((entry) => (entry === existing ? item : entry))
              : [...current, item];
          });
        }
        if (type === "tool_execution_update") {
          const id = String(event.toolCallId);
          const name = String(event.toolName);
          const progress = toolResultText(event.partialResult);
          setItems((current) => {
            const existing = current.find(
              (entry) =>
                entry.tool &&
                (entry.id === id || entry.toolCallId === id),
            );
            const stage = name === "pi-research"
              ? researchProgress(progress)
              : undefined;
            const stages = stage
              ? [
                  ...(existing?.researchProgress ?? []).filter(
                    (entry) => entry.stage !== stage.stage,
                  ),
                  stage,
                ]
              : existing?.researchProgress;
            const next: Item = {
              ...(existing ?? {
                id,
                role: "tool",
                occurredAt: Date.now(),
                toolCalls: [
                  {
                    id,
                    name,
                    args: (event.args as Record<string, unknown>) ?? {},
                  },
                ],
              }),
              tool: name,
              toolCallId: id,
              toolActive: true,
              researchProgress: stages,
              content: stage ? (existing?.content ?? "") : (progress || existing?.content || ""),
            };
            return existing
              ? current.map((entry) => (entry === existing ? next : entry))
              : [...current, next];
          });
        }
        if (type === "tool_execution_end") {
          const id = String(event.toolCallId);
          const name = String(event.toolName);
          const result = toolResultText(event.result);
          setItems((current) => {
            const existing = current.find(
              (entry) =>
                entry.tool &&
                (entry.id === id || entry.toolCallId === id),
            );
            const next: Item = {
              ...(existing ?? {
                id,
                role: "tool",
                occurredAt: Date.now(),
                toolCalls: [
                  {
                    id,
                    name,
                    args: (event.args as Record<string, unknown>) ?? {},
                  },
                ],
              }),
              tool: name,
              toolCallId: id,
              toolActive: false,
              toolError: event.isError === true,
              content: result || existing?.content || "",
            };
            return existing
              ? current.map((entry) => (entry === existing ? next : entry))
              : [...current, next];
          });
        }
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    const refresh = () => {
      setSessionGranted(
        Boolean(session?.id) &&
          sessionStorage.getItem(`agent-k-permission:${session?.id}`) === "allow",
      );
    };
    refresh();
    window.addEventListener("agent-k-permission", refresh);
    return () => window.removeEventListener("agent-k-permission", refresh);
  }, [session?.id]);
  const scrollToLatest = (behavior: ScrollBehavior = "smooth") => {
    const list = messageListRef.current;
    if (!list) return;
    stopDampedScrolling(list);
    stickToBottom.current = true;
    setShowJumpToLatest(false);
    list.scrollTo({ top: list.scrollHeight, behavior });
  };
  const updateScrollMetrics = (list = messageListRef.current) => {
    const scrollbar = scrollbarRef.current;
    if (!list || !scrollbar) return;
    const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight);
    const height = Math.min(
      100,
      Math.max(5, (list.clientHeight / Math.max(list.scrollHeight, 1)) * 100),
    );
    const thumb = scrollbar.firstElementChild as HTMLElement | null;
    scrollbar.classList.toggle("is-visible", maxScroll > 1);
    if (thumb) {
      thumb.style.height = `${height}%`;
      thumb.style.top = `${
        maxScroll > 0 ? (list.scrollTop / maxScroll) * (100 - height) : 0
      }%`;
    }
  };
  const scheduleScrollMetrics = (list = messageListRef.current) => {
    if (!list || scrollMetricsFrame.current !== undefined) return;
    scrollMetricsFrame.current = window.requestAnimationFrame(() => {
      scrollMetricsFrame.current = undefined;
      updateScrollMetrics(list);
    });
  };
  const jumpToMessage = useCallback((id: string) => {
    const list = messageListRef.current;
    const message = document.getElementById(`message-${id}`);
    if (!list || !message) return;
    stopDampedScrolling(list);
    stickToBottom.current = false;
    const listBounds = list.getBoundingClientRect();
    const messageBounds = message.getBoundingClientRect();
    const top = Math.max(
      0,
      Math.min(
        list.scrollHeight - list.clientHeight,
        list.scrollTop + messageBounds.top - listBounds.top -
          (list.clientHeight - messageBounds.height) / 2,
      ),
    );
    list.scrollTo({ behavior: "smooth", top });
  }, []);
  useEffect(() => {
    // Tool updates can replace several thousand lines in one render. Starting
    // another smooth scroll for every update makes Chromium keep multiple
    // scrolling/compositing animations alive and occasionally leaves stale
    // white text layers behind. Coalesce updates to one paint and follow the
    // stream immediately; explicit user navigation can still use smooth
    // scrolling.
    if (autoScrollFrame.current !== undefined)
      window.cancelAnimationFrame(autoScrollFrame.current);
    autoScrollFrame.current = window.requestAnimationFrame(() => {
      autoScrollFrame.current = undefined;
      if (stickToBottom.current) scrollToLatest("auto");
      else setShowJumpToLatest(true);
      updateScrollMetrics();
    });
    return () => {
      if (autoScrollFrame.current !== undefined) {
        window.cancelAnimationFrame(autoScrollFrame.current);
        autoScrollFrame.current = undefined;
      }
    };
  }, [items, running]);
  useEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    const observer = new ResizeObserver(() => {
      // Expanding a thought/details block changes a message's height, not the
      // scroll container's border box. Keep both the scroll position and the
      // custom thumb in sync with that internal resize.
      if (stickToBottom.current) {
        list.scrollTop = list.scrollHeight;
        setShowJumpToLatest(false);
      }
      scheduleScrollMetrics(list);
    });
    const observeMessages = () => {
      for (const child of list.children) observer.observe(child);
    };
    observer.observe(list);
    observeMessages();
    const mutations = new MutationObserver(observeMessages);
    mutations.observe(list, { childList: true });
    scheduleScrollMetrics(list);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      if (scrollMetricsFrame.current !== undefined) {
        window.cancelAnimationFrame(scrollMetricsFrame.current);
        scrollMetricsFrame.current = undefined;
      }
      if (scrollbarDragFrame.current !== undefined) {
        window.cancelAnimationFrame(scrollbarDragFrame.current);
        scrollbarDragFrame.current = undefined;
      }
    };
  }, []);
  useEffect(() => {
    const layout = conversationLayoutRef.current;
    const composer = composerShellRef.current;
    if (!layout || !composer) return;
    const updateReserve = () => {
      layout.style.setProperty(
        "--composer-reserve",
        `${Math.ceil(composer.getBoundingClientRect().height + 32)}px`,
      );
      const list = messageListRef.current;
      if (list && stickToBottom.current) list.scrollTop = list.scrollHeight;
      scheduleScrollMetrics(list);
    };
    const observer = new ResizeObserver(updateReserve);
    observer.observe(composer);
    updateReserve();
    return () => {
      observer.disconnect();
      layout.style.removeProperty("--composer-reserve");
    };
  }, []);
  const runBuiltinCommand = async (input: string): Promise<boolean> => {
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(input.trim());
    if (!match || !builtinCommands.some((command) => command.name === match[1]))
      return false;
    const [, name, rawArguments = ""] = match;
    const argumentsText = rawArguments.trim();
    if (["settings", "skills", "extensions", "editors"].includes(name)) {
      const page = name === "skills" || name === "extensions" || name === "editors" ? name : "models";
      window.dispatchEvent(new CustomEvent("agent-k-open-settings", { detail: { page } }));
      return true;
    }
    if (name === "model") {
      if (!argumentsText) {
        setModelMenu(true);
        return true;
      }
      const [provider, ...modelParts] = argumentsText.split("/");
      const modelId = modelParts.join("/");
      if (!provider || !modelId)
        throw new Error(en ? "Use /model provider/model" : "请使用 /model provider/model");
      await desktop.command({ type: "set_model", provider, modelId }, session?.runtimeId);
      window.dispatchEvent(new Event("agent-k-model-changed"));
      return true;
    }
    if (name === "compact") {
      await desktop.command({
        type: "compact",
        ...(argumentsText ? { customInstructions: argumentsText } : {}),
      }, session?.runtimeId);
      pushNotification(en ? "Session context compacted" : "会话上下文已压缩");
      return true;
    }
    if (name === "new") {
      await cancelExtensionUi();
      clearSessionUi();
      await desktop.command({ type: "new_session" }, session?.runtimeId);
      setItems([]);
      window.dispatchEvent(new CustomEvent("agent-k-session-name", {
        detail: { name: "New session" },
      }));
      return true;
    }
    if (name === "name") {
      if (!argumentsText)
        throw new Error(en ? "Use /name <session name>" : "请使用 /name <会话名称>");
      await desktop.command({ type: "set_session_name", name: argumentsText }, session?.runtimeId);
      window.dispatchEvent(new CustomEvent("agent-k-session-name", {
        detail: { name: argumentsText },
      }));
      return true;
    }
    if (name === "session") {
      const stats = await desktop.command({ type: "get_session_stats" }, session?.runtimeId);
      pushNotification(`${en ? "Session" : "会话"}: ${JSON.stringify(stats)}`, "info", {
        read: true,
        showToast: false,
      });
      pushNotification(en ? "Session statistics were added to notifications" : "会话统计已添加到通知中心");
      return true;
    }
    if (name === "reload") {
      await desktop.reloadPiRuntimes();
      setCommandRevision((revision) => revision + 1);
      window.dispatchEvent(new Event("agent-k-model-changed"));
      pushNotification(en ? "Pi resources and configuration reloaded" : "Pi 资源和配置已重新加载");
      return true;
    }
    if (name === "fork" || name === "tree") {
      if (name === "tree") {
        type TreeNode = {
          entry?: {
            id?: string;
            type?: string;
            message?: { role?: string; content?: unknown };
          };
          children?: TreeNode[];
          label?: string;
        };
        const result = await desktop.command(
          { type: "get_tree" },
          session?.runtimeId,
        ) as { tree?: TreeNode[] };
        const options: Array<{ entryId: string; text: string }> = [];
        const visit = (nodes: TreeNode[], depth: number) => {
          for (const node of nodes) {
            const entry = node.entry;
            if (entry?.id && entry.type === "message" && entry.message?.role === "user") {
              const content = entry.message.content;
              const text = typeof content === "string"
                ? content
                : Array.isArray(content)
                  ? content
                      .filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null && "type" in part)
                      .filter((part) => part.type === "text")
                      .map((part) => part.text ?? "")
                      .join("")
                  : "";
              options.push({
                entryId: entry.id,
                text: `${"  ".repeat(depth)}${depth ? "↳ " : ""}${node.label ? `[${node.label}] ` : ""}${text}`,
              });
            }
            visit(node.children ?? [], depth + 1);
          }
        };
        visit(result.tree ?? [], 0);
        setCommandPicker({ kind: "tree", options });
        return true;
      }
      const result = await desktop.command(
        { type: "get_fork_messages" },
        session?.runtimeId,
      ) as { messages?: Array<{ entryId: string; text: string }> };
      setCommandPicker({ kind: "fork", options: result.messages ?? [] });
      return true;
    }
    return false;
  };
  const selectCommandBranch = async (entryId: string) => {
    if (!session || running) return;
    const kind = commandPicker?.kind;
    setCommandPicker(undefined);
    try {
      await cancelExtensionUi();
      clearSessionUi();
      const result = await desktop.command({ type: "fork", entryId }, session.runtimeId) as {
        cancelled?: boolean;
      };
      if (!result.cancelled)
        pushNotification(kind === "fork"
          ? (en ? "Fork created" : "已创建会话分支")
          : (en ? "Session tree position changed" : "已切换会话树位置"));
    } catch (cause) {
      onError(String(cause));
    }
  };
  const submit = async (
    mode: "steer" | "queue" = "steer",
    draftOverride?: string,
    attachmentOverride?: ComposerAttachment[],
  ) => {
    const input = draftOverride ?? draftValueRef.current;
    const activeAttachments = attachmentOverride ?? attachments;
    if (
      (!input.trim() && activeAttachments.length === 0) ||
      !session ||
      !connected ||
      submitting
    )
      return;
    if (input.trimStart().startsWith("/")) {
      setSubmitting(true);
      try {
        if (await runBuiltinCommand(input)) {
          commitDraft("");
          return;
        }
      } catch (cause) {
        onError(String(cause));
        return;
      } finally {
        setSubmitting(false);
      }
    }
    if (activeAttachments.some((attachment) => attachment.kind === "image") && !modelSupportsImages) {
      onError(
        en
          ? "The current model does not support image input."
          : "当前模型不支持图片输入。",
      );
      return;
    }
    const value = input.trim();
    const imagePaths = activeAttachments
      .filter((attachment) => attachment.kind === "image")
      .map((attachment) => attachment.path);
    const filePaths = activeAttachments
      .filter((attachment) => attachment.kind !== "image")
      .map((attachment) => attachment.path);
    const withFileReferences = (message: string) => {
      const additions = [
        filePaths.length
          ? `<attached_files>\n${filePaths
              .map((path) => `- ${JSON.stringify(path)}`)
              .join("\n")}\n</attached_files>\nUse the available file tools to inspect these local files when needed.`
          : "",
        fileFormatContext
          ? `<agent_k_file_format>\nThe active Agent K ${fileFormatContext.name} editor is showing ${JSON.stringify(fileFormatContext.path)}. The agent_k_file_editor tool always supports open for a workspace file path, run-web-project for a project directory with an npm dev script, capture-preview for the currently visible HTML or web-project preview, and get-preview-console for the current web-project preview. For the active editor,${fileFormatContext.capabilities.length ? ` use only one of these additional capabilities:\n${fileFormatContext.capabilities.map((capability) => `- ${capability.id}: ${capability.description}${capability.parameters ? `; parameters ${JSON.stringify(capability.parameters)}` : ""}`).join("\n")}` : " no additional editor actions are available."}\n</agent_k_file_format>`
          : "",
      ].filter(Boolean);
      return additions.length
        ? `${message}${message.trim() ? "\n\n" : ""}${additions.join("\n\n")}`
        : message;
    };
    if (running && mode === "steer" && attachmentOverride === undefined) {
      setPendingSteer({ attachments: activeAttachments, value });
      commitDraft("");
      setAttachments([]);
      return;
    }
    setSubmitting(true);
    try {
      const modelMessage = await beforeSend(value);
      if (modelMessage === false) return;
      commitDraft("");
      setAttachments([]);
      stickToBottom.current = true;
      setItems((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "user",
          content: value,
          localImageUrls: activeAttachments
            .filter((attachment) => attachment.kind === "image")
            .flatMap((attachment) => attachment.previewUrl ? [attachment.previewUrl] : []),
          localFiles: activeAttachments
            .filter(
              (attachment): attachment is ComposerAttachment & { kind: "document" | "text" } =>
                attachment.kind !== "image",
            )
            .map((attachment) => ({ kind: attachment.kind, name: attachment.name })),
          occurredAt: Date.now(),
        },
      ]);
      requestAnimationFrame(() => scrollToLatest());
      await desktop.command(
        running
          ? mode === "queue"
            ? { type: "follow_up", message: withFileReferences(value), imagePaths }
            : { type: "steer", message: withFileReferences(value), imagePaths }
          : { type: "prompt", message: withFileReferences(modelMessage), imagePaths },
        session.runtimeId,
      );
      onUserMessage(value || activeAttachments.map((attachment) => attachment.name).join(", "));
    } catch (cause) {
      if (!running) setRunning(false);
      onError(String(cause));
    } finally {
      setSubmitting(false);
    }
  };
  const acceptSlashCommand = (
    command: SlashCommand,
  ) => {
    const completed = `/${command.name} `;
    commitDraft(completed);
    setDismissedSlashDraft(completed);
    const editor = composerRef.current;
    if (editor) {
      populateComposer(editor, completed);
      requestAnimationFrame(() => placeCaretAtEnd(editor));
    }
  };
  const stopGeneration = async () => {
    if (!session || !connected || stopping) return;
    setStopping(true);
    // Reflect the user's intent immediately. Pi lifecycle events remain the
    // authority and can set running=true again if another queued turn starts.
    setRunning(false);
    setSubmitting(false);
    streamingId.current = undefined;
    setItems((current) =>
      current.map((item) => ({
        ...item,
        thinkingActive: false,
        toolActive: false,
      })),
    );
    try {
      const [abortResult] = await Promise.allSettled([
        desktop.abort(session?.runtimeId),
        cancelExtensionUi(),
      ]);
      if (abortResult.status === "rejected") onError(String(abortResult.reason));
    } finally {
      setStopping(false);
    }
  };
  const revertTurn = async (id: string, query: string, calls: ToolCall[]) => {
    if (!session?.cwd || running || reverting) return;
    setReverting(id);
    try {
      for (const call of [...calls].reverse()) {
        const path = toolPath(call.args);
        if (!path) continue;
        if (call.name === "write") {
          if (typeof call.args.oldContent === "string")
            await desktop.write(session.cwd, path, call.args.oldContent);
          else if (call.args.fileExisted === false)
            await desktop.trash(session.cwd, path);
          // Sessions created before Agent K started recording file snapshots
          // can still navigate back, but their old file contents are unknown.
          continue;
        }
        let content = await desktop.read(session.cwd, path);
        const edits = Array.isArray(call.args.edits)
          ? call.args.edits
          : [{ oldText: call.args.oldText, newText: call.args.newText }];
        for (const rawEdit of [...edits].reverse()) {
          const edit = rawEdit as Record<string, unknown>;
          const oldText = edit.oldText;
          const newText = edit.newText;
          if (typeof oldText !== "string" || typeof newText !== "string")
            throw new Error(`无法解析 ${path} 的编辑记录`);
          if (!content.includes(newText))
            throw new Error(`${path} 已发生其他变化，无法安全撤销`);
          content = content.replace(newText, oldText);
        }
        await desktop.write(session.cwd, path, content);
      }
      const available = (await desktop.command(
        { type: "get_fork_messages" },
        session.runtimeId,
      )) as { messages?: Array<{ entryId: string; text: string }> };
      const target = [...(available.messages ?? [])]
        .reverse()
        .find((message) => message.text.trim() === query.trim());
      if (!target) throw new Error("无法定位这条消息的会话树节点");
      await cancelExtensionUi();
      clearSessionUi();
      const navigation = (await desktop.command({
        // Upstream Pi exposes public branch restoration through `fork`.
        // Keep AgentK on that protocol instead of requiring a patched
        // `navigate_tree` command.
        type: "fork",
        entryId: target.entryId,
      }, session.runtimeId)) as { text?: string; cancelled?: boolean };
      if (navigation.cancelled) return;
      const page = (await desktop.command(
        { type: "get_messages" },
        session.runtimeId,
      )) as {
        messages?: Array<Record<string, unknown>>;
      };
      setItems(toItems(page.messages ?? []));
      const editorText = navigation.text ?? query;
      commitDraft(editorText);
      requestAnimationFrame(() => placeCaretAtEnd(composerRef.current));
    } catch (cause) {
      onError(`Revert 失败：${String(cause)}`);
    } finally {
      setReverting(undefined);
    }
  };
  const deleteUserMessage = async () => {
    const targetItem = pendingMessageDelete;
    if (!targetItem || !session || running || submitting || deletingMessage) return;
    setDeletingMessage(true);
    try {
      type SessionEntry = {
        id: string;
        parentId: string | null;
        timestamp?: string;
        type: string;
        message?: Record<string, unknown>;
      };
      const result = await desktop.command(
        { type: "get_entries" },
        session.runtimeId,
      ) as { entries?: SessionEntry[]; leafId?: string | null };
      const entries = result.entries ?? [];
      const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
      const activePath: SessionEntry[] = [];
      let cursor = result.leafId ? entriesById.get(result.leafId) : undefined;
      while (cursor) {
        activePath.push(cursor);
        cursor = cursor.parentId ? entriesById.get(cursor.parentId) : undefined;
      }
      const userEntries = activePath.reverse().filter(
        (entry) => entry.type === "message" && entry.message?.role === "user",
      );
      const targetTime = targetItem.occurredAt;
      const matchingContent = userEntries.filter((entry) => {
        const content = entry.message ? messageParts(entry.message).content : "";
        return displayUserContent("user", content).trim() === targetItem.content.trim();
      });
      const candidates = matchingContent.length ? matchingContent : userEntries;
      const targetEntry = targetTime === undefined
        ? candidates.at(-1)
        : candidates.reduce<SessionEntry | undefined>((closest, entry) => {
            if (!closest) return entry;
            const entryTime = Date.parse(entry.timestamp ?? "");
            const closestTime = Date.parse(closest.timestamp ?? "");
            if (!Number.isFinite(entryTime)) return closest;
            if (!Number.isFinite(closestTime)) return entry;
            return Math.abs(entryTime - targetTime) < Math.abs(closestTime - targetTime)
              ? entry
              : closest;
          }, undefined);
      if (!targetEntry) throw new Error(en ? "Unable to locate this message in the session tree" : "无法在会话树中定位这条消息");

      await cancelExtensionUi();
      clearSessionUi();
      const navigation = await desktop.command(
        { type: "fork", entryId: targetEntry.id },
        session.runtimeId,
      ) as { cancelled?: boolean };
      if (navigation.cancelled) return;
      const page = await desktop.command(
        { type: "get_messages" },
        session.runtimeId,
      ) as { messages?: Array<Record<string, unknown>> };
      setItems(toItems(page.messages ?? []));
      commitDraft("");
      setPendingMessageDelete(undefined);
      pushNotification(
        en
          ? "Rewound to before this question. Use /tree to return to the previous branch."
          : "已回退到该问题之前，可通过 /tree 返回原分支。",
      );
    } catch (cause) {
      onError(`${en ? "Rewind failed" : "回退失败"}：${String(cause)}`);
    } finally {
      setDeletingMessage(false);
    }
  };
  const continueInNewSession = async (id: string, query: string) => {
    if (running || branching) return;
    setBranching(id);
    try {
      const restoredQuery = await onContinueInNewSession(query);
      if (!restoredQuery) return;
      commitDraft(restoredQuery);
      requestAnimationFrame(() => placeCaretAtEnd(composerRef.current));
    } finally {
      setBranching(undefined);
    }
  };
  const visibleItems = useMemo(
    () => items.filter(
      (item) =>
        item.display !== false &&
        (item.tool ||
          item.content.trim().length > 0 ||
          item.thinking?.trim() ||
          item.images?.length ||
          item.localImageUrls?.length),
    ),
    [items],
  );
  const timelineEntries = useMemo(() => timeline(visibleItems), [visibleItems]);
  const navigationEntries = useMemo(
    () => conversationNavigation(visibleItems),
    [visibleItems],
  );
  const stopInsteadOfSend = running && !draft.trim() && attachments.length === 0;
  const accessLabel =
    settings.permissionMode === "full"
      ? t("permissionFull")
      : sessionGranted
        ? t("permissionSession")
        : t("permissionAsk");
  const setAccess = async (mode: "ask" | "session" | "full") => {
    setAccessMenu(false);
    if (mode === "full") {
      await updateSettings({ permissionMode: "full" });
      return;
    }
    await updateSettings({ permissionMode: "ask" });
    if (session?.id) {
      await desktop.setSessionPermission(session.id, mode === "session");
      if (mode === "session") sessionStorage.setItem(`agent-k-permission:${session.id}`, "allow");
      else sessionStorage.removeItem(`agent-k-permission:${session.id}`);
      setSessionGranted(mode === "session");
    }
  };
  const projectName = session?.cwd
    ?.replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop();
  const responseModelName = (item: Item) => {
    const listed = availableModels.find(
      (model) =>
        model.provider === item.modelProvider && model.id === item.modelId,
    );
    return listed?.name ?? item.modelName ?? item.modelId ?? modelName;
  };
  const toggleWindowMaximize = async () => {
    if (await desktopWindow.isMaximized()) await desktopWindow.unmaximize();
    else await desktopWindow.maximize();
  };
  return (
    <div
      className={
        attachments.length > 0
          ? "conversation-layout has-attachments"
          : "conversation-layout"
      }
      ref={conversationLayoutRef}
    >
      <header
        className="workspace-header"
        onDoubleClick={(event) => {
          const target = event.target;
          if (target instanceof Element && target.closest("button, input, select, textarea, a")) return;
          void toggleWindowMaximize();
        }}
      >
        <div>
          <p className="eyebrow workspace-project">
            <span>{en ? "Current project" : "当前项目"}</span>
            <strong>{projectName ?? (en ? "No project selected" : "未选择项目")}</strong>
          </p>
          <h1>{session?.name ?? session?.id ?? (en ? "Select a session" : "选择一个 session")}</h1>
        </div>
        <button
          className={running ? "header-action is-running" : "header-action"}
          disabled={!connected}
          onClick={() => void stopGeneration()}
          type="button"
        >
          <span className="status-dot" />
          {connecting ? (en ? "Loading" : "正在加载") : running ? (en ? "Stop" : "停止生成") : (en ? "Ready" : "已就绪")}
        </button>
      </header>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button
            aria-label={t("close")}
            onClick={dismissError}
            title={t("close")}
            type="button"
          >
            <i aria-hidden="true" className="fa-solid fa-xmark" />
          </button>
        </div>
      )}
      <div className="message-scroll-region">
        <section
          className="message-list"
          data-native-wheel
          onScroll={(event) => {
            const element = event.currentTarget;
            const isAtBottom =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              56;
            stickToBottom.current = isAtBottom;
            setShowJumpToLatest(!isAtBottom);
            scheduleScrollMetrics(element);
          }}
          ref={messageListRef}
        >
          {timelineEntries.map((entry, index, entries) => {
            if (entry.type === "activity") {
              const isLiveActivity =
                running &&
                !entries
                  .slice(index + 1)
                  .some(
                    (later) =>
                      later.type === "activity" || later.type === "message",
                  );
              return (
                <ActivityGroup
                  durationMs={activityDuration(
                    entries,
                    index,
                    isLiveActivity ? liveNow : undefined,
                    isLiveActivity ? runStartedAt : undefined,
                  )}
                  items={entry.items}
                  key={`activity-${entry.items[0]?.id ?? index}`}
                  open={!isFollowedByAnswer(entries, index)}
                />
              );
            }
            if (entry.type === "file-changes")
              return (
                <section
                  aria-label={en ? "File changes" : "文件变更"}
                  className="message-file-changes"
                  key={`changes-${index}`}
                >
                  {entry.calls.map((call, callIndex) => (
                    <FileChangeSummary
                      call={call}
                      key={`${call.name}-${toolPath(call.args) ?? callIndex}-${callIndex}`}
                      onReview={() => onReview(entry.calls)}
                    />
                  ))}
                </section>
              );
            if (entry.type === "response-actions") {
              const usedModelName = responseModelName(entry.item);
              return (
                <footer
                  className="response-actions"
                  key={`actions-${entry.item.id}`}
                >
                  <button
                    aria-label={en ? "Copy response" : "复制回答"}
                    onClick={() =>
                      void navigator.clipboard.writeText(entry.item.content)
                    }
                    title={en ? "Copy response" : "复制回答"}
                    type="button"
                  >
                    <i aria-hidden="true" className="fa-regular fa-copy" />
                  </button>
                  {entry.query ? (
                    <button
                      aria-label={
                        reverting === entry.item.id
                          ? (en ? "Reverting turn" : "正在撤销本轮")
                          : (en ? "Revert turn" : "撤销本轮")
                      }
                      disabled={running || Boolean(reverting)}
                      onClick={() =>
                        void revertTurn(entry.item.id, entry.query, entry.calls)
                      }
                      title={en ? "Revert this turn and edit the query" : "回到本轮问题之前并重新编辑"}
                      type="button"
                    >
                      <i
                        aria-hidden="true"
                        className={`fa-solid fa-rotate-left${
                          reverting === entry.item.id ? " fa-spin" : ""
                        }`}
                      />
                    </button>
                  ) : null}
                  {entry.query ? (
                    <button
                      aria-label={en ? "Continue in a new task" : "在新任务中继续"}
                      disabled={running || Boolean(branching)}
                      onClick={() =>
                        void continueInNewSession(entry.item.id, entry.query)
                      }
                      title={en ? "Continue in a new task" : "在新任务中继续"}
                      type="button"
                    >
                      <i
                        aria-hidden="true"
                        className="fa-solid fa-code-branch"
                      />
                    </button>
                  ) : null}
                  {entry.item.occurredAt ? (
                    <time
                      dateTime={new Date(entry.item.occurredAt).toISOString()}
                    >
                      {formatMessageTime(entry.item.occurredAt)}
                    </time>
                  ) : null}
                  {usedModelName ? (
                    <span className="response-model" title={usedModelName}>
                      · {usedModelName}
                    </span>
                  ) : null}
                </footer>
              );
            }
            return (
              <ConversationMessage
                en={en}
                item={entry.item}
                key={entry.item.id}
                onContextMenu={openMessageContextMenu}
                onError={onError}
              />
            );
          })}
        </section>
        <div
          aria-hidden="true"
          className="conversation-scrollbar"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            const list = messageListRef.current;
            if (!list) return;
            const rect = event.currentTarget.getBoundingClientRect();
            scrollbarDragRef.current = {
              maxScroll: Math.max(0, list.scrollHeight - list.clientHeight),
              pointerId: event.pointerId,
              top: rect.top,
              trackHeight: rect.height,
            };
            const ratio = Math.max(
              0,
              Math.min(1, (event.clientY - rect.top) / rect.height),
            );
            list.scrollTop = ratio * scrollbarDragRef.current.maxScroll;
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const list = messageListRef.current;
            const drag = scrollbarDragRef.current;
            if (!list || !drag || drag.pointerId !== event.pointerId) return;
            const ratio = Math.max(
              0,
              Math.min(1, (event.clientY - drag.top) / drag.trackHeight),
            );
            // Streaming tool output can grow while the thumb is held. The
            // maximum captured on pointer-down would then only reach the old
            // halfway point, even when the pointer is at the bottom.
            scrollbarDragTarget.current =
              ratio * Math.max(0, list.scrollHeight - list.clientHeight);
            if (scrollbarDragFrame.current !== undefined) return;
            scrollbarDragFrame.current = window.requestAnimationFrame(() => {
              scrollbarDragFrame.current = undefined;
              const current = messageListRef.current;
              if (current) current.scrollTop = scrollbarDragTarget.current;
            });
          }}
          onPointerUp={(event) => {
            if (scrollbarDragRef.current?.pointerId === event.pointerId)
              scrollbarDragRef.current = undefined;
          }}
          ref={scrollbarRef}
        >
          <span />
        </div>
      </div>
      <ConversationMinimap
        en={en}
        entries={navigationEntries}
        onJump={jumpToMessage}
      />
      {showJumpToLatest && (
        <button
          className="jump-to-latest"
          onClick={() => scrollToLatest()}
          type="button"
        >
          ↓ 回到最新
        </button>
      )}
      {messageContextMenu && (
        <div
          className="message-context-layer"
          onContextMenu={(event) => event.preventDefault()}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setMessageContextMenu(undefined);
          }}
        >
          <div
            className="file-context-menu message-context-menu"
            style={{
              left: Math.max(8, Math.min(messageContextMenu.x, window.innerWidth - 196)),
              top: Math.max(8, Math.min(messageContextMenu.y, window.innerHeight - 92)),
            }}
          >
            <button
              onClick={() => {
                void navigator.clipboard
                  .writeText(messageContextMenu.item.content)
                  .catch((cause) => onError(String(cause)));
                setMessageContextMenu(undefined);
              }}
              type="button"
            >
              <i aria-hidden="true" className="fa-regular fa-copy" />
              {en ? "Copy question" : "复制问题"}
            </button>
            <div className="file-context-separator" />
            <button
              className="message-context-delete"
              disabled={running || submitting || deletingMessage}
              onClick={() => {
                setPendingMessageDelete(messageContextMenu.item);
                setMessageContextMenu(undefined);
              }}
              type="button"
            >
              <i aria-hidden="true" className="fa-regular fa-trash-can" />
              {en ? "Rewind to here" : "回退到这里"}
            </button>
          </div>
        </div>
      )}
      {pendingMessageDelete && (
        <div
          className="session-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deletingMessage)
              setPendingMessageDelete(undefined);
          }}
        >
          <section aria-modal="true" className="session-dialog-card" role="dialog">
            <h2>{en ? "Rewind to here?" : "回退到这里？"}</h2>
            <p>
              {en
                ? "The conversation will return to before this question. The current branch remains available through /tree. File changes will not be reverted."
                : "对话将回退到该问题之前，当前分支仍可通过 /tree 找回；已经产生的文件改动不会被撤销。"}
            </p>
            <div className="message-delete-preview">{pendingMessageDelete.content}</div>
            <footer>
              <button
                disabled={deletingMessage}
                onClick={() => setPendingMessageDelete(undefined)}
                type="button"
              >
                {en ? "Cancel" : "取消"}
              </button>
              <button
                className="danger-button"
                disabled={deletingMessage}
                onClick={() => void deleteUserMessage()}
                type="button"
              >
                {deletingMessage ? (en ? "Rewinding…" : "正在回退…") : (en ? "Rewind" : "回退")}
              </button>
            </footer>
          </section>
        </div>
      )}
      {commandPicker && (
        <div className="command-picker-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setCommandPicker(undefined);
        }}>
          <section aria-modal="true" className="command-picker" role="dialog">
            <header>
              <strong>{commandPicker.kind === "fork" ? (en ? "Fork session" : "创建会话分支") : (en ? "Session tree" : "会话树")}</strong>
              <button aria-label={t("close")} onClick={() => setCommandPicker(undefined)} type="button">×</button>
            </header>
            <div>
              {commandPicker.options.map((option) => (
                <button key={option.entryId} onClick={() => void selectCommandBranch(option.entryId)} type="button">
                  {option.text || option.entryId}
                </button>
              ))}
              {commandPicker.options.length === 0 && (
                <p>{en ? "No user messages are available." : "当前没有可导航的用户消息。"}</p>
              )}
            </div>
          </section>
        </div>
      )}
      <form
        className={`composer${composerDragActive ? " is-dragging" : ""}${
          running || submitting ? " is-working" : ""
        }`}
        onDragEnter={(event) => {
          if (
            Array.from(event.dataTransfer.items).some((item) => item.kind === "file")
          ) {
            event.preventDefault();
            setComposerDragActive(true);
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setComposerDragActive(false);
        }}
        onDragOver={(event) => {
          if (
            Array.from(event.dataTransfer.items).some((item) => item.kind === "file")
          ) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(event) => {
          const files = Array.from(event.dataTransfer.files);
          if (!files.length) return;
          event.preventDefault();
          event.stopPropagation();
          setComposerDragActive(false);
          void importAttachmentFiles(files);
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        ref={composerShellRef}
      >
        {(running || submitting) && (
          <div
            aria-live="polite"
            className="composer-working-indicator"
            role="status"
          >
            <i
              aria-hidden="true"
              className="fa-solid fa-circle-notch fa-spin"
            />
            <span>Agent K Working</span>
          </div>
        )}
        {slashMenuVisible && (
          <section
            aria-label={t("commands")}
            className="slash-command-menu"
            ref={slashMenuRef}
            role="listbox"
          >
            <header>
              <span>{t("commands")}</span>
              <kbd>↑↓</kbd>
              <kbd>Tab</kbd>
              <kbd>Enter</kbd>
            </header>
            <div className="slash-command-options">
              {slashCommandsLoading ? (
                <div className="slash-command-empty">
                  <i aria-hidden="true" className="fa-solid fa-circle-notch fa-spin" />
                  {t("loadingCommands")}
                </div>
              ) : filteredSlashCommands.length === 0 ? (
                <div className="slash-command-empty">
                  {t("noMatchingCommands")}
                </div>
              ) : (
                filteredSlashCommands.map((command, index) => {
                  const sourceLabel =
                    command.source === "builtin"
                      ? t("builtinCommand")
                      : command.source === "extension"
                      ? t("extensionCommand")
                      : command.source === "prompt"
                        ? t("promptCommand")
                        : t("skillCommand");
                  return (
                    <button
                      aria-selected={index === activeSlashIndex}
                      className={index === activeSlashIndex ? "is-active" : undefined}
                      id={`slash-command-${index}`}
                      key={`${command.source}:${command.name}`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        acceptSlashCommand(command);
                      }}
                      role="option"
                      title={command.sourceInfo?.path}
                      type="button"
                    >
                      <span className="slash-command-name">/{command.name}</span>
                      <small className={`is-${command.source}`}>{sourceLabel}</small>
                      {command.description && (
                        <span className="slash-command-description">
                          {command.description}
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </section>
        )}
        {composerDragActive && (
          <div className="composer-drop-hint">
            <i aria-hidden="true" className="fa-solid fa-paperclip" />
            {en ? "Drop to attach files" : "释放以添加文件"}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((attachment) => (
              <figure className={`is-${attachment.kind}`} key={attachment.id}>
                {attachment.previewUrl ? (
                  <img alt={attachment.name} src={attachment.previewUrl} />
                ) : (
                  <span className="composer-attachment-file-icon">
                    <i
                      aria-hidden="true"
                      className={
                        attachment.kind === "document"
                          ? "fa-regular fa-file-lines"
                          : "fa-regular fa-file-code"
                      }
                    />
                  </span>
                )}
                <figcaption title={attachment.name}>{attachment.name}</figcaption>
                <button
                  aria-label={en ? `Remove ${attachment.name}` : `移除 ${attachment.name}`}
                  onClick={() =>
                    setAttachments((current) =>
                      current.filter((item) => item.id !== attachment.id),
                    )
                  }
                  title={en ? "Remove file" : "移除文件"}
                  type="button"
                >
                  <i aria-hidden="true" className="fa-solid fa-xmark" />
                </button>
              </figure>
            ))}
          </div>
        )}
        {widgets
          .filter((widget) => widget.placement === "aboveEditor")
          .map((widget) => (
            <section className="extension-widget" key={widget.key}>
              {widget.lines.map((line, index) => (
                <div key={`${widget.key}-${index}`}><AnsiText text={line} /></div>
              ))}
            </section>
          ))}
        {pendingSteer ? (
          <section className="pending-steer-card">
            <span className="pending-steer-text">{pendingSteer.value || pendingSteer.attachments.map((attachment) => attachment.name).join(", ")}</span>
            <div className="pending-steer-actions">
              <button
                aria-label={en ? "Steer" : "引导"}
                onClick={() => {
                  const pending = pendingSteer;
                  setPendingSteer(undefined);
                  void submit("steer", pending.value, pending.attachments);
                }}
                type="button"
              ><i aria-hidden="true" className="fa-solid fa-turn-up" /> {en ? "Steer" : "引导"}</button>
              <button
                aria-label={en ? "Discard" : "撤销发送"}
                onClick={() => setPendingSteer(undefined)}
                title={en ? "Discard" : "撤销发送"}
                type="button"
              ><i aria-hidden="true" className="fa-regular fa-trash-can" /></button>
            </div>
          </section>
        ) : null}
        <div
          aria-disabled={!session || !connected || submitting}
          aria-multiline="true"
          className="composer-editor"
          contentEditable={Boolean(session && connected && !submitting)}
          data-placeholder={
            !session
              ? (en ? "Select a session first" : "先选择一个 session")
              : connecting
                ? (en ? "Connecting to Pi and loading session…" : "正在连接 Pi 并加载会话…")
                : running
                  ? (en ? "Send a follow-up instruction…" : "向 Pi 发送跟进指令…")
                  : (en ? "Agent K standing by…" : "Agent K 待命中...")
          }
          onClick={(event) => {
            const reference = (event.target as Element).closest<HTMLElement>(
              ".composer-inline-file-reference",
            );
            const path = reference?.dataset.path;
            const line = Number(reference?.dataset.line);
            if (!path || !Number.isFinite(line)) return;
            event.preventDefault();
            window.dispatchEvent(
              new CustomEvent("agent-k-open-file-line", {
                detail: { line, path },
              }),
            );
          }}
          onInput={(event) => {
            const value = serializeComposer(event.currentTarget);
            if (!value) event.currentTarget.replaceChildren();
            if (value !== draftValueRef.current) setDismissedSlashDraft(undefined);
            // Slash-command filtering must remain immediate. Ordinary prose can
            // stay in the DOM and synchronize after a short idle period.
            if (/^\/[^\s]*$/.test(value)) commitDraft(value);
            else queueDraftCommit(value);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp" && pendingSteer && !draftValueRef.current.trim()) {
              event.preventDefault();
              const pending = pendingSteer;
              setPendingSteer(undefined);
              setAttachments(pending.attachments);
              commitDraft(pending.value);
              requestAnimationFrame(() => {
                const editor = composerRef.current;
                if (!editor) return;
                populateComposer(editor, pending.value);
                placeCaretAtEnd(editor);
                editor.focus();
              });
              return;
            }
            if (slashMenuVisible) {
              if (event.key === "Escape") {
                event.preventDefault();
                setDismissedSlashDraft(draftValueRef.current);
                return;
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (!filteredSlashCommands.length) return;
                setSlashSelection((current) =>
                  event.key === "ArrowDown"
                    ? (current + 1) % filteredSlashCommands.length
                    : (current - 1 + filteredSlashCommands.length) %
                      filteredSlashCommands.length,
                );
                return;
              }
              if (
                (event.key === "Tab" ||
                  (event.key === "Enter" && !event.shiftKey)) &&
                filteredSlashCommands.length > 0
              ) {
                event.preventDefault();
                acceptSlashCommand(
                  filteredSlashCommands[activeSlashIndex],
                );
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit(event.ctrlKey ? "queue" : "steer");
            }
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files).filter((file) =>
              file.type.startsWith("image/"),
            );
            if (!files.length) {
              const text = event.clipboardData.getData("text/plain");
              if (!text) return;
              event.preventDefault();
              const selection = window.getSelection();
              if (!selection?.rangeCount) return;
              const range = selection.getRangeAt(0);
              range.deleteContents();
              const node = document.createTextNode(text);
              range.insertNode(node);
              range.setStartAfter(node);
              range.collapse(true);
              selection.removeAllRanges();
              selection.addRange(range);
              commitDraft(serializeComposer(event.currentTarget));
              return;
            }
            event.preventDefault();
            void importAttachmentFiles(files);
          }}
          ref={composerRef}
          role="textbox"
          spellCheck
          suppressContentEditableWarning
        />
        {widgets
          .filter((widget) => widget.placement === "belowEditor")
          .map((widget) => (
            <section className="extension-widget is-below" key={widget.key}>
              {widget.lines.map((line, index) => (
                <div key={`${widget.key}-${index}`}><AnsiText text={line} /></div>
              ))}
            </section>
          ))}
        <div className="composer-footer">
          <button
            aria-label={en ? "Attach images" : "添加图片"}
            className="composer-attach"
            disabled={!session || !connected || submitting || !modelSupportsImages}
            onClick={() => void chooseImages()}
            title={
              modelSupportsImages
                ? (en ? "Attach images" : "添加图片")
                : (en ? "Current model does not support images" : "当前模型不支持图片")
            }
            type="button"
          >
            <i aria-hidden="true" className="fa-solid fa-plus" />
          </button>
          <div className="access-control">
            <button className="access-level" onClick={() => setAccessMenu((current) => !current)} type="button">◈ {accessLabel} <i className="fa-solid fa-chevron-up" /></button>
            {accessMenu && <div className="access-menu"><button onClick={() => void setAccess("ask")} type="button">{t("permissionAsk")}</button><button disabled={!session?.id} onClick={() => void setAccess("session")} type="button">{t("permissionSession")}</button><button onClick={() => void setAccess("full")} type="button">{t("permissionFull")}</button></div>}
          </div>
          <span className="composer-hint">
            {running
              ? (en ? "Enter steer · Ctrl + Enter queue" : "Enter 跟进 · Ctrl + Enter 排队")
              : (en ? "Enter send · Shift + Enter newline" : "Enter 发送 · Shift + Enter 换行")}
          </span>
          {statuses.length > 0 && (
            <div className="extension-statuses" aria-live="polite">
              {statuses.map((status) => (
                <span key={status.key} title={plainUiText(status.text)}>
                  {status.key === "agent-k-plan" && status.text.includes("executing") && (
                    <i aria-hidden="true" className="fa-solid fa-spinner session-running-spinner" />
                  )}
                  <AnsiText text={status.text} />
                </span>
              ))}
            </div>
          )}
          <div className="model-control" ref={modelControlRef}>
            <button
              aria-expanded={modelMenu}
              aria-haspopup="listbox"
              className="composer-model"
              disabled={!connected || availableModels.length === 0}
              onClick={() => setModelMenu((current) => !current)}
              title={en ? "Switch model" : "切换模型"}
              type="button"
            >
              <span>{switchingModel ? (en ? "Switching…" : "正在切换…") : modelName}</span>
              <i aria-hidden="true" className="fa-solid fa-chevron-up" />
            </button>
            {modelMenu && (
              <div className="model-menu" role="listbox">
                <header>{en ? "Select model" : "选择模型"}</header>
                <div>
                  {availableModels.map((model) => {
                    const key = `${model.provider}/${model.id}`;
                    return (
                      <button
                        aria-selected={key === currentModelKey}
                        className={key === currentModelKey ? "is-active" : undefined}
                        disabled={switchingModel || running}
                        key={key}
                        onClick={() => void selectModel(model)}
                        role="option"
                        type="button"
                      >
                        <span>{model.name ?? model.id}</span>
                        <small>{model.provider}</small>
                        {key === currentModelKey && (
                          <i aria-hidden="true" className="fa-solid fa-check" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <button
            aria-label={stopInsteadOfSend ? (en ? "Stop generation" : "停止生成") : (en ? "Send message" : "发送消息")}
            className={
              stopInsteadOfSend ? "composer-submit is-stop" : "composer-submit"
            }
            disabled={
              stopInsteadOfSend
                ? !session || !connected || stopping
                : (!draft.trim() && attachments.length === 0) ||
                  !session ||
                  !connected ||
                  submitting ||
                  (attachments.some((attachment) => attachment.kind === "image") &&
                    !modelSupportsImages)
            }
            onClick={
              stopInsteadOfSend
                ? () => void stopGeneration()
                : undefined
            }
            type={stopInsteadOfSend ? "button" : "submit"}
          >
            {stopInsteadOfSend ? (
              <svg aria-hidden="true" viewBox="0 0 16 16">
                <rect height="7" rx="1" width="7" x="4.5" y="4.5" />
              </svg>
            ) : (
              <svg aria-hidden="true" viewBox="0 0 16 16">
                <path d="M8 12V4m0 0L4.8 7.2M8 4l3.2 3.2" />
              </svg>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
