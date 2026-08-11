import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  LanguagePackHost,
  type LanguagePackAction,
  type LanguagePackManifest,
  type WorkspaceFileChange,
} from "./language-pack-host.js";
import { preparePluginSource } from "./plugin-archive.js";

export const LANGUAGE_PACK_MANIFEST = "agent-k.language-pack.json";
const ACTIVE_RECEIPT = "active.json";

type DiskManifest = Record<string, unknown>;

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim().length > 0)
    ? value.map((item) => (item as string).trim()) : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !child.startsWith(sep) && !resolve(candidate).startsWith(`..${sep}`));
}

function semanticVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value);
}

function compareVersions(left: string, right: string): number {
  const numeric = (value: string) => value.split("-", 1)[0]!.split(".").map(Number);
  const a = numeric(left); const b = numeric(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return left.includes("-") === right.includes("-") ? left.localeCompare(right) : left.includes("-") ? -1 : 1;
}

function parseActions(value: unknown): LanguagePackAction[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const actions = value.flatMap((item) => {
    const input = object(item);
    const parameters = object(input?.parameters);
    return input && typeof input.id === "string" && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u.test(input.id)
      && typeof input.method === "string" && /^[A-Za-z][A-Za-z0-9]*$/u.test(input.method)
      && typeof input.description === "string" && input.description.trim() && parameters?.type === "object"
      ? [{ id: input.id, method: input.method, description: input.description.trim(), parameters }]
      : [];
  });
  return actions.length === value.length && new Set(actions.map(({ id }) => id)).size === actions.length ? actions : undefined;
}

function parseSkills(value: unknown): LanguagePackManifest["skills"] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const skills = value.flatMap((item) => {
    const input = object(item);
    const frontmatter = typeof input?.markdown === "string" ? /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(input.markdown)?.[1] : undefined;
    const declaredName = frontmatter ? /^name:\s*([^\r\n]+)$/mu.exec(frontmatter)?.[1]?.trim() : undefined;
    const description = frontmatter ? /^description:\s*([^\r\n]+)$/mu.exec(frontmatter)?.[1]?.trim() : undefined;
    return input && typeof input.name === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.name)
      && typeof input.markdown === "string" && input.markdown.length > 0 && input.markdown.length <= 256 * 1024
      && declaredName === input.name && Boolean(description)
      ? [{ name: input.name, markdown: input.markdown }] : [];
  });
  return skills.length === value.length && new Set(skills.map(({ name }) => name)).size === skills.length ? skills : undefined;
}

function parsePermissions(value: unknown): LanguagePackManifest["permissions"] | undefined {
  const input = object(value); const externalTools = strings(input?.externalTools);
  return input && externalTools && typeof input.network === "boolean" && typeof input.processes === "boolean" && typeof input.workspaceWrite === "boolean"
    ? { externalTools, network: input.network, processes: input.processes, workspaceWrite: input.workspaceWrite } : undefined;
}

function parseToolchains(value: unknown): LanguagePackManifest["toolchains"] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const toolchains = value.flatMap((item) => {
    const input = object(item); const system = object(input?.system); const fallback = object(input?.fallback);
    const commands = strings(system?.commands);
    const parsedSystem = system && commands && typeof system.versionRange === "string" && system.versionRange.trim()
      ? { commands, versionRange: system.versionRange.trim() } : undefined;
    let parsedFallback: LanguagePackManifest["toolchains"][number]["fallback"];
    if (fallback && typeof fallback.version === "string" && fallback.version.trim()) {
      const platformsInput = object(fallback.platforms); const platforms: NonNullable<typeof parsedFallback>["platforms"] = {};
      for (const platform of ["win32", "linux", "darwin"] as const) {
        const candidate = object(platformsInput?.[platform]);
        if (!candidate) continue;
        const digest = typeof candidate.sha256 === "string" && /^[a-f0-9]{64}$/iu.test(candidate.sha256) ? { sha256: candidate.sha256.toLowerCase() }
          : typeof candidate.sha512 === "string" && /^[a-f0-9]{128}$/iu.test(candidate.sha512) ? { sha512: candidate.sha512.toLowerCase() } : undefined;
        if (typeof candidate.url !== "string" || !/^https:\/\//u.test(candidate.url) || !digest) return [];
        platforms[platform] = { url: candidate.url, ...digest };
      }
      if (!Object.keys(platforms).length) return [];
      parsedFallback = { version: fallback.version.trim(), platforms };
    }
    return input && typeof input.id === "string" && /^[a-z0-9][a-z0-9.-]*$/u.test(input.id) && (parsedSystem || parsedFallback)
      ? [{ id: input.id, ...(parsedSystem ? { system: parsedSystem } : {}), ...(parsedFallback ? { fallback: parsedFallback } : {}) }] : [];
  });
  return toolchains.length === value.length && new Set(toolchains.map(({ id }) => id)).size === toolchains.length ? toolchains : undefined;
}

