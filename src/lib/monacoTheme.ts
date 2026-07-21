import type * as Monaco from "monaco-editor";

export function defineAgentKTheme(monaco: typeof Monaco) {
  monaco.editor.defineTheme("agent-k-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#F6F4F1",
      "editorGutter.background": "#F6F4F1",
      "editor.lineHighlightBackground": "#EDF4FC",
      "editor.selectionBackground": "#B6D7FF",
      "editor.inactiveSelectionBackground": "#DBEAFE",
      "editor.selectionHighlightBackground": "#D7E9FF99",
    },
  });
  monaco.editor.defineTheme("agent-k-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#252422",
      "editorGutter.background": "#252422",
      "editor.lineHighlightBackground": "#272F3A",
      "editor.selectionBackground": "#264F78",
      "editor.inactiveSelectionBackground": "#20364D",
      "editor.selectionHighlightBackground": "#2F669966",
    },
  });
  window.addEventListener("agent-k-theme", (event) => {
    const mode = (event as CustomEvent<string>).detail;
    monaco.editor.setTheme(mode === "dark" ? "agent-k-dark" : "agent-k-light");
  });
}

export function applyAgentKTheme(_: unknown, monaco: typeof Monaco) {
  monaco.editor.setTheme(
    document.documentElement.dataset.theme === "dark"
      ? "agent-k-dark"
      : "agent-k-light",
  );
}
