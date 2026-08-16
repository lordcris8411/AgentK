import type { JsonObject } from "./types.js";
import { asArray, asObject, asString } from "./utils.js";
import type { ThinkingLevelMap } from "./model-reasoning.js";

export function configuredProviderModels(
  existingProvider: unknown,
  models: Array<{ contextWindow?: number; id: string; name?: string; reasoning?: boolean; thinkingLevelMap?: ThinkingLevelMap }>,
): JsonObject[] {
  const existingModels = new Map(
    asArray(asObject(existingProvider).models)
      .map(asObject)
      .flatMap((model) => {
        const modelId = asString(model.id);
        return modelId ? [[modelId, model] as const] : [];
      }),
  );
  return models.map((value) => {
    const modelId = value.id.trim();
    const existing = existingModels.get(modelId) ?? {};
    const existingContextWindow = existing.contextWindow;
    return {
      ...existing,
      id: modelId,
      name: value.name?.trim() || asString(existing.name) || modelId,
      ...(value.contextWindow !== undefined
        ? { contextWindow: value.contextWindow }
        : typeof existingContextWindow === "number" ? { contextWindow: existingContextWindow } : {}),
      // A generic OpenAI-compatible `/models` response does not advertise
      // which reasoning-effort values a model accepts. Keep reasoning off
      // until the provider explicitly declares it, rather than exposing
      // unsupported levels and sending an invalid request.
      reasoning: typeof value.reasoning === "boolean"
        ? value.reasoning
        : typeof existing.reasoning === "boolean" ? existing.reasoning : false,
      ...(value.thinkingLevelMap ? { thinkingLevelMap: value.thinkingLevelMap } : {}),
    };
  });
}
