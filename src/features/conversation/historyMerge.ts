type MessageItem = {
  content: string;
  optimistic?: boolean;
  role: string;
};

export function mergePersistedItems<T extends MessageItem>(
  persisted: T[],
  current: T[],
  preserveOptimistic: boolean,
): T[] {
  if (!preserveOptimistic) return persisted;
  const pendingUsers = current.filter((item) =>
    item.optimistic &&
    item.role === "user" &&
    !persisted.some((candidate) =>
      candidate.role === "user" && candidate.content === item.content,
    ),
  );
  return pendingUsers.length ? [...persisted, ...pendingUsers] : persisted;
}
