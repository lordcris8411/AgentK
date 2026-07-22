export const EDITOR_API_VERSION = 1 as const;
export const EDITOR_CHANNEL = "agent-k-editor" as const;

export type EditorTheme = "light" | "dark";

export type EditorInitialState = {
  absolutePath: string;
  binary?: ArrayBuffer;
  byteSize?: number;
  codec?: string;
  content: string;
  fileName: string;
  language: string;
  locale: "en-US" | "zh-CN";
  mediaKind?: "image" | "audio" | "video" | "pdf";
  mimeType?: string;
  path: string;
  readOnly: boolean;
  theme: EditorTheme;
  wordWrap: boolean;
};

export type EditorInstance = {
  dispose?(): void;
  executeAction?(action: string, parameters: Record<string, unknown>): void;
  focus?(): void;
  getContent(): string;
  markSaved?(content: string): void;
  navigate?(line: number, column: number): void;
  setContent(content: string): void;
  setLayoutSuspended?(suspended: boolean): void;
  setTheme?(theme: EditorTheme): void;
  setWordWrap?(enabled: boolean): void;
};

export type EditorHost = {
  readonly root: HTMLElement;
  reportDirty(dirty: boolean): void;
  reportError(message: string): void;
  requestSave(content: string): void;
  referenceLine(line: number, column?: number): void;
  updateContent(content: string): void;
};

export type EditorFactory = (
  host: EditorHost,
  initialState: EditorInitialState,
) => EditorInstance | Promise<EditorInstance>;

type HostMessage = {
  apiVersion: typeof EDITOR_API_VERSION;
  channel: typeof EDITOR_CHANNEL;
  nonce: string;
  requestId?: string;
  type: "action" | "focus" | "initialize" | "mark-saved" | "navigate" | "read-content" | "set-content" | "set-layout-suspended" | "set-theme" | "set-word-wrap";
  value?: unknown;
};

function post(nonce: string, type: string, value?: unknown, requestId?: string): void {
  window.parent.postMessage({
    apiVersion: EDITOR_API_VERSION,
    channel: EDITOR_CHANNEL,
    nonce,
    requestId,
    type,
    value,
  }, "*");
}

/**
 * Registers a programmable editor inside Agent K's sandboxed editor frame.
 *
 * The plugin owns the frame's DOM and CSS. Agent K only exchanges structured
 * messages with it; Electron and Node APIs are deliberately unavailable.
 */
export function defineEditor(factory: EditorFactory): void {
  let instance: EditorInstance | undefined;
  let initialization = Promise.resolve();
  let initializationRevision = 0;
  let nonce = "";

  const host: EditorHost = {
    get root() {
      const root = document.getElementById("agent-k-editor-root");
      if (!root) throw new Error("Agent K editor root is unavailable");
      return root;
    },
    reportDirty(dirty) {
      if (nonce) post(nonce, "dirty", dirty);
    },
    reportError(message) {
      if (nonce) post(nonce, "error", message);
    },
    requestSave(content) {
      if (nonce) post(nonce, "request-save", content);
    },
    referenceLine(line, column = 1) {
      if (nonce) post(nonce, "reference-line", { column, line });
    },
    updateContent(content) {
      if (nonce) post(nonce, "content-change", content);
    },
  };

  window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (
      !message ||
      message.channel !== EDITOR_CHANNEL ||
      message.apiVersion !== EDITOR_API_VERSION
    ) return;

    if (message.type === "initialize") {
      if (typeof message.nonce !== "string") return;
      const nextNonce = message.nonce;
      const initialState = message.value as EditorInitialState;
      const revision = ++initializationRevision;
      nonce = nextNonce;
      initialization = initialization
        .catch(() => undefined)
        .then(async () => {
          if (revision !== initializationRevision) return;
          instance?.dispose?.();
          instance = undefined;
          host.root.replaceChildren();
          const created = await factory(host, initialState);
          if (revision !== initializationRevision) {
            created.dispose?.();
            return;
          }
          instance = created;
          post(nextNonce, "ready");
        })
        .catch((cause: unknown) => {
          if (revision === initializationRevision)
            post(nextNonce, "error", cause instanceof Error ? cause.message : String(cause));
        });
      return;
    }
    if (!instance || message.nonce !== nonce) return;

    switch (message.type) {
      case "action": {
        const action = message.value as { id?: unknown; parameters?: unknown };
        if (typeof action?.id === "string")
          instance.executeAction?.(action.id, action.parameters && typeof action.parameters === "object" ? action.parameters as Record<string, unknown> : {});
        break;
      }
      case "focus":
        instance.focus?.();
        break;
      case "navigate": {
        const target = message.value as { column?: unknown; line?: unknown };
        if (typeof target?.line === "number")
          instance.navigate?.(target.line, typeof target.column === "number" ? target.column : 1);
        break;
      }
      case "mark-saved":
        if (typeof message.value === "string") instance.markSaved?.(message.value);
        break;
      case "read-content":
        post(nonce, "content", instance.getContent(), message.requestId);
        break;
      case "set-content":
        if (typeof message.value === "string") instance.setContent(message.value);
        break;
      case "set-layout-suspended":
        if (typeof message.value === "boolean") instance.setLayoutSuspended?.(message.value);
        break;
      case "set-theme":
        if (message.value === "light" || message.value === "dark")
          instance.setTheme?.(message.value);
        break;
      case "set-word-wrap":
        if (typeof message.value === "boolean") instance.setWordWrap?.(message.value);
        break;
      default:
        break;
    }
  });

  window.addEventListener("beforeunload", () => instance?.dispose?.());
  window.parent.postMessage({
    apiVersion: EDITOR_API_VERSION,
    channel: EDITOR_CHANNEL,
    type: "booted",
  }, "*");
}
