import { asArray, asObject, asString } from "./utils.js";
import type { ModelReasoningProfile, ThinkingLevelMap } from "./model-reasoning.js";

export interface ProviderModelDraft {
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  assessment?: ModelReasoningProfile["assessment"];
}

/**
 * Builds the OpenAI-compatible model endpoint without treating a path such as
 * `/v1` as a filename. `new URL("models", "…/v1")` otherwise drops `/v1`.
 */
export function localModelsEndpoint(baseUrl: string): URL {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol))
    throw new Error("Only HTTP(S) model services are supported");
  const path = base.pathname.replace(/\/+$/, "");
  base.pathname = path.endsWith("/v1") ? `${path}/` : `${path}/v1/`;
  base.search = "";
  base.hash = "";
  return new URL("models", base);
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

export function discoveredModels(value: unknown): ProviderModelDraft[] {
  return asArray(asObject(value).data).flatMap((item) => {
    const model = asObject(item);
    const id = asString(model.id);
    if (!id) return [];
    const contextWindow = positiveInteger(
      model.max_model_len ?? model.max_context_length ?? model.context_window ?? model.contextWindow,
    );
    return [{ id, ...(contextWindow === undefined ? {} : { contextWindow }) }];
  });
}
