import { defineConfig } from "@playwright/test";

export default defineConfig({
  fullyParallel: false,
  reporter: "line",
  testDir: "./test/e2e",
  testMatch: "local-models.spec.ts",
  timeout: 60_000,
  workers: 1,
});
