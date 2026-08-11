import assert from "node:assert/strict";
import test from "node:test";
import { matchesProjectMarker } from "../src/features/extensions/projectMarkers.ts";

test("project markers match exact direct child names without case sensitivity", () => {
  assert.equal(matchesProjectMarker("CMakeLists.txt", new Set(["cmakelists.txt"])), true);
  assert.equal(matchesProjectMarker("package.json", new Set(["src", "package.json"])), true);
});

test("project markers support a single leading extension wildcard", () => {
  assert.equal(matchesProjectMarker("*.csproj", new Set(["src", "Example.csproj"])), true);
  assert.equal(matchesProjectMarker("*.sln", new Set(["example.slnx"])), false);
  assert.equal(matchesProjectMarker("*proj", new Set(["example.csproj"])), false);
});
