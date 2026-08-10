import assert from "node:assert/strict";
import test from "node:test";
import { execute } from "./run.mjs";

test("runs deterministic operations", () => {
  assert.deepEqual(execute("sort", { versions: ["2.0.0", "1.10.0", "1.2.9"] }), { versions: ["1.2.9", "1.10.0", "2.0.0"] });
  assert.deepEqual(execute("sum", { values: ["250ms", "2s", "3m", "1h"] }), { totalMilliseconds: 3782250 });
});
