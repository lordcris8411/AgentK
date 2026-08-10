import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import type { LanguagePackManifest } from "./language-pack-host.js";

export type ResolvedSystemTool = { command: string; id: string; source: "system"; version: string };

function candidates(command: string): string[] {
  if (isAbsolute(command)) return [command];
  const suffixes = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  return (process.env.PATH ?? "").split(delimiter).flatMap((directory) => suffixes.map((suffix) => resolve(directory, process.platform === "win32" && !command.toLowerCase().endsWith(suffix.toLowerCase()) ? command + suffix.toLowerCase() : command)));
}
function versionFrom(value: string): string | undefined { return /(?:^|\D)(\d+\.\d+(?:\.\d+)?)(?:\D|$)/u.exec(value)?.[1]; }
function compatible(version: string, range: string): boolean {
  const parts = (value: string) => value.split(".").map(Number); const actual = parts(version);
  const compare = (target: string) => { const expected = parts(target); for (let index = 0; index < 3; index += 1) { const delta = (actual[index] ?? 0) - (expected[index] ?? 0); if (delta) return delta; } return 0; };
  return range.split(/\s+/u).every((rule) => { const match = /^(>=|>|<=|<|=)?(\d+(?:\.\d+){0,2})$/u.exec(rule); if (!match) return false; const result = compare(match[2]!); return match[1] === ">=" ? result >= 0 : match[1] === ">" ? result > 0 : match[1] === "<=" ? result <= 0 : match[1] === "<" ? result < 0 : result === 0; });
}
function versionProbeLaunch(command: string): { executable: string; args: string[] } {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(command))
    return { executable: command, args: ["--version"] };
  // CreateProcess cannot execute command scripts directly. Do not use
  // child_process `shell: true`: Node 24 warns because it concatenates args
  // into an unescaped command string. The resolved executable is quoted as a
  // single cmd.exe command and the only argument is the fixed --version flag.
  const quoted = command.replaceAll('"', '""');
  return {
    executable: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `""${quoted}" --version"`],
  };
}
function probe(command: string): Promise<string | undefined> {
  return new Promise((done) => {
    let child: ReturnType<typeof spawn>;
    try {
      const launch = versionProbeLaunch(command);
      child = spawn(launch.executable, launch.args, {
        env: { PATH: dirname(command), SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
        shell: false,
        windowsVerbatimArguments: process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(command),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      done(undefined);
      return;
    }
    let output = ""; const timer = setTimeout(() => { child.kill(); done(undefined); }, 3000);
    child.stdout?.on("data", (value) => { output += value; }); child.stderr?.on("data", (value) => { output += value; });
    child.once("error", () => { clearTimeout(timer); done(undefined); }); child.once("close", () => { clearTimeout(timer); done(versionFrom(output)); });
  });
}
export class LanguagePackToolchainManager {
  constructor(private readonly manifest: LanguagePackManifest) {}
  async resolveSystemTools(): Promise<Record<string, ResolvedSystemTool>> {
    const tools: Record<string, ResolvedSystemTool> = {};
    for (const requirement of this.manifest.toolchains) {
      if (!requirement.system) continue;
      for (const name of requirement.system.commands) {
        const command = candidates(name).find(existsSync); if (!command) continue;
        const version = await probe(command); if (!version || !compatible(version, requirement.system.versionRange)) continue;
        tools[requirement.id] = { command, id: requirement.id, source: "system", version }; break;
      }
    }
    return tools;
  }
}
