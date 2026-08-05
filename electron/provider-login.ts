import type { PiLaunch } from "./pi-runtime.js";

const MAC_TERMINAL_SCRIPT = [
  "on run argv",
  "set commandText to \"cd \" & quoted form of (item 1 of argv as text)",
  "set providerId to item 2 of argv as text",
  "set commandText to commandText & \" && printf '\\nAgent K: enter /login %s in Pi to authenticate.\\n\\n' \" & quoted form of providerId",
  "set commandText to commandText & \"; exec\"",
  "repeat with argumentIndex from 3 to count of argv",
  "set commandText to commandText & \" \" & quoted form of (item argumentIndex of argv as text)",
  "end repeat",
  "tell application \"Terminal\"",
  "activate",
  "do script commandText",
  "end tell",
  "end run",
];

export function macTerminalLoginArguments(
  cwd: string,
  providerId: string,
  launch: PiLaunch,
): string[] {
  const environment = Object.entries(launch.environment ?? {})
    .filter(
      (entry): entry is [string, string] =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]) &&
        typeof entry[1] === "string",
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`);
  return [
    ...MAC_TERMINAL_SCRIPT.flatMap((line) => ["-e", line]),
    "--",
    cwd,
    providerId,
    "/usr/bin/env",
    ...environment,
    launch.executable,
    ...launch.args,
  ];
}
