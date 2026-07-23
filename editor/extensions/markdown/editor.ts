import type * as Monaco from "monaco-editor";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { defineEditor, type EditorTheme } from "../../sdk";
import "katex/dist/katex.min.css";
import "./editor.css";

const monaco = (globalThis as typeof globalThis & {
  AgentKEditorDependencies: { monaco: typeof Monaco };
}).AgentKEditorDependencies.monaco;

function themeName(theme: EditorTheme): string {
  return theme === "dark" ? "agent-k-markdown-dark" : "agent-k-markdown-light";
}

function fileUrl(path: string): string {
  return `agentk-file://local/?path=${encodeURIComponent(path)}`;
}

function normalizePath(path: string): string {
  const drive = path.match(/^[A-Za-z]:/);
  const prefix = drive ? `${drive[0]}\\` : path.startsWith("\\\\") ? "\\\\" : "";
  const parts = path
    .slice(prefix.length)
    .split(/[\\/]+/)
    .filter((part) => part && part !== ".");
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return `${prefix}${normalized.join("\\")}`;
}

function markdownImageUrl(source: string | undefined, markdownPath: string): string | undefined {
  if (!source || /^(?:https?:|data:|blob:|agentk-file:)/i.test(source)) return source;

  // Markdown paths are relative to the document, while this editor runs from a
  // blob URL and therefore has no useful browser base URL.
  const match = source.match(/^([^?#]*)(.*)$/u);
  const rawPath = match?.[1] ?? source;
  const suffix = match?.[2] ?? "";
  let path = rawPath.replace(/\\/g, "/");
  if (/^file:\/\//i.test(path)) {
    path = decodeURIComponent(path.replace(/^file:\/\/\/?/i, ""));
  }
  if (!/^[A-Za-z]:[\\/]/.test(path) && !path.startsWith("//")) {
    const directory = markdownPath.slice(0, Math.max(markdownPath.lastIndexOf("\\"), markdownPath.lastIndexOf("/")) + 1);
    path = path.startsWith("/") && /^[A-Za-z]:/.test(markdownPath)
      ? `${markdownPath.slice(0, 2)}${path}`
      : `${directory}${path}`;
  }
  return `${fileUrl(normalizePath(path))}${suffix}`;
}

defineEditor((host, initial) => {
  document.documentElement.dataset.theme = initial.theme;
  monaco.editor.defineTheme("agent-k-markdown-light", {
    base: "vs", inherit: true, rules: [],
    colors: { "editor.background": "#F6F4F1", "editorGutter.background": "#F6F4F1", "editor.selectionBackground": "#B6D7FF" },
  });
  monaco.editor.defineTheme("agent-k-markdown-dark", {
    base: "vs-dark", inherit: true, rules: [],
    colors: { "editor.background": "#252422", "editorGutter.background": "#252422", "editor.selectionBackground": "#264F78" },
  });

  host.root.className = "markdown-editor";
  const stage = document.createElement("div");
  stage.className = "markdown-stage";
  const source = document.createElement("div");
  source.className = "markdown-source";
  const preview = document.createElement("article");
  preview.className = "markdown-preview";
  stage.append(source, preview);
  host.root.append(stage);

  const model = monaco.editor.createModel(
    initial.content,
    "markdown",
    monaco.Uri.file(initial.absolutePath),
  );
  const editor = monaco.editor.create(source, {
    automaticLayout: false,
    inertialScroll: true,
    minimap: { enabled: false },
    model,
    mouseWheelScrollSensitivity: 1.5,
    readOnly: initial.readOnly,
    scrollbar: { alwaysConsumeMouseWheel: false, handleMouseWheel: true },
    smoothScrolling: true,
    theme: themeName(initial.theme),
    wordWrap: initial.wordWrap ? "on" : "off",
  });
  const previewRoot = createRoot(preview);
  let saved = initial.content;
  let layoutSuspended = false;
  let previewing = false;
  let contentTimer: number | undefined;
  let contextLine: number | undefined;

  const updatePreview = () => {
    previewRoot.render(createElement(
      ReactMarkdown,
      {
        components: {
          img: ({ node: _node, src, ...props }: any) => createElement("img", {
            ...props,
            src: markdownImageUrl(src, initial.absolutePath),
          }),
        },
        rehypePlugins: [rehypeKatex],
        remarkPlugins: [remarkGfm, remarkBreaks, remarkMath],
      },
      model.getValue(),
    ));
  };
  const setPreview = (enabled: boolean) => {
    previewing = enabled;
    source.hidden = enabled;
    preview.hidden = !enabled;
    if (enabled) updatePreview();
    else requestAnimationFrame(() => editor.layout());
  };
  setPreview(false);

  const changes = model.onDidChangeContent(() => {
    host.reportDirty(model.getValue() !== saved);
    if (contentTimer !== undefined) window.clearTimeout(contentTimer);
    contentTimer = window.setTimeout(() => host.updateContent(model.getValue()), 350);
    if (previewing) updatePreview();
  });
  const context = editor.onContextMenu((event) => {
    contextLine = event.target.position?.lineNumber;
  });
  editor.addAction({
    contextMenuGroupId: "navigation",
    contextMenuOrder: 1.25,
    id: "agent-k-add-line-to-conversation",
    label: initial.locale === "en-US" ? "Add this line to conversation" : "添加本行到对话",
    run(sourceEditor) {
      const position = sourceEditor.getPosition();
      host.referenceLine(contextLine ?? position?.lineNumber ?? 1, position?.column ?? 1);
      contextLine = undefined;
    },
  });
  const keydown = editor.onKeyDown((event) => {
    if (!(event.ctrlKey || event.metaKey) || event.keyCode !== monaco.KeyCode.KeyS) return;
    event.preventDefault();
    event.stopPropagation();
    host.requestSave(model.getValue());
  });
  const observer = new ResizeObserver(() => {
    if (!layoutSuspended && !previewing && source.clientWidth > 0 && source.clientHeight > 0)
      editor.layout({ width: source.clientWidth, height: source.clientHeight });
  });
  observer.observe(source);

  return {
    dispose() {
      if (contentTimer !== undefined) window.clearTimeout(contentTimer);
      observer.disconnect();
      previewRoot.unmount();
      keydown.dispose();
      context.dispose();
      changes.dispose();
      editor.dispose();
      model.dispose();
    },
    executeAction(action, parameters) {
      if (action === "set-preview" && typeof parameters.enabled === "boolean")
        setPreview(parameters.enabled);
    },
    focus: () => editor.focus(),
    getContent: () => model.getValue(),
    markSaved(content) {
      saved = content;
      host.reportDirty(model.getValue() !== saved);
    },
    navigate(line, column) {
      setPreview(false);
      const target = Math.max(1, Math.min(line, model.getLineCount()));
      editor.setPosition({ lineNumber: target, column: Math.max(1, column) });
      editor.revealLineInCenter(target);
      editor.focus();
    },
    setContent(content) {
      saved = content;
      model.setValue(content);
      host.updateContent(content);
      host.reportDirty(false);
    },
    setLayoutSuspended(suspended) {
      layoutSuspended = suspended;
      if (!suspended && !previewing && source.clientWidth > 0 && source.clientHeight > 0)
        editor.layout({ width: source.clientWidth, height: source.clientHeight });
    },
    setTheme(theme) {
      document.documentElement.dataset.theme = theme;
      monaco.editor.setTheme(themeName(theme));
    },
    setWordWrap(enabled) {
      editor.updateOptions({ wordWrap: enabled ? "on" : "off" });
    },
  };
});
