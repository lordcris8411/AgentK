import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import extractZip from "extract-zip";

type PreparedPluginSource = { cleanup(): Promise<void>; source: string };

async function packageRoot(directory: string, manifestFile: string): Promise<string> {
  if (existsSync(join(directory, manifestFile))) return directory;
  const entries = await readdir(directory, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && existsSync(join(directory, entry.name, manifestFile)))
    .map((entry) => join(directory, entry.name));
  if (candidates.length === 1) return candidates[0]!;
  throw new Error(`ZIP extension package must contain ${manifestFile} at its root or in one top-level folder`);
}

/** Resolves a directory package or safely extracts one ZIP package for installation. */
export async function preparePluginSource(sourcePath: string, manifestFile: string): Promise<PreparedPluginSource> {
  const selected = resolve(sourcePath);
  if ((await stat(selected)).isDirectory()) return { source: selected, cleanup: async () => {} };
  if (extname(selected).toLowerCase() !== ".zip") throw new Error("Select an extension directory or ZIP file");
  const temporary = await mkdtemp(join(tmpdir(), "agent-k-plugin-"));
  try {
    await extractZip(selected, { dir: temporary });
    return { source: await packageRoot(temporary, manifestFile), cleanup: () => rm(temporary, { force: true, recursive: true }) };
  } catch (cause) {
    await rm(temporary, { force: true, recursive: true });
    throw cause;
  }
}
