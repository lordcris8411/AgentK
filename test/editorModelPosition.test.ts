import assert from "node:assert/strict";
import test from "node:test";
import { boundedLinePrefix } from "../editor/extensions/text/model-position.ts";

function model(lines: string[]) {
  return {
    getLineContent(lineNumber: number) {
      assert.ok(lineNumber >= 1 && lineNumber <= lines.length, "lineNumber is in range");
      return lines[lineNumber - 1] ?? "";
    },
    getLineCount: () => lines.length,
    getLineLength(lineNumber: number) {
      assert.ok(lineNumber >= 1 && lineNumber <= lines.length, "lineNumber is in range");
      return (lines[lineNumber - 1] ?? "").length;
    },
  };
}

test("bounds Monaco's stale cursor after deleting the last line", () => {
  assert.equal(
    boundedLinePrefix(model(["first", "second"]), { lineNumber: 3, column: 40 }),
    "second",
  );
});

test("returns the current prefix for a valid Monaco cursor", () => {
  assert.equal(
    boundedLinePrefix(model(["object.member"]), { lineNumber: 1, column: 8 }),
    "object.",
  );
  assert.equal(boundedLinePrefix(model([""]), null), "");
});
