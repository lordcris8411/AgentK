import type * as Monaco from "monaco-editor";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, {
  defaultSchema,
  type Options as RehypeSanitizeSchema,
} from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { defineEditor, type EditorTheme, type EditorThemeConfig } from "../../sdk";
import "katex/dist/katex.min.css";
import "./editor.css";

const monaco = (globalThis as typeof globalThis & {
  AgentKEditorDependencies: { monaco: typeof Monaco };
}).AgentKEditorDependencies.monaco;
const defaultCodeFont = '"Cascadia Code", "Cascadia Mono", Consolas, monospace';

// GitHub-flavoured Markdown commonly uses HTML for aligned and sized images,
// collapsible sections, and picture sources. Parse it, but retain an explicit
// allow-list so a repository README cannot inject scripts or event handlers.
const markdownHtmlSchema: RehypeSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      "alt", "align", "decoding", "height", "loading", "srcSet", "title", "width",
    ],
    source: [
      ...(defaultSchema.attributes?.source ?? []),
      "media", "sizes", "src", "srcSet", "type",
    ],
  },
};

function themeName(theme: EditorTheme): string {
  return theme === "dark"
    ? "agent-k-markdown-dark"
    : theme === "soft-light"
      ? "agent-k-markdown-soft-light"
      : "agent-k-markdown-light";
}