function commands(value: unknown): LanguagePackManifest["commands"] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const parsed = value.flatMap((item) => {
    const input = object(item);
    return input && typeof input.id === "string" && typeof input.title === "string" && input.kind === "project-manager"
      ? [{ id: input.id, title: input.title, kind: "project-manager" as const }] : [];
  });
  return parsed.length === value.length ? parsed : undefined;
}

function editorContribution(value: unknown): LanguagePackManifest["editorContribution"] | undefined {
  if (value === undefined) return undefined;
  const input = object(value);
  return input && typeof input.id === "string" && typeof input.name === "string" && typeof input.description === "string"
    && typeof input.version === "string" && /^\d+\.\d+\.\d+$/u.test(input.version) && typeof input.editorPluginId === "string"
    ? { id: input.id, name: input.name, description: input.description, version: input.version, editorPluginId: input.editorPluginId } : undefined;
}

function projectMenu(value: unknown): LanguagePackManifest["projectMenu"] | undefined {
  if (value === undefined) return undefined;
  const input = object(value);
  if (!(input && typeof input.loadLabel === "string" && typeof input.unloadLabel === "string")) return undefined;
  const rawActions = input.actions;
  const actions = rawActions === undefined ? undefined : Array.isArray(rawActions) ? rawActions.flatMap((item) => {
    const action = object(item); if (!action || typeof action.id !== "string" || typeof action.label !== "string" || typeof action.method !== "string") return [];
    const rawProfiles = action.profiles;
    const profiles = rawProfiles === undefined ? undefined : Array.isArray(rawProfiles) ? rawProfiles.flatMap((profile) => {
      const value = object(profile); return value && typeof value.id === "string" && typeof value.label === "string" ? [{ id: value.id, label: value.label }] : [];
    }) : undefined;
    if (rawProfiles !== undefined && (!Array.isArray(rawProfiles) || !profiles || profiles.length !== rawProfiles.length)) return [];
    if (action.defaultProfile !== undefined && (typeof action.defaultProfile !== "string" || !profiles?.some(({ id }) => id === action.defaultProfile))) return [];
    return [{ id: action.id, label: action.label, method: action.method, ...(profiles ? { profiles } : {}), ...(typeof action.defaultProfile === "string" ? { defaultProfile: action.defaultProfile } : {}) }];
  }) : undefined;
  return rawActions !== undefined && (!actions || actions.length !== (rawActions as unknown[]).length) ? undefined
    : { loadLabel: input.loadLabel, unloadLabel: input.unloadLabel, ...(actions ? { actions } : {}) };
}

