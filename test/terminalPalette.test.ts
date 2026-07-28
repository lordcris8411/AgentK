import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_K_TERMINAL_ACCENT_FOREGROUND_INDEX,
  AGENT_K_TERMINAL_ACCENT_INDEX,
  terminalAccentSequence,
} from "../src/lib/terminalPalette.ts";

test("maps theme accent colors to Agent K's private xterm palette slot", () => {
  assert.equal(AGENT_K_TERMINAL_ACCENT_INDEX, 16);
  assert.equal(AGENT_K_TERMINAL_ACCENT_FOREGROUND_INDEX, 17);
  assert.equal(terminalAccentSequence("#F0EDE8", "#1f1f1f"), "\x1b]4;16;#f0ede8;17;#1f1f1f\x1b\\");
  assert.equal(terminalAccentSequence("#abc8", "#123f"), "\x1b]4;16;#aabbcc;17;#112233\x1b\\");
  assert.equal(terminalAccentSequence("rgb(48 45 42 / 80%)", "rgb(255 255 255)"), "\x1b]4;16;#302d2a;17;#ffffff\x1b\\");
  assert.equal(terminalAccentSequence("rgb(50%, 25%, 0%)", "rgb(0%, 0%, 0%)"), "\x1b]4;16;#804000;17;#000000\x1b\\");
});

test("rejects colors that xterm OSC 4 cannot represent", () => {
  assert.equal(terminalAccentSequence("not-a-color", "#fff"), undefined);
  assert.equal(terminalAccentSequence("#12345", "#fff"), undefined);
  assert.equal(terminalAccentSequence("#fff", "not-a-color"), undefined);
});
