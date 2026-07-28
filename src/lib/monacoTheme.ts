import type * as Monaco from "monaco-editor";
import type { ThemeDefinition } from "./themes";

const fallbackSyntax = (dark: boolean) => dark ? {
  comment: "6A9955", keyword: "569CD6", string: "CE9178", number: "B5CEA8",
  type: "4FC1FF", function: "4FC1FF", variable: "D4D4D4", parameter: "9CA3AF",
  macro: "C586C0", namespace: "C586C0", property: "C49732",
} : {
  comment: "6A737D", keyword: "0000FF", string: "A31515", number: "098658",
  type: "267F99", function: "267F99", variable: "24292F", parameter: "6B7280",
  macro: "AF00DB", namespace: "AF00DB", property: "8B6508",
};

function syntaxRules(theme: ThemeDefinition) {
  const syntax = { ...fallbackSyntax(theme.base === "dark"), ...theme.monacoSyntax };
  const color = (key: keyof typeof syntax) => syntax[key].replace(/^#/, "");
  return [
    { token: "comment", foreground: color("comment") }, { token: "keyword", foreground: color("keyword") },
    { token: "string", foreground: color("string") }, { token: "number", foreground: color("number") },
    { token: "type", foreground: color("type") }, { token: "class", foreground: color("type") },
    { token: "function", foreground: color("function") }, { token: "method", foreground: color("function") },
    { token: "variable", foreground: color("variable") }, { token: "parameter", foreground: color("parameter") },
    { token: "macro", foreground: color("macro") }, { token: "namespace", foreground: color("namespace") },
    { token: "property", foreground: color("property") }, { token: "enum", foreground: color("property") },
    { token: "enumMember", foreground: color("property") },
  ];
}

function customTheme(monaco: typeof Monaco, theme: ThemeDefinition) {
  monaco.editor.defineTheme("agent-k-custom", {
    base: theme.base === "dark" ? "vs-dark" : "vs", inherit: true, rules: syntaxRules(theme), colors: theme.monaco,
  });
}

function themeName(theme: ThemeDefinition | string | undefined) {
  if (typeof theme === "object") return "agent-k-custom";
  return theme === "dark" ? "agent-k-dark" : theme === "soft-light" ? "agent-k-soft-light" : "agent-k-light";
}

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
    const theme = (event as CustomEvent<ThemeDefinition | string>).detail;
    if (typeof theme === "object") customTheme(monaco, theme);
    monaco.editor.setTheme(themeName(theme));
  });
  const active = (window as Window & { agentKActiveTheme?: ThemeDefinition }).agentKActiveTheme;
  if (active) customTheme(monaco, active);
}

export function applyAgentKTheme(_: unknown, monaco: typeof Monaco) {
  const active = (window as Window & { agentKActiveTheme?: ThemeDefinition }).agentKActiveTheme;
  if (active) customTheme(monaco, active);
  monaco.editor.setTheme(themeName(active ?? document.documentElement.dataset.theme));
}
