import type * as Monaco from "monaco-editor";

export function defineAgentKTheme(monaco: typeof Monaco) {
  monaco.editor.defineTheme("agent-k-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#F6F4F1",
      "editorGutter.background": "#F6F4F1",
      "editor.lineHighlightBackground": "#ECE8E3",
      "editor.selectionBackground": "#E5E0D9",
      "editor.inactiveSelectionBackground": "#EEEAE5",
    },
  });
  monaco.editor.defineTheme("agent-k-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#252422",
      "editorGutter.background": "#252422",
      "editor.lineHighlightBackground": "#353330",
      "editor.selectionBackground": "#504B45",
      "editor.inactiveSelectionBackground": "#403D39",
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
