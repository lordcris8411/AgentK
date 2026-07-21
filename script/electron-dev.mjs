import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = join(import.meta.dirname, "..");
const windows = process.platform === "win32";
const bin = (name) => join(root, "node_modules", ".bin", `${name}${windows ? ".cmd" : ""}`);

function run(command, args, options = {}) {
  return spawn(command, args, {
    cwd: root,
    shell: windows,
    stdio: "inherit",
    ...options,
  });
}

async function waitForVite(child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Vite exited before it became ready");
    try {
      const response = await fetch("http://127.0.0.1:1420/");
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Vite on port 1420");
}

if (!existsSync(bin("electron"))) {
  console.error("Electron is not installed. Run npm ci --ignore-scripts first.");
  process.exit(1);
}

const compile = run(bin("tsc"), ["-p", "tsconfig.electron.json"]);
const compileCode = await new Promise((resolve) => compile.once("exit", resolve));
if (compileCode !== 0) process.exit(Number(compileCode) || 1);

const vite = run(bin("vite"), ["--host", "127.0.0.1"]);
let electron;
const stop = () => {
  if (electron && electron.exitCode === null) electron.kill("SIGTERM");
  if (vite.exitCode === null) vite.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await waitForVite(vite);
  const env = {
    ...process.env,
    AGENT_K_DEV_URL: "http://127.0.0.1:1420",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = run(bin("electron"), ["."], { env });
  const code = await new Promise((resolve) => electron.once("exit", resolve));
  stop();
  process.exitCode = Number(code) || 0;
} catch (cause) {
  stop();
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
}
