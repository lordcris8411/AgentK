import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

const root = join(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function canLoadNodePty() {
  return spawnSync(process.execPath, ["-e", "require('node-pty')"], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true,
  }).status === 0;
}

if (!canLoadNodePty()) {
  console.log("Preparing the reviewed node-pty native module...");
  const rebuilt = spawnSync(npm, ["rebuild", "node-pty"], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (rebuilt.status !== 0 || !canLoadNodePty()) {
    console.error(
      "Unable to prepare node-pty. Install the platform C/C++ build tools, then run npm run prepare:native again.",
    );
    process.exit(rebuilt.status || 1);
  }
}
