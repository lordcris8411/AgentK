import assert from "node:assert/strict";
import test from "node:test";
import { isLocalDebugScope } from "../src/features/debug/scopes.ts";

test("shows local and argument scopes without CodeLLDB static or register scopes", () => {
  assert.equal(isLocalDebugScope({ name: "Local" }), true);
  assert.equal(isLocalDebugScope({ name: "Arguments", presentationHint: "arguments" }), true);
  assert.equal(isLocalDebugScope({ name: "Captured Variables" }), true);
  assert.equal(isLocalDebugScope({ name: "Static" }), false);
  assert.equal(isLocalDebugScope({ name: "Globals" }), false);
  assert.equal(isLocalDebugScope({ name: "Registers" }), false);
  assert.equal(isLocalDebugScope({ name: "CPU", presentationHint: "registers" }), false);
});
