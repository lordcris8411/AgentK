export type SessionHistoryEntry = {
  id?: unknown;
  message?: unknown;
  parentId?: unknown;
  type?: unknown;
};

/** Reconstruct the full visible branch without discarding pre-compaction messages. */
export function activeBranchMessages(
  entries: readonly SessionHistoryEntry[],
  leafId?: unknown,
): Array<Record<string, unknown>> {
  const byId = new Map<string, SessionHistoryEntry>();
  for (const entry of entries)
    if (typeof entry.id === "string" && entry.id) byId.set(entry.id, entry);
  const fallbackLeaf = [...entries].reverse().find(
    (entry) => typeof entry.id === "string" && entry.id,
  )?.id;
  let cursor = typeof leafId === "string" && byId.has(leafId)
    ? leafId
    : typeof fallbackLeaf === "string"
      ? fallbackLeaf
      : undefined;
  const branch: SessionHistoryEntry[] = [];
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const entry = byId.get(cursor);
    if (!entry) break;
    branch.push(entry);
    cursor = typeof entry.parentId === "string" ? entry.parentId : undefined;
  }
  branch.reverse();
  return branch.flatMap((entry) =>
    entry.type === "message" && entry.message && typeof entry.message === "object"
      ? [entry.message as Record<string, unknown>]
      : [],
  );
}
