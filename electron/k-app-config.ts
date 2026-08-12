export type KAppConfig = {
  author: string;
  functionality: string;
  name: string;
  reserved: Record<string, unknown>;
  schemaVersion: 1;
  settings: Record<string, unknown>;
  version: string;
  [key: string]: unknown;
};

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`config.k ${field} must be an object`);
  return value as Record<string, unknown>;
}

export function parseKAppConfig(source: string): KAppConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new Error(`config.k must contain valid JSON: ${String(cause)}`);
  }
  const config = object(parsed, "root");
  if (config.schemaVersion !== 1) throw new Error("config.k schemaVersion must be 1");
  for (const field of ["name", "author", "functionality"] as const) {
    if (typeof config[field] !== "string" || !config[field].trim())
      throw new Error(`config.k ${field} must be a non-empty string`);
  }
  if (typeof config.version !== "string" || !SEMVER.test(config.version))
    throw new Error("config.k version must be a semantic version");
  const reserved = object(config.reserved, "reserved");
  const settings = object(config.settings, "settings");
  return { ...config, reserved, settings } as KAppConfig;
}

export async function loadKAppConfig(directory: string, appPath?: string): Promise<KAppConfig> {
  if (appPath && !["app.html", "app.htm"].includes(basename(appPath).toLocaleLowerCase("en-US")))
    throw new Error("Agent K API is available only to a k-app app.htm(l)");
  const entries = await readdir(directory, { withFileTypes: true });
  const files = new Map(entries.filter((entry) => entry.isFile()).map((entry) => [entry.name.toLocaleLowerCase("en-US"), entry.name]));
  if (!files.has("app.html") && !files.has("app.htm")) throw new Error("k-app requires app.html or app.htm");
  const configName = files.get("config.k");
  if (!configName) throw new Error("Agent K API requires config.k");
  return parseKAppConfig(await readFile(join(directory, configName), "utf8"));
}
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
