import assert from "node:assert/strict";
import test from "node:test";
import { listDebugProcesses } from "./processes.ts";

test("debug process discovery uses an absolute platform utility and returns selectable processes", async () => {
  const processes = await listDebugProcesses();
  assert.ok(processes.length > 0);
  assert.ok(processes.every((item) => Number.isInteger(item.pid) && item.pid > 0 && item.name.length > 0));
  assert.equal(processes.some((item) => item.pid === process.pid), false);
});
