import type { AgentSessionState, ConversationMessage } from "../types/agent";

/**
 * Frontend port for Pi communication.
 *
 * The initial mock keeps UI development independent from process management.
 * The production Electron adapter forwards Pi RPC events without exposing
 * process access to feature components.
 */
export interface AgentClient {
  getState(): Promise<AgentSessionState>;
  prompt(message: string): Promise<void>;
  subscribe(listener: (message: ConversationMessage) => void): () => void;
}

export const mockAgentClient: AgentClient = {
  async getState() {
    return {
      sessionId: "mock-session",
      sessionName: "Pi visual client",
      isStreaming: false,
      messageCount: 2,
    };
  },
  async prompt(_message) {
    // Replaced by the Electron-backed RPC client in production.
  },
  subscribe(_listener) {
    return () => undefined;
  },
};
