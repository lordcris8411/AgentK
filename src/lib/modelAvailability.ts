import type { ClientSettings } from "./desktop";

type ModelAvailabilitySettings = Pick<
  ClientSettings,
  "disabledModelProviders" | "disabledModels"
>;

export function modelKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

export function modelIsEnabled(
  settings: ModelAvailabilitySettings,
  provider: string,
  modelId: string,
): boolean {
  return !settings.disabledModelProviders.includes(provider) &&
    !settings.disabledModels.includes(modelKey(provider, modelId));
}
