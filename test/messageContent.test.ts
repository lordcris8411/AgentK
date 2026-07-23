import assert from "node:assert/strict";
import test from "node:test";
import { displayUserContent } from "../src/features/conversation/messageContent.ts";

test("hides Agent K file-format context from user messages", () => {
  assert.equal(
    displayUserContent(
      "user",
      '补上C++版本\n\n<agent_k_file_format>\nThe active editor is showing "hello.js".\n</agent_k_file_format>',
    ),
    "补上C++版本",
  );
});

test("hides expanded skill instructions and preserves the question", () => {
  assert.equal(
    displayUserContent(
      "user",
      '<skill name="agent-k-html-editor" location="/tmp/SKILL.md">\n# Agent K HTML Editor\nInternal instructions.\n</skill>\n\n打开hello.html',
    ),
    "打开hello.html",
  );
});

test("hides attachment and editor context together", () => {
  assert.equal(
    displayUserContent(
      "user",
      '检查文件\n\n<attached_files>\n- "/tmp/example.md"\n</attached_files>\nUse the available file tools to inspect these local files when needed.\n\n<agent_k_file_format>\nInternal editor context.\n</agent_k_file_format>',
    ),
    "检查文件",
  );
});

test("keeps a useful label when a skill was invoked without arguments", () => {
  assert.equal(
    displayUserContent(
      "user",
      '<skill name="agent-k-text-editor" location="/tmp/SKILL.md">\nInternal instructions.\n</skill>',
    ),
    "/skill:agent-k-text-editor",
  );
});
