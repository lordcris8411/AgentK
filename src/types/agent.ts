export type ConversationRole = "user" | "assistant" | "tool";

export interface ConversationMessage {
  id: string;
  role: ConversationRole;
  content: string;
  name?: string;
}

export interface AgentSessionState {
  sessionId: string;
  sessionName?: string;
  isStreaming: boolean;
  messageCount: number;
}

