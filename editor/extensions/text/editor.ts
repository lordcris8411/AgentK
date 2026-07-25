import type * as Monaco from "monaco-editor";
import { defineEditor, type EditorTheme } from "../../sdk";
import "./editor.css";

const monaco = (globalThis as typeof globalThis & {
  AgentKEditorDependencies: { monaco: typeof Monaco };
}).AgentKEditorDependencies.monaco;

// clangd 22's initialize response defines this exact legend. It deliberately
// contains repeated standard names, so token indices must not be replaced by a
// generic LSP legend (notably `property` is index 6).
const CLANGD_TOKEN_TYPES = ["variable", "variable", "parameter", "function", "method", "function", "property", "variable", "class", "interface", "enum", "enumMember", "type", "type", "unknown", "namespace", "typeParameter", "concept", "type", "macro", "modifier", "operator", "bracket", "label", "comment"];
const CLANGD_TOKEN_MODIFIERS = ["declaration", "definition", "deprecated", "deduced", "readonly", "static", "abstract", "virtual", "dependentName", "defaultLibrary", "usedAsMutableReference", "usedAsMutablePointer", "constructorOrDestructor", "userDefined", "functionScope", "classScope", "fileScope", "globalScope"];
const CLANGD_PROPERTY_TOKEN = CLANGD_TOKEN_TYPES.indexOf("property");
const CLANGD_CLASS_TOKEN = CLANGD_TOKEN_TYPES.indexOf("class");
const CLANGD_ENUM_TOKEN = CLANGD_TOKEN_TYPES.indexOf("enum");
const CLANGD_ENUM_MEMBER_TOKEN = CLANGD_TOKEN_TYPES.indexOf("enumMember");
const CLANGD_MACRO_TOKEN = CLANGD_TOKEN_TYPES.indexOf("macro");
const CLANGD_METHOD_TOKEN = CLANGD_TOKEN_TYPES.indexOf("method");
const CLANGD_NAMESPACE_TOKEN = CLANGD_TOKEN_TYPES.indexOf("namespace");

