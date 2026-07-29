import type { LanguageServerPlugin } from "../../lib/desktop";

export type DebugProvider = {
  fileExtensions: string[];
  id: string;
  label: string;
  languageServerId: string;
  languages: string[];
  modes: Array<"attach" | "dump" | "launch">;
  priority: number;
  projectMarkers: string[];
};

export function debugProviders(plugins: LanguageServerPlugin[]): DebugProvider[] {
  return plugins.flatMap((plugin) => plugin.enabled === false ? [] : (plugin.debugServer?.providers ?? []).map((provider) => ({
    ...provider,
    languageServerId: plugin.id,
  }))).sort((left, right) => right.priority - left.priority || left.label.localeCompare(right.label));
}

export function rankDebugProviders(providers: DebugProvider[], contextFile?: string, preferred?: string): DebugProvider[] {
  const extension = /(?:^|[/\\])[^/\\]*(\.[^./\\]+)$/u.exec(contextFile ?? "")?.[1]?.toLowerCase();
  return [...providers].sort((left, right) => {
    const identity = (provider: DebugProvider) => `${provider.languageServerId}:${provider.id}`;
    const score = (provider: DebugProvider) =>
      (preferred === identity(provider) ? 1_000_000 : 0) +
      (extension && provider.fileExtensions.includes(extension) ? 100_000 : 0) + provider.priority;
    return score(right) - score(left) || left.label.localeCompare(right.label);
  });
}

export function debugProviderForFile(providers: DebugProvider[], file: string): DebugProvider | undefined {
  const extension = /(?:^|[/\\])[^/\\]*(\.[^./\\]+)$/u.exec(file)?.[1]?.toLowerCase();
  if (!extension) return undefined;
  return rankDebugProviders(providers.filter((provider) => provider.fileExtensions.includes(extension)), file)[0];
}

export function debugProviderIdentity(provider: Pick<DebugProvider, "id" | "languageServerId">): string {
  return `${provider.languageServerId}:${provider.id}`;
}
