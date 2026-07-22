import { spawn, spawnSync } from "node:child_process";
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

// Vite enables interactive shortcuts by putting inherited stdin into raw mode.
// If it is terminated together with Electron on Windows, that mode can leak
// back to PowerShell (Backspace then prints as ^H). It only needs stdout and
// stderr for this launcher, so deliberately give it no console input handle.
const vite = run(bin("vite"), ["--host", "127.0.0.1"], {
  detached: !windows,
  stdio: ["ignore", "inherit", "inherit"],
});
let electron;
function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  // On Windows, npm's .cmd launchers add a cmd.exe parent. Killing only that
  // parent leaves Vite's node.exe child alive and keeps port 1420 occupied.
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
  stopChild(electron);
  stopChild(vite);
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
  await waitForVite(vite);
  const env = {
    ...process.env,
    AGENT_K_DEV_URL: "http://127.0.0.1:1420",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = run(bin("electron"), ["."], { detached: !windows, env });
  const code = await new Promise((resolve) => electron.once("exit", resolve));
  process.exitCode = Number(code) || 0;
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
} finally {
  cleanup();
}
