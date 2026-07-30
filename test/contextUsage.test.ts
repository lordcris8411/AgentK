import assert from "node:assert/strict";
import test from "node:test";
import { latestContextTokens } from "../src/features/conversation/contextUsage.ts";

test("uses the latest assistant context usage on the active message path", () => {
  const messages = [
    { role: "assistant", usage: { totalTokens: 1_200 } },
    { role: "user", content: "continue" },
    { role: "assistant", usage: { input: 2_000, output: 300, cacheRead: 400 } },
  ];

  assert.equal(latestContextTokens(messages), 2_700);
});

test("recomputes context usage when conversation history is rewound", () => {
  const beforeRewind = [
    { role: "assistant", usage: { totalTokens: 1_200 } },
    { role: "user", content: "continue" },
    { role: "assistant", usage: { totalTokens: 8_400 } },
  ];

  assert.equal(latestContextTokens(beforeRewind), 8_400);
  assert.equal(latestContextTokens(beforeRewind.slice(0, 1)), 1_200);
  assert.equal(latestContextTokens([]), undefined);
});