function customSyntaxRules(config?: EditorThemeConfig) {
  return Object.entries(config?.monacoSyntax ?? {}).map(([token, color]) => ({
    token,
    foreground: color.replace(/^#/, ""),
  }));
}

function customMonacoColors(config: EditorThemeConfig): Record<string, string> {
  const colors = config.colors;
  const components = config.components;
  const raised = colors["surface-raised"];
  const primary = colors["text-primary"];
  const secondary = colors["text-secondary"];
  const border = colors["border-strong"];
  const accent = colors.accent;
  const active = components["active-item"] ?? colors["surface-active"];
  const activeForeground = components["active-item-foreground"] ?? primary;
  const hover = components.hover ?? colors["surface-hover"];
  const hoverForeground = components["hover-foreground"] ?? primary;
  return {
    "focusBorder": accent,
    "input.background": components.input ?? raised,
    "input.border": border,
    "input.foreground": components["input-foreground"] ?? primary,
    "input.placeholderForeground": colors["text-muted"],
    "editorWidget.background": raised,
    "editorWidget.border": border,
    "editorWidget.foreground": primary,
    "editorWidget.resizeBorder": accent,
    "editorHoverWidget.background": raised,
    "editorHoverWidget.border": border,
    "editorHoverWidget.foreground": primary,
    "editorHoverWidget.highlightForeground": accent,
    "editorHoverWidget.statusBarBackground": colors["surface-panel"],
    "editorSuggestWidget.background": raised,
    "editorSuggestWidget.border": border,
    "editorSuggestWidget.foreground": secondary,
    "editorSuggestWidget.focusHighlightForeground": accent,
    "editorSuggestWidget.highlightForeground": accent,
    "editorSuggestWidget.selectedBackground": active,
    "editorSuggestWidget.selectedForeground": activeForeground,
    "list.activeSelectionBackground": active,
    "list.activeSelectionForeground": activeForeground,
    "list.hoverBackground": hover,
    "list.hoverForeground": hoverForeground,
    "list.inactiveSelectionBackground": active,
    "list.inactiveSelectionForeground": activeForeground,
    "scrollbarSlider.background": colors["scrollbar-thumb"],
    "scrollbarSlider.hoverBackground": colors["scrollbar-thumb-hover"],
    "scrollbarSlider.activeBackground": colors["scrollbar-thumb-hover"],
    "textCodeBlock.background": components["code-block"] ?? colors["surface-active"],
    "textPreformat.foreground": components["code-block-foreground"] ?? primary,
    "textLink.foreground": colors.info ?? accent,
    ...config.monaco,
  };
}

function applyCssTheme(config?: EditorThemeConfig): void {
  const style = document.documentElement.style;
  const set = (name: string, value?: string) => value
    ? style.setProperty(name, value)
    : style.removeProperty(name);
  set("--md-background", config?.colors["surface-panel"]);
  set("--md-border", config?.colors["border-color"]);
  set("--md-text", config?.colors["text-primary"]);
  set("--md-muted", config?.colors["text-secondary"]);
  set("--md-raised", config?.components["code-block"] ?? config?.colors["surface-raised"]);
  set("--md-code-text", config?.components["code-block-foreground"] ?? config?.colors["text-primary"]);
  set("--md-accent", config?.colors.accent);
  set("--md-selection", config?.colors["selection-background"]);
  set("--md-ui-font", config?.fonts?.ui);
  set("--md-code-font", config?.fonts?.code);
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
  applyCssTheme(initial.themeConfig);
  monaco.editor.defineTheme("agent-k-markdown-light", {
    base: "vs", inherit: true, rules: [],
    colors: { "editor.background": "#F6F4F1", "editorGutter.background": "#F6F4F1", "editor.selectionBackground": "#B6D7FF" },
  });
  monaco.editor.defineTheme("agent-k-markdown-soft-light", {
    base: "vs", inherit: true, rules: [],
    colors: { "editor.background": "#E2DED8", "editorGutter.background": "#E2DED8", "editor.selectionBackground": "#A8C9E8" },
  });
  monaco.editor.defineTheme("agent-k-markdown-dark", {
    base: "vs-dark", inherit: true, rules: [],
    colors: { "editor.background": "#252422", "editorGutter.background": "#252422", "editor.selectionBackground": "#264F78" },
  });
  let currentTheme = initial.theme;
  let themeConfig = initial.themeConfig;
  const applyThemeConfig = (config?: EditorThemeConfig) => {
    themeConfig = config;
    applyCssTheme(config);
    if (config) {
      monaco.editor.defineTheme("agent-k-markdown-custom", {
        base: currentTheme === "dark" ? "vs-dark" : "vs",
        inherit: true,
        rules: customSyntaxRules(config),
        colors: customMonacoColors(config),
      });
    }
  };
  applyThemeConfig(themeConfig);
  const activeThemeName = () => themeConfig ? "agent-k-markdown-custom" : themeName(currentTheme);

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
    fontFamily: initial.themeConfig?.fonts?.code ?? defaultCodeFont,
    inertialScroll: true,
    minimap: { enabled: false },
    model,
    mouseWheelScrollSensitivity: 1.5,
    readOnly: initial.readOnly,
    scrollbar: { alwaysConsumeMouseWheel: false, handleMouseWheel: true },
    smoothScrolling: true,
    theme: activeThemeName(),
    wordWrap: initial.wordWrap ? "on" : "off",
  });
  const previewRoot = createRoot(preview);
  let saved = initial.content;
  let layoutSuspended = false;
  let layoutFrame: number | undefined;
  let layoutHeight = 0;
  let layoutWidth = 0;
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
        rehypePlugins: [rehypeRaw, [rehypeSanitize, markdownHtmlSchema], rehypeKatex],
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
  const layout = () => {
    layoutFrame = undefined;
    if (layoutSuspended || previewing) return;
    const { clientHeight: height, clientWidth: width } = source;
    if (height <= 0 || width <= 0 || (height === layoutHeight && width === layoutWidth)) return;
    layoutHeight = height;
    layoutWidth = width;
    editor.layout({ height, width });
  };
  const scheduleLayout = () => {
    if (layoutSuspended || previewing || layoutFrame !== undefined) return;
    layoutFrame = requestAnimationFrame(layout);
  };
  const observer = new ResizeObserver(scheduleLayout);
  observer.observe(source);

  return {
    dispose() {
      if (contentTimer !== undefined) window.clearTimeout(contentTimer);
      if (layoutFrame !== undefined) cancelAnimationFrame(layoutFrame);
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
      currentTheme = theme;
      document.documentElement.dataset.theme = theme;
      applyThemeConfig(themeConfig);
      monaco.editor.setTheme(activeThemeName());
    },
    setThemeConfig(config: EditorThemeConfig | undefined) {
      applyThemeConfig(config);
      editor.updateOptions({ fontFamily: config?.fonts?.code ?? defaultCodeFont });
      monaco.editor.setTheme(activeThemeName());
    },
    setWordWrap(enabled) {
      editor.updateOptions({ wordWrap: enabled ? "on" : "off" });
    },
  };
});
