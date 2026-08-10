import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export type PiLaunch = {
  executable: string;
  args: string[];
  environment?: NodeJS.ProcessEnv;
};

export function selectPiCommandCandidate(
  candidates: string[],
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const available = candidates.map((candidate) => candidate.trim()).filter(Boolean);
  if (platform !== "win32") return available[0];
  for (const extension of [".exe", ".cmd", ".bat"]) {
    const candidate = available.find((path) => path.toLocaleLowerCase("en-US").endsWith(extension));
    if (candidate) return candidate;
  }
  for (const candidate of available) {
    for (const extension of [".exe", ".cmd", ".bat"]) {
      const wrapper = `${candidate}${extension}`;
      if (existsSync(wrapper)) return wrapper;
    }
  }
  return available[0];
}

function commandOnPath(command: string): string | undefined {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [command], { encoding: "utf8", windowsHide: true });
  return result.status === 0
    ? selectPiCommandCandidate(result.stdout.split(/\r?\n/))
    : undefined;
}

function externalPi(executable: string): PiLaunch {
  return {
    executable: selectPiCommandCandidate([executable]) ?? executable,
    args: [],
  };
}

export function resolvePiLaunch(
  configuredExecutable: string,
  bundledCli: string,
  bundledNodeExecutable = process.execPath,
): PiLaunch {
  const environmentExecutable = process.env.AGENT_K_PI_EXECUTABLE?.trim();
  if (environmentExecutable) return externalPi(environmentExecutable);
  if (configuredExecutable) return externalPi(configuredExecutable);
  // The reviewed, pinned runtime is the deterministic default. An ambient
  // npm `pi.cmd` may be a different version and requires shell execution on
  // Windows; only explicit environment/settings overrides should replace it.
  if (existsSync(bundledCli)) {
    return {
      executable: bundledNodeExecutable,
      args: [bundledCli],
      environment: {
        AGENT_K_NODE_EXECUTABLE: bundledNodeExecutable,
        ELECTRON_RUN_AS_NODE: "1",
      },
    };
  }
  const discoveredExecutable = commandOnPath("pi");
  if (discoveredExecutable) return externalPi(discoveredExecutable);
  throw new Error("No Pi executable was found and the bundled Pi runtime is unavailable");
}
