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
  monaco.editor.defineTheme("agent-k-soft-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#E2DED8",
      "editorGutter.background": "#E2DED8",
      "editor.lineHighlightBackground": "#D8E0E5",
      "editor.selectionBackground": "#A8C9E8",
      "editor.inactiveSelectionBackground": "#C4D7E5",
      "editor.selectionHighlightBackground": "#B8CFDF99",
    },
  });
  window.addEventListener("agent-k-theme", (event) => {
    const mode = (event as CustomEvent<string>).detail;
    monaco.editor.setTheme(
      mode === "dark"
        ? "agent-k-dark"
        : mode === "soft-light"
          ? "agent-k-soft-light"
          : "agent-k-light",
    );
  });
}

export function applyAgentKTheme(_: unknown, monaco: typeof Monaco) {
  monaco.editor.setTheme(
    document.documentElement.dataset.theme === "dark"
      ? "agent-k-dark"
      : document.documentElement.dataset.theme === "soft-light"
        ? "agent-k-soft-light"
        : "agent-k-light",
  );
}
