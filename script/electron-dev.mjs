import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = join(import.meta.dirname, "..");
const windows = process.platform === "win32";
const bin = (name) => join(root, "node_modules", ".bin", `${name}${windows ? ".cmd" : ""}`);
const electronExecutable = windows
  ? join(root, "node_modules", "electron", "dist", "electron.exe")
  : bin("electron");
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
const viteDev = join(root, "script", "vite-dev.mjs");

function run(command, args, options = {}) {
  return spawn(command, args, {
    cwd: root,
    shell: false,
    stdio: "inherit",
    ...options,
  });
}

async function waitForVite(child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Vite exited before it became ready");
    try {
      // A listening socket is not enough: Vite may still be optimizing the
      // renderer graph. Bound each probe so one stalled response cannot hang
      // the desktop launcher forever.
      const response = await fetch("http://127.0.0.1:1420/", {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Vite on port 1420");
}

if (!existsSync(electronExecutable)) {
  console.error("Electron is not installed. Run npm ci --ignore-scripts first.");
  process.exit(1);
}

const compile = run(process.execPath, [tsc, "-p", "tsconfig.electron.json"]);
const compileCode = await new Promise((resolve) => compile.once("exit", resolve));
if (compileCode !== 0) process.exit(Number(compileCode) || 1);

const editorBuild = run(process.execPath, [join(root, "script", "build-editor-extensions.mjs")]);
const editorBuildCode = await new Promise((resolve) => editorBuild.once("exit", resolve));
if (editorBuildCode !== 0) process.exit(Number(editorBuildCode) || 1);

const languageServerBuild = run(process.execPath, [join(root, "script", "build-language-packs.mjs")]);
const languageServerBuildCode = await new Promise((resolve) => languageServerBuild.once("exit", resolve));
if (languageServerBuildCode !== 0) process.exit(Number(languageServerBuildCode) || 1);

// Vite enables interactive shortcuts by putting inherited stdin into raw mode.
// If it is terminated together with Electron on Windows, that mode can leak
// back to PowerShell (Backspace then prints as ^H). It only needs stdout and
// stderr for this launcher, so deliberately give it no console input handle.
// The dedicated launcher closes Vite if this process disappears before its
// normal finally block can run, preventing an orphan from retaining port 1420.
const viteProcess = run(process.execPath, [viteDev, String(process.pid)], {
  detached: !windows,
  stdio: ["ignore", "inherit", "inherit"],
});
let electronProcess;
function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  // Terminate the process tree on Windows so Vite's node.exe child cannot
  // survive the launcher and keep port 1420 occupied.
  if (windows && child.pid) {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  // Vite and Electron each run in their own Unix process group. Stopping the
  // group also releases Chromium helpers and the listening socket if the
  // launcher receives Ctrl+Z, SIGHUP, or another terminal signal.
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch (cause) {
      if (cause?.code !== "ESRCH") throw cause;
    }
  }
  child.kill("SIGTERM");
}
const stop = () => {
  stopChild(electronProcess);
  stopChild(viteProcess);
};
const restoreTerminal = () => {
  if (!process.stdin.isTTY) return;
  try {
    process.stdin.setRawMode(false);
  } catch {
    // Another process may already have released the console input handle.
  }
};
const cleanup = () => {
  stop();
  restoreTerminal();
};
for (const signal of windows
  ? ["SIGINT", "SIGTERM"]
  : ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGTSTP"]) {
  process.once(signal, cleanup);
}
process.once("exit", stop);

try {
  await waitForVite(viteProcess);
  const env = {
    ...process.env,
    AGENT_K_DEV_URL: "http://127.0.0.1:1420",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  electronProcess = run(electronExecutable, ["."], { detached: !windows, env });
  const code = await new Promise((resolve) => electronProcess.once("exit", resolve));
  process.exitCode = Number(code) || 0;
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
} finally {
  cleanup();
}
