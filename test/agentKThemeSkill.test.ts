import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("theme Skill writes only to Agent K's isolated custom-theme directory", async () => {
  const [runtime, skill] = await Promise.all([
    readFile(join(root, "electron/themes.ts"), "utf8"),
    readFile(join(root, "skills/create-agent-k-theme/SKILL.md"), "utf8"),
  ]);

  assert.match(runtime, /piAgentDirectory\(\), "k_themes"/u);
  assert.match(skill, /%USERPROFILE%\\\\\.pi\\\\agent\\\\k_themes/u);
  assert.doesNotMatch(skill, /%USERPROFILE%\\\\\.pi\\\\agent\\\\themes/u);
});

test("theme Skill maps every template element to a visible Agent K role", async () => {
  const [skill, reference, templateText] = await Promise.all([
    readFile(join(root, "skills/create-agent-k-theme/SKILL.md"), "utf8"),
    readFile(join(root, "skills/create-agent-k-theme/references/theme-elements.md"), "utf8"),
    readFile(join(root, "skills/create-agent-k-theme/assets/theme.template.json"), "utf8"),
  ]);
  const template = JSON.parse(templateText) as Record<string, unknown>;
  const groups = ["colors", "components", "fonts", "monaco", "monacoSyntax", "terminal"];
  const keys = groups.flatMap((group) => Object.keys(template[group] as Record<string, unknown>)
    .map((key) => group === "fonts" ? `fonts.${key}` : key));

  assert.match(skill, /read `references\/theme-elements\.md` completely/u);
  for (const key of keys) assert.ok(reference.includes("`" + key + "`"), key);
  assert.match(reference, /main chat composer is a raised surface/u);
  assert.match(reference, /terminal palette is independent/u);
});

test("Editor Skill previews use the active theme scrollbar palette", async () => {
  const theme = await readFile(join(root, "src/styles/theme.css"), "utf8");

  assert.match(theme, /\.skill-hub-preview textarea \{[^}]*scrollbar-color: var\(--scrollbar-thumb\) var\(--surface-panel\)/su);
  assert.match(theme, /\.skill-hub-preview textarea::-webkit-scrollbar-thumb \{[^}]*background: var\(--scrollbar-thumb\)/su);
  assert.match(theme, /\.skill-hub-preview textarea::-webkit-scrollbar-thumb:hover \{[^}]*background: var\(--scrollbar-thumb-hover\)/su);
  assert.match(theme, /\.skill-hub-preview textarea::-webkit-scrollbar-track \{ background: var\(--surface-panel\); \}/u);
});
