import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { desktop } from "../../lib/desktop";
import { useSettings } from "../settings/SettingsContext";

type DialogMethod = "select" | "confirm" | "input" | "editor";
type NotificationType = "info" | "warning" | "error";
type WidgetPlacement = "aboveEditor" | "belowEditor";

type ExtensionDialog = {
  id: string;
  runtimeId?: string;
  method: DialogMethod;
  title: string;
  message?: string;
  options: string[];
  placeholder?: string;
  prefill?: string;
  secret: boolean;
  timeout?: number;
};

type ExtensionNotification = {
  id: string;
  message: string;
  type: NotificationType;
  createdAt: number;
  read: boolean;
};

export type ExtensionWidget = {
  key: string;
  lines: string[];
  placement: WidgetPlacement;
};

type EditorTextUpdate = { sequence: number; text: string };

type ExtensionUiContextValue = {
  ready: boolean;
  notifications: ExtensionNotification[];
  notificationHistory: ExtensionNotification[];
  statuses: Array<{ key: string; text: string }>;
  widgets: ExtensionWidget[];
  editorTextUpdate?: EditorTextUpdate;
  cancelPending(runtimeId?: string): Promise<void>;
  clearSessionUi(runtimeId?: string): void;
  setActiveRuntimeId(runtimeId?: string): void;
  dismissNotification(id: string): void;
  markNotificationRead(id: string): void;
  clearNotificationHistory(): void;
  pushNotification(
    message: string,
    type?: NotificationType,
    options?: { read?: boolean; showToast?: boolean },
  ): void;
};

const ExtensionUiContext = createContext<ExtensionUiContextValue | undefined>(
  undefined,
);

const ansiSequencePattern =
  /[\u001b\u009b](?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[0-?]*[ -/]*[@-~])/g;
const fileFormatActionPrefix = "agent-k-file-format-action:";
const previewConsoleRequestPrefix = "agent-k-preview-console:";

// Extension UI strings are often authored for Pi's terminal renderer. Strip
// ANSI CSI/OSC control sequences before displaying them in the WebView.
export function plainUiText(value: unknown) {
  return String(value ?? "").replace(ansiSequencePattern, "");
}

type AnsiStyle = {
  color?: string;
  fontWeight?: number;
  opacity?: number;
};

const ansi16Colors = [
  "#1f1f1f", "#c94f4f", "#4f9d69", "#c59a37",
  "#4f79bd", "#9b63b6", "#3b9c9c", "#c7c7c7",
  "#747474", "#ef6b73", "#70c98b", "#e8bd5b",
  "#78a4e8", "#c58bdd", "#65c7c7", "#f2f2f2",
];

function ansi256Color(index: number) {
  const value = Math.max(0, Math.min(255, Math.round(index)));
  if (value < 16) return ansi16Colors[value];
  if (value < 232) {
    const cube = value - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    const red = levels[Math.floor(cube / 36)];
    const green = levels[Math.floor((cube % 36) / 6)];
    const blue = levels[cube % 6];
    return `rgb(${red} ${green} ${blue})`;
  }
  const gray = 8 + (value - 232) * 10;
  return `rgb(${gray} ${gray} ${gray})`;
}

function applySgr(style: AnsiStyle, parameters: number[]) {
  const next = { ...style };
  const codes = parameters.length ? parameters : [0];
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index];
    if (code === 0) {
      delete next.color;
      delete next.fontWeight;
      delete next.opacity;
    } else if (code === 1) next.fontWeight = 700;
    else if (code === 2) next.opacity = 0.68;
    else if (code === 22) {
      delete next.fontWeight;
      delete next.opacity;
    } else if (code >= 30 && code <= 37) next.color = ansi16Colors[code - 30];
    else if (code >= 90 && code <= 97) next.color = ansi16Colors[code - 90 + 8];
    else if (code === 39) delete next.color;
    else if (code === 38 && codes[index + 1] === 5) {
      next.color = ansi256Color(codes[index + 2] ?? 0);
      index += 2;
    } else if (code === 38 && codes[index + 1] === 2) {
      const red = Math.max(0, Math.min(255, codes[index + 2] ?? 0));
      const green = Math.max(0, Math.min(255, codes[index + 3] ?? 0));
      const blue = Math.max(0, Math.min(255, codes[index + 4] ?? 0));
      next.color = `rgb(${red} ${green} ${blue})`;
      index += 4;
    }
  }
  return next;
}

