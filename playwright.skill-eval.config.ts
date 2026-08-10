import { defineConfig } from "@playwright/test";

export default defineConfig({
  fullyParallel: false,
  reporter: [["line"], ["json", { outputFile: process.env.AGENT_K_EVAL_PLAYWRIGHT_REPORT ?? ".agent-k-evaluation/playwright-results.json" }]],
  testDir: "./test/e2e",
  testMatch: "agent-k-skill-eval.spec.mjs",
  timeout: 40 * 60_000,
  workers: 1,
});
