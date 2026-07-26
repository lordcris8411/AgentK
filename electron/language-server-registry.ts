import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { LanguageServerHost, type LanguageServerPluginManifest } from "./language-server-host.js";

const MANIFEST_FILE = "agent-k.language-server.json";

type DiskManifest = {
  apiVersion?: unknown;
  debugServer?: unknown;
  displayName?: unknown;
  editorContribution?: unknown;
  id?: unknown;
  languages?: unknown;
  projectMarkers?: unknown;
  projectMenu?: unknown;
  skill?: unknown;
  commands?: unknown;
  worker?: unknown;
};

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0) ? value : undefined;
}
function commands(value: unknown): LanguageServerPluginManifest["commands"] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const parsed = value.flatMap((item) => item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" && typeof (item as { title?: unknown }).title === "string" && (item as { kind?: unknown }).kind === "project-manager"
    ? [{ id: (item as { id: string }).id, title: (item as { title: string }).title, kind: "project-manager" as const }]
    : []);
  return parsed.length === value.length ? parsed : undefined;
}

function isInside(root: string, candidate: string): boolean {
  const relative = candidate.slice(root.length);
  return candidate === root || (candidate.startsWith(root) && (relative.startsWith(sep) || relative.startsWith("/")));
}

function parseDebugServer(value: unknown): LanguageServerPluginManifest["debugServer"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as { adapters?: unknown; protocol?: unknown };
  if (input.protocol !== "dap" || !Array.isArray(input.adapters)) return undefined;
  const adapters = input.adapters.flatMap((adapter) => {
    if (!adapter || typeof adapter !== "object") return [];
    const candidate = adapter as { command?: unknown; platforms?: unknown };
    const platforms = strings(candidate.platforms);
    return typeof candidate.command === "string" && platforms ? [{ command: candidate.command, platforms: platforms as NodeJS.Platform[] }] : [];
  });
  return adapters.length === input.adapters.length ? { adapters, protocol: "dap" } : undefined;
}
function editorContribution(value: unknown): LanguageServerPluginManifest["editorContribution"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  return typeof input.id === "string" && typeof input.name === "string" && typeof input.description === "string" && typeof input.version === "string" && /^\d+\.\d+\.\d+$/.test(input.version) && typeof input.editorPluginId === "string"
    ? { id: input.id, name: input.name, description: input.description, version: input.version, editorPluginId: input.editorPluginId }
    : undefined;
}
function skill(value: unknown): LanguageServerPluginManifest["skill"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  return typeof input.name === "string" && typeof input.markdown === "string" && input.markdown.length <= 256 * 1024
    ? { name: input.name, markdown: input.markdown } : undefined;
}
function projectMenu(value: unknown): LanguageServerPluginManifest["projectMenu"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  return typeof input.loadLabel === "string" && typeof input.unloadLabel === "string" && input.loadLabel.trim() && input.unloadLabel.trim()
    ? { loadLabel: input.loadLabel.trim(), unloadLabel: input.unloadLabel.trim() } : undefined;
}

/**
 * Discovers trusted native-language plugin packages. They are intentionally
 * loaded only from the application data directory, never from an opened
 * project, because a worker has Node/process privileges.
 */
export async function discoverLanguageServerPlugins(directory: string): Promise<LanguageServerPluginManifest[]> {
  if (!existsSync(directory)) return [];
  const results: LanguageServerPluginManifest[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginDirectory = resolve(directory, entry.name);
    const manifestPath = join(pluginDirectory, MANIFEST_FILE);
    if (!existsSync(manifestPath)) continue;
    let input: DiskManifest;
    try { input = JSON.parse(await readFile(manifestPath, "utf8")) as DiskManifest; } catch { continue; }
    const languages = strings(input.languages); const projectMarkers = strings(input.projectMarkers); const pluginCommands = commands(input.commands); const contribution = editorContribution(input.editorContribution); const pluginSkill = skill(input.skill); const menu = projectMenu(input.projectMenu);
    if (input.apiVersion !== 1 || typeof input.id !== "string" || !/^[a-z0-9][a-z0-9.-]*$/i.test(input.id) || typeof input.displayName !== "string" || !input.displayName.trim() || !languages || !projectMarkers || typeof input.worker !== "string" || extname(input.worker) !== ".js") continue;
    const worker = resolve(dirname(manifestPath), input.worker);
    if (!isInside(pluginDirectory, worker) || !existsSync(worker)) continue;
    const debugServer = parseDebugServer(input.debugServer);
    if (input.debugServer !== undefined && !debugServer) continue;
    if ((input.commands !== undefined && !pluginCommands) || (input.editorContribution !== undefined && !contribution) || (input.skill !== undefined && !pluginSkill) || (input.projectMenu !== undefined && !menu)) continue;
    results.push({ apiVersion: 1, displayName: input.displayName.trim(), id: input.id, languages, projectMarkers, worker: pathToFileURL(worker), ...(menu ? { projectMenu: menu } : {}), ...(contribution ? { editorContribution: contribution } : {}), ...(pluginSkill ? { skill: pluginSkill } : {}), ...(pluginCommands ? { commands: pluginCommands } : {}), ...(debugServer ? { debugServer } : {}) });
  }
  return results;
}

