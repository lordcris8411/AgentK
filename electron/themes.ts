import { readFile, readdir, rm, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, extname, join } from "node:path";
import { asObject, asString, atomicWrite, piAgentDirectory } from "./utils.js";

export type ThemeDefinition = {
  id: string;
  name: string;
  base: "light" | "soft-light" | "dark";
  colors: Record<string, string>;
  components: Record<string, string>;
  fonts?: { ui: string; code: string };
  monaco: Record<string, string>;
  monacoSyntax?: Record<string, string>;
  terminal: Record<string, string>;
  builtin?: boolean;
};

const COLOR_KEYS = ["surface-app", "surface-panel", "surface-raised", "surface-hover", "surface-active", "border-color", "border-strong", "text-primary", "text-secondary", "text-muted", "accent", "selection-background", "selection-foreground", "scrollbar-thumb", "scrollbar-thumb-hover", "danger", "info", "success", "warning", "modal-overlay"];
const COMPONENT_KEYS = ["primary-action", "primary-action-foreground", "active-item", "active-item-foreground", "input", "input-foreground", "code-block", "code-block-foreground", "hover", "hover-foreground"];
const FONT_KEYS = ["ui", "code"];
const MONACO_KEYS = ["editor.background", "editorGutter.background", "editor.lineHighlightBackground", "editor.selectionBackground", "editor.inactiveSelectionBackground", "editor.selectionHighlightBackground"];
const MONACO_SYNTAX_KEYS = ["comment", "keyword", "string", "number", "type", "function", "variable", "parameter", "macro", "namespace", "property"];
const TERMINAL_KEYS = ["background", "foreground", "cursor", "cursorAccent", "selectionBackground", "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"];
const validId = (value: string) => /^[a-z0-9][a-z0-9-]{1,63}$/i.test(value);
const validCustomId = (value: string) => validId(value) && !["light", "soft-light", "dark", "system"].includes(value);
const validColor = (value: string) => /^#[0-9a-f]{3,8}$/i.test(value) || /^rgb(a)?\([\d.% ,/]+\)$/i.test(value);
const validFont = (value: string) => value.length <= 240 && /^[\p{L}\p{N}\s,.'"_-]+$/u.test(value);

/* Legacy fallback for installations upgraded before bundled theme presets exist. */
function legacyBuiltIn(id: "light" | "soft-light" | "dark"): ThemeDefinition {
  const dark = id === "dark";
  const soft = id === "soft-light";
  const app = dark ? "#1f1f1f" : soft ? "#d9d5cf" : "#f7f6f4";
  const panel = dark ? "#252422" : soft ? "#e2ded8" : "#f6f4f1";
  const foreground = dark ? "#ece9e4" : "#272625";
  return {
    id, name: id === "soft-light" ? "Soft light" : id.charAt(0).toUpperCase() + id.slice(1), base: id, builtin: true,
    colors: { "surface-app": app, "surface-panel": panel, "surface-raised": dark ? "#2c2b29" : soft ? "#ece9e4" : "#ffffff", "surface-hover": dark ? "#353330" : soft ? "#d3cec7" : "#ebe8e4", "surface-active": dark ? "#403d39" : soft ? "#c8c2ba" : "#e6e1dc", "border-color": dark ? "#3b3936" : soft ? "#c8c1b8" : "#e5e2dd", "border-strong": dark ? "#4b4844" : soft ? "#b8b0a7" : "#dcd7d1", "text-primary": foreground, "text-secondary": dark ? "#b9b3ac" : soft ? "#5e5953" : "#6f6a64", "text-muted": dark ? "#8d8780" : soft ? "#777069" : "#98928a", accent: dark ? "#f0ede8" : "#302d2a", "selection-background": dark ? "#264f78" : soft ? "#a8c9e8" : "#b6d7ff", "selection-foreground": dark ? "#f0f6fc" : soft ? "#092e4f" : "#0a3069", "scrollbar-thumb": dark ? "#625e59" : soft ? "#aaa39b" : "#c9c4bd", "scrollbar-thumb-hover": dark ? "#7b756f" : soft ? "#817a72" : "#a9a39b", danger: dark ? "#e07467" : "#b94d3e", info: dark ? "#7db5df" : "#477da8", success: dark ? "#8fbd82" : "#68965d", warning: dark ? "#e0b36d" : "#a66c12", "modal-overlay": dark ? "rgb(0 0 0 / 52%)" : "rgb(28 25 22 / 36%)" },
    components: { "primary-action": dark ? "#f0ede8" : "#302d2a", "primary-action-foreground": dark ? "#1f1f1f" : "#ffffff", "active-item": dark ? "#403d39" : soft ? "#c8c2ba" : "#e6e1dc", "active-item-foreground": foreground, input: dark ? "#2c2b29" : soft ? "#ece9e4" : "#ffffff", "input-foreground": foreground, "code-block": dark ? "#403d39" : soft ? "#c8c2ba" : "#e6e1dc", "code-block-foreground": foreground, hover: dark ? "#353330" : soft ? "#d3cec7" : "#ebe8e4", "hover-foreground": foreground },
    monaco: { "editor.background": panel, "editorGutter.background": panel, "editor.lineHighlightBackground": dark ? "#272F3A" : "#EDF4FC", "editor.selectionBackground": dark ? "#264F78" : soft ? "#A8C9E8" : "#B6D7FF", "editor.inactiveSelectionBackground": dark ? "#20364D" : "#DBEAFE", "editor.selectionHighlightBackground": dark ? "#2F669966" : "#D7E9FF99" },
    terminal: { background: dark ? "#242321" : soft ? "#e2ded8" : "#fffdf9", foreground: dark ? "#dedad4" : "#302d2a", cursor: dark ? "#dedad4" : "#302d2a", cursorAccent: dark ? "#242321" : soft ? "#e2ded8" : "#fffdf9", selectionBackground: dark ? "#69533f" : "#d9c3ae", black: dark ? "#242321" : "#302d2a", red: dark ? "#d17a6d" : "#a73e32", green: dark ? "#8fb573" : "#557d3e", yellow: dark ? "#d5ad68" : "#936a20", blue: dark ? "#75a9c7" : "#316e92", magenta: dark ? "#b998c5" : "#795388", cyan: dark ? "#72b8ad" : "#27796f", white: dark ? "#dedad4" : "#e7e2dc", brightBlack: dark ? "#817b73" : "#77716a", brightRed: dark ? "#eb9184" : "#c45548", brightGreen: dark ? "#a8cc8d" : "#6d974f", brightYellow: dark ? "#ebc47c" : "#ad8132", brightBlue: dark ? "#8dc3e0" : "#4488af", brightMagenta: dark ? "#d0addb" : "#9369a3", brightCyan: dark ? "#8ed0c5" : "#38958a", brightWhite: dark ? "#fffdf9" : soft ? "#f0ede8" : "#ffffff" },
  };
}

const legacyBuiltinThemes = [legacyBuiltIn("light"), legacyBuiltIn("soft-light"), legacyBuiltIn("dark")];
function normalize(input: unknown, builtin = false): ThemeDefinition {
  const source = asObject(input); const id = asString(source.id); const name = asString(source.name); const base = asString(source.base);
  if (!id || !name || !base) throw new Error("Invalid theme metadata");
  if (!(builtin ? validId(id) : validCustomId(id)) || name.length > 80 || !["light", "soft-light", "dark"].includes(base)) throw new Error("Invalid theme metadata");
  const group = (value: unknown, keys: string[], label: string) => {
    const record = asObject(value); const result: Record<string, string> = {};
    for (const key of keys) { const color = asString(record[key]); if (!color || !validColor(color)) throw new Error(`Invalid ${label}.${key}`); result[key] = color; }
    return result;
  };
  const colors = group(source.colors, COLOR_KEYS, "colors");
  const fallbackComponents = {
    "primary-action": colors.accent!, "primary-action-foreground": colors["surface-raised"]!,
    "active-item": colors["surface-active"]!, "active-item-foreground": colors["text-primary"]!,
    input: colors["surface-raised"]!, "input-foreground": colors["text-primary"]!,
    "code-block": colors["surface-active"]!, "code-block-foreground": colors["text-primary"]!,
    hover: colors["surface-hover"]!, "hover-foreground": colors["text-primary"]!,
  };
  const components = Object.keys(asObject(source.components)).length
    ? group(source.components, COMPONENT_KEYS, "components")
    : fallbackComponents;
  const fontSource = asObject(source.fonts);
  const fonts: Record<string, string> = {};
  for (const key of FONT_KEYS) {
    const value = asString(fontSource[key]);
    if (!value || !validFont(value)) {
      if (Object.keys(fontSource).length) throw new Error(`Invalid fonts.${key}`);
      continue;
    }
    fonts[key] = value;
  }
  const syntaxSource = asObject(source.monacoSyntax);
  const monacoSyntax: Record<string, string> = {};
  for (const [key, value] of Object.entries(syntaxSource)) {
    const color = asString(value);
    if (!MONACO_SYNTAX_KEYS.includes(key) || !color || !/^#[0-9a-f]{3,8}$/i.test(color))
      throw new Error(`Invalid monacoSyntax.${key}`);
    monacoSyntax[key] = color;
  }
  return { id, name, base: base as ThemeDefinition["base"], colors, components, ...(Object.keys(fonts).length ? { fonts: fonts as ThemeDefinition["fonts"] } : {}), monaco: group(source.monaco, MONACO_KEYS, "monaco"), ...(Object.keys(monacoSyntax).length ? { monacoSyntax } : {}), terminal: group(source.terminal, TERMINAL_KEYS, "terminal"), ...(builtin ? { builtin: true } : {}) };
}

export function themeDirectory() { return join(piAgentDirectory(), "themes"); }

/** Discover themes placed directly in a recognised themes directory or any of
 * its ordinary subdirectories. Nested folders make it practical to organise
 * a larger personal collection without registering each file separately. */
async function themeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (path: string): Promise<void> => {
    let entries: Dirent[];
    try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === ".json") files.push(child);
    }
  };
  await visit(root);
  return files;
}

