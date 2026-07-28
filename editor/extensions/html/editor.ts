import type * as Monaco from "monaco-editor";
import { defineEditor, type EditorTheme, type EditorThemeConfig } from "../../sdk";
import "./editor.css";

const monaco = (globalThis as typeof globalThis & {
  AgentKEditorDependencies: { monaco: typeof Monaco };
}).AgentKEditorDependencies.monaco;
const defaultCodeFont = '"Cascadia Code", "Cascadia Mono", Consolas, monospace';

function themeName(theme: EditorTheme): string {
  return theme === "dark"
    ? "agent-k-html-dark"
    : theme === "soft-light"
      ? "agent-k-html-soft-light"
      : "agent-k-html-light";
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
  set("--html-background", config?.colors["surface-panel"]);
  set("--html-border", config?.colors["border-color"]);
  set("--html-text", config?.colors["text-primary"]);
  set("--html-raised", config?.colors["surface-raised"]);
  set("--html-ui-font", config?.fonts?.ui);
}

defineEditor((host, initial) => {
  document.documentElement.dataset.theme = initial.theme;
  applyCssTheme(initial.themeConfig);
  monaco.editor.defineTheme("agent-k-html-light", {
    base: "vs", inherit: true, rules: [],
    colors: { "editor.background": "#F6F4F1", "editorGutter.background": "#F6F4F1", "editor.selectionBackground": "#B6D7FF" },
  });
  monaco.editor.defineTheme("agent-k-html-soft-light", {
    base: "vs", inherit: true, rules: [],
    colors: { "editor.background": "#E2DED8", "editorGutter.background": "#E2DED8", "editor.selectionBackground": "#A8C9E8" },
  });
  monaco.editor.defineTheme("agent-k-html-dark", {
    base: "vs-dark", inherit: true, rules: [],
    colors: { "editor.background": "#252422", "editorGutter.background": "#252422", "editor.selectionBackground": "#264F78" },
  });
  let currentTheme = initial.theme;
  let themeConfig = initial.themeConfig;
  const applyThemeConfig = (config?: EditorThemeConfig) => {
    themeConfig = config;
    applyCssTheme(config);
    if (config) {
      monaco.editor.defineTheme("agent-k-html-custom", {
        base: currentTheme === "dark" ? "vs-dark" : "vs",
        inherit: true,
        rules: customSyntaxRules(config),
        colors: customMonacoColors(config),
      });
    }
  };
  applyThemeConfig(themeConfig);
  const activeThemeName = () => themeConfig ? "agent-k-html-custom" : themeName(currentTheme);

  host.root.className = "html-editor";
  const stage = document.createElement("div");
  stage.className = "html-stage";
  const source = document.createElement("div");
  source.className = "html-source";
  const preview = document.createElement("iframe");
  preview.className = "html-preview";
  preview.sandbox.add("allow-scripts");
  stage.append(source, preview);
  host.root.append(stage);

  const model = monaco.editor.createModel(
    initial.content,
    "html",
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
  let saved = initial.content;
  let layoutSuspended = false;
  let layoutFrame: number | undefined;
  let layoutHeight = 0;
  let layoutWidth = 0;
  let previewing = false;
  let contentTimer: number | undefined;
  let contextLine: number | undefined;

  const updatePreview = () => {
    preview.srcdoc = model.getValue();
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
