import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isPathInside } from "./utils.js";

export async function canonicalWorkspaceRoot(root: string): Promise<string> {
  const path = await realpath(root);
  if (!(await stat(path)).isDirectory()) throw new Error("Project root is not a directory");
  return path;
}

export async function confinedWorkspacePath(rootInput: string, requested: string): Promise<string> {
  const root = await canonicalWorkspaceRoot(rootInput);
  const candidate = isAbsolute(requested) ? requested : join(root, requested);
  const parent = await realpath(dirname(candidate));
  const normalized = join(parent, basename(candidate));
  if (!isPathInside(root, normalized)) throw new Error("Path is outside the active project");
  try {
    const existing = await realpath(normalized);
    if (!isPathInside(root, existing)) throw new Error("Path resolves outside the active project");
    return existing;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    return normalized;
  }
}
