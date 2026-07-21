import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Bell, PanelLeft, PanelRight, Trash2, X } from "lucide-react";
import { useSettings } from "../../features/settings/SettingsContext";
import {
  AnsiText,
  useExtensionUi,
} from "../../features/extensions/ExtensionUiContext";

interface AppShellProps {
  sidebar: ReactNode;
  inspector: ReactNode;
  children: ReactNode;
}

const LEFT_PANEL_MINIMUM = 240;
const RIGHT_PANEL_MINIMUM = 420;
const WORKSPACE_MINIMUM = 360;
const RESIZERS_WIDTH = 12;

export function AppShell({ sidebar, inspector, children }: AppShellProps) {
  const { settings, t } = useSettings();
  const en = settings.locale === "en-US";
  const {
    clearNotificationHistory,
    dismissNotification,
    markNotificationRead,
    notificationHistory,
    notifications,
  } = useExtensionUi();
  const unreadNotifications = notificationHistory.filter(
    (notification) => !notification.read,
  ).length;
  const [notificationHistoryOpen, setNotificationHistoryOpen] = useState(false);
  const [leftWidth, setLeftWidth] = useState(304);
  const [rightWidth, setRightWidth] = useState(RIGHT_PANEL_MINIMUM);
  const [leftHidden, setLeftHidden] = useState(false);
  const [rightHidden, setRightHidden] = useState(false);
  const leftWidthRef = useRef(leftWidth);
  const rightWidthRef = useRef(rightWidth);
  const windowWidthRef = useRef(window.innerWidth);
  const leftRatioRef = useRef(leftWidth / window.innerWidth);
  const rightRatioRef = useRef(rightWidth / window.innerWidth);
  leftWidthRef.current = leftWidth;
  rightWidthRef.current = rightWidth;
  const drag = useRef<"left" | "right" | undefined>(undefined);
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty(
      "--left-panel-width",
      leftHidden ? "0px" : `${leftWidth}px`,
    );
    root.style.setProperty(
      "--right-panel-width",
      rightHidden ? "0px" : `${rightWidth}px`,
    );
  }, [leftHidden, leftWidth, rightHidden, rightWidth]);
  useEffect(() => {
    let animationFrame = 0;
    const resize = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const windowWidth = window.innerWidth;
        if (windowWidth === windowWidthRef.current || drag.current) return;
        const available = windowWidth - WORKSPACE_MINIMUM - RESIZERS_WIDTH;
        const nextLeft = Math.max(
          LEFT_PANEL_MINIMUM,
          Math.min(available - RIGHT_PANEL_MINIMUM, windowWidth * leftRatioRef.current),
        );
        const nextRight = Math.max(
          RIGHT_PANEL_MINIMUM,
          Math.min(available - nextLeft, windowWidth * rightRatioRef.current),
        );
        leftWidthRef.current = nextLeft;
        rightWidthRef.current = nextRight;
        windowWidthRef.current = windowWidth;
        setLeftWidth(nextLeft);
        setRightWidth(nextRight);
      });
    };
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
    };
  }, []);
  useEffect(() => {
    const suppressContextMenu = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".monaco-editor")) return;
      event.preventDefault();
    };
    window.addEventListener("contextmenu", suppressContextMenu);
    return () => window.removeEventListener("contextmenu", suppressContextMenu);
  }, []);
  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!drag.current) return;
      if (drag.current === "left") {
        const nextLeft = Math.max(
          LEFT_PANEL_MINIMUM,
          Math.min(
            window.innerWidth - rightWidthRef.current - WORKSPACE_MINIMUM - RESIZERS_WIDTH,
            event.clientX,
          ),
        );
        leftWidthRef.current = nextLeft;
        leftRatioRef.current = nextLeft / window.innerWidth;
        setLeftWidth(nextLeft);
      } else {
        const nextRight = Math.max(
          RIGHT_PANEL_MINIMUM,
          Math.min(
            window.innerWidth - leftWidthRef.current - WORKSPACE_MINIMUM - RESIZERS_WIDTH,
            window.innerWidth - event.clientX,
          ),
        );
        rightWidthRef.current = nextRight;
        rightRatioRef.current = nextRight / window.innerWidth;
        setRightWidth(nextRight);
      }
    };
    const stop = () => {
      drag.current = undefined;
      document.body.classList.remove("is-resizing");
      windowWidthRef.current = window.innerWidth;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };
  }, []);
  const startDrag =
    (side: "left" | "right") => (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      drag.current = side;
      document.body.classList.add("is-resizing");
    };
  const appWindow = getCurrentWindow();
  const toggleMaximize = async () => {
    if (await appWindow.isMaximized()) await appWindow.unmaximize();
    else await appWindow.maximize();
  };
  const dragWindow = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button === 0) void appWindow.startDragging();
  };
  const layoutStyle = {
    "--left-panel-width": leftHidden ? "0px" : `${leftWidth}px`,
    "--right-panel-width": rightHidden ? "0px" : `${rightWidth}px`,
  } as Record<string, string>;
  return (
    <div className="app-frame" style={layoutStyle}>
      <header className="window-titlebar">
        <div
          aria-label={en ? "Drag window" : "拖动窗口"}
          className="window-drag-region"
          onDoubleClick={() => void toggleMaximize()}
          onMouseDown={dragWindow}
        />
        <div className="window-controls">
          <button
            aria-label={en ? "Minimize" : "最小化"}
            onClick={() => void appWindow.minimize()}
            type="button"
          >
            <span className="window-icon-minimize" />
          </button>
          <button
            aria-label={en ? "Maximize or restore" : "最大化或还原"}
            onClick={() => void toggleMaximize()}
            type="button"
          >
            <span className="window-icon-maximize" />
          </button>
          <button
            aria-label={en ? "Close" : "关闭"}
            className="window-close"
            onClick={() => void appWindow.close()}
            type="button"
          >
            <span className="window-icon-close" />
          </button>
        </div>
      </header>
      <main className="app-shell">
        <aside className={leftHidden ? "app-sidebar is-hidden" : "app-sidebar"}>{sidebar}</aside>
        <div
          aria-label={en ? "Resize left sidebar" : "调整左侧栏宽度"}
          className={leftHidden ? "panel-resizer panel-resizer-left is-collapsed" : "panel-resizer panel-resizer-left"}
          onMouseDown={leftHidden ? undefined : startDrag("left")}
          role="separator"
        />
        <section className="app-workspace">
          <div className="workspace-panel-controls">
            <button
              aria-expanded={notificationHistoryOpen}
              aria-label={t("notificationHistory")}
              className={
                notificationHistoryOpen
                  ? "workspace-panel-button notification-center-button is-active"
                  : "workspace-panel-button notification-center-button"
              }
              onClick={() => setNotificationHistoryOpen((open) => !open)}
              title={t("notificationHistory")}
              type="button"
            >
              <Bell aria-hidden="true" size={16} strokeWidth={1.8} />
              {unreadNotifications > 0 ? (
                <span className="notification-count">
                  {unreadNotifications > 99
                    ? "99+"
                    : unreadNotifications}
                </span>
              ) : null}
            </button>
            <button
              aria-label={leftHidden ? (en ? "Show left sidebar" : "显示左侧栏") : (en ? "Hide left sidebar" : "隐藏左侧栏")}
              className={leftHidden ? "workspace-panel-button is-collapsed" : "workspace-panel-button"}
              onClick={() => setLeftHidden((hidden) => !hidden)}
              title={leftHidden ? (en ? "Show left sidebar" : "显示左侧栏") : (en ? "Hide left sidebar" : "隐藏左侧栏")}
              type="button"
            >
              <PanelLeft aria-hidden="true" size={16} strokeWidth={1.8} />
            </button>
            <button
              aria-label={rightHidden ? (en ? "Show right sidebar" : "显示右侧栏") : (en ? "Hide right sidebar" : "隐藏右侧栏")}
              className={rightHidden ? "workspace-panel-button is-collapsed" : "workspace-panel-button"}
              onClick={() => setRightHidden((hidden) => !hidden)}
              title={rightHidden ? (en ? "Show right sidebar" : "显示右侧栏") : (en ? "Hide right sidebar" : "隐藏右侧栏")}
              type="button"
            >
              <PanelRight aria-hidden="true" size={16} strokeWidth={1.8} />
            </button>
          </div>
          {!notificationHistoryOpen ? (
            <div aria-live="polite" className="extension-notifications">
              {notifications.map((notification) => (
                <button
                  className={`extension-notification is-${notification.type}`}
                  key={notification.id}
                  onClick={() => dismissNotification(notification.id)}
                  type="button"
                >
                  <i
                    aria-hidden="true"
                    className={
                      notification.type === "error"
                        ? "fa-solid fa-circle-exclamation"
                        : notification.type === "warning"
                          ? "fa-solid fa-triangle-exclamation"
                          : "fa-solid fa-circle-info"
                    }
                  />
                  <span>
                    <AnsiText text={notification.message} />
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {notificationHistoryOpen ? (
            <section
              aria-label={t("notificationHistory")}
              className="notification-history-panel"
            >
              <header>
                <div>
                  <strong>{t("notificationHistory")}</strong>
                  <small>{notificationHistory.length}</small>
                </div>
                <div className="notification-history-actions">
                  <button
                    aria-label={t("clearNotifications")}
                    disabled={notificationHistory.length === 0}
                    onClick={clearNotificationHistory}
                    title={t("clearNotifications")}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={14} strokeWidth={1.8} />
                  </button>
                  <button
                    aria-label={t("close")}
                    onClick={() => setNotificationHistoryOpen(false)}
                    title={t("close")}
                    type="button"
                  >
                    <X aria-hidden="true" size={15} strokeWidth={1.8} />
                  </button>
                </div>
              </header>
              <div className="notification-history-list">
                {notificationHistory.length ? (
                  [...notificationHistory].reverse().map((notification) => (
                    <button
                      className={`notification-history-item is-${notification.type} ${notification.read ? "is-read" : "is-unread"}`}
                      key={notification.id}
                      onClick={() => markNotificationRead(notification.id)}
                      type="button"
                    >
                      <i
                        aria-hidden="true"
                        className={
                          notification.type === "error"
                            ? "fa-solid fa-circle-exclamation"
                            : notification.type === "warning"
                              ? "fa-solid fa-triangle-exclamation"
                              : "fa-solid fa-circle-info"
                        }
                      />
                      <div>
                        <p>
                          <AnsiText text={notification.message} />
                        </p>
                        <footer>
                          <time dateTime={new Date(notification.createdAt).toISOString()}>
                            {new Intl.DateTimeFormat(settings.locale, {
                              day: "2-digit",
                              hour: "2-digit",
                              hour12: false,
                              minute: "2-digit",
                              month: "2-digit",
                              second: "2-digit",
                              year: "numeric",
                            }).format(notification.createdAt)}
                          </time>
                          <span>{t(notification.read ? "read" : "unread")}</span>
                        </footer>
                      </div>
                    </button>
                  ))
                ) : (
                  <p className="notification-history-empty">
                    {t("noNotifications")}
                  </p>
                )}
              </div>
            </section>
          ) : null}
          <div className="workspace-surface">{children}</div>
        </section>
        <div
          aria-label={en ? "Resize right sidebar" : "调整右侧栏宽度"}
          className={rightHidden ? "panel-resizer panel-resizer-right is-collapsed" : "panel-resizer panel-resizer-right"}
          onMouseDown={rightHidden ? undefined : startDrag("right")}
          role="separator"
        />
        <div className={rightHidden ? "app-inspector-slot is-hidden" : "app-inspector-slot"}>{inspector}</div>
      </main>
    </div>
  );
}
