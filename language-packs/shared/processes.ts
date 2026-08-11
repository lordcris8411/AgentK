import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type DebugProcess = { command: string; name: string; pid: number };

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, { env: { LANG: process.env.LANG ?? "C", SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolveOutput(stdout) : reject(new Error(stderr.trim() || `Process discovery exited with code ${code}`)));
  });
}

export async function listDebugProcesses(): Promise<DebugProcess[]> {
  if (process.platform === "win32") {
    const system = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    const tasklist = join(system, "System32", "tasklist.exe");
    if (!existsSync(tasklist)) throw new Error("Windows tasklist.exe is unavailable");
    const output = await run(tasklist, ["/fo", "csv", "/nh"]);
    return output.split(/\r?\n/u).flatMap((line) => {
      const fields = [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/gu)].map((match) => match[1]!.replaceAll('""', '"'));
      const pid = Number(fields[1]);
      return Number.isInteger(pid) && pid > 0 && pid !== process.pid ? [{ pid, name: fields[0] || `Process ${pid}`, command: fields[0] || "" }] : [];
    }).sort((left, right) => left.name.localeCompare(right.name));
  }
  const ps = ["/bin/ps", "/usr/bin/ps"].find(existsSync);
  if (!ps) throw new Error("ps is unavailable");
  const output = await run(ps, ["-axo", "pid=,comm=,args="]);
  return output.split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\S+)\s*(.*)$/u.exec(line); const pid = Number(match?.[1]);
    return match && pid > 0 && pid !== process.pid ? [{ pid, name: match[2]!, command: match[3] || match[2]! }] : [];
  }).sort((left, right) => left.name.localeCompare(right.name));
}
