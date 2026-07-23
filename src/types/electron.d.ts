interface AgentKWindowState {
  maximized: boolean;
  width: number;
  height: number;
}

interface AgentKBridge {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  getVersion(): Promise<string>;
  openDialog(options: {
    directory?: boolean;
    multiple?: boolean;
    title?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<string | string[] | null>;
  pathForFile(file: File): string;
  projectConsole?: {
    write(id: string, data: string): void;
    onEvent(listener: (event: Record<string, unknown>) => void): () => void;
  };
  onPiEvent(listener: (event: Record<string, unknown>) => void): () => void;
  window: {
    invoke<T>(action: string, payload?: Record<string, unknown>): Promise<T>;
    onResized(listener: (state: AgentKWindowState) => void): () => void;
  };
}

interface Window {
  agentK: AgentKBridge;
}
