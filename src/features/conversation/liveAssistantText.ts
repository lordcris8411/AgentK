export type LiveAssistantTextValue = {
  content: string;
  thinking?: string;
};

type LiveAssistantTextSnapshot = {
  content: string;
  id?: string;
  thinking: string;
};

/**
 * A deliberately tiny external store for the one assistant message that is
 * currently growing. Keeping it outside the conversation array prevents each
 * stream frame from reconciling every historical message and navigation item.
 */
export class LiveAssistantTextStore {
  private listeners = new Set<() => void>();
  private snapshot: LiveAssistantTextSnapshot = { content: "", thinking: "" };

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  clear(): void {
    if (!this.snapshot.id) return;
    this.snapshot = { content: "", thinking: "" };
    for (const listener of this.listeners) listener();
  }

  publish(id: string, item: LiveAssistantTextValue): void {
    const next = {
      content: item.content,
      id,
      thinking: item.thinking ?? "",
    };
    if (
      this.snapshot.id === next.id &&
      this.snapshot.content === next.content &&
      this.snapshot.thinking === next.thinking
    ) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  text(id: string, kind: "content" | "thinking", fallback: string): string {
    return this.snapshot.id === id ? this.snapshot[kind] : fallback;
  }
}
