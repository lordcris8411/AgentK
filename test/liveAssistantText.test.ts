import assert from "node:assert/strict";
import test from "node:test";
import { LiveAssistantTextStore } from "../src/features/conversation/liveAssistantText.ts";

test("live assistant text only notifies subscribers for observable changes", () => {
  const store = new LiveAssistantTextStore();
  let updates = 0;
  const unsubscribe = store.subscribe(() => updates += 1);

  store.publish("assistant-1", { content: "", thinking: "one" });
  store.publish("assistant-1", { content: "", thinking: "one" });
  store.publish("assistant-1", { content: "", thinking: "one two" });

  assert.equal(updates, 2);
  assert.equal(store.text("assistant-1", "thinking", "fallback"), "one two");
  assert.equal(store.text("historical", "thinking", "fallback"), "fallback");

  unsubscribe();
  store.publish("assistant-1", { content: "answer", thinking: "one two" });
  assert.equal(updates, 2);
});

test("clearing live text restores committed message fallbacks", () => {
  const store = new LiveAssistantTextStore();
  let updates = 0;
  store.subscribe(() => updates += 1);
  store.publish("assistant-1", { content: "streamed", thinking: "thought" });
  store.clear();
  store.clear();

  assert.equal(updates, 2);
  assert.equal(store.text("assistant-1", "content", "committed"), "committed");
});
