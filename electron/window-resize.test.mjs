import assert from "node:assert/strict";
import test from "node:test";
import {
  resizedWindowBounds,
  usesManualWindowResize,
} from "../.electron-dist/window-resize.js";

test("native Wayland uses compositor resize while Windows and X11 stay manual", () => {
  assert.equal(usesManualWindowResize("linux", { XDG_SESSION_TYPE: "wayland" }), false);
  assert.equal(usesManualWindowResize("linux", { WAYLAND_DISPLAY: "wayland-0" }), false);
  assert.equal(usesManualWindowResize("linux", { XDG_SESSION_TYPE: "wayland" }, "x11"), true);
  assert.equal(usesManualWindowResize("linux", {}, "wayland"), false);
  assert.equal(usesManualWindowResize("win32", { XDG_SESSION_TYPE: "wayland" }), true);
});

test("manual left resize keeps the right edge fixed", () => {
  const start = { height: 900, width: 1600, x: 100, y: 200 };
  assert.deepEqual(
    resizedWindowBounds(start, "West", 100, 0, 1372, 640),
    { height: 900, width: 1500, x: 200, y: 200 },
  );
  assert.deepEqual(
    resizedWindowBounds(start, "West", 400, 0, 1372, 640),
    { height: 900, width: 1372, x: 328, y: 200 },
  );
});

test("manual right resize keeps the left edge fixed", () => {
  const start = { height: 900, width: 1600, x: 100, y: 200 };
  assert.deepEqual(
    resizedWindowBounds(start, "East", -100, 0, 1372, 640),
    { height: 900, width: 1500, x: 100, y: 200 },
  );
});
