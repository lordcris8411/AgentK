import { asArray, asObject, asString } from "./utils.js";

export interface ProviderModelDraft {
  id: string;
  name?: string;
  contextWindow?: number;
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