function parseDebugServer(value: unknown): LanguagePackManifest["debugServer"] | undefined {
  if (value === undefined) return undefined;
  const input = object(value); if (!input || input.protocol !== "dap" || !Array.isArray(input.adapters) || !Array.isArray(input.providers)) return undefined;
  const adapters = input.adapters.flatMap((item) => { const adapter = object(item); const platforms = strings(adapter?.platforms); return adapter && typeof adapter.command === "string" && platforms ? [{ command: adapter.command, platforms: platforms as NodeJS.Platform[] }] : []; });
  const providers = input.providers.flatMap((item) => {
    const provider = object(item); const fileExtensions = strings(provider?.fileExtensions); const languages = strings(provider?.languages); const projectMarkers = strings(provider?.projectMarkers);
    const modes = Array.isArray(provider?.modes) && provider.modes.every((mode) => mode === "launch" || mode === "attach" || mode === "dump") ? provider.modes as Array<"attach" | "dump" | "launch"> : undefined;
    return provider && typeof provider.id === "string" && typeof provider.label === "string" && fileExtensions && languages && projectMarkers && modes && typeof provider.priority === "number"
      ? [{ id: provider.id, label: provider.label, fileExtensions, languages, projectMarkers, modes, priority: provider.priority }] : [];
  });
  const prepareMethod = typeof input.prepareMethod === "string" ? input.prepareMethod : undefined;
  return adapters.length === input.adapters.length && providers.length === input.providers.length && providers.length > 0
    ? { adapters, providers, protocol: "dap", ...(prepareMethod ? { prepareMethod } : {}) } : undefined;
}

export async function validateLanguagePackDirectory(directory: string): Promise<LanguagePackManifest> {
  const packDirectory = resolve(directory); const manifestPath = join(packDirectory, LANGUAGE_PACK_MANIFEST);
  const input = JSON.parse(await readFile(manifestPath, "utf8")) as DiskManifest;
  const languages = strings(input.languages); const fileExtensions = strings(input.fileExtensions); const projectMarkers = strings(input.projectMarkers);
  const platforms = strings(input.platforms); const actions = parseActions(input.actions); const skills = parseSkills(input.skills);
  const permissions = parsePermissions(input.permissions); const toolchains = parseToolchains(input.toolchains);
  const pluginCommands = commands(input.commands); const contribution = editorContribution(input.editorContribution); const menu = projectMenu(input.projectMenu); const debugServer = parseDebugServer(input.debugServer);
  if (input.apiVersion !== 1 || input.kind !== "language-pack" || typeof input.id !== "string" || !/^[a-z0-9][a-z0-9.-]*$/u.test(input.id)
    || !semanticVersion(input.version) || typeof input.displayName !== "string" || !input.displayName.trim() || !languages || new Set(languages).size !== languages.length
    || !fileExtensions || !fileExtensions.every((value) => /^\.[A-Za-z0-9.+_-]+$/u.test(value))
    || !projectMarkers || !projectMarkers.every((value) => !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..") || !platforms
    || !platforms.every((value) => value === "win32" || value === "linux" || value === "darwin") || !actions || !skills || !permissions || !toolchains
    || typeof input.worker !== "string" || extname(input.worker) !== ".js" || !contribution) throw new Error("Invalid Agent K Language Pack manifest");
  if (input.commands !== undefined && !pluginCommands || input.editorContribution !== undefined && !contribution || input.projectMenu !== undefined && !menu || input.debugServer !== undefined && !debugServer)
    throw new Error("Invalid optional Language Pack contribution");
  if (toolchains.some((toolchain) => !permissions.externalTools.includes(toolchain.id) && !toolchain.system?.commands.some((command) => permissions.externalTools.includes(command))))
    throw new Error("Language Pack toolchain is missing from externalTools permissions");
  if (!permissions.processes || toolchains.some((toolchain) => toolchain.fallback) && !permissions.network)
    throw new Error("Language Pack permissions do not cover its worker or fallback downloads");
  if (debugServer?.adapters.some(({ command }) => !permissions.externalTools.includes(command)))
    throw new Error("Language Pack debug adapter is missing from externalTools permissions");
  const worker = resolve(packDirectory, input.worker);
  if (!isInside(packDirectory, worker) || !existsSync(worker) || !isInside(await realpath(packDirectory), await realpath(worker)))
    throw new Error("Language Pack worker is missing or escapes the package");
  return { apiVersion: 1, kind: "language-pack", id: input.id, version: input.version, displayName: input.displayName.trim(), languages, fileExtensions, projectMarkers,
    platforms: platforms as NodeJS.Platform[], actions, skills, permissions, toolchains, worker: pathToFileURL(worker), ...(pluginCommands ? { commands: pluginCommands } : {}),
    ...(contribution ? { editorContribution: contribution } : {}), ...(menu ? { projectMenu: menu } : {}), ...(debugServer ? { debugServer } : {}) };
}

async function packDirectories(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const directories: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const direct = join(root, entry.name);
    if (existsSync(join(direct, LANGUAGE_PACK_MANIFEST))) { directories.push(direct); continue; }
    try {
      const receipt = JSON.parse(await readFile(join(direct, ACTIVE_RECEIPT), "utf8")) as { version?: unknown };
      if (typeof receipt.version === "string") directories.push(join(direct, receipt.version));
    } catch { /* Old language-server directories are deliberately incompatible. */ }
  }
  return directories;
}

