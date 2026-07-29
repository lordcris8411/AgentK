import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export type CMakeDebugTarget = {
  built: boolean;
  id: string;
  name: string;
  program: string;
};

const DEBUG_CONFIGURATION_DIRECTORY: Record<string, string> = {
  Debug: "d",
  MinSizeRel: "m",
  Release: "r",
  RelWithDebInfo: "i",
};

/**
 * CMake's compiler probes add several nested directories below the build
 * directory. Keep this path deliberately short so MSVC and projects that do
 * not enable Windows long paths can still create their temporary objects.
 */
export function cmakeDebugBuildDirectory(cachePath: string, root: string, toolchainMarker: string, configuration: string): string {
  const key = createHash("sha256").update(root).update("\0").update(toolchainMarker).digest("hex").slice(0, 16);
  return join(cachePath, "d", key, DEBUG_CONFIGURATION_DIRECTORY[configuration] ?? "d");
}

export function prioritizeCMakeProjectRoots(roots: string[], contextFile?: string): string[] {
  if (!contextFile) return [...roots];
  const ownsContext = (root: string): boolean => {
    const nested = relative(root, contextFile);
    return nested !== ".." && !isAbsolute(nested) && !nested.startsWith("../") && !nested.startsWith("..\\");
  };
  return [...roots].sort((left, right) => Number(ownsContext(right)) - Number(ownsContext(left)));
}

/** Finds top-level CMake projects when the workspace is only a container. */
export async function cmakeProjectRoots(workspace: string): Promise<string[]> {
  if (existsSync(join(workspace, "CMakeLists.txt"))) return [await realpath(workspace)];
  const ignored = new Set([".cache", ".git", ".hg", ".svn", "build", "node_modules", "out"]);
  const pending = [workspace];
  const roots: string[] = [];
  let cursor = 0;
  while (cursor < pending.length) {
    const directory = pending[cursor++]!;
    if (cursor > 20_000) throw new Error("CMake project search exceeded 20,000 folders");
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const normalized = entry.name.toLocaleLowerCase("en-US");
      if (ignored.has(normalized) || normalized.startsWith("cmake-build-")) continue;
      const candidate = join(directory, entry.name);
      if (existsSync(join(candidate, "CMakeLists.txt"))) roots.push(await realpath(candidate));
      else pending.push(candidate);
    }
  }
  return roots.sort((left, right) => relative(workspace, left).localeCompare(relative(workspace, right), "en-US"));
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function safeReplyFile(replyDirectory: string, value: unknown): string | undefined {
  if (typeof value !== "string" || !value.endsWith(".json")) return undefined;
  const path = resolve(replyDirectory, value);
  const nested = relative(replyDirectory, path);
  return !isAbsolute(nested) && nested !== ".." && !nested.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    ? path
    : undefined;
}

async function json(path: string): Promise<Record<string, unknown>> {
  return object(JSON.parse(await readFile(path, "utf8")) as unknown);
}

/** Reads executable artifacts from CMake's versioned File API codemodel. */
export async function cmakeDebugTargets(buildDirectory: string): Promise<CMakeDebugTarget[]> {
  const replyDirectory = join(buildDirectory, ".cmake", "api", "v1", "reply");
  if (!existsSync(replyDirectory)) return [];
  const indexName = (await readdir(replyDirectory))
    .filter((name) => /^index-.*\.json$/u.test(name))
    .sort((left, right) => right.localeCompare(left, "en-US"))[0];
  if (!indexName) return [];
  const index = await json(join(replyDirectory, indexName));
  const codemodelReply = object(object(index.reply)["codemodel-v2"]);
  const codemodelFile = safeReplyFile(replyDirectory, codemodelReply.jsonFile);
  if (!codemodelFile) return [];
  const codemodel = await json(codemodelFile);
  const configurations = Array.isArray(codemodel.configurations) ? codemodel.configurations : [];
  const results: CMakeDebugTarget[] = [];
  for (const configurationValue of configurations) {
    const configuration = object(configurationValue);
    const targets = Array.isArray(configuration.targets) ? configuration.targets : [];
    for (const targetReferenceValue of targets) {
      const reference = object(targetReferenceValue);
      const targetFile = safeReplyFile(replyDirectory, reference.jsonFile);
      if (!targetFile) continue;
      const target = await json(targetFile);
      if (target.type !== "EXECUTABLE") continue;
      const artifacts = Array.isArray(target.artifacts) ? target.artifacts : [];
      const artifact = artifacts.map(object).find((item) => typeof item.path === "string");
      const rawProgram = artifact?.path;
      const id = typeof reference.id === "string" ? reference.id : undefined;
      const name = typeof target.name === "string" ? target.name : typeof reference.name === "string" ? reference.name : undefined;
      if (!id || !name || typeof rawProgram !== "string") continue;
      const program = resolve(buildDirectory, rawProgram);
      const nested = relative(buildDirectory, program);
      if (isAbsolute(nested) || nested === ".." || nested.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) continue;
      results.push({ built: existsSync(program), id, name, program });
    }
  }
  return [...new Map(results.map((target) => [target.id, target])).values()]
    .sort((left, right) => left.name.localeCompare(right.name, "en-US"));
}
