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
