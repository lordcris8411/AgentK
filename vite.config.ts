import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Agent and extension evaluations deliberately create isolated worktrees
    // under .agent-k-* directories. They are build artifacts, not renderer
    // source. Watching them recursively can create hundreds of thousands of
    // Windows handles and delay the first page response by over a minute.
    watch: {
      ignored: ["**/.agent-k-*/**"],
    },
  },
  envPrefix: ["VITE_"],
  build: {
    target: "chrome142",
    minify: "esbuild",
    sourcemap: false,
  },
});
