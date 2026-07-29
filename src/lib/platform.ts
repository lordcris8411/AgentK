export type OpenDialogOptions = {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
};

export type WindowResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

export const platform = {
  appVersion: () => window.agentK.getVersion(),
  copyText: async (value: string) => {
    if (window.agentK?.copyText) return window.agentK.copyText(value);
    await navigator.clipboard.writeText(value);
  },
  openDialog: (options: OpenDialogOptions) => window.agentK.openDialog(options),
  pathForFile: (file: File) => window.agentK.pathForFile(file),
  fileUrl: (path: string) =>
    `agentk-file://local/?path=${encodeURIComponent(path)}`,
};

export const desktopWindow = {
  openDebug: (root: string, contextFile?: string) => window.agentK.window.invoke<void>("open-debug", { root, ...(contextFile ? { contextFile } : {}) }),
  openDebugTool: (kind: "disassembly" | "memory" | "registers", target?: string, languageServerId?: string, sessionId?: string) => window.agentK.window.invoke<void>("open-debug-tool", { kind, ...(target ? { target } : {}), ...(languageServerId ? { languageServerId } : {}), ...(sessionId ? { sessionId } : {}) }),
  setDebugRoot: (root?: string) => window.agentK.window.invoke<void>("set-debug-root", root ? { root } : {}),
  openEditorLocation: (location: { column?: number; focus?: boolean; line: number; path: string }) => window.agentK.window.invoke<void>("open-editor-location", location),
  onDebugRoot: (listener: (root: string) => void) => window.agentK.window.onDebugRoot(listener),
  onDebugContext: (listener: (context: { contextFile?: string; root: string }) => void) => window.agentK.window.onDebugContext(listener),
  onDebugProviderHit: (listener: (languageServerId: string) => void) => window.agentK.window.onDebugProviderHit(listener),
  onDebugToolTarget: (listener: (target: string) => void) => window.agentK.window.onDebugToolTarget(listener),
  onDebugToolProvider: (listener: (languageServerId: string) => void) => window.agentK.window.onDebugToolProvider(listener),
  onDebugToolSession: (listener: (sessionId?: string) => void) => window.agentK.window.onDebugToolSession(listener),
  onOpenEditorLocation: (listener: (location: { column: number; line: number; path: string }) => void) => window.agentK.window.onOpenEditorLocation(listener),
  setSize: (size: { width: number; height: number }) =>
    window.agentK.window.invoke<void>("set-size", size),
  isMaximized: () => window.agentK.window.invoke<boolean>("is-maximized"),
  maximize: () => window.agentK.window.invoke<void>("maximize"),
  unmaximize: () => window.agentK.window.invoke<void>("unmaximize"),
  minimize: () => window.agentK.window.invoke<void>("minimize"),
  close: () => window.agentK.window.invoke<void>("close"),
  openDevTools: () => window.agentK.window.invoke<void>("open-devtools"),
  capturePreview: (bounds: { x: number; y: number; width: number; height: number }, outputPath: string) =>
    window.agentK.window.invoke<string>("capture-preview", { ...bounds, outputPath }),
  getPreviewConsole: (url: string, limit = 80) =>
    window.agentK.window.invoke<Array<{
      column?: number;
      frameUrl?: string;
      level: "debug" | "error" | "info" | "log" | "warning";
      line?: number;
      text: string;
      timestamp: number;
    }>>("get-preview-console", { limit, url }),
  beginResize: (
    direction: WindowResizeDirection,
    screenX: number,
    screenY: number,
  ) =>
    window.agentK.window.invoke<void>("resize-begin", {
      direction,
      screenX,
      screenY,
    }),
  updateResize: (screenX: number, screenY: number) =>
    window.agentK.window.invoke<void>("resize-update", { screenX, screenY }),
  endResize: () => window.agentK.window.invoke<void>("resize-end"),
  onResized: async (listener: () => void) =>
    window.agentK.window.onResized(listener),
};
