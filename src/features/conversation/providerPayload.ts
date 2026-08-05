export type ProviderRequestDump = {
  capturedAt: number;
  payload: unknown;
};

type ProviderRequestItem = {
  role: string;
  providerRequests?: ProviderRequestDump[];
};

export function attachProviderRequestDump<T extends ProviderRequestItem>(
  items: T[],
  dump: ProviderRequestDump,
  totalLimit = 24,
  perMessageLimit = 8,
): T[] {
  let target = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.role === "user") {
      target = index;
      break;
    }
  }
  if (target < 0) return items;
  const next = items.map((item, index) => index === target
    ? {
        ...item,
        providerRequests: [...(item.providerRequests ?? []), dump].slice(-perMessageLimit),
      }
    : item);
  let remaining = totalLimit;
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const requests = next[index]?.providerRequests;
    if (!requests?.length) continue;
    const keep = Math.min(remaining, requests.length);
    remaining -= keep;
    if (keep === requests.length) continue;
    next[index] = { ...next[index]!, providerRequests: keep ? requests.slice(-keep) : undefined };
  }
  return next;
}
