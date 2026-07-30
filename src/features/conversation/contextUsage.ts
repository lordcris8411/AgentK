export function contextTokens(message: Record<string, unknown>): number | undefined {
  const usage = message.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const value = usage as Record<string, unknown>;
  const total = Number(value.totalTokens);
  if (Number.isFinite(total) && total > 0) return total;
  const parts = [value.input, value.output, value.cacheRead, value.cacheWrite]
    .map(Number)
    .filter(Number.isFinite);
  const calculated = parts.reduce((sum, part) => sum + part, 0);
  return calculated > 0 ? calculated : undefined;
}

export function latestContextTokens(
  messages: Array<Record<string, unknown>>,
): number | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const tokens = contextTokens(message);
    if (tokens !== undefined) return tokens;
  }
  return undefined;
}