function themeName(theme: EditorTheme): string {
  return theme === "dark" ? "agent-k-plugin-dark" : "agent-k-plugin-light";
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

function pathFromFileUri(uri: string): string | undefined {
  try {
    const parsed = new URL(uri); if (parsed.protocol !== "file:") return undefined;
    const path = decodeURIComponent(parsed.pathname);
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : parsed.host ? `//${parsed.host}${path}` : path;
  } catch { return undefined; }
}

defineEditor((host, initial) => {
  monaco.editor.defineTheme("agent-k-plugin-light", {
    base: "vs",
    inherit: true,
    rules: [{ token: "property", foreground: "8B6508" }],
    colors: {
      "editor.background": "#F6F4F1",
      "editorGutter.background": "#F6F4F1",
      "editor.lineHighlightBackground": "#EDF4FC",
      "editor.selectionBackground": "#B6D7FF",
      "editor.inactiveSelectionBackground": "#DBEAFE",
    },
  });
  monaco.editor.defineTheme("agent-k-plugin-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [{ token: "property", foreground: "C49732" }],
    colors: {
      "editor.background": "#252422",
      "editorGutter.background": "#252422",
      "editor.lineHighlightBackground": "#272F3A",
      "editor.selectionBackground": "#264F78",
      "editor.inactiveSelectionBackground": "#20364D",
    },
  });

  const model = monaco.editor.createModel(
    initial.content,
    initial.language,
    monaco.Uri.file(initial.absolutePath),
  );
  const editor = monaco.editor.create(host.root, {
    automaticLayout: false,
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
    theme: themeName(initial.theme),
    wordWrap: initial.wordWrap ? "on" : "off",
  });
  const cpp = initial.language === "cpp";
  const position = (value: Monaco.Position) => ({ line: value.lineNumber - 1, character: value.column - 1 });
  const document = () => ({ uri: model.uri.toString(), languageId: "cpp", version: model.getVersionId(), text: model.getValue() });
  let languageSync: Promise<void> = Promise.resolve();
  let cppDocumentOpened = false;
  const openDocument = () => {
    if (!cpp) return languageSync;
    languageSync = languageSync.catch(() => undefined).then(() => host.languageRequest("textDocument/didOpen", { textDocument: document() })
      .then(() => { cppDocumentOpened = true; })
      .catch(() => { cppDocumentOpened = false; }));
    return languageSync;
  };
  const syncDocument = () => {
    if (!cpp) return languageSync;
    languageSync = languageSync.catch(() => undefined).then(() => {
      // A tab may predate project loading, or survive an unload/reload. clangd
      // ignores didChange for such a document until a fresh didOpen succeeds.
      if (!cppDocumentOpened) return undefined;
      return host.languageRequest("textDocument/didChange", {
        textDocument: { uri: model.uri.toString(), version: model.getVersionId() },
        contentChanges: [{ text: model.getValue() }],
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
  const memberDecorations = editor.createDecorationsCollection();
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
      sanitized.push(inputLine - outputLine, inputLine === outputLine ? inputCharacter - outputCharacter : inputCharacter, safeLength, tokenType, modifiers);
      outputLine = inputLine; outputCharacter = inputCharacter;
    }
    return sanitized;
  };
  const applyMemberDecorations = (data: number[]) => {
    let character = 0; let line = 0; const ranges: Monaco.editor.IModelDeltaDecoration[] = [];
    for (let index = 0; index + 4 < data.length; index += 5) {
      const lineDelta = data[index]; line += lineDelta;
      character = lineDelta === 0 ? character + data[index + 1] : data[index + 1];
      const tokenType = data[index + 3];
      const inlineClassName = tokenType === CLANGD_PROPERTY_TOKEN
        ? "agent-k-cpp-member"
        : tokenType === CLANGD_CLASS_TOKEN
          ? "agent-k-cpp-class"
          : tokenType === CLANGD_ENUM_TOKEN || tokenType === CLANGD_ENUM_MEMBER_TOKEN
            ? "agent-k-cpp-enum"
          : tokenType === CLANGD_METHOD_TOKEN
            ? "agent-k-cpp-method"
            : tokenType === CLANGD_MACRO_TOKEN
              ? "agent-k-cpp-macro"
          : tokenType === CLANGD_NAMESPACE_TOKEN
            ? "agent-k-cpp-namespace"
            : undefined;
      if (inlineClassName) ranges.push({ range: new monaco.Range(line + 1, character + 1, line + 1, character + data[index + 2] + 1), options: { inlineClassName } });
    }
    memberDecorations.set(ranges);
  };
  type LspRange = { start: { line: number; character: number }; end: { line: number; character: number } };
  type LspLocation = { uri?: string; range?: LspRange; targetUri?: string; targetRange?: LspRange; targetSelectionRange?: LspRange };
  const definitionTargets = async (at: Monaco.Position) => {
    await flushDocumentSync();
    const result = await host.languageRequest("textDocument/definition", { textDocument: { uri: model.uri.toString() }, position: position(at) }) as LspLocation | LspLocation[] | undefined;
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
          }) as { items?: Array<{ label?: string; detail?: string; documentation?: string; insertText?: string; kind?: number }> } | Array<{ label?: string; detail?: string; documentation?: string; insertText?: string; kind?: number }> | undefined;
          if (token?.isCancellationRequested || requestedVersion !== model.getVersionId()) return { suggestions: [] };
          const items = Array.isArray(response) ? response : response?.items ?? [];
          return { suggestions: items.filter((item) => typeof item.label === "string").map((item) => ({ label: item.label!, detail: item.detail, documentation: item.documentation, insertText: item.insertText ?? item.label!, kind: item.kind ?? monaco.languages.CompletionItemKind.Text, range: new monaco.Range(at.lineNumber, at.column, at.lineNumber, at.column) })) };
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
          if (token?.isCancellationRequested || requestedVersion !== model.getVersionId()) return null;
          try {
            const result = await host.languageRequest("textDocument/semanticTokens/full", { textDocument: { uri: model.uri.toString() } }) as { data?: number[] } | undefined;
            if (token?.isCancellationRequested || requestedVersion !== model.getVersionId()) return null;
            const data = sanitizeSemanticTokens(result?.data ?? []); applyMemberDecorations(data);
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
    void definitionTargets(event.target.position).then((locations) => {
      const target = locations[0]; const path = target ? pathFromFileUri(target.uri) : undefined;
      if (path) host.openFile(path, target.range.start.line + 1, target.range.start.character + 1);
    }).catch(() => undefined);
  });
  let contextLine: number | undefined;
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
      changes.dispose();
      definitionHover.dispose(); definitionClick.dispose(); definitionLink.clear();
      memberDecorations.clear();
      if (cpp) void host.languageRequest("textDocument/didClose", { textDocument: { uri: model.uri.toString() } }).catch(() => undefined);
      completion?.dispose(); hover?.dispose(); semantic?.dispose();
      editor.dispose();
      model.dispose();
    },
    executeAction(action, parameters) {
      if (action === "set-cpp-diagnostics" && Array.isArray(parameters.diagnostics))
        applyDiagnostics(parameters.diagnostics as LspDiagnostic[]);
      if (action === "cpp-project-ready") {
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
    markSaved(content) {
      saved = content;
      host.reportDirty(model.getValue() !== saved);
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
    setLayoutSuspended(suspended) {
      layoutSuspended = suspended;
      if (!suspended && host.root.clientWidth > 0 && host.root.clientHeight > 0)
        editor.layout({ width: host.root.clientWidth, height: host.root.clientHeight });
    },
    setTheme(theme) {
      monaco.editor.setTheme(themeName(theme));
    },
    setWordWrap(enabled) {
      editor.updateOptions({ wordWrap: enabled ? "on" : "off" });
    },
  };
});
