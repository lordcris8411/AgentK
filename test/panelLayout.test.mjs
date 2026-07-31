import assert from "node:assert/strict";
import test from "node:test";
import { fitPanelWidths } from "../src/components/layout/panelLayout.ts";

test("clamps an oversized persisted inspector before the first window resize", () => {
  assert.deepEqual(fitPanelWidths(1600, 245, 1343), {
    left: 245,
    right: 643,
  });
});

test("preserves valid persisted panel widths", () => {
  assert.deepEqual(fitPanelWidths(1600, 304, 420), {
    left: 304,
    right: 420,
  });
});

test("keeps both panel minimums and the workspace minimum", () => {
  assert.deepEqual(fitPanelWidths(1372, 1000, 1000), {
    left: 240,
    right: 420,
  });
});
