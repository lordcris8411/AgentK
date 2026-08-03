import type { JsonObject } from "./types.js";
import { asArray, asObject, asString } from "./utils.js";

export function configuredProviderModels(
  existingProvider: unknown,
  models: Array<{ contextWindow?: number; id: string; name?: string; reasoning?: boolean }>,
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
      reasoning: typeof value.reasoning === "boolean"
        ? value.reasoning
        : typeof existing.reasoning === "boolean" ? existing.reasoning : true,
    };
  });
}
