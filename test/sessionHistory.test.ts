import assert from "node:assert/strict";
import test from "node:test";
import { activeBranchMessages as desktopBranchMessages } from "../electron/session-history.ts";
import { activeBranchMessages as rendererBranchMessages } from "../src/features/conversation/sessionHistory.ts";

const implementations = [
  ["desktop", desktopBranchMessages],
  ["renderer", rendererBranchMessages],
] as const;

for (const [name, activeBranchMessages] of implementations) test(`${name}: keeps visible ancestors when Pi compacts the model context`, () => {
  const entries = [
    { id: "model", type: "model_change" },
    { id: "user-1", parentId: "model", type: "message", message: { role: "user", content: "first" } },
    { id: "assistant-1", parentId: "user-1", type: "message", message: { role: "assistant", content: "answer" } },
    { id: "compact", parentId: "assistant-1", type: "compaction", summary: "model-only summary" },
    { id: "user-2", parentId: "compact", type: "message", message: { role: "user", content: "second" } },
  ];
  assert.deepEqual(
    activeBranchMessages(entries, "user-2").map((message) => message.content),
    ["first", "answer", "second"],
  );
});

for (const [name, activeBranchMessages] of implementations) test(`${name}: shows only the selected session branch`, () => {
  const entries = [
    { id: "root", type: "model_change" },
    { id: "question", parentId: "root", type: "message", message: { role: "user", content: "question" } },
    { id: "old", parentId: "question", type: "message", message: { role: "assistant", content: "old branch" } },
    { id: "new", parentId: "question", type: "message", message: { role: "assistant", content: "active branch" } },
  ];
  assert.deepEqual(
    activeBranchMessages(entries, "new").map((message) => message.content),
    ["question", "active branch"],
  );
});