export function AnsiText({ text }: { text: string }) {
  const segments: Array<{ text: string; style: AnsiStyle }> = [];
  const hasAnsi = plainUiText(text) !== text;
  let style: AnsiStyle = {};
  let offset = 0;
  ansiSequencePattern.lastIndex = 0;
  for (const match of text.matchAll(ansiSequencePattern)) {
    if (match.index! > offset)
      segments.push({ text: text.slice(offset, match.index), style: { ...style } });
    const sgr = /^(?:\u001b\[|\u009b)([0-9;:]*)m$/.exec(match[0]);
    if (sgr) {
      const parameters = sgr[1]
        ? sgr[1].split(/[;:]/).filter(Boolean).map(Number)
        : [0];
      style = applySgr(style, parameters);
    }
    offset = match.index! + match[0].length;
  }
  if (offset < text.length)
    segments.push({ text: text.slice(offset), style: { ...style } });
  return (
    <span className={hasAnsi ? "ansi-text has-ansi" : "ansi-text"}>
      {segments.map((segment, index) => (
        <span key={index} style={segment.style}>{segment.text}</span>
      ))}
    </span>
  );
}

function dialogFromEvent(
  event: Record<string, unknown>,
): ExtensionDialog | undefined {
  const method = String(event.method ?? "");
  if (!(["select", "confirm", "input", "editor"] as string[]).includes(method))
    return undefined;
  return {
    id: String(event.id),
    runtimeId:
      typeof event.runtimeId === "string" ? event.runtimeId : undefined,
    method: method as DialogMethod,
    title: plainUiText(event.title ?? "Agent K"),
    message:
      typeof event.message === "string"
        ? plainUiText(event.message)
        : undefined,
    options: Array.isArray(event.options)
      ? event.options.map(plainUiText)
      : [],
    placeholder:
      typeof event.placeholder === "string"
        ? plainUiText(event.placeholder)
        : undefined,
    prefill:
      typeof event.prefill === "string"
        ? plainUiText(event.prefill)
        : undefined,
    secret: event.secret === true,
    timeout:
      typeof event.timeout === "number" && event.timeout > 0
        ? event.timeout
        : undefined,
  };
}

function permissionMetadata(request: ExtensionDialog) {
  if (request.method !== "select") return undefined;
  const [header, ...summary] = request.title.split("\n");
  if (!header.startsWith("agent-k-permission:")) return undefined;
  const [, tool, sessionId] = header.split(":");
  if (!tool || !sessionId) return undefined;
  return { sessionId, summary: summary.join("\n"), tool };
}

function optionParts(option: string) {
  const parts = option.split(/\s+[—–]\s+/, 2);
  return {
    label: parts[0]?.trim() || option,
    detail: parts.length > 1 ? parts[1].trim() : undefined,
  };
}

export function ExtensionUiProvider({ children }: { children: ReactNode }) {
  const { settings, update, t } = useSettings();
  const [ready, setReady] = useState(false);
  const [activeRuntimeId, setActiveRuntimeId] = useState<string>();
  const [dialogs, setDialogs] = useState<ExtensionDialog[]>([]);
  const dialogsRef = useRef<ExtensionDialog[]>([]);
  const [dialogValue, setDialogValue] = useState("");
  const [notifications, setNotifications] = useState<ExtensionNotification[]>(
    [],
  );
  const [notificationHistory, setNotificationHistory] = useState<
    ExtensionNotification[]
  >([]);
  const [statuses, setStatuses] = useState<
    Record<string, Record<string, string>>
  >({});
  const [widgets, setWidgets] = useState<
    Record<string, Record<string, ExtensionWidget>>
  >({});
  const [editorTextUpdates, setEditorTextUpdates] = useState<
    Record<string, EditorTextUpdate>
  >({});
  const [authStatus, setAuthStatus] = useState<string>();
  const editorSequence = useRef(0);

  const replaceDialogs = useCallback((next: ExtensionDialog[]) => {
    dialogsRef.current = next;
    setDialogs(next);
  }, []);

  const removeDialog = useCallback(
    (id: string) => {
      replaceDialogs(dialogsRef.current.filter((request) => request.id !== id));
    },
    [replaceDialogs],
  );

  const pushNotification = useCallback(
    (
      message: string,
      type: NotificationType = "info",
      options: { read?: boolean; showToast?: boolean } = {},
    ) => {
      const id = crypto.randomUUID();
      const notification = {
        createdAt: Date.now(),
        id,
        message,
        read: options.read === true,
        type,
      };
      if (options.showToast !== false)
        setNotifications((current) => [...current, notification]);
      setNotificationHistory((current) => [...current, notification]);
      if (options.showToast !== false)
        window.setTimeout(
          () =>
            setNotifications((current) =>
              current.filter((notification) => notification.id !== id),
            ),
          type === "error" ? 8000 : 5000,
        );
    },
    [],
  );

  const dismissNotification = useCallback((id: string) => {
    setNotifications((current) =>
      current.filter((notification) => notification.id !== id),
    );
    setNotificationHistory((current) =>
      current.map((notification) =>
        notification.id === id ? { ...notification, read: true } : notification,
      ),
    );
  }, []);

  const markNotificationRead = useCallback((id: string) => {
    setNotificationHistory((current) =>
      current.map((notification) =>
        notification.id === id ? { ...notification, read: true } : notification,
      ),
    );
  }, []);

  const clearNotificationHistory = useCallback(() => {
    setNotifications([]);
    setNotificationHistory([]);
  }, []);

  const cancelPending = useCallback(async (runtimeId?: string) => {
    const target = runtimeId ?? activeRuntimeId;
    const pending = dialogsRef.current.filter(
      (request) => !target || request.runtimeId === target,
    );
    replaceDialogs(
      dialogsRef.current.filter((request) => !pending.includes(request)),
    );
    await Promise.allSettled(
      pending.map((request) =>
        desktop.extensionResponse({
          type: "extension_ui_response",
          id: request.id,
          cancelled: true,
        }, request.runtimeId),
      ),
    );
  }, [activeRuntimeId, replaceDialogs]);

  const clearSessionUi = useCallback((runtimeId?: string) => {
    const target = runtimeId ?? activeRuntimeId;
    if (!target) return;
    setStatuses((current) => {
      const next = { ...current };
      delete next[target];
      return next;
    });
    setWidgets((current) => {
      const next = { ...current };
      delete next[target];
      return next;
    });
    setEditorTextUpdates((current) => {
      const next = { ...current };
      delete next[target];
      return next;
    });
    document.title = "Agent K";
  }, [activeRuntimeId]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void desktop
      .onEvent((event) => {
        if (event.type === "auth_event") {
          const auth =
            typeof event.event === "object" && event.event !== null
              ? (event.event as Record<string, unknown>)
              : {};
          const message =
            auth.message ?? auth.instructions ?? auth.userCode ?? undefined;
          setAuthStatus(
            typeof message === "string" && message
              ? plainUiText(message)
              : undefined,
          );
          if (auth.type === "auth_url" && typeof auth.url === "string")
            void desktop.openExternalUrl(auth.url, settings.browserId);
          if (
            auth.type === "device_code" &&
            typeof auth.verificationUri === "string"
          )
            void desktop.openExternalUrl(
              auth.verificationUri,
              settings.browserId,
            );
          return;
        }
        if (event.type !== "extension_ui_request") return;
        const runtimeId =
          typeof event.runtimeId === "string" ? event.runtimeId : "default";
        const method = String(event.method ?? "");
        const title = typeof event.title === "string" ? event.title : "";
        if (method === "input" && title.startsWith(previewConsoleRequestPrefix)) {
          const limit = Math.max(1, Math.min(200, Number(title.slice(previewConsoleRequestPrefix.length)) || 80));
          const requestId = typeof event.id === "string" ? event.id : "";
          const respond = (value: string) => void desktop.extensionResponse({
            type: "extension_ui_response",
            id: requestId,
            value,
          }, runtimeId);
          const bridgeEvent = new CustomEvent("agent-k-preview-console-request", {
            cancelable: true,
            detail: { limit, respond },
          });
          if (window.dispatchEvent(bridgeEvent))
            respond("No active Agent K web-project preview is available.");
          return;
        }
        const request = dialogFromEvent(event);
        if (request) {
          if (!dialogsRef.current.some((entry) => entry.id === request.id))
            replaceDialogs([...dialogsRef.current, request]);
          return;
        }
        if (method === "notify") {
          const message = String(event.message ?? "");
          if (message.startsWith(fileFormatActionPrefix)) {
            try {
              const detail = JSON.parse(message.slice(fileFormatActionPrefix.length)) as Record<string, unknown>;
              if (typeof detail.action === "string")
                window.dispatchEvent(new CustomEvent("agent-k-file-format-action", { detail }));
            } catch {
              // A malformed extension notification must not affect normal UI notifications.
            }
            return;
          }
          const notifyType = String(event.notifyType ?? "info");
          pushNotification(
            message,
            (["info", "warning", "error"] as string[]).includes(notifyType)
              ? (notifyType as NotificationType)
              : "info",
          );
          return;
        }
        if (method === "setStatus") {
          const key = String(event.statusKey ?? "");
          if (!key) return;
          setStatuses((current) => {
            const next = { ...(current[runtimeId] ?? {}) };
            if (typeof event.statusText === "string" && event.statusText)
              next[key] = event.statusText;
            else delete next[key];
            return { ...current, [runtimeId]: next };
          });
          return;
        }
        if (method === "setWidget") {
          const key = String(event.widgetKey ?? "");
          if (!key) return;
          setWidgets((current) => {
            const next = { ...(current[runtimeId] ?? {}) };
            if (Array.isArray(event.widgetLines)) {
              next[key] = {
                key,
                lines: event.widgetLines.map(String),
                placement:
                  event.widgetPlacement === "belowEditor"
                    ? "belowEditor"
                    : "aboveEditor",
              };
            } else delete next[key];
            return { ...current, [runtimeId]: next };
          });
          return;
        }
        if (method === "setTitle") {
          document.title = plainUiText(event.title || "Agent K");
          return;
        }
        if (method === "set_editor_text") {
          editorSequence.current += 1;
          setEditorTextUpdates((current) => ({
            ...current,
            [runtimeId]: {
              sequence: editorSequence.current,
              text: plainUiText(event.text),
            },
          }));
        }
      })
      .then((stop) => {
        if (disposed) stop();
        else {
          unlisten = stop;
          setReady(true);
        }
      });
    return () => {
      disposed = true;
      unlisten?.();
      const pending = dialogsRef.current;
      dialogsRef.current = [];
      for (const request of pending)
        void desktop.extensionResponse({
          type: "extension_ui_response",
          id: request.id,
          cancelled: true,
        }, request.runtimeId);
    };
  }, [pushNotification, replaceDialogs, settings.browserId]);

  const activeDialog = dialogs.find(
    (request) => request.runtimeId === activeRuntimeId,
  );
  useEffect(() => {
    setDialogValue(activeDialog?.prefill ?? "");
    if (!activeDialog?.timeout) return;
    const timer = window.setTimeout(
      () => removeDialog(activeDialog.id),
      activeDialog.timeout,
    );
    return () => window.clearTimeout(timer);
  }, [activeDialog, removeDialog]);

  useEffect(() => {
    const cancelOnClose = () => {
      for (const request of dialogsRef.current)
        void desktop.extensionResponse({
          type: "extension_ui_response",
          id: request.id,
          cancelled: true,
        }, request.runtimeId);
      dialogsRef.current = [];
    };
    window.addEventListener("beforeunload", cancelOnClose);
    return () => window.removeEventListener("beforeunload", cancelOnClose);
  }, []);

  const respond = async (response: Record<string, unknown>) => {
    if (!activeDialog) return;
    const request = activeDialog;
    removeDialog(request.id);
    setAuthStatus(undefined);
    try {
      await desktop.extensionResponse({
        type: "extension_ui_response",
        id: request.id,
        ...response,
      }, request.runtimeId);
    } catch (cause) {
      pushNotification(String(cause), "error");
    }
  };

  const selectOption = async (option: string, index: number) => {
    if (!activeDialog) return;
    const permission = permissionMetadata(activeDialog);
    try {
      if (permission && index === 2) {
        await desktop.setSessionPermission(permission.sessionId, true);
        sessionStorage.setItem(
          `agent-k-permission:${permission.sessionId}`,
          "allow",
        );
        window.dispatchEvent(new Event("agent-k-permission"));
      } else if (permission && index === 3) {
        await update({ permissionMode: "full" });
        window.dispatchEvent(new Event("agent-k-permission"));
      }
    } catch (cause) {
      pushNotification(String(cause), "error");
    }
    await respond({ value: option });
  };

  const value = useMemo<ExtensionUiContextValue>(
    () => ({
      ready,
      notifications,
      notificationHistory,
      statuses: Object.entries(statuses[activeRuntimeId ?? ""] ?? {}).map(
        ([key, text]) => ({ key, text }),
      ),
      widgets: Object.values(widgets[activeRuntimeId ?? ""] ?? {}),
      editorTextUpdate: editorTextUpdates[activeRuntimeId ?? ""],
      cancelPending,
      clearSessionUi,
      setActiveRuntimeId,
      clearNotificationHistory,
      dismissNotification,
      markNotificationRead,
      pushNotification,
    }),
    [
      cancelPending,
      clearNotificationHistory,
      clearSessionUi,
      activeRuntimeId,
      editorTextUpdates,
      dismissNotification,
      markNotificationRead,
      notificationHistory,
      notifications,
      pushNotification,
      ready,
      statuses,
      widgets,
    ],
  );
  const permission = activeDialog
    ? permissionMetadata(activeDialog)
    : undefined;

  return (
    <ExtensionUiContext.Provider value={value}>
      {children}
      {activeDialog && (
        <div
          className={
            activeDialog.method === "select" && !permission
              ? "extension-dialog-backdrop is-select"
              : "extension-dialog-backdrop"
          }
          onKeyDown={(event) => {
            if (event.key === "Escape") void respond({ cancelled: true });
          }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget)
              void respond({ cancelled: true });
          }}
        >
          <section
            aria-modal="true"
            className={
              permission
                ? `extension-dialog is-permission${activeDialog.method === "select" ? " is-select" : ""}`
                : `extension-dialog${activeDialog.method === "select" ? " is-select" : ""}`
            }
            role="dialog"
          >
            <header>
              <i
                aria-hidden="true"
                className={
                  permission
                    ? "fa-solid fa-shield-halved"
                    : "fa-regular fa-message"
                }
              />
              <div>
                <strong>
                  {permission ? t("askPermissionTitle") : activeDialog.title}
                </strong>
                {permission && <small>{permission.tool}</small>}
              </div>
              <button
                aria-label={t("cancel")}
                className="extension-dialog-close"
                onClick={() => void respond({ cancelled: true })}
                type="button"
              >
                <i aria-hidden="true" className="fa-solid fa-xmark" />
              </button>
            </header>
            {(permission?.summary || activeDialog.message) && (
              <pre>{permission?.summary ?? activeDialog.message}</pre>
            )}
            {authStatus && <p className="auth-status">{authStatus}</p>}
            {activeDialog.method === "select" && (
              <div className="extension-dialog-options">
                {activeDialog.options.map((option, index) => (
                  <button
                    autoFocus={index === 0}
                    className={
                      permission && index === 2 ? "primary-button" : undefined
                    }
                    key={`${option}-${index}`}
                    onClick={() => void selectOption(option, index)}
                    type="button"
                  >
                    <span aria-hidden="true" className="extension-option-index">
                      •
                    </span>
                    <span className="extension-option-copy">
                      <strong>{optionParts(option).label}</strong>
                      {optionParts(option).detail && (
                        <small>{optionParts(option).detail}</small>
                      )}
                    </span>
                    <i
                      aria-hidden="true"
                      className="fa-solid fa-chevron-right"
                    />
                  </button>
                ))}
              </div>
            )}
            {activeDialog.method === "input" && (
              <input
                autoFocus
                onChange={(event) => setDialogValue(event.target.value)}
                placeholder={activeDialog.placeholder}
                type={activeDialog.secret ? "password" : "text"}
                value={dialogValue}
              />
            )}
            {activeDialog.method === "editor" && (
              <textarea
                autoFocus
                onChange={(event) => setDialogValue(event.target.value)}
                rows={10}
                value={dialogValue}
              />
            )}
            {activeDialog.method !== "select" && (
              <footer>
                {activeDialog.method === "confirm" && (
                  <button
                    onClick={() => void respond({ confirmed: false })}
                    type="button"
                  >
                    {t("no")}
                  </button>
                )}
                <button
                  onClick={() => void respond({ cancelled: true })}
                  type="button"
                >
                  {t("cancel")}
                </button>
                <button
                  autoFocus={activeDialog.method === "confirm"}
                  className="primary-button"
                  onClick={() =>
                    void respond(
                      activeDialog.method === "confirm"
                        ? { confirmed: true }
                        : { value: dialogValue },
                    )
                  }
                  type="button"
                >
                  {activeDialog.method === "confirm" ? t("confirm") : t("submit")}
                </button>
              </footer>
            )}
          </section>
        </div>
      )}
    </ExtensionUiContext.Provider>
  );
}

export function useExtensionUi() {
  const value = useContext(ExtensionUiContext);
  if (!value) throw new Error("ExtensionUiProvider is missing");
  return value;
}
