import type { AgentSessionState, ConversationMessage } from "../types/agent";

/**
 * Frontend port for Pi communication.
 *
 * The initial mock keeps UI development independent from process management.
 * A future Tauri implementation will invoke Rust commands and subscribe to
 * forwarded Pi RPC events without changing feature components.
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
    // Replaced by the Tauri-backed RPC client in the integration milestone.
  },
  subscribe(_listener) {
    return () => undefined;
  },
};

