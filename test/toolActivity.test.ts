import assert from "node:assert/strict";
import test from "node:test";
import { toolActivityContent } from "../src/features/conversation/toolActivity.ts";

test("bash activity shows the invoked command before its output", () => {
  assert.equal(
    toolActivityContent(
      { content: "hello\n", tool: "bash" },
      { args: { command: "printf hello" }, name: "bash" },
      false,
    ),
    "$ printf hello\n\nhello\n",
  );
});

test("non-bash activity preserves the existing result presentation", () => {
  assert.equal(
    toolActivityContent(
      { content: "done", tool: "read" },
      { args: { path: "README.md" }, name: "read" },
      true,
    ),
    "done",
  );
});