export async function discoverLanguagePacks(directory: string): Promise<LanguagePackManifest[]> {
  const results: LanguagePackManifest[] = [];
  for (const candidate of await packDirectories(directory)) {
    try { results.push(await validateLanguagePackDirectory(candidate)); } catch { /* Invalid packages are not executable. */ }
  }
  return results;
}

function validateActionArguments(schema: Record<string, unknown>, value: Record<string, unknown>, path = "arguments"): void {
  if (schema.type !== undefined && schema.type !== "object") throw new Error("Language Pack action root schema must have type 'object'");
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const name of required) if (typeof name !== "string" || !(name in value)) throw new Error(`${path}.${String(name)} is required`);
  const properties = object(schema.properties);
  if (!properties) return;
  for (const [name, propertySchema] of Object.entries(properties)) {
    if (!(name in value)) continue;
    const definition = object(propertySchema); const actual = value[name]; const expected = definition?.type;
    const matches = expected === undefined || expected === "string" && typeof actual === "string" || expected === "number" && typeof actual === "number"
      || expected === "integer" && Number.isInteger(actual) || expected === "boolean" && typeof actual === "boolean"
      || expected === "object" && Boolean(object(actual)) || expected === "array" && Array.isArray(actual);
    if (!matches) throw new Error(`${path}.${name} must be ${String(expected)}`);
  }
}

export class LanguagePackRegistry {
  private readonly hosts = new Map<string, LanguagePackHost>();
  private readonly disabled = new Set<string>();
  private readonly installApprovals = new Map<string, { id: string; source: string; version: string; expiresAt: number }>();

  constructor(private readonly firstPartyDirectory: string, private readonly installedDirectory: string, private readonly cachePath: string, private readonly emit: (event: Record<string, unknown>) => void) {}

  async initialize(): Promise<void> {
    const [bundled, installed] = await Promise.all([discoverLanguagePacks(this.firstPartyDirectory), discoverLanguagePacks(this.installedDirectory)]);
    const languageOwners = new Map<string, string>();
    for (const manifest of [...installed, ...bundled]) {
      if (!manifest.platforms.includes(process.platform)) { this.emit({ type: "language_pack_error", id: manifest.id, error: `Unsupported platform: ${process.platform}` }); continue; }
      if (this.hosts.has(manifest.id)) { this.emit({ type: "language_pack_error", id: manifest.id, error: "Duplicate Language Pack id" }); continue; }
      const conflict = manifest.languages.find((language) => languageOwners.has(language.toLowerCase()));
      if (conflict) { this.emit({ type: "language_pack_error", id: manifest.id, error: `Language id '${conflict}' is already owned by '${languageOwners.get(conflict.toLowerCase())}'` }); continue; }
      const host = new LanguagePackHost(manifest, join(this.cachePath, "language-packs", manifest.id), this.emit);
      await host.prepareToolchains(); this.hosts.set(manifest.id, host);
      for (const language of manifest.languages) languageOwners.set(language.toLowerCase(), manifest.id);
    }
  }

