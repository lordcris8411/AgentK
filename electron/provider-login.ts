import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PiLaunch } from "./pi-runtime.js";
import { piAgentDirectory } from "./utils.js";

type AuthPrompt = {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  options?: ReadonlyArray<{ id: string; label: string }>;
  signal?: AbortSignal;
};

type AuthEvent = {
  type: "info" | "auth_url" | "device_code" | "progress";
  url?: string;
};

type CodexModelRuntime = {
  login(
    providerId: string,
    type: "oauth",
    interaction: {
      prompt(prompt: AuthPrompt): Promise<string>;
      notify(event: AuthEvent): void;
    },
  ): Promise<unknown>;
};

export function piModelRuntimeEntry(launch: PiLaunch): string | undefined {
  const cli = launch.args.find((argument) => /(?:^|[\\/])dist[\\/]cli\.js$/i.test(argument));
  return cli ? join(dirname(cli), "index.js") : undefined;
}

export async function runOpenAICodexLogin(
  runtime: CodexModelRuntime,
  openExternal: (url: string) => Promise<unknown>,
): Promise<void> {
  await runtime.login("openai-codex", "oauth", {
    prompt(prompt) {
      if (prompt.type === "select") {
        const browser = prompt.options?.find((option) => option.id === "browser");
        if (!browser) throw new Error("OpenAI Codex browser login is unavailable");
        return Promise.resolve(browser.id);
      }
      if (prompt.type === "manual_code") {
        return new Promise<string>((_resolve, reject) => {
          const cancel = () => reject(new Error("Login cancelled"));
          if (prompt.signal?.aborted) cancel();
          else prompt.signal?.addEventListener("abort", cancel, { once: true });
        });
      }
      throw new Error(`OpenAI Codex OAuth requested unsupported input: ${prompt.message}`);
    },
    notify(event) {
      if (event.type === "auth_url" && event.url) void openExternal(event.url);
    },
  });
}

export async function loginOpenAICodex(
  launch: PiLaunch,
  openExternal: (url: string) => Promise<unknown>,
): Promise<void> {
  const entry = piModelRuntimeEntry(launch);
  if (!entry) throw new Error("OpenAI OAuth requires the bundled Pi runtime");
  const module = await import(pathToFileURL(entry).href) as {
    ModelRuntime?: { create(options: { authPath: string; modelsPath: string; allowModelNetwork: boolean }): Promise<CodexModelRuntime> };
  };
  if (!module.ModelRuntime) throw new Error("The bundled Pi runtime does not expose OAuth support");
  const directory = piAgentDirectory();
  const runtime = await module.ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: join(directory, "models.json"),
    allowModelNetwork: false,
  });
  await runOpenAICodexLogin(runtime, openExternal);
}

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
