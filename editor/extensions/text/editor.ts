import type * as Monaco from "monaco-editor";
import { defineEditor, type EditorTheme } from "../../sdk";
import "./editor.css";

const monaco = (globalThis as typeof globalThis & {
  AgentKEditorDependencies: { monaco: typeof Monaco };
}).AgentKEditorDependencies.monaco;

function themeName(theme: EditorTheme): string {
  return theme === "dark" ? "agent-k-plugin-dark" : "agent-k-plugin-light";
}

defineEditor((host, initial) => {
  monaco.editor.defineTheme("agent-k-plugin-light", {
    base: "vs",
    inherit: true,
    rules: [],
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
    rules: [],
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
    smoothScrolling: true,
    theme: themeName(initial.theme),
    wordWrap: initial.wordWrap ? "on" : "off",
  });
  let saved = initial.content;
  let layoutSuspended = false;
  let contextLine: number | undefined;
  let contentTimer: number | undefined;
  const changes = model.onDidChangeContent(() => {
    const content = model.getValue();
    host.reportDirty(content !== saved);
    if (contentTimer !== undefined) window.clearTimeout(contentTimer);
    contentTimer = window.setTimeout(() => host.updateContent(model.getValue()), 350);
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
    if (layoutSuspended) return;
    const { clientHeight: height, clientWidth: width } = host.root;
    if (height > 0 && width > 0) editor.layout({ height, width });
  });
  observer.observe(host.root);

  return {
    dispose() {
      if (contentTimer !== undefined) window.clearTimeout(contentTimer);
      observer.disconnect();
      keydown.dispose();
      context.dispose();
      changes.dispose();
      editor.dispose();
      model.dispose();
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
