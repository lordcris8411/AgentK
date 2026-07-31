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
  let latestCompactionTimestamp: number | undefined;
  for (const message of messages) {
    if (message.role !== "compactionSummary") continue;
    const timestamp = messageTimestamp(message.timestamp);
    if (
      timestamp !== undefined &&
      (latestCompactionTimestamp === undefined ||
        timestamp > latestCompactionTimestamp)
    ) latestCompactionTimestamp = timestamp;
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    if (message.stopReason === "aborted" || message.stopReason === "error")
      continue;
    if (latestCompactionTimestamp !== undefined) {
      const timestamp = messageTimestamp(message.timestamp);
      // Messages retained after compaction keep their original provider usage.
      // That usage describes the larger pre-compaction request and must not be
      // restored as the current context size after a session reload.
      if (timestamp === undefined || timestamp <= latestCompactionTimestamp)
        continue;
    }
    const tokens = contextTokens(message);
    if (tokens !== undefined) return tokens;
  }
  return undefined;
}

function messageTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