/** Plugin registry: discovery, uniqueness and generic worker routing. */
export class LanguageServerRegistry {
  private readonly hosts = new Map<string, LanguageServerHost>();
  private readonly disabled = new Set<string>();

  constructor(
    private readonly builtins: readonly LanguageServerPluginManifest[],
    private readonly pluginDirectory: string,
    private readonly cachePath: string,
    private readonly emit: (event: Record<string, unknown>) => void,
  ) {}

  async initialize(): Promise<void> {
    const installed = await discoverLanguageServerPlugins(this.pluginDirectory);
    for (const manifest of [...this.builtins, ...installed]) {
      if (this.hosts.has(manifest.id)) {
        this.emit({ type: "language_server_plugin_error", id: manifest.id, error: "Duplicate language-server plugin id" });
        continue;
      }
      this.hosts.set(manifest.id, new LanguageServerHost(manifest, join(this.cachePath, "language-servers", manifest.id), this.emit));
    }
  }

  /** Re-scan trusted packages. Existing workers are deliberately stopped so a
   * newly installed worker or manifest is never mixed with an old process. */
  async reload(): Promise<void> {
    this.shutdown();
    await this.initialize();
  }

  list(): Array<Omit<LanguageServerPluginManifest, "worker"> & { enabled: boolean }> {
    return [...this.hosts.values()].map(({ manifest }) => {
      const { worker: _worker, ...publicManifest } = manifest;
      return { ...publicManifest, enabled: !this.disabled.has(manifest.id) };
    });
  }

  /** Enumerate projects owned by every installed worker in a common envelope. */
  async listProjects(): Promise<Array<Record<string, unknown>>> {
    const projects = await Promise.all([...this.hosts.entries()].map(async ([languageServerId, host]) => {
      if (this.disabled.has(languageServerId)) return [];
      const result = await host.call<unknown>("list").catch((cause) => {
        this.emit({ type: "language_server_plugin_error", id: languageServerId, error: cause instanceof Error ? cause.message : String(cause) });
        return [];
      });
      if (!Array.isArray(result)) return [];
      return result.flatMap((project) => project && typeof project === "object"
        ? [{ ...(project as Record<string, unknown>), languageServerId, languageServerName: host.manifest.displayName }]
        : []);
    }));
    return projects.flat();
  }

  call<T>(id: string, method: string, ...args: unknown[]): Promise<T> {
    if (this.disabled.has(id)) return Promise.reject(new Error(`Language-server plugin '${id}' is disabled`));
    const host = this.hosts.get(id);
    if (!host) return Promise.reject(new Error(`Language-server plugin '${id}' is not installed`));
    return host.call<T>(method, ...args);
  }

  callForLanguage<T>(language: string, method: string, ...args: unknown[]): Promise<T> {
    const normalized = language.toLowerCase();
    const match = [...this.hosts.values()].find((host) => !this.disabled.has(host.manifest.id) && host.manifest.languages.some((item) => item.toLowerCase() === normalized));
    if (!match) return Promise.reject(new Error(`No language-server plugin supports '${language}'`));
    return match.call<T>(method, ...args);
  }

  setEnabled(id: string, enabled: boolean): void {
    const host = this.hosts.get(id);
    if (!host) throw new Error(`Language-server plugin '${id}' is not installed`);
    if (enabled) { this.disabled.delete(id); return; }
    this.disabled.add(id);
    host.shutdown();
    this.emit({ type: "language_server_plugin_disabled", languageServerId: id });
  }

  shutdown(): void { for (const host of this.hosts.values()) host.shutdown(); this.hosts.clear(); }
}
