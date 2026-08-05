import { spawnSync } from "node:child_process";
import { chmod, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = join(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCli = process.env.npm_execpath;

function loadedNativeDirectory() {
  if (process.platform === "win32") return undefined;
  const resolved = spawnSync(
    process.execPath,
    [
      "-e",
      [
        "const path = require('node:path');",
        "const utils = require.resolve('node-pty/lib/utils');",
        "const loaded = require(utils).loadNativeModule('pty');",
        "process.stdout.write(path.resolve(path.dirname(utils), loaded.dir));",
      ].join(""),
    ],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  return resolved.status === 0 ? resolved.stdout.trim() : undefined;
}

async function makeSpawnHelpersExecutable() {
  if (process.platform === "win32") return;
  const nativeRoot = join(root, "node_modules", "node-pty");
  const directories = [join(nativeRoot, "build", "Release"), join(nativeRoot, "build", "Debug")];
  const prebuilds = join(nativeRoot, "prebuilds");
  if (existsSync(prebuilds)) {
    for (const entry of await readdir(prebuilds, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(join(prebuilds, entry.name));
    }
  }
  for (const directory of directories) {
    const helper = join(directory, "spawn-helper");
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
  if (process.platform === "win32") return canLoadNodePty();
  const directory = loadedNativeDirectory();
  return Boolean(directory && existsSync(join(directory, "spawn-helper")));
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
