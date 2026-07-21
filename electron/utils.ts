import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const pendingAtomicWrites = new Map<string, Promise<void>>();

function retryableRenameError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    ["EACCES", "EBUSY", "EPERM"].includes(String(cause.code))
  );
}

async function replaceFile(temporary: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    await rm(target, { force: true });
    try {
      await rename(temporary, target);
      return;
    } catch (cause) {
      if (!retryableRenameError(cause) || attempt >= 4) throw cause;
      await new Promise((resume) => setTimeout(resume, 25 * (attempt + 1)));
    }
  }
}

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
  const target = resolve(path);
  const previous = pendingAtomicWrites.get(target) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(async () => {
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, content, privateFile ? { mode: 0o600 } : undefined);
      await replaceFile(temporary, target);
    } catch (cause) {
      await rm(temporary, { force: true });
      throw cause;
    }
  });
  pendingAtomicWrites.set(target, write);
  try {
    await write;
  } finally {
    if (pendingAtomicWrites.get(target) === write) pendingAtomicWrites.delete(target);
  }
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
