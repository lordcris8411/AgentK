export type SkillPosition = { character: number; line: number };
export type SkillRange = { end: SkillPosition; start: SkillPosition };
export type SkillLocation = { range: SkillRange; uri: string };
export type SkillSymbol = {
  containerName?: string;
  kind?: number;
  location?: SkillLocation | { uri: string };
  name?: string;
  range?: SkillRange;
  selectionRange?: SkillRange;
  uri?: string;
};

const TYPE_SYMBOL_KINDS = new Set([5, 10, 11, 23, 26]);

export function symbolLocation(symbol: SkillSymbol): SkillLocation | undefined {
  if (symbol.location && "range" in symbol.location) return symbol.location;
  const uri = symbol.location?.uri ?? symbol.uri;
  const range = symbol.selectionRange ?? symbol.range;
  return typeof uri === "string" && range ? { range, uri } : undefined;
}

function qualifiedSymbolName(symbol: SkillSymbol): string {
  return symbol.containerName ? `${symbol.containerName}::${symbol.name ?? ""}` : symbol.name ?? "";
}

/** Exact matching keeps a fuzzy workspace/symbol result from silently routing
 * a semantic operation to a different identifier. */
export function selectWorkspaceSymbols(value: unknown, query: string, typesOnly = false): SkillSymbol[] {
  if (!Array.isArray(value)) return [];
  const symbols = value.filter((item): item is SkillSymbol => Boolean(item && typeof item === "object" && typeof (item as SkillSymbol).name === "string" && symbolLocation(item as SkillSymbol)));
  const eligible = typesOnly ? symbols.filter((item) => typeof item.kind === "number" && TYPE_SYMBOL_KINDS.has(item.kind)) : symbols;
  const exact = eligible.filter((item) => item.name === query || qualifiedSymbolName(item) === query);
  if (exact.length) return exact;
  const normalized = query.toLocaleLowerCase("en-US");
  return eligible.filter((item) => item.name?.toLocaleLowerCase("en-US") === normalized || qualifiedSymbolName(item).toLocaleLowerCase("en-US") === normalized);
}
