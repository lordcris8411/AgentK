import type * as Monaco from "monaco-editor";
import { defineEditor, type EditorTheme, type EditorThemeConfig } from "../../sdk";
import "./editor.css";

const monaco = (globalThis as typeof globalThis & {
  AgentKEditorDependencies: { monaco: typeof Monaco };
}).AgentKEditorDependencies.monaco;
const defaultCodeFont = '"Cascadia Code", "Cascadia Mono", Consolas, monospace';

// clangd 22's initialize response defines this exact legend. It deliberately
// contains repeated standard names, so token indices must not be replaced by a
// generic LSP legend (notably `property` is index 6).
const CLANGD_TOKEN_TYPES = ["variable", "variable", "parameter", "function", "method", "function", "property", "variable", "class", "interface", "enum", "enumMember", "type", "type", "unknown", "namespace", "typeParameter", "concept", "type", "macro", "modifier", "operator", "bracket", "label", "comment"];
const CLANGD_TOKEN_MODIFIERS = ["declaration", "definition", "deprecated", "deduced", "readonly", "static", "abstract", "virtual", "dependentName", "defaultLibrary", "usedAsMutableReference", "usedAsMutablePointer", "constructorOrDestructor", "userDefined", "functionScope", "classScope", "fileScope", "globalScope"];
const CLANGD_METHOD_TOKEN = CLANGD_TOKEN_TYPES.indexOf("method");
const CLANGD_FUNCTION_TOKEN = CLANGD_TOKEN_TYPES.indexOf("function");
const CLANGD_STATIC_MODIFIER = 1 << CLANGD_TOKEN_MODIFIERS.indexOf("static");
const CLANGD_CONSTRUCTOR_OR_DESTRUCTOR_MODIFIER =
  1 << CLANGD_TOKEN_MODIFIERS.indexOf("constructorOrDestructor");

function themeName(theme: EditorTheme, config?: EditorThemeConfig): string {
  if (config) return "agent-k-plugin-custom";
  return theme === "dark"
    ? "agent-k-plugin-dark"
    : theme === "soft-light"
      ? "agent-k-plugin-soft-light"
      : "agent-k-plugin-light";
}

function customSyntaxRules(theme: EditorTheme, syntax?: Record<string, string>) {
  const defaults = theme === "dark" ? {
    comment: "6A9955", keyword: "569CD6", string: "CE9178", number: "B5CEA8",
    type: "4FC1FF", function: "4FC1FF", variable: "D4D4D4", parameter: "9CA3AF",
    macro: "C586C0", namespace: "C586C0", property: "C49732",
  } : {
    comment: "6A737D", keyword: "0000FF", string: "A31515", number: "098658",
    type: "267F99", function: "267F99", variable: "24292F", parameter: "6B7280",
    macro: "AF00DB", namespace: "AF00DB", property: "8B6508",
  };
  const palette = { ...defaults, ...syntax };
  const color = (key: keyof typeof defaults) => palette[key].replace(/^#/, "");
  return [
    { token: "comment", foreground: color("comment") }, { token: "keyword", foreground: color("keyword") },
    { token: "string", foreground: color("string") }, { token: "number", foreground: color("number") },
    { token: "type", foreground: color("type") }, { token: "class", foreground: color("type") },
    { token: "interface", foreground: color("type") }, { token: "concept", foreground: color("type") },
    { token: "function", foreground: color("function") }, { token: "method", foreground: color("function") },
    { token: "variable", foreground: color("variable") }, { token: "parameter", foreground: color("parameter") },
    { token: "macro", foreground: color("macro") }, { token: "namespace", foreground: color("namespace") },
    { token: "property", foreground: color("property") }, { token: "enum", foreground: color("property") },
    { token: "enumMember", foreground: color("property") },
  ];
}

function customMonacoColors(config: EditorThemeConfig): Record<string, string> {
  const colors = config.colors;
  const components = config.components;
  const raised = colors["surface-raised"];
  const panel = colors["surface-panel"];
  const primary = colors["text-primary"];
  const secondary = colors["text-secondary"];
  const muted = colors["text-muted"];
  const border = colors["border-strong"];
  const accent = colors.accent;
  const active = components["active-item"] ?? colors["surface-active"];
  const activeForeground = components["active-item-foreground"] ?? primary;
  const hover = components.hover ?? colors["surface-hover"];
  const hoverForeground = components["hover-foreground"] ?? primary;
  const input = components.input ?? raised;
  const inputForeground = components["input-foreground"] ?? primary;
  const codeBlock = components["code-block"] ?? colors["surface-active"];
  const codeForeground = components["code-block-foreground"] ?? primary;
  return {
    "focusBorder": accent,
    "input.background": input,
    "input.border": border,
    "input.foreground": inputForeground,
    "input.placeholderForeground": muted,
    "editorWidget.background": raised,
    "editorWidget.border": border,
    "editorWidget.foreground": primary,
    "editorWidget.resizeBorder": accent,
    "editorHoverWidget.background": raised,
    "editorHoverWidget.border": border,
    "editorHoverWidget.foreground": primary,
    "editorHoverWidget.highlightForeground": accent,
    "editorHoverWidget.statusBarBackground": panel,
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
    "textCodeBlock.background": codeBlock,
    "textPreformat.foreground": codeForeground,
    "textLink.foreground": colors.info ?? accent,
    ...config.monaco,
  };
}

function hoverMarkdown(contents: unknown): Array<{ value: string }> {
  const values = Array.isArray(contents) ? contents : [contents];
  return values.flatMap((item) => {
    if (typeof item === "string") return [{ value: item }];
    if (!item || typeof item !== "object" || typeof (item as { value?: unknown }).value !== "string") return [];
    const { language, value } = item as { language?: unknown; value: string };
    return [{ value: typeof language === "string" ? `\`\`\`${language}\n${value}\n\`\`\`` : value }];
  });
}

type LspCompletionPosition = { character?: unknown; line?: unknown };
type LspCompletionRange = { end?: LspCompletionPosition; start?: LspCompletionPosition };
type LspCompletionTextEdit = {
  insert?: LspCompletionRange;
  newText?: unknown;
  range?: LspCompletionRange;
  replace?: LspCompletionRange;
};
type LspCompletionItem = {
  additionalTextEdits?: Array<{ newText?: unknown; range?: LspCompletionRange }>;
  commitCharacters?: unknown;
  deprecated?: unknown;
  detail?: unknown;
  documentation?: unknown;
  filterText?: unknown;
  insertText?: unknown;
  insertTextFormat?: unknown;
  kind?: unknown;
  label?: unknown;
  preselect?: unknown;
  sortText?: unknown;
  tags?: unknown;
  textEdit?: LspCompletionTextEdit;
};

function completionKind(kind: unknown): Monaco.languages.CompletionItemKind {
  const kinds: Monaco.languages.CompletionItemKind[] = [
    monaco.languages.CompletionItemKind.Text,
    monaco.languages.CompletionItemKind.Method,
    monaco.languages.CompletionItemKind.Function,
    monaco.languages.CompletionItemKind.Constructor,
    monaco.languages.CompletionItemKind.Field,
    monaco.languages.CompletionItemKind.Variable,
    monaco.languages.CompletionItemKind.Class,
    monaco.languages.CompletionItemKind.Interface,
    monaco.languages.CompletionItemKind.Module,
    monaco.languages.CompletionItemKind.Property,
    monaco.languages.CompletionItemKind.Unit,
    monaco.languages.CompletionItemKind.Value,
    monaco.languages.CompletionItemKind.Enum,
    monaco.languages.CompletionItemKind.Keyword,
    monaco.languages.CompletionItemKind.Snippet,
    monaco.languages.CompletionItemKind.Color,
    monaco.languages.CompletionItemKind.File,
    monaco.languages.CompletionItemKind.Reference,
    monaco.languages.CompletionItemKind.Folder,
    monaco.languages.CompletionItemKind.EnumMember,
    monaco.languages.CompletionItemKind.Constant,
    monaco.languages.CompletionItemKind.Struct,
    monaco.languages.CompletionItemKind.Event,
    monaco.languages.CompletionItemKind.Operator,
    monaco.languages.CompletionItemKind.TypeParameter,
  ];
  return typeof kind === "number" && Number.isInteger(kind) && kind >= 1
    ? kinds[kind - 1] ?? monaco.languages.CompletionItemKind.Text
    : monaco.languages.CompletionItemKind.Text;
}

function completionRange(range: LspCompletionRange | undefined): Monaco.IRange | undefined {
  const start = range?.start; const end = range?.end;
  if (typeof start?.line !== "number" || typeof start.character !== "number" ||
      typeof end?.line !== "number" || typeof end.character !== "number" ||
      start.line !== end.line || start.line < 0 || start.character < 0 || end.character < start.character)
    return undefined;
  return new monaco.Range(start.line + 1, start.character + 1, end.line + 1, end.character + 1);
}

function completionDocumentation(value: unknown): string | Monaco.IMarkdownString | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || typeof (value as { value?: unknown }).value !== "string") return undefined;
  return { value: (value as { value: string }).value };
}

