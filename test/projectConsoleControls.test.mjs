import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("terminal copy control has a visible icon and full-size hit target", async () => {
  const [component, styles] = await Promise.all([
    readFile(join(root, "src/components/layout/ProjectConsole.tsx"), "utf8"),
    readFile(join(root, "src/styles/theme.css"), "utf8"),
  ]);

  assert.match(component, /className="project-console-copy"/u);
  assert.match(styles, /\.project-console :is\([^)]*\.fa-regular[^)]*\) \{ font-family: var\(--_fa-family\) !important; \}/u);
  assert.match(styles, /\.project-console > header > \.project-console-copy \{[\s\S]*height: 34px;[\s\S]*width: 32px;/u);
  assert.match(styles, /\.project-console > header > \.project-console-copy > i \{ font-size: 12px; \}/u);
  assert.match(styles, /\.project-console > header > \.project-console-copy:disabled \{ opacity: 0\.5; \}/u);
});
