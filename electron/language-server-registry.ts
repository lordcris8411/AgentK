import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { LanguageServerHost, type LanguageServerPluginManifest } from "./language-server-host.js";

const MANIFEST_FILE = "agent-k.language-server.json";

type DiskManifest = {
  apiVersion?: unknown;
  debugServer?: unknown;
  id?: unknown;
  languages?: unknown;
  projectMarkers?: unknown;
  worker?: unknown;
};

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0) ? value : undefined;
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
    const languages = strings(input.languages); const projectMarkers = strings(input.projectMarkers);
    if (input.apiVersion !== 1 || typeof input.id !== "string" || !/^[a-z0-9][a-z0-9.-]*$/i.test(input.id) || !languages || !projectMarkers || typeof input.worker !== "string" || extname(input.worker) !== ".js") continue;
    const worker = resolve(dirname(manifestPath), input.worker);
    if (!isInside(pluginDirectory, worker) || !existsSync(worker)) continue;
    const debugServer = parseDebugServer(input.debugServer);
    if (input.debugServer !== undefined && !debugServer) continue;
    results.push({ apiVersion: 1, id: input.id, languages, projectMarkers, worker: pathToFileURL(worker), ...(debugServer ? { debugServer } : {}) });
  }
  return results;
}

/** Plugin registry: discovery, uniqueness and generic worker routing. */
export class LanguageServerRegistry {
  private readonly hosts = new Map<string, LanguageServerHost>();

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

  list(): Array<Omit<LanguageServerPluginManifest, "worker">> {
    return [...this.hosts.values()].map(({ manifest }) => {
      const { worker: _worker, ...publicManifest } = manifest;
      return publicManifest;
    });
  }

  call<T>(id: string, method: string, ...args: unknown[]): Promise<T> {
    const host = this.hosts.get(id);
    if (!host) return Promise.reject(new Error(`Language-server plugin '${id}' is not installed`));
    return host.call<T>(method, ...args);
  }

  callForLanguage<T>(language: string, method: string, ...args: unknown[]): Promise<T> {
    const normalized = language.toLowerCase();
    const match = [...this.hosts.values()].find((host) => host.manifest.languages.some((item) => item.toLowerCase() === normalized));
    if (!match) return Promise.reject(new Error(`No language-server plugin supports '${language}'`));
    return match.call<T>(method, ...args);
  }

  shutdown(): void { for (const host of this.hosts.values()) host.shutdown(); this.hosts.clear(); }
}
