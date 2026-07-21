import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function homeDirectory(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (!home) throw new Error("Home directory unavailable");
  return home;
}

export function piAgentDirectory(): string {
  return join(homeDirectory(), ".pi", "agent");
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function atomicWrite(
  path: string,
  content: string | Uint8Array,
  privateFile = false,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, content, privateFile ? { mode: 0o600 } : undefined);
  await rm(path, { force: true });
  await rename(temporary, path);
}

export function isPathInside(root: string, target: string): boolean {
  const child = relative(resolve(root), resolve(target));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

export function randomId(prefix = ""): string {
  return `${prefix}${randomBytes(8).toString("hex")}`;
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
