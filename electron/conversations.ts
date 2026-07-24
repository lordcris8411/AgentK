import { basename } from "node:path";
import type { AgentBackend, JsonObject, ProjectSummary, SessionSummary } from "./types.js";
import { atomicWrite, readJson } from "./utils.js";
import { join } from "node:path";

export type StoredConversation = SessionSummary & { backend: AgentBackend; hidden?: boolean };
type Registry = { workspaces: string[]; conversations: StoredConversation[]; messages: Record<string, JsonObject[]> };

/** Agent K's authoritative workspace and conversation index.
 * Runtime-specific session files/threads are deliberately only references here. */
export class ConversationStore {
  private registry: Registry = { workspaces: [], conversations: [], messages: {} };

  constructor(private readonly appDataPath: string) {}

  async initialize(): Promise<void> {
    const value = await readJson<Partial<Registry>>(this.path(), {});
    this.registry = {
      workspaces: Array.isArray(value.workspaces) ? value.workspaces.filter((cwd): cwd is string => typeof cwd === "string") : [],
      conversations: Array.isArray(value.conversations)
        ? value.conversations.filter((entry): entry is StoredConversation =>
          Boolean(entry) && typeof entry.id === "string" && typeof entry.path === "string" &&
          typeof entry.cwd === "string" && (entry.backend === "pi" || entry.backend === "codex"),
        )
        : [],
      messages: value.messages && typeof value.messages === "object"
        ? Object.fromEntries(Object.entries(value.messages).map(([path, messages]) => [path, Array.isArray(messages) ? messages.map((message) => ({ ...message })) : []]))
        : {},
    };
  }

  async addWorkspace(cwd: string): Promise<void> {
    if (!this.registry.workspaces.includes(cwd)) {
      this.registry.workspaces.push(cwd);
      await this.save();
    }
  }

  async register(conversation: StoredConversation): Promise<void> {
    await this.addWorkspace(conversation.cwd);
    const index = this.registry.conversations.findIndex((entry) => entry.path === conversation.path);
    if (index >= 0) this.registry.conversations[index] = { ...this.registry.conversations[index], ...conversation };
    else this.registry.conversations.push(conversation);
    await this.save();
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return this.registry.workspaces.map((cwd) => {
      const sessions = this.registry.conversations
        .filter((entry) => entry.cwd === cwd && !entry.hidden)
        .sort((left, right) => right.updatedAt - left.updatedAt);
      return {
        cwd,
        name: basename(cwd) || cwd,
        updatedAt: sessions[0]?.updatedAt ?? 0,
        sessions,
      };
    }).sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name));
  }

  find(path: string): StoredConversation | undefined {
    return this.registry.conversations.find((entry) => entry.path === path);
  }

  async rename(path: string, name: string): Promise<void> {
    const entry = this.find(path);
    if (!entry) throw new Error("Agent K conversation was not found");
    entry.name = name;
    entry.updatedAt = Math.floor(Date.now() / 1000);
    await this.save();
  }

  async hide(path: string, hidden: boolean): Promise<void> {
    const entry = this.find(path);
    if (!entry) return;
    entry.hidden = hidden;
    await this.save();
  }

  async remove(path: string): Promise<StoredConversation | undefined> {
    const index = this.registry.conversations.findIndex((entry) => entry.path === path);
    if (index < 0) return undefined;
    const [removed] = this.registry.conversations.splice(index, 1);
    delete this.registry.messages[path];
    await this.save();
    return removed;
  }

  async appendMessage(path: string, message: JsonObject): Promise<void> {
    if (!this.find(path)) return;
    const messages = this.registry.messages[path] ?? [];
    messages.push(message);
    this.registry.messages[path] = messages.slice(-2_000);
    await this.save();
  }

  messages(path: string): JsonObject[] { return this.registry.messages[path] ?? []; }

  private path(): string { return join(this.appDataPath, "agent-k-conversations.json"); }
  private save(): Promise<void> { return atomicWrite(this.path(), JSON.stringify(this.registry, null, 2)); }
}
