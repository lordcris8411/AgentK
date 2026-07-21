import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export type PiLaunch = {
  executable: string;
  args: string[];
  environment?: NodeJS.ProcessEnv;
};

function commandOnPath(command: string): string | undefined {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [command], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.split(/\r?\n/)[0]?.trim() : undefined;
}

function externalPi(executable: string): PiLaunch {
  return { executable, args: [] };
}

export function resolvePiLaunch(configuredExecutable: string, bundledCli: string): PiLaunch {
  const environmentExecutable = process.env.AGENT_K_PI_EXECUTABLE?.trim();
  if (environmentExecutable) return externalPi(environmentExecutable);
  if (configuredExecutable) return externalPi(configuredExecutable);
  const discoveredExecutable = commandOnPath("pi");
  if (discoveredExecutable) return externalPi(discoveredExecutable);
  if (!existsSync(bundledCli))
    throw new Error("No Pi executable was found and the bundled Pi runtime is unavailable");
  return {
    executable: process.execPath,
    args: [bundledCli],
    environment: { ELECTRON_RUN_AS_NODE: "1" },
  };
}
