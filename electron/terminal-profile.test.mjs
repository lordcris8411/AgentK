import assert from "node:assert/strict";
import test from "node:test";
import { agentKBashRcConfig, agentKStarshipConfig } from "../.electron-dist/terminal-profile.js";

test("keeps the Agent K Starship profile on the theme-controlled ANSI palette", () => {
  assert.match(agentKStarshipConfig, /bg:16/);
  assert.match(agentKStarshipConfig, /fg:16/);
  assert.match(agentKStarshipConfig, /fg:17 bg:16/);
  assert.doesNotMatch(agentKStarshipConfig, /bright-green/);
  assert.doesNotMatch(agentKStarshipConfig, /#[0-9a-f]{3,8}/i);
  assert.doesNotMatch(agentKStarshipConfig, /rgb\(/i);
});

test("loads the user's Bash configuration before applying the themed directory color", () => {
  assert.match(agentKBashRcConfig, /\. "\$\{HOME\}\/\.bashrc"/);
  assert.match(agentKBashRcConfig, /di=01;38;5;16/);
  assert.match(agentKBashRcConfig, /export USER_LS_COLORS=1/);
});
