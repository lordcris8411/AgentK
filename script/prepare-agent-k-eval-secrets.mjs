import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const runnerTemp = process.env.RUNNER_TEMP;
const githubEnvironment = process.env.GITHUB_ENV;
if (!runnerTemp || !githubEnvironment) throw new Error("This helper must run inside GitHub Actions");

const directory = join(runnerTemp, "agent-k-evaluation-config");
await mkdir(directory, { recursive: true });

const inputs = [
  ["AGENT_K_EVAL_AUTH_JSON", "AGENT_K_EVAL_AUTH_PATH", "auth.json"],
  ["AGENT_K_EVAL_CLIENT_SETTINGS_JSON", "AGENT_K_EVAL_CLIENT_SETTINGS_PATH", "client-settings.json"],
  ["AGENT_K_EVAL_MODELS_JSON", "AGENT_K_EVAL_MODELS_PATH", "models.json"],
  ["AGENT_K_EVAL_PI_SETTINGS_JSON", "AGENT_K_EVAL_PI_SETTINGS_PATH", "settings.json"],
];

const exported = [];
for (const [secretName, pathName, fileName] of inputs) {
  const source = process.env[secretName];
  if (!source) throw new Error(`Required Actions secret ${secretName} is empty`);
  const normalized = `${JSON.stringify(JSON.parse(source), null, 2)}\n`;
  const path = join(directory, fileName);
  await writeFile(path, normalized, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
  exported.push(`${pathName}=${path}`);
}

await appendFile(githubEnvironment, `${exported.join("\n")}\n`, "utf8");
