import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workspaceSource = await readFile(
  new URL("../src/features/conversation/ConversationWorkspace.tsx", import.meta.url),
  "utf8",
);
const themeSource = await readFile(
  new URL("../src/styles/theme.css", import.meta.url),
  "utf8",
);

test("conversation scroll height includes a real composer clearance element", () => {
  assert.match(
    workspaceSource,
    /<div aria-hidden="true" className="message-list-tail" \/>/,
  );
  assert.match(
    themeSource,
    /\.message-list-tail\s*{[^}]*flex:\s*0 0 var\(--composer-reserve\)/s,
  );
  assert.match(
    themeSource,
    /\.message-list-tail\s*{[^}]*margin-top:\s*calc\(-1 \* var\(--message-list-gap\)\)/s,
  );
  assert.match(
    themeSource,
    /\.message-list\s*{[^}]*padding-bottom:\s*0/s,
  );
});

test("composer controls stay docked to the bottom of the input surface", () => {
  assert.match(
    themeSource,
    /\.composer\s*{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s,
  );
  assert.match(
    themeSource,
    /\.composer-footer\s*{[^}]*margin-top:\s*auto;/s,
  );
});

test("conversation readiness status always stays on one line", () => {
  assert.match(
    themeSource,
    /\.header-action\s*{[^}]*flex:\s*0 0 auto;[^}]*white-space:\s*nowrap;/s,
  );
});

test("model picker does not report a connection attempt without a session", () => {
  assert.match(
    workspaceSource,
    /!session\s*\?\s*\(en \? "No session" : "未选择会话"\)/,
  );
});

test("composer ignores Enter while an IME composition is active", () => {
  const guard = workspaceSource.indexOf(
    "event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229",
  );
  const sendShortcut = workspaceSource.indexOf(
    'if (event.key === "Enter" && !event.shiftKey)',
  );
  assert.ok(guard >= 0, "composer is missing its IME composition guard");
  assert.ok(guard < sendShortcut, "IME composition must be checked before Enter sends");
});
