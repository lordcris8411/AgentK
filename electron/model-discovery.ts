import { asArray, asObject, asString } from "./utils.js";
import type { ModelReasoningProfile, ThinkingLevelMap } from "./model-reasoning.js";

export interface ProviderModelDraft {
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
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
    const declaredInput = asArray(model.input ?? model.modalities).flatMap((item) => {
      if (item === "text") return ["text" as const];
      return item === "image" || item === "images" || item === "vision" ? ["image" as const] : [];
    });
    const capabilities = asObject(model.capabilities);
    const capabilityNames = asArray(model.capabilities).map((item) => String(item).toLowerCase());
    const vision = capabilities.vision === true || capabilities.image === true || capabilities.multimodal === true
      || capabilityNames.some((item) => item === "vision" || item === "image" || item === "images" || item === "multimodal");
    const input: Array<"text" | "image"> = declaredInput.length
      ? [...new Set(["text" as const, ...declaredInput])]
      : vision ? ["text", "image"] : ["text"];
    return [{ id, input, ...(contextWindow === undefined ? {} : { contextWindow }) }];
  });
}

export async function enrichOllamaModelCapabilities(
  base: URL,
  models: ProviderModelDraft[],
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderModelDraft[]> {
  return Promise.all(models.map(async (model) => {
    try {
      const response = await fetchImpl(new URL("/api/show", base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: model.id, verbose: false }),
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return model;
      const capabilities = asArray(asObject(await response.json()).capabilities)
        .map((item) => String(item).toLowerCase());
      if (!capabilities.includes("vision")) return model;
      return { ...model, input: ["text", "image"] as Array<"text" | "image"> };
    } catch {
      return model;
    }
  }));
}
