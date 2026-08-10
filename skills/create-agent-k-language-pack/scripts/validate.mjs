import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function validatePack(input) {
  const root = resolve(input); const path = resolve(root, "agent-k.language-pack.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const strings = (value) => Array.isArray(value) && value.length && value.every((item) => typeof item === "string" && item.trim());
  if (manifest.apiVersion !== 1 || manifest.kind !== "language-pack" || !/^[a-z0-9][a-z0-9.-]*$/.test(manifest.id ?? "") || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) throw new Error("Invalid Language Pack identity");
  for (const field of ["platforms", "languages", "fileExtensions", "projectMarkers", "skills", "actions", "toolchains"]) if (!Array.isArray(manifest[field]) || !manifest[field].length) throw new Error(`${field} must be a non-empty array`);
  if (!strings(manifest.languages) || !strings(manifest.fileExtensions) || !manifest.fileExtensions.every((value) => /^\.[A-Za-z0-9.+_-]+$/.test(value))) throw new Error("Invalid language or extension list");
  if (!manifest.permissions || typeof manifest.permissions.network !== "boolean" || typeof manifest.permissions.processes !== "boolean" || typeof manifest.permissions.workspaceWrite !== "boolean" || !strings(manifest.permissions.externalTools)) throw new Error("Explicit permissions are required");
  const actionIds = manifest.actions.map((item) => item?.id); if (new Set(actionIds).size !== actionIds.length || manifest.actions.some((item) => !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/.test(item?.id ?? "") || !/^[A-Za-z][A-Za-z0-9]*$/.test(item?.method ?? "") || typeof item?.description !== "string" || !item.description.trim() || item?.parameters?.type !== "object")) throw new Error("Actions must use lowercase dot/kebab IDs, valid worker methods, descriptions, and unique object schemas");
  const languageIds = manifest.languages.map((value) => value.toLowerCase()); if (new Set(languageIds).size !== languageIds.length) throw new Error("Duplicate language ID");
  if (manifest.skills.some((item) => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item?.name ?? "") || typeof item?.markdown !== "string" || !item.markdown.includes("description:"))) throw new Error("Every pack requires a valid embedded Skill");
  const invalidToolchain = manifest.toolchains.some((item) => {
    if (!item?.id || !item.system && !item.fallback) return true;
    if (item.system && (!strings(item.system.commands) || !item.system.versionRange)) return true;
    if (!item.fallback) return false;
    const platforms = Object.values(item.fallback.platforms ?? {});
    return !item.fallback.version || !platforms.length || platforms.some((platform) =>
      typeof platform?.url !== "string" || !/^https:\/\//.test(platform.url)
      || !(/^[a-f0-9]{64}$/i.test(platform.sha256 ?? "") || /^[a-f0-9]{128}$/i.test(platform.sha512 ?? "")));
  });
  if (invalidToolchain) throw new Error("Every toolchain requires a versioned system rule or pinned HTTPS fallback with a platform digest");
  if (!manifest.editorContribution || !/^\d+\.\d+\.\d+$/.test(manifest.editorContribution.version ?? "") || typeof manifest.editorContribution.id !== "string" || typeof manifest.editorContribution.name !== "string" || typeof manifest.editorContribution.description !== "string" || typeof manifest.editorContribution.editorPluginId !== "string") throw new Error("A valid core or sandbox Editor contribution is required");
  const worker = resolve(root, manifest.worker ?? ""); const child = relative(root, worker); if (!manifest.worker?.endsWith(".js") || isAbsolute(child) || child === ".." || child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || !existsSync(worker)) throw new Error("Worker is missing or escapes the pack");
  return { root, manifest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = await validatePack(process.argv[2] ?? "."); console.log(JSON.stringify({ ok: true, id: result.manifest.id, version: result.manifest.version }, null, 2));
}