export async function listThemes(appDataPath: string, builtinDirectory: string): Promise<ThemeDefinition[]> {
  const result: ThemeDefinition[] = [];
  try { for (const file of await themeFiles(builtinDirectory)) result.push(normalize(JSON.parse(await readFile(file, "utf8")), true)); } catch { result.push(...legacyBuiltinThemes); }
  const knownIds = new Set(result.map((theme) => theme.id));
  for (const file of await themeFiles(themeDirectory())) {
    try {
      const theme = normalize(JSON.parse(await readFile(file, "utf8")));
      if (theme.id === basename(file, ".json") && !knownIds.has(theme.id)) {
        result.push(theme); knownIds.add(theme.id);
      }
    } catch {}
  }
  return result;
}
export async function resolveTheme(
  appDataPath: string,
  builtinDirectory: string,
  id: string,
  systemDark: boolean,
): Promise<ThemeDefinition> {
  const effectiveId = id === "system" ? systemDark ? "dark" : "light" : id;
  const themes = await listThemes(appDataPath, builtinDirectory);
  return themes.find((theme) => theme.id === effectiveId) ?? themes.find((theme) => theme.id === "light") ?? legacyBuiltinThemes[0]!;
}
export async function importTheme(appDataPath: string, source: string): Promise<ThemeDefinition> {
  if (extname(source).toLowerCase() !== ".json" || !(await stat(source)).isFile()) throw new Error("Select a theme JSON file");
  const theme = normalize(JSON.parse(await readFile(source, "utf8")));
  await atomicWrite(join(themeDirectory(), `${theme.id}.json`), JSON.stringify(theme, null, 2)); return theme;
}
export async function removeTheme(appDataPath: string, id: string): Promise<void> {
  if (!validCustomId(id)) throw new Error("Built-in themes cannot be removed");
  for (const file of await themeFiles(themeDirectory())) {
    try {
      const theme = normalize(JSON.parse(await readFile(file, "utf8")));
      if (theme.id === id) { await rm(file, { force: true }); return; }
    } catch {}
  }
}
