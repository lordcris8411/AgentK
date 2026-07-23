import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectSummary } from "../src/lib/desktop.ts";
import { sortProjectsByActivity } from "../src/features/sessions/activity.ts";

function project(
  name: string,
  updatedAt: number,
  sessionTimes: number[],
): ProjectSummary {
  return {
    cwd: `/workspace/${name}`,
    name,
    updatedAt,
    sessions: sessionTimes.map((time, index) => ({
      cwd: `/workspace/${name}`,
      id: `${name}-${index}`,
      path: `/sessions/${name}-${index}.jsonl`,
      preview: "",
      updatedAt: time,
    })),
  };
}

test("sorts workspaces and their sessions by descending activity", () => {
  const older = project("older", 10, [4, 9]);
  const newer = project("newer", 20, [18, 12]);

  const sorted = sortProjectsByActivity([older, newer]);

  assert.deepEqual(sorted.map((item) => item.name), ["newer", "older"]);
  assert.deepEqual(
    sorted[1]?.sessions.map((session) => session.updatedAt),
    [9, 4],
  );
  assert.deepEqual(older.sessions.map((session) => session.updatedAt), [4, 9]);
});
