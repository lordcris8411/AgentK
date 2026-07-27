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
    contextmenu: false,
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
  const openDocument = () => {
    if (!cpp) return languageSync;
    showLanguageStatus();
    languageSync = languageSync.catch(() => undefined).then(() => host.languageRequest("textDocument/didOpen", { textDocument: document() })
      .then((accepted) => { cppDocumentOpened = accepted === true; if (!cppDocumentOpened) hideLanguageStatus(); })
      .catch(() => { cppDocumentOpened = false; hideLanguageStatus(); }));
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
            const data = sanitizeSemanticTokens(result?.data ?? []); applyMemberDecorations(data); hideLanguageStatus();
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
  const contextBlur = editor.onDidBlurEditorText(() => window.setTimeout(hideContextMenu, 0));
  const selectionChange = editor.onDidChangeCursorSelection(({ selection }) => {
    host.reportSelection(selection.isEmpty() ? "" : model.getValueInRange(selection));
  });
  const contextOutside = (event: PointerEvent) => {
    if (!contextMenu.contains(event.target as Node)) hideContextMenu();
  };
  globalThis.document.addEventListener("pointerdown", contextOutside, true);
  const keydown = editor.onKeyDown((event) => {
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
      contextBlur.dispose(); selectionChange.dispose(); contextMenu.remove();
      globalThis.document.removeEventListener("pointerdown", contextOutside, true);
      changes.dispose();
      definitionHover.dispose(); definitionClick.dispose(); definitionLink.clear();
      languageFocus.dispose(); referenceBlur.dispose();
      hideReferences(); referencePanel.remove();
      languageStatus?.remove();
      memberDecorations.clear();
      if (cpp) void host.languageRequest("textDocument/didClose", { textDocument: { uri: model.uri.toString() } }).catch(() => undefined);
      completion?.dispose(); hover?.dispose(); semantic?.dispose();
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
      if (languageStatus) languageStatus.dataset.theme = theme;
    },
    setWordWrap(enabled) {
      editor.updateOptions({ wordWrap: enabled ? "on" : "off" });
    },
  };
});
