import assert from "node:assert/strict";
import test from "node:test";
import {
  latestContextTokens,
  piCompactionThreshold,
} from "../src/features/conversation/contextUsage.ts";

test("places the Pi default compaction marker at the reserved-token boundary", () => {
  assert.deepEqual(piCompactionThreshold(272_000), {
    percent: (255_616 / 272_000) * 100,
    tokens: 255_616,
  });
  assert.deepEqual(piCompactionThreshold(8_192), { percent: 0, tokens: 0 });
  assert.equal(piCompactionThreshold(0), undefined);
});

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

test("does not restore stale pre-compaction usage after a session reload", () => {
  const compacted = [
    {
      role: "compactionSummary",
      summary: "Older work",
      timestamp: 2_000,
      tokensBefore: 250_000,
    },
    {
      role: "assistant",
      timestamp: 1_500,
      usage: { totalTokens: 248_000 },
    },
  ];
  assert.equal(latestContextTokens(compacted), undefined);
  assert.equal(
    latestContextTokens([
      ...compacted,
      {
        role: "assistant",
        timestamp: 2_500,
        usage: { totalTokens: 31_000 },
      },
    ]),
    31_000,
  );
});
