import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export function packagedResourcesPath(context) {
  return context.electronPlatformName === "darwin"
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : join(context.appOutDir, "resources");
}

export default async function verifyPackagedRuntime(context) {
  const resources = packagedResourcesPath(context);
  const cli = join(
    resources,
    "pi-runtime",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js",
  );
  try {
    await access(cli);
    if ((await stat(cli)).size === 0) throw new Error("bundled Pi CLI is empty");
  } catch (cause) {
    throw new Error(`Packaged Pi runtime is unavailable at ${cli}`, { cause });
  }

  if (context.electronPlatformName === "win32") return;
  const prebuilds = join(
    resources,
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "prebuilds",
  );
  const platformPrefix = `${context.electronPlatformName}-`;
  const helpers = (await readdir(prebuilds, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(platformPrefix))
    .map((entry) => join(prebuilds, entry.name, "spawn-helper"));
  if (!helpers.length) throw new Error(`Packaged node-pty spawn helper is unavailable in ${prebuilds}`);
  for (const helper of helpers) {
    try {
      await access(helper, constants.X_OK);
    } catch (cause) {
      throw new Error(`Packaged node-pty spawn helper is not executable at ${helper}`, { cause });
    }
  }
}
