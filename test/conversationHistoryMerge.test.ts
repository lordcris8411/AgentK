import assert from "node:assert/strict";
import test from "node:test";
import { mergePersistedItems } from "../src/features/conversation/historyMerge.ts";

test("does not carry an optimistic message into another session", () => {
  const optimistic = { content: "你好", optimistic: true, role: "user" };
  assert.deepEqual(mergePersistedItems([], [optimistic], false), []);
});

test("keeps an optimistic message while the same session refreshes", () => {
  const optimistic = { content: "你好", optimistic: true, role: "user" };
  assert.deepEqual(mergePersistedItems([], [optimistic], true), [optimistic]);
});