  async reload(): Promise<void> { await this.shutdown(); await this.initialize(); this.emit({ type: "language_pack_registry_reloaded" }); }

  async preview(sourceDirectory: string): Promise<Omit<LanguagePackManifest, "worker"> & { approvalToken: string }> {
    const prepared = await preparePluginSource(sourceDirectory, LANGUAGE_PACK_MANIFEST);
    try {
      const candidate = await validateLanguagePackDirectory(prepared.source);
      const { worker: _worker, ...publicManifest } = candidate;
      const approvalToken = randomUUID();
      this.installApprovals.set(approvalToken, { id: candidate.id, source: resolve(sourceDirectory), version: candidate.version, expiresAt: Date.now() + 10 * 60_000 });
      return { ...publicManifest, approvalToken };
    } finally { await prepared.cleanup(); }
  }

  async install(sourceDirectory: string, approvalToken: string): Promise<Omit<LanguagePackManifest, "worker"> & { enabled: boolean }> {
    const prepared = await preparePluginSource(sourceDirectory, LANGUAGE_PACK_MANIFEST);
    const staging = join(this.installedDirectory, `.staging-${randomUUID()}`);
    try {
      const candidate = await validateLanguagePackDirectory(prepared.source);
      const approval = this.installApprovals.get(approvalToken); this.installApprovals.delete(approvalToken);
      if (!approval || approval.expiresAt < Date.now() || approval.source !== resolve(sourceDirectory) || approval.id !== candidate.id || approval.version !== candidate.version)
        throw new Error("Language Pack installation requires a current user-approved preview");
      if (!candidate.platforms.includes(process.platform)) throw new Error(`Language Pack '${candidate.id}' does not support ${process.platform}`);
      const existing = this.list().find(({ id }) => id === candidate.id);
      if (existing && compareVersions(candidate.version, existing.version) <= 0) throw new Error(`Language Pack ${candidate.id} must upgrade from ${existing.version}`);
      await mkdir(this.installedDirectory, { recursive: true }); await cp(prepared.source, staging, { recursive: true });
      const stagedManifest = await validateLanguagePackDirectory(staging);
      const coldHost = new LanguagePackHost(stagedManifest, join(this.cachePath, "language-packs", candidate.id, ".install-test"), () => undefined);
      try { await coldHost.call("list"); } finally { await coldHost.shutdown(); }
      const root = join(this.installedDirectory, candidate.id); const versionDirectory = join(root, candidate.version); const receipt = join(root, ACTIVE_RECEIPT);
      await mkdir(root, { recursive: true });
      let oldReceipt: string | undefined; try { oldReceipt = await readFile(receipt, "utf8"); } catch { /* First install. */ }
      await this.shutdown(); await rename(staging, versionDirectory);
      const nextReceipt = join(root, `.active-${randomUUID()}.json`); await writeFile(nextReceipt, `${JSON.stringify({ id: candidate.id, version: candidate.version, installedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
      await rm(receipt, { force: true }); await rename(nextReceipt, receipt);
      try { await this.initialize(); }
      catch (cause) {
        await this.shutdown(); await rm(receipt, { force: true });
        if (oldReceipt) await writeFile(receipt, oldReceipt, "utf8");
        await rm(versionDirectory, { recursive: true, force: true }); await this.initialize(); throw cause;
      }
      const installed = this.list().find(({ id }) => id === candidate.id); if (!installed) throw new Error("Installed Language Pack was not discovered");
      this.emit({ type: "language_pack_installed", id: candidate.id, version: candidate.version }); return installed;
    } finally { await rm(staging, { recursive: true, force: true }); await prepared.cleanup(); }
  }

  async uninstall(id: string): Promise<void> {
    const root = join(this.installedDirectory, id); if (!isInside(this.installedDirectory, root)) throw new Error("Invalid Language Pack id");
    if (!existsSync(join(root, ACTIVE_RECEIPT))) throw new Error(`Language Pack '${id}' is bundled and cannot be uninstalled`);
    await this.hosts.get(id)?.shutdown(); this.hosts.delete(id); this.disabled.delete(id); await rm(root, { recursive: true, force: true });
    await this.reload();
    this.emit({ type: "language_pack_uninstalled", id });
  }

  list(): Array<Omit<LanguagePackManifest, "worker"> & { enabled: boolean; toolchainSources: Array<{ command?: string; id: string; source: "private" | "system"; version: string }> }> {
    return [...this.hosts.values()].map((host) => { const { manifest } = host; const { worker: _worker, ...publicManifest } = manifest; return { ...publicManifest, enabled: !this.disabled.has(manifest.id), toolchainSources: host.toolchainSources() }; });
  }

  async listProjects(): Promise<Array<Record<string, unknown>>> {
    const projects = await Promise.all([...this.hosts.entries()].map(async ([packId, host]) => this.disabled.has(packId) ? [] : host.call<unknown>("list").then((value) => Array.isArray(value)
      ? value.flatMap((project) => project && typeof project === "object" ? [{ ...(project as Record<string, unknown>), packId, packName: host.manifest.displayName }] : []) : [])
      .catch((cause) => { this.emit({ type: "language_pack_error", id: packId, error: cause instanceof Error ? cause.message : String(cause) }); return []; })));
    return projects.flat();
  }

  call<T>(id: string, method: string, ...args: unknown[]): Promise<T> {
    if (this.disabled.has(id)) return Promise.reject(new Error(`Language Pack '${id}' is disabled`));
    const host = this.hosts.get(id); if (!host) return Promise.reject(new Error(`Language Pack '${id}' is not installed`)); return host.call<T>(method, ...args);
  }

  invoke<T>(packId: string, actionId: string, arguments_: Record<string, unknown>): Promise<T> {
    const host = this.hosts.get(packId); if (!host || this.disabled.has(packId)) return Promise.reject(new Error(`Language Pack '${packId}' is unavailable`));
    const action = host.manifest.actions.find(({ id }) => id === actionId); if (!action) return Promise.reject(new Error(`Language Pack '${packId}' does not declare '${actionId}'`));
    validateActionArguments(action.parameters, arguments_);
    return host.call<T>(action.method, { ...arguments_, action: actionId });
  }

  async skillDirectories(): Promise<Array<{ directory: string; id: string }>> {
    const root = join(this.cachePath, "language-pack-skills");
    await rm(root, { recursive: true, force: true });
    const results: Array<{ directory: string; id: string }> = [];
    for (const [packId, host] of this.hosts) {
      if (this.disabled.has(packId)) continue;
      for (const skill of host.manifest.skills) {
        const directory = join(root, packId, skill.name);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "SKILL.md"), skill.markdown, "utf8");
        results.push({ directory, id: packId });
      }
    }
    return results;
  }

  callForLanguage<T>(language: string, method: string, ...args: unknown[]): Promise<T> {
    const host = [...this.hosts.values()].find((candidate) => !this.disabled.has(candidate.manifest.id) && candidate.manifest.languages.some((item) => item.toLowerCase() === language.toLowerCase()));
    return host ? host.call<T>(method, ...args) : Promise.reject(new Error(`No enabled Language Pack supports '${language}'`));
  }

  workspaceFilesChanged(changes: WorkspaceFileChange[]): void { if (changes.length) for (const [id, host] of this.hosts) if (!this.disabled.has(id)) host.workspaceFilesChanged(changes); }
  async setEnabled(id: string, enabled: boolean): Promise<void> { const host = this.hosts.get(id); if (!host) throw new Error(`Language Pack '${id}' is not installed`); if (enabled) this.disabled.delete(id); else { this.disabled.add(id); await host.shutdown(); } this.emit({ type: enabled ? "language_pack_enabled" : "language_pack_disabled", id }); }
  async shutdown(): Promise<void> { await Promise.all([...this.hosts.values()].map((host) => host.shutdown())); this.hosts.clear(); }
}
