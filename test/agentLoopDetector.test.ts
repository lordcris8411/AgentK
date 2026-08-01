import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoopDetector } from "../agent-loop-detector.ts";

test("detects five consecutive identical tool calls", () => {
  const detector = new AgentLoopDetector();
  for (let index = 0; index < 4; index++) {
    assert.equal(detector.addToolCall("bash", { command: "rg TODO", cwd: "/repo" }), undefined);
  }
  assert.equal(
    detector.addToolCall("bash", { cwd: "/repo", command: "rg TODO" })?.type,
    "tool-call-cycle",
  );
});

test("detects repeated short tool-call cycles but not varying batch work", () => {
  const detector = new AgentLoopDetector();
  for (let index = 0; index < 5; index++) {
    assert.equal(detector.addToolCall("read", { path: "a.ts" }), undefined);
    const result = detector.addToolCall("grep", { pattern: "needle" });
    if (index < 4) assert.equal(result, undefined);
    else assert.match(result?.detail ?? "", /length 2/);
  }

  const batch = new AgentLoopDetector();
  for (let index = 0; index < 30; index++) {
    assert.equal(batch.addToolCall("read", { path: `${index}.ts` }), undefined);
  }
});

test("reset starts a fresh prompt history", () => {
  const detector = new AgentLoopDetector();
  for (let index = 0; index < 4; index++) detector.addToolCall("bash", { command: "same" });
  detector.reset();
  assert.equal(detector.addToolCall("bash", { command: "same" }), undefined);
});

test("detects repeated streamed prose", () => {
  const detector = new AgentLoopDetector();
  const repeated = "I will inspect the same file again without changing the approach. ";
  let detection;
  for (let index = 0; index < 12 && !detection; index++) detection = detector.addContent(repeated);
  assert.equal(detection?.type, "content-repetition");
});

test("does not detect repetition inside fenced code blocks", () => {
  const detector = new AgentLoopDetector();
  detector.addContent("```text\n");
  for (let index = 0; index < 20; index++) {
    assert.equal(detector.addContent("same generated code line repeated many times\n"), undefined);
  }
  assert.equal(detector.addContent("```\n"), undefined);
});

test("resetStreamingContent preserves tool-call cycle history", () => {
  const detector = new AgentLoopDetector();
  for (let index = 0; index < 4; index++) detector.addToolCall("bash", { command: "same" });
  detector.resetStreamingContent();
  assert.equal(detector.addToolCall("bash", { command: "same" })?.type, "tool-call-cycle");
});

test("resetStreamingContent clears an unfinished code-block boundary", () => {
  const detector = new AgentLoopDetector();
  detector.addContent("```text\nunfinished code block");
  detector.resetStreamingContent();
  const repeated = "I will inspect the same file again without changing the approach. ";
  let detection;
  for (let index = 0; index < 12 && !detection; index++) detection = detector.addContent(repeated);
  assert.equal(detection?.type, "content-repetition");
});