function pathFromFileUri(uri: string): string | undefined {
  try {
    const parsed = new URL(uri); if (parsed.protocol !== "file:") return undefined;
    const path = decodeURIComponent(parsed.pathname);
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : parsed.host ? `//${parsed.host}${path}` : path;
  } catch { return undefined; }
}

defineEditor((host, initial) => {
  globalThis.document.documentElement.dataset.theme = initial.theme;
  monaco.editor.defineTheme("agent-k-plugin-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "property", foreground: "8B6508" },
      { token: "class", foreground: "267F99" },
      { token: "enum", foreground: "B57614" },
      { token: "enumMember", foreground: "B57614" },
      { token: "function", foreground: "267F99" },
      { token: "method", foreground: "2E7D32" },
      { token: "macro", foreground: "AF00DB" },
      { token: "namespace", foreground: "AF00DB" },
      { token: "parameter", foreground: "6B7280" },
    ],
    colors: {
      "editor.background": "#F6F4F1",
      "editorGutter.background": "#F6F4F1",
      "editor.lineHighlightBackground": "#EDF4FC",
      "editor.selectionBackground": "#B6D7FF",
      "editor.inactiveSelectionBackground": "#DBEAFE",
    },
  });
  monaco.editor.defineTheme("agent-k-plugin-soft-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "property", foreground: "795C12" },
      { token: "class", foreground: "226F87" },
      { token: "enum", foreground: "98630E" },
      { token: "enumMember", foreground: "98630E" },
      { token: "function", foreground: "226F87" },
      { token: "method", foreground: "286F2D" },
      { token: "macro", foreground: "8F18B1" },
      { token: "namespace", foreground: "8F18B1" },
      { token: "parameter", foreground: "60666F" },
    ],
    colors: {
      "editor.background": "#E2DED8",
      "editorGutter.background": "#E2DED8",
      "editor.lineHighlightBackground": "#D8E0E5",
      "editor.selectionBackground": "#A8C9E8",
      "editor.inactiveSelectionBackground": "#C4D7E5",
    },
  });
  monaco.editor.defineTheme("agent-k-plugin-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "property", foreground: "C49732" },
      { token: "class", foreground: "4FC1FF" },
      { token: "enum", foreground: "F9D65C" },
      { token: "enumMember", foreground: "F9D65C" },
      { token: "function", foreground: "4FC1FF" },
      { token: "method", foreground: "9CDC8C" },
      { token: "macro", foreground: "C586C0" },
      { token: "namespace", foreground: "C586C0" },
      { token: "parameter", foreground: "9CA3AF" },
    ],
    colors: {
      "editor.background": "#252422",
      "editorGutter.background": "#252422",
      "editor.lineHighlightBackground": "#272F3A",
      "editor.selectionBackground": "#264F78",
      "editor.inactiveSelectionBackground": "#20364D",
    },
  });

  let currentTheme = initial.theme;
  let themeConfig = initial.themeConfig;
  const applyThemeConfig = (config?: EditorThemeConfig) => {
    themeConfig = config;
    const style = globalThis.document.documentElement.style;
    const set = (name: string, value?: string) => value
      ? style.setProperty(name, value)
      : style.removeProperty(name);
    set("--text-background", config?.colors["surface-panel"]);
    set("--text-raised", config?.colors["surface-raised"]);
    set("--text-hover", config?.components.hover ?? config?.colors["surface-hover"]);
    set("--text-hover-foreground", config?.components["hover-foreground"] ?? config?.colors["text-primary"]);
    set("--text-border", config?.colors["border-strong"]);
    set("--text-primary", config?.colors["text-primary"]);
    set("--text-secondary", config?.colors["text-secondary"]);
    set("--text-muted", config?.colors["text-muted"]);
    set("--text-accent", config?.colors.accent);
    set("--text-scrollbar", config?.colors["scrollbar-thumb"]);
    set("--text-scrollbar-hover", config?.colors["scrollbar-thumb-hover"]);
    set("--text-ui-font", config?.fonts?.ui);
    set("--text-code-font", config?.fonts?.code);
    if (config) {
      monaco.editor.defineTheme("agent-k-plugin-custom", {
        base: currentTheme === "dark" ? "vs-dark" : "vs",
        inherit: true,
        // Custom syntax entries override only the requested tokens; the
        // base palette keeps every unspecified language token readable.
        rules: customSyntaxRules(currentTheme, config.monacoSyntax),
        colors: customMonacoColors(config),
      });
    }
  };
  applyThemeConfig(themeConfig);

  const model = monaco.editor.createModel(
    initial.content,
    initial.language,
    monaco.Uri.file(initial.absolutePath),
  );
  const editor = monaco.editor.create(host.root, {
    automaticLayout: false,
    contextmenu: false,
    fontFamily: themeConfig?.fonts?.code ?? defaultCodeFont,
    glyphMargin: true,
    inertialScroll: true,
    minimap: { enabled: false },
    model,
    mouseWheelScrollSensitivity: 1.5,
    readOnly: initial.readOnly,
    scrollbar: { alwaysConsumeMouseWheel: false, handleMouseWheel: true },
    "semanticHighlighting.enabled": true,
    quickSuggestions: { comments: false, other: true, strings: false },
    suggestOnTriggerCharacters: true,
    smoothScrolling: true,
    theme: themeName(initial.theme, themeConfig),
    wordWrap: initial.wordWrap ? "on" : "off",
  });
  const debugDecorations = editor.createDecorationsCollection();
  const applyDebugState = (state: { breakpoints: number[]; currentLine?: number; paused: boolean }) => {
    debugDecorations.set([
      ...state.breakpoints.map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: { glyphMarginClassName: "agent-k-debug-breakpoint", glyphMarginHoverMessage: { value: initial.locale === "en-US" ? "Breakpoint" : "断点" } },
      })),
      ...(state.paused && state.currentLine ? [{
        range: new monaco.Range(state.currentLine, 1, state.currentLine, 1),
        options: { glyphMarginClassName: "agent-k-debug-current-glyph", isWholeLine: true, className: "agent-k-debug-current-line" },
      }] : []),
    ]);
  };
  const debugGutter = editor.onMouseDown((event) => {
    if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !event.target.position) return;
    host.toggleBreakpoint(event.target.position.lineNumber);
  });
  const cpp = initial.language === "cpp";
  const languageStatus = cpp ? globalThis.document.createElement("div") : undefined;
  if (languageStatus) {
    languageStatus.className = "agent-k-cpp-language-status";
    languageStatus.dataset.theme = initial.theme;
    const spinner = globalThis.document.createElement("span");
    spinner.className = "agent-k-cpp-language-spinner";
    const label = globalThis.document.createElement("span");
    label.textContent = initial.locale === "en-US" ? "Preparing C++ analysis…" : "正在准备 C++ 语义分析…";
    languageStatus.append(spinner, label);
    host.root.append(languageStatus);
  }
  const hideLanguageStatus = () => { if (languageStatus) languageStatus.hidden = true; };
  const showLanguageStatus = () => { if (languageStatus) languageStatus.hidden = false; };
  const position = (value: Monaco.Position) => ({ line: value.lineNumber - 1, character: value.column - 1 });
  const document = () => ({ uri: model.uri.toString(), languageId: "cpp", version: model.getVersionId(), text: model.getValue() });
  let languageSync: Promise<void> = Promise.resolve();
  let cppDocumentOpened = false;
  const semanticChangeListeners = new Set<(event: void) => unknown>();
  const fireSemanticChange = () => {
    for (const listener of semanticChangeListeners) listener(undefined);
  };
  const openDocument = () => {
    if (!cpp) return languageSync;
    const openingDocument = document();
    showLanguageStatus();
    languageSync = languageSync.catch(() => undefined).then(() => host.languageRequest("textDocument/didOpen", { textDocument: openingDocument })
      .then((accepted) => {
        cppDocumentOpened = accepted === true;
        if (cppDocumentOpened) fireSemanticChange();
        else hideLanguageStatus();
      })
      .catch(() => { cppDocumentOpened = false; hideLanguageStatus(); }));
    return languageSync;
  };
  const syncDocument = () => {
    if (!cpp) return languageSync;
    // Capture the exact edit snapshot now. Reading Monaco only when this
    // queued operation eventually runs makes rapid edits send the same latest
    // version repeatedly, so clangd and completion positions can diverge.
    const uri = model.uri.toString();
    const version = model.getVersionId();
    const text = model.getValue();
    languageSync = languageSync.catch(() => undefined).then(() => {
      // A tab may predate project loading, or survive an unload/reload. clangd
      // ignores didChange for such a document until a fresh didOpen succeeds.
      if (!cppDocumentOpened) return undefined;
      return host.languageRequest("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      }).then(() => undefined).catch(() => { cppDocumentOpened = false; });
    });
    return languageSync;
  };
  const flushDocumentSync = () => languageSync;
  type LspDiagnostic = { message?: unknown; range?: { end?: { character?: unknown; line?: unknown }; start?: { character?: unknown; line?: unknown } }; severity?: unknown };
  const applyDiagnostics = (items: readonly LspDiagnostic[]) => {
    const markers = items.flatMap((item) => {
      const start = item.range?.start; const end = item.range?.end;
      if (typeof item.message !== "string" || typeof start?.line !== "number" || typeof start.character !== "number" || typeof end?.line !== "number" || typeof end.character !== "number" || start.line < 0 || end.line < start.line || start.line >= model.getLineCount() || end.line >= model.getLineCount()) return [];
      const startColumn = Math.min(Math.max(1, start.character + 1), model.getLineMaxColumn(start.line + 1));
      const endColumn = Math.min(Math.max(1, end.character + 1), model.getLineMaxColumn(end.line + 1));
      const severity = item.severity === 1 ? monaco.MarkerSeverity.Error : item.severity === 2 ? monaco.MarkerSeverity.Warning : item.severity === 3 ? monaco.MarkerSeverity.Info : monaco.MarkerSeverity.Hint;
      return [{ endColumn, endLineNumber: end.line + 1, message: item.message, severity, startColumn, startLineNumber: start.line + 1 }];
    });
    monaco.editor.setModelMarkers(model, "clangd", markers);
  };
  const sanitizeSemanticTokens = (data: number[]): number[] => {
    let inputCharacter = 0; let inputLine = 0; let outputCharacter = 0; let outputLine = 0;
    const sanitized: number[] = [];
    for (let index = 0; index + 4 < data.length; index += 5) {
      const [lineDelta, characterDelta, length, tokenType, modifiers] = data.slice(index, index + 5);
      inputLine += lineDelta;
      inputCharacter = lineDelta === 0 ? inputCharacter + characterDelta : characterDelta;
      if (!Number.isSafeInteger(inputLine) || !Number.isSafeInteger(inputCharacter) || !Number.isSafeInteger(length) || inputLine < 0 || inputCharacter < 0 || length <= 0 || inputLine >= model.getLineCount()) continue;
      const lineLength = model.getLineLength(inputLine + 1);
      const safeLength = Math.min(length, lineLength - inputCharacter);
      if (safeLength <= 0) continue;
      // clangd distinguishes static methods and constructors through its
      // internal token kind/modifier combination. Normalize those to Monaco's
      // standard `function` token so one theme rule colors every function-like
      // symbol without DOM decorations or CSS overrides.
      const functionLike = CLANGD_TOKEN_TYPES[tokenType] === "function" ||
        (tokenType === CLANGD_METHOD_TOKEN &&
          (modifiers & (CLANGD_STATIC_MODIFIER | CLANGD_CONSTRUCTOR_OR_DESTRUCTOR_MODIFIER)) !== 0);
      sanitized.push(
        inputLine - outputLine,
        inputLine === outputLine ? inputCharacter - outputCharacter : inputCharacter,
        safeLength,
        functionLike ? CLANGD_FUNCTION_TOKEN : tokenType,
        modifiers,
      );
      outputLine = inputLine; outputCharacter = inputCharacter;
    }
    return sanitized;
  };
  type LspRange = { start: { line: number; character: number }; end: { line: number; character: number } };
  type LspLocation = { uri?: string; range?: LspRange; targetUri?: string; targetRange?: LspRange; targetSelectionRange?: LspRange };
  const locationTargets = async (method: string, at: Monaco.Position, extra: Record<string, unknown> = {}) => {
    await flushDocumentSync();
    const result = await host.languageRequest(method, { textDocument: { uri: model.uri.toString() }, position: position(at), ...extra }) as LspLocation | LspLocation[] | undefined;
    return (Array.isArray(result) ? result : result ? [result] : []).flatMap((item) => {
      const uri = item.targetUri ?? item.uri; const range = item.targetSelectionRange ?? item.targetRange ?? item.range;
      return typeof uri === "string" && range ? [{ uri, range }] : [];
    });
  };
  if (cpp) void openDocument();
  let completion: { dispose(): void } | undefined;
  let hover: { dispose(): void } | undefined;
  let semantic: { dispose(): void } | undefined;
  if (cpp) {
    // Language-service integrations are optional. A Monaco API mismatch or a
    // failed provider must never prevent the underlying C++ file from opening.
    try {
      completion = monaco.languages.registerCompletionItemProvider("cpp", { triggerCharacters: [".", ">", ":"], provideCompletionItems: async (requestedModel, at, context, token) => {
        try {
          if (requestedModel !== model) return { suggestions: [] };
          const requestedVersion = model.getVersionId();
          await flushDocumentSync();
          if (token?.isCancellationRequested || requestedVersion !== model.getVersionId()) return { suggestions: [] };
          const response = await host.languageRequest("textDocument/completion", {
            textDocument: { uri: model.uri.toString() },
            position: position(at),
            context: {
              triggerCharacter: context.triggerCharacter,
              triggerKind: context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter ? 2 : 1,
            },
          }) as { isIncomplete?: unknown; items?: LspCompletionItem[] } | LspCompletionItem[] | undefined;
          if (token?.isCancellationRequested || requestedVersion !== model.getVersionId()) return { suggestions: [] };
          const items = Array.isArray(response) ? response : response?.items ?? [];
          const currentWord = requestedModel.getWordUntilPosition(at);
          const fallbackRange = new monaco.Range(at.lineNumber, currentWord.startColumn, at.lineNumber, at.column);
          const suggestions = items.flatMap((item): Monaco.languages.CompletionItem[] => {
            if (typeof item.label !== "string") return [];
            const textEdit = item.textEdit;
            const editRange = completionRange(textEdit?.range);
            const insertRange = completionRange(textEdit?.insert);
            const replaceRange = completionRange(textEdit?.replace);
            const range = insertRange && replaceRange
              ? { insert: insertRange, replace: replaceRange }
              : editRange ?? replaceRange ?? insertRange ?? fallbackRange;
            const label = item.label.trimStart() || item.label;
            const insertText = typeof textEdit?.newText === "string"
              ? textEdit.newText
              : typeof item.insertText === "string"
                ? item.insertText
                : label;
            const additionalTextEdits = Array.isArray(item.additionalTextEdits)
              ? item.additionalTextEdits.flatMap((edit) => {
                  const range = completionRange(edit.range);
                  return range && typeof edit.newText === "string" ? [{ range, text: edit.newText }] : [];
                })
              : undefined;
            const deprecated = item.deprecated === true || (Array.isArray(item.tags) && item.tags.includes(1));
            return [{
              label,
              kind: completionKind(item.kind),
              range,
              insertText,
              ...(typeof item.detail === "string" ? { detail: item.detail } : {}),
              ...(completionDocumentation(item.documentation) ? { documentation: completionDocumentation(item.documentation) } : {}),
              ...(typeof item.filterText === "string" ? { filterText: item.filterText } : {}),
              ...(typeof item.sortText === "string" ? { sortText: item.sortText } : {}),
              ...(item.preselect === true ? { preselect: true } : {}),
              ...(item.insertTextFormat === 2 ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet } : {}),
              ...(Array.isArray(item.commitCharacters) ? { commitCharacters: item.commitCharacters.filter((value): value is string => typeof value === "string" && value.length === 1) } : {}),
              ...(additionalTextEdits?.length ? { additionalTextEdits } : {}),
              ...(deprecated ? { tags: [monaco.languages.CompletionItemTag.Deprecated] } : {}),
            }];
          });
          return { suggestions, incomplete: !Array.isArray(response) && response?.isIncomplete === true };
        } catch {
          // Provider promises are invoked outside editor initialization. Never
          // let a timed-out IPC request tear down the whole iframe runtime.
          return { suggestions: [] };
        }
      } });
      hover = monaco.languages.registerHoverProvider("cpp", { provideHover: async (_, at) => {
        try {
          const value = await host.languageRequest("textDocument/hover", { textDocument: { uri: model.uri.toString() }, position: position(at) }) as { contents?: unknown }; if (!value?.contents) return null;
          const contents = hoverMarkdown(value.contents); return contents.length ? { contents } : null;
        } catch {
          return null;
        }
      } });
      semantic = monaco.languages.registerDocumentSemanticTokensProvider("cpp", {
        onDidChange: (listener: (event: void) => unknown, thisArg?: unknown) => {
          const subscribed = thisArg === undefined
            ? listener
            : (event: void) => listener.call(thisArg, event);
          semanticChangeListeners.add(subscribed);
          return { dispose: () => semanticChangeListeners.delete(subscribed) };
        },
        getLegend: () => ({ tokenTypes: CLANGD_TOKEN_TYPES, tokenModifiers: CLANGD_TOKEN_MODIFIERS }),
        provideDocumentSemanticTokens: async (requestedModel, _lastResultId, token) => {
          if (requestedModel !== model) return null;
          const requestedVersion = model.getVersionId();
          await languageSync;
          // Monaco invalidates the previous request on every edit. Let the
          // latest version settle before asking clangd for an expensive full
          // semantic token snapshot, otherwise rapid edits can starve its
          // interactive completion queue.
          await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
          if (!cppDocumentOpened || token?.isCancellationRequested || requestedVersion !== model.getVersionId()) return null;
          try {
            const result = await host.languageRequest("textDocument/semanticTokens/full", { textDocument: { uri: model.uri.toString() } }) as { data?: number[] } | undefined;
            if (!Array.isArray(result?.data) || token?.isCancellationRequested || requestedVersion !== model.getVersionId()) return null;
            const data = sanitizeSemanticTokens(result?.data ?? []); hideLanguageStatus();
            return { data: new Uint32Array(data) };
          } catch {
            // clangd cancels an in-flight request when didChange wins the race.
            // Keep the last valid colors while Monaco requests fresh tokens.
            return null;
          }
        },
        releaseDocumentSemanticTokens: () => undefined,
      });
    } catch (cause) {
      host.reportError(cause instanceof Error ? `C++ language service unavailable: ${cause.message}` : "C++ language service unavailable");
    }
  }
  let saved = initial.content;
  let layoutSuspended = false;
  let layoutFrame: number | undefined;
  let layoutHeight = 0;
  let layoutWidth = 0;
  const definitionLink = editor.createDecorationsCollection();
  const definitionHover = editor.onMouseMove((event) => {
    if (!cpp || !(event.event.ctrlKey || event.event.metaKey) || !event.target.position) { definitionLink.clear(); return; }
    const word = model.getWordAtPosition(event.target.position);
    if (!word) { definitionLink.clear(); return; }
    definitionLink.set([{ range: new monaco.Range(event.target.position.lineNumber, word.startColumn, event.target.position.lineNumber, word.endColumn), options: { inlineClassName: "agent-k-definition-link" } }]);
  });
  const definitionClick = editor.onMouseDown((event) => {
    if (!cpp || !(event.event.ctrlKey || event.event.metaKey) || !event.target.position) return;
    void openFirstLocation("textDocument/definition", event.target.position);
  });
  const openFirstLocation = async (method: "textDocument/declaration" | "textDocument/definition", at: Monaco.Position) => {
    const target = (await locationTargets(method, at))[0];
    const path = target ? pathFromFileUri(target.uri) : undefined;
    if (path) host.openFile(path, target.range.start.line + 1, target.range.start.character + 1);
  };
  const referencePanel = globalThis.document.createElement("section");
  referencePanel.className = "agent-k-cpp-references";
  referencePanel.hidden = true; referencePanel.style.display = "none";
  host.root.append(referencePanel);
  let referencePanelRevision = 0;
  let referenceDragCleanup: (() => void) | undefined;
  const hideReferences = () => {
    referencePanelRevision += 1;
    referenceDragCleanup?.(); referenceDragCleanup = undefined;
    referencePanel.hidden = true;
    referencePanel.style.display = "none";
  };
  const placeReferences = (at: Monaco.Position) => {
    const visible = editor.getScrolledVisiblePosition(at);
    const rootBounds = host.root.getBoundingClientRect();
    const left = Math.max(8, Math.min((visible?.left ?? 12) + 12, rootBounds.width - referencePanel.offsetWidth - 8));
    const top = Math.max(8, Math.min((visible?.top ?? 12) + (visible?.height ?? 18) + 8, rootBounds.height - referencePanel.offsetHeight - 8));
    referencePanel.style.left = `${left}px`; referencePanel.style.right = "auto"; referencePanel.style.top = `${top}px`;
  };
  const previewFor = async (path: string, line: number) => {
    const text = path.replaceAll("\\", "/").toLowerCase() === initial.absolutePath.replaceAll("\\", "/").toLowerCase()
      ? model.getValue()
      : await host.languageRequest("agent-k/read-file", { path }) as string;
    return text.split(/\r?\n/)[line]?.trim() ?? "";
  };
  const showReferences = async (at: Monaco.Position) => {
    // References do not carry a kind. A single definition and declaration
    // lookup lets us classify their locations without one request per file.
    const [targets, definitions, declarations] = await Promise.all([
      locationTargets("textDocument/references", at, { context: { includeDeclaration: true } }),
      locationTargets("textDocument/definition", at),
      locationTargets("textDocument/declaration", at),
    ]);
    const revision = ++referencePanelRevision;
    const sameLocation = (left: { uri: string; range: LspRange }, right: { uri: string; range: LspRange }) =>
      left.uri.replaceAll("\\", "/").toLowerCase() === right.uri.replaceAll("\\", "/").toLowerCase()
      && left.range.start.line === right.range.start.line && left.range.start.character === right.range.start.character;
    const referenceKind = (target: { uri: string; range: LspRange }) => definitions.some((item) => sameLocation(item, target))
      ? (initial.locale === "en-US" ? "Definition" : "定义")
      : declarations.some((item) => sameLocation(item, target))
        ? (initial.locale === "en-US" ? "Declaration" : "声明")
        : (initial.locale === "en-US" ? "Reference" : "引用");
    referencePanel.replaceChildren();
    const header = globalThis.document.createElement("div");
    header.className = "agent-k-cpp-references-header";
    const title = globalThis.document.createElement("strong");
    title.textContent = initial.locale === "en-US" ? `${targets.length} References` : `${targets.length} 个引用`;
    const close = globalThis.document.createElement("button");
    close.type = "button"; close.textContent = "×"; close.title = initial.locale === "en-US" ? "Close" : "关闭";
    close.onclick = (event) => { event.preventDefault(); event.stopPropagation(); hideReferences(); };
    header.append(title, close); referencePanel.append(header);
    header.onpointerdown = (event) => {
      if ((event.target as HTMLElement | null)?.closest("button")) return;
      event.preventDefault(); event.stopPropagation();
      const startX = event.clientX; const startY = event.clientY;
      const startLeft = referencePanel.offsetLeft; const startTop = referencePanel.offsetTop;
      const move = (moveEvent: PointerEvent) => {
        const rootBounds = host.root.getBoundingClientRect();
        const left = Math.max(8, Math.min(startLeft + moveEvent.clientX - startX, rootBounds.width - referencePanel.offsetWidth - 8));
        const top = Math.max(8, Math.min(startTop + moveEvent.clientY - startY, rootBounds.height - referencePanel.offsetHeight - 8));
        referencePanel.style.left = `${left}px`; referencePanel.style.top = `${top}px`;
      };
      const end = () => { referenceDragCleanup?.(); };
      referenceDragCleanup?.();
      globalThis.addEventListener("pointermove", move); globalThis.addEventListener("pointerup", end, { once: true });
      referenceDragCleanup = () => { globalThis.removeEventListener("pointermove", move); globalThis.removeEventListener("pointerup", end); referenceDragCleanup = undefined; };
    };
    for (const target of targets) {
      const path = pathFromFileUri(target.uri); if (!path) continue;
      const item = globalThis.document.createElement("button");
      item.type = "button"; item.className = "agent-k-cpp-reference";
      const location = globalThis.document.createElement("span");
      location.className = "agent-k-cpp-reference-location";
      const kind = globalThis.document.createElement("em");
      kind.className = "agent-k-cpp-reference-kind"; kind.textContent = referenceKind(target);
      location.append(kind, globalThis.document.createTextNode(`${path.replaceAll("\\", "/").split("/").pop() ?? path}:${target.range.start.line + 1}`));
      const preview = globalThis.document.createElement("span");
      preview.className = "agent-k-cpp-reference-preview"; preview.textContent = "…";
      item.append(location, preview);
      item.title = path;
      item.onclick = (event) => { event.preventDefault(); event.stopPropagation(); host.openFile(path, target.range.start.line + 1, target.range.start.character + 1); };
      referencePanel.append(item);
      void previewFor(path, target.range.start.line).then((value) => {
        if (revision === referencePanelRevision) preview.textContent = value || "…";
      }).catch(() => {
        if (revision === referencePanelRevision) preview.textContent = initial.locale === "en-US" ? "Preview unavailable" : "无法读取预览";
      });
    }
    referencePanel.hidden = false; referencePanel.style.display = "block"; placeReferences(at);
  };
  referencePanel.onpointerdown = (event) => { event.preventDefault(); };
  const referenceBlur = editor.onDidBlurEditorText(() => hideReferences());
  const languageFocus = editor.onDidFocusEditorText(() => {
    // A tab can outlive an unload/reload or be opened before the worker is
    // ready. Retry didOpen only until clangd confirms it accepted the write.
    if (cpp && !cppDocumentOpened) void openDocument();
  });
  let contextLine: number | undefined;
  let contextPosition: Monaco.Position | undefined;
  let contentTimer: number | undefined;
  let suggestTimer: number | undefined;
  const changes = model.onDidChangeContent(() => {
    const content = model.getValue();
    host.reportDirty(content !== saved);
    if (contentTimer !== undefined) window.clearTimeout(contentTimer);
    contentTimer = window.setTimeout(() => host.updateContent(model.getValue()), 350);
    if (cpp) {
      syncDocument();
      const cursor = editor.getPosition();
      const prefix = cursor ? model.getLineContent(cursor.lineNumber).slice(0, cursor.column - 1) : "";
      if (/(?:->|\.|::)$/.test(prefix)) {
        if (suggestTimer !== undefined) window.clearTimeout(suggestTimer);
        const version = model.getVersionId();
        suggestTimer = window.setTimeout(() => {
          suggestTimer = undefined;
          void flushDocumentSync().then(() => {
            if (version === model.getVersionId()) editor.trigger("agent-k-cpp-member-access", "editor.action.triggerSuggest", {});
          });
        }, 110);
      }
    }
  });
  const contextMenu = globalThis.document.createElement("section");
  contextMenu.className = "agent-k-editor-context-menu";
  contextMenu.hidden = true; host.root.append(contextMenu);
  // Keep Monaco focused while choosing an item. Otherwise its blur handler
  // hides the menu between pointerdown and click, swallowing every action.
  contextMenu.onpointerdown = (event) => { event.preventDefault(); };
  const hideContextMenu = () => { contextMenu.hidden = true; };
  const addContextAction = (label: string, run: () => void | Promise<void>) => {
    const item = globalThis.document.createElement("button");
    item.type = "button"; item.textContent = label;
    item.onclick = (event) => { event.preventDefault(); event.stopPropagation(); hideContextMenu(); void run(); };
    contextMenu.append(item);
  };
  const addContextSeparator = () => contextMenu.append(globalThis.document.createElement("hr"));
  const context = editor.onContextMenu((event) => {
    contextLine = event.target.position?.lineNumber;
    contextPosition = event.target.position ?? undefined;
    const at = contextPosition ?? editor.getPosition();
    contextMenu.replaceChildren();
    // This is intentionally first in every editor, not just C++.
    addContextAction(initial.locale === "en-US" ? "Add this line to conversation" : "添加本行到对话", () => {
      const position = at ?? editor.getPosition();
      host.referenceLine(contextLine ?? position?.lineNumber ?? 1, position?.column ?? 1);
      contextLine = undefined;
    });
    // cppDocumentOpened is true only after the language worker accepted
    // didOpen, which also proves that this file belongs to a loaded project.
    if (cpp && cppDocumentOpened && at) {
      addContextAction(initial.locale === "en-US" ? "Go to Declaration" : "跳转到声明", () => openFirstLocation("textDocument/declaration", at));
      addContextAction(initial.locale === "en-US" ? "Go to Definition" : "跳转到定义", () => openFirstLocation("textDocument/definition", at));
      addContextAction(initial.locale === "en-US" ? "Find All References" : "查找所有引用", () => showReferences(at));
    }
    addContextSeparator();
    addContextAction(initial.locale === "en-US" ? "Cut" : "剪切", () => editor.trigger("agent-k-context-menu", "editor.action.clipboardCutAction", {}));
    addContextAction(initial.locale === "en-US" ? "Copy" : "复制", () => editor.trigger("agent-k-context-menu", "editor.action.clipboardCopyAction", {}));
    addContextAction(initial.locale === "en-US" ? "Paste" : "粘贴", () => editor.trigger("agent-k-context-menu", "editor.action.clipboardPasteAction", {}));
    const visible = at ? editor.getScrolledVisiblePosition(at) : undefined;
    contextMenu.hidden = false;
    const mouse = event.event as { posx?: unknown; posy?: unknown };
    const bounds = host.root.getBoundingClientRect();
    const rawLeft = typeof mouse.posx === "number" ? mouse.posx - bounds.left : (visible?.left ?? 8) + 8;
    const rawTop = typeof mouse.posy === "number" ? mouse.posy - bounds.top : (visible?.top ?? 8) + (visible?.height ?? 18);
    const left = Math.max(8, Math.min(rawLeft, host.root.clientWidth - contextMenu.offsetWidth - 8));
    const top = Math.max(8, Math.min(rawTop, host.root.clientHeight - contextMenu.offsetHeight - 8));
    contextMenu.style.left = `${left}px`; contextMenu.style.top = `${top}px`;
  });
  const selectionChange = editor.onDidChangeCursorSelection(({ selection }) => {
    host.reportSelection(selection.isEmpty() ? "" : model.getValueInRange(selection));
  });
  const contextOutside = (event: PointerEvent) => {
    if (!contextMenu.contains(event.target as Node)) hideContextMenu();
  };
  globalThis.document.addEventListener("pointerdown", contextOutside, true);
  // Monaco briefly blurs its hidden text input while dispatching a context
  // menu on Linux. That is an implementation detail, not an indication that
  // the user left the editor. Only close when the iframe itself loses focus.
  globalThis.window.addEventListener("blur", hideContextMenu);
  const keydown = editor.onKeyDown((event) => {
    if (event.keyCode === monaco.KeyCode.Escape && !contextMenu.hidden) {
      event.preventDefault(); event.stopPropagation(); hideContextMenu(); return;
    }
    if (event.keyCode === monaco.KeyCode.Escape && !referencePanel.hidden) {
      event.preventDefault(); event.stopPropagation(); hideReferences(); return;
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.keyCode === monaco.KeyCode.KeyF) {
      event.preventDefault(); event.stopPropagation();
      const selection = editor.getSelection();
      const selectedText = selection?.isEmpty() ? "" : model.getValueInRange(selection ?? new monaco.Range(1, 1, 1, 1));
      host.command("advanced-search", selectedText);
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.keyCode !== monaco.KeyCode.KeyS) return;
    event.preventDefault();
    event.stopPropagation();
    host.requestSave(model.getValue());
  });
  const layout = () => {
    layoutFrame = undefined;
    if (layoutSuspended) return;
    const { clientHeight: height, clientWidth: width } = host.root;
    if (height <= 0 || width <= 0 || (height === layoutHeight && width === layoutWidth)) return;
    layoutHeight = height;
    layoutWidth = width;
    editor.layout({ height, width });
  };
  const scheduleLayout = () => {
    if (layoutSuspended || layoutFrame !== undefined) return;
    layoutFrame = requestAnimationFrame(layout);
  };
  const observer = new ResizeObserver(scheduleLayout);
  observer.observe(host.root);

  return {
    dispose() {
      if (contentTimer !== undefined) window.clearTimeout(contentTimer);
      if (suggestTimer !== undefined) window.clearTimeout(suggestTimer);
      if (layoutFrame !== undefined) cancelAnimationFrame(layoutFrame);
      observer.disconnect();
      keydown.dispose();
      context.dispose();
      selectionChange.dispose(); contextMenu.remove();
      globalThis.document.removeEventListener("pointerdown", contextOutside, true);
      globalThis.window.removeEventListener("blur", hideContextMenu);
      changes.dispose();
      definitionHover.dispose(); definitionClick.dispose(); definitionLink.clear();
      debugGutter.dispose(); debugDecorations.clear();
      languageFocus.dispose(); referenceBlur.dispose();
      hideReferences(); referencePanel.remove();
      languageStatus?.remove();
      if (cpp) void host.languageRequest("textDocument/didClose", { textDocument: { uri: model.uri.toString() } }).catch(() => undefined);
      completion?.dispose(); hover?.dispose(); semantic?.dispose();
      semanticChangeListeners.clear();
      editor.dispose();
      model.dispose();
    },
    executeAction(action, parameters) {
      if (action === "set-language-diagnostics" && Array.isArray(parameters.diagnostics))
        { applyDiagnostics(parameters.diagnostics as LspDiagnostic[]); hideLanguageStatus(); }
      if (action === "language-server-project-ready") {
        cppDocumentOpened = false;
        void openDocument();
      }
    },
    focus() {
      editor.focus();
    },
    getContent() {
      return model.getValue();
    },
    getSelection() {
      const selection = editor.getSelection();
      return selection?.isEmpty() ? "" : model.getValueInRange(selection ?? new monaco.Range(1, 1, 1, 1));
    },
    markSaved(content) {
      saved = content;
      host.reportDirty(model.getValue() !== saved);
      if (cpp && cppDocumentOpened) {
        languageSync = languageSync.catch(() => undefined).then(() =>
          host.languageRequest("textDocument/didSave", {
            textDocument: { uri: model.uri.toString() },
            text: content,
          }).then(() => undefined).catch(() => undefined),
        );
      }
    },
    navigate(line, column) {
      const targetLine = Math.max(1, Math.min(line, model.getLineCount()));
      editor.setPosition({ column: Math.max(1, column), lineNumber: targetLine });
      editor.revealLineInCenter(targetLine);
      editor.focus();
    },
    setContent(content) {
      saved = content;
      model.setValue(content);
      host.updateContent(content);
      host.reportDirty(false);
    },
    setDebugState(state) {
      applyDebugState(state);
    },
    setLayoutSuspended(suspended) {
      layoutSuspended = suspended;
      if (!suspended && host.root.clientWidth > 0 && host.root.clientHeight > 0)
        editor.layout({ width: host.root.clientWidth, height: host.root.clientHeight });
    },
    setTheme(theme) {
      currentTheme = theme;
      globalThis.document.documentElement.dataset.theme = theme;
      applyThemeConfig(themeConfig);
      monaco.editor.setTheme(themeName(theme, themeConfig));
      if (languageStatus) languageStatus.dataset.theme = theme;
    },
    setThemeConfig(config) {
      applyThemeConfig(config);
      editor.updateOptions({ fontFamily: config?.fonts?.code ?? defaultCodeFont });
      monaco.editor.setTheme(themeName(currentTheme, themeConfig));
    },
    setWordWrap(enabled) {
      editor.updateOptions({ wordWrap: enabled ? "on" : "off" });
    },
  };
});
