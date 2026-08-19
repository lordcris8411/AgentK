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
const electronMainSource = await readFile(
  new URL("../electron/main.ts", import.meta.url),
  "utf8",
);
const appShellSource = await readFile(
  new URL("../src/components/layout/AppShell.tsx", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(await readFile(
  new URL("../package.json", import.meta.url),
  "utf8",
));

test("assistant streaming updates use a 16 ms frame window end to end", () => {
  assert.match(workspaceSource, /const ASSISTANT_STREAM_FRAME_MS = 16;/);
  assert.match(
    workspaceSource,
    /window\.setTimeout\(\s*\(\) => flushAssistantUpdate\(\),\s*ASSISTANT_STREAM_FRAME_MS,/s,
  );
  assert.match(electronMainSource, /const ASSISTANT_STREAM_FRAME_MS = 16;/);
  assert.match(
    electronMainSource,
    /setTimeout\(\s*\(\) => flushAssistantEvent\(runtimeKey\),\s*ASSISTANT_STREAM_FRAME_MS,/s,
  );
});

test("live assistant text uses isolated Pretext layout", () => {
  assert.equal(packageJson.dependencies["@chenglou/pretext"], "0.0.8");
  assert.match(
    workspaceSource,
    /import \{ layoutWithLines, prepareWithSegments \} from "@chenglou\/pretext";/,
  );
  assert.match(workspaceSource, /useSyncExternalStore\(/);
  assert.match(workspaceSource, /layoutWithLines\(prepared, width, THINKING_LINE_HEIGHT\)/);
  assert.match(workspaceSource, /if \(\s*!forceCommit &&[\s\S]*?previousStructure\.key === structureKey[\s\S]*?\) return;/);
  assert.match(themeSource, /\.thinking-block pre\.pretext-thinking-text\s*{[^}]*overflow:\s*hidden;/s);
});

test("panel resizing defers conversation layout until the splitter settles", () => {
  assert.match(
    workspaceSource,
    /if \(document\.body\.classList\.contains\("is-resizing-panels"\)\) return;/,
  );
  assert.match(
    appShellSource,
    /window\.dispatchEvent\(new Event\("agent-k-panel-resize-finished"\)\);/,
  );
  assert.match(
    workspaceSource,
    /window\.addEventListener\("agent-k-panel-resize-finished", finishPanelResize\);/,
  );
});

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

test("queued composer messages render every attachment", () => {
  assert.match(
    workspaceSource,
    /pendingSteer\.attachments\.map\(\(attachment\) => \([\s\S]*?attachment\.previewUrl[\s\S]*?<figcaption title=\{attachment\.name\}>\{attachment\.name\}<\/figcaption>/,
  );
  assert.match(
    workspaceSource,
    /aria-label=\{en \? "Queued attachments" : "排队消息的附件"\}/,
  );
  assert.match(
    themeSource,
    /\.pending-steer-attachments\s*{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto;/s,
  );
});
