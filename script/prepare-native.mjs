import { spawnSync } from "node:child_process";
import { chmod, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = join(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCli = process.env.npm_execpath;

function currentSpawnHelper() {
  return process.platform === "win32"
    ? undefined
    : join(
        root,
        "node_modules",
        "node-pty",
        "prebuilds",
        `${process.platform}-${process.arch}`,
        "spawn-helper",
      );
}

async function makeSpawnHelpersExecutable() {
  if (process.platform === "win32") return;
  const prebuilds = join(root, "node_modules", "node-pty", "prebuilds");
  if (!existsSync(prebuilds)) return;
  for (const entry of await readdir(prebuilds, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const helper = join(prebuilds, entry.name, "spawn-helper");
    if (existsSync(helper)) await chmod(helper, 0o755);
  }
}

function canLoadNodePty() {
  return spawnSync(process.execPath, ["-e", "require('node-pty')"], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true,
  }).status === 0;
}

function nativeArtifactsReady() {
  const helper = currentSpawnHelper();
  return canLoadNodePty() && (!helper || existsSync(helper));
}

if (!nativeArtifactsReady()) {
  console.log("Preparing the reviewed node-pty native module...");
  const rebuilt = spawnSync(
    npmCli ? process.execPath : npm,
    npmCli ? [npmCli, "rebuild", "node-pty"] : ["rebuild", "node-pty"],
    {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    },
  );
  if (rebuilt.status !== 0 || !nativeArtifactsReady()) {
    console.error(
      "Unable to prepare node-pty. Install the platform C/C++ build tools, then run npm run prepare:native again.",
    );
    process.exit(rebuilt.status || 1);
  }
}

await makeSpawnHelpersExecutable();
