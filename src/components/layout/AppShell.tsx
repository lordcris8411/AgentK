import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
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
const WORKSPACE_MINIMUM = 780;
const RESIZERS_WIDTH = 12;
type WindowResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";
const WINDOW_RESIZE_DIRECTIONS: WindowResizeDirection[] = [
  "North",
  "NorthEast",
  "East",
  "SouthEast",
  "South",
  "SouthWest",
  "West",
  "NorthWest",
];

export function AppShell({ sidebar, inspector, children }: AppShellProps) {
  const appWindow = getCurrentWindow();
  const { ready, settings, t, update: updateSettings } = useSettings();
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
  const [leftWidth, setLeftWidth] = useState(settings.leftPanelWidth);
  const [rightWidth, setRightWidth] = useState(settings.rightPanelWidth);
  const [leftHidden, setLeftHidden] = useState(settings.leftPanelHidden);
  const [rightHidden, setRightHidden] = useState(settings.rightPanelHidden);
  const [windowMaximized, setWindowMaximized] = useState(false);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLElement | null>(null);
  const leftWidthRef = useRef(leftWidth);
  const rightWidthRef = useRef(rightWidth);
  const leftHiddenRef = useRef(leftHidden);
  const rightHiddenRef = useRef(rightHidden);
  const windowWidthRef = useRef(window.innerWidth);
  const leftRatioRef = useRef(leftWidth / window.innerWidth);
  const rightRatioRef = useRef(rightWidth / window.innerWidth);
  const updateSettingsRef = useRef(updateSettings);
  const restoredLayoutRef = useRef(false);
  const restoringWindowRef = useRef(false);
  const restoreTimerRef = useRef<number | undefined>(undefined);
  const drag = useRef<"left" | "right" | undefined>(undefined);
  const panelResizeFrame = useRef<number | undefined>(undefined);
  const panelCommitFrame = useRef<number | undefined>(undefined);
  const frozenPanelContents = useRef<
    Array<{
      contain: string;
      element: HTMLElement;
      width: string;
    }>
  >([]);
  const floatingWorkspaceElements = useRef<
    Array<{
      element: HTMLElement;
      leftWidth: string;
      rightWidth: string;
    }>
  >([]);
  leftHiddenRef.current = leftHidden;
  rightHiddenRef.current = rightHidden;
  updateSettingsRef.current = updateSettings;

  useEffect(() => {
    if (!ready || restoredLayoutRef.current) return;
    restoredLayoutRef.current = true;
    restoringWindowRef.current = true;

    leftWidthRef.current = settings.leftPanelWidth;
    rightWidthRef.current = settings.rightPanelWidth;
    leftHiddenRef.current = settings.leftPanelHidden;
    rightHiddenRef.current = settings.rightPanelHidden;
    leftRatioRef.current = settings.leftPanelWidth / settings.windowWidth;
    rightRatioRef.current = settings.rightPanelWidth / settings.windowWidth;
    setLeftWidth(settings.leftPanelWidth);
    setRightWidth(settings.rightPanelWidth);
    setLeftHidden(settings.leftPanelHidden);
    setRightHidden(settings.rightPanelHidden);

    void appWindow
      .setSize(new LogicalSize(settings.windowWidth, settings.windowHeight))
      .then(async () => {
        if (settings.windowMaximized) await appWindow.maximize();
        else if (await appWindow.isMaximized()) await appWindow.unmaximize();
      })
      .catch(() => undefined)
      .finally(() => {
        restoreTimerRef.current = window.setTimeout(() => {
          windowWidthRef.current = window.innerWidth;
          restoringWindowRef.current = false;
          restoreTimerRef.current = undefined;
        }, 350);
      });
  }, [
    appWindow,
    ready,
    settings.leftPanelHidden,
    settings.leftPanelWidth,
    settings.rightPanelHidden,
    settings.rightPanelWidth,
    settings.windowHeight,
    settings.windowMaximized,
    settings.windowWidth,
  ]);

  useEffect(() => {
    let disposed = false;
    let stopResizeListener: (() => void) | undefined;
    let persistTimer: number | undefined;
    const syncMaximized = () => {
      void appWindow
        .isMaximized()
        .then((maximized) => {
          if (disposed) return;
          setWindowMaximized(maximized);
          if (restoringWindowRef.current) return;
          if (persistTimer !== undefined) window.clearTimeout(persistTimer);
          persistTimer = window.setTimeout(() => {
            const patch = maximized
              ? { windowMaximized: true }
              : {
                  windowHeight: window.innerHeight,
                  windowMaximized: false,
                  windowWidth: window.innerWidth,
                };
            void updateSettingsRef.current(patch).catch(() => undefined);
            persistTimer = undefined;
          }, 250);
        })
        .catch(() => undefined);
    };
    syncMaximized();
    void appWindow
      .onResized(syncMaximized)
      .then((unlisten) => {
        if (disposed) unlisten();
        else stopResizeListener = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      if (persistTimer !== undefined) window.clearTimeout(persistTimer);
      stopResizeListener?.();
    };
  }, []);
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
    const applyPanelWidths = () => {
      panelResizeFrame.current = undefined;
      const left = leftHiddenRef.current ? "0px" : `${leftWidthRef.current}px`;
      const right = rightHiddenRef.current ? "0px" : `${rightWidthRef.current}px`;
      if (shellRef.current) {
        shellRef.current.style.gridTemplateColumns = `${left} 6px minmax(${WORKSPACE_MINIMUM}px, 1fr) 6px ${right}`;
      }
      for (const { element } of floatingWorkspaceElements.current) {
        element.style.setProperty("--left-panel-width", left);
        element.style.setProperty("--right-panel-width", right);
      }
    };
    const releaseFrozenPanelContents = () => {
      for (const { contain, element, width } of frozenPanelContents.current) {
        element.style.contain = contain;
        element.style.width = width;
      }
      frozenPanelContents.current = [];
      for (const {
        element,
        leftWidth,
        rightWidth,
      } of floatingWorkspaceElements.current) {
        element.style.setProperty("--left-panel-width", leftWidth);
        element.style.setProperty("--right-panel-width", rightWidth);
      }
      floatingWorkspaceElements.current = [];
      shellRef.current?.style.removeProperty("grid-template-columns");
      // Keep the placeholder visible until the final React width has been
      // committed and the frozen panel contents are ready to lay out again.
      document.body.classList.remove("is-resizing-panels");
      panelCommitFrame.current = undefined;
    };
    const schedulePanelWidths = () => {
      if (panelResizeFrame.current !== undefined) return;
      panelResizeFrame.current = requestAnimationFrame(applyPanelWidths);
    };
    const move = (event: MouseEvent) => {
      if (!drag.current) return;
      if (drag.current === "left") {
        const nextLeft = Math.max(
          LEFT_PANEL_MINIMUM,
          Math.min(
            window.innerWidth - (rightHiddenRef.current ? 0 : rightWidthRef.current) - WORKSPACE_MINIMUM - RESIZERS_WIDTH,
            event.clientX,
          ),
        );
        leftWidthRef.current = nextLeft;
        leftRatioRef.current = nextLeft / window.innerWidth;
      } else {
        const nextRight = Math.max(
          RIGHT_PANEL_MINIMUM,
          Math.min(
            window.innerWidth - (leftHiddenRef.current ? 0 : leftWidthRef.current) - WORKSPACE_MINIMUM - RESIZERS_WIDTH,
            window.innerWidth - event.clientX,
          ),
        );
        rightWidthRef.current = nextRight;
        rightRatioRef.current = nextRight / window.innerWidth;
      }
      schedulePanelWidths();
    };
    const stop = () => {
      if (!drag.current) return;
      if (panelResizeFrame.current !== undefined) {
        cancelAnimationFrame(panelResizeFrame.current);
        applyPanelWidths();
      }
      drag.current = undefined;
      setLeftWidth(leftWidthRef.current);
      setRightWidth(rightWidthRef.current);
      void updateSettingsRef
        .current({
          leftPanelWidth: Math.round(leftWidthRef.current),
          rightPanelWidth: Math.round(rightWidthRef.current),
        })
        .catch(() => undefined);
      document.body.classList.remove("is-resizing");
      windowWidthRef.current = window.innerWidth;
      if (panelCommitFrame.current !== undefined) {
        cancelAnimationFrame(panelCommitFrame.current);
      }
      // React commits the final CSS variables before the next frame. Keep the
      // concrete grid tracks and frozen child widths until then so releasing
      // the pointer cannot briefly jump back to the previous dimensions.
      panelCommitFrame.current = requestAnimationFrame(releaseFrozenPanelContents);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
    return () => {
      if (panelResizeFrame.current !== undefined)
        cancelAnimationFrame(panelResizeFrame.current);
      if (panelCommitFrame.current !== undefined)
        cancelAnimationFrame(panelCommitFrame.current);
      if (restoreTimerRef.current !== undefined)
        window.clearTimeout(restoreTimerRef.current);
      releaseFrozenPanelContents();
      document.body.classList.remove("is-resizing");
      document.body.classList.remove("is-resizing-panels");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
    };
  }, []);
  const startDrag =
    (side: "left" | "right") => (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag.current = side;
      if (panelCommitFrame.current !== undefined) {
        cancelAnimationFrame(panelCommitFrame.current);
        panelCommitFrame.current = undefined;
      }
      const panelContents = frameRef.current?.querySelectorAll<HTMLElement>(
        ".app-sidebar > *, .workspace-surface, .app-inspector-slot > *",
      );
      frozenPanelContents.current = Array.from(panelContents ?? [], (element) => {
        const frozen = {
          contain: element.style.contain,
          element,
          width: element.style.width,
        };
        element.style.width = `${element.getBoundingClientRect().width}px`;
        // layout/paint containment creates a containing block for fixed
        // descendants. The composer lives inside workspace-surface but is
        // positioned against the viewport, so strict containment would shift
        // and clip it while dragging a panel. Size containment still freezes
        // the expensive conversation layout without changing that coordinate
        // system.
        element.style.contain = element.matches(".workspace-surface")
          ? "size style"
          : "strict";
        return frozen;
      });
      const floatingElements = frameRef.current?.querySelectorAll<HTMLElement>(
        ".composer, .extension-dialog-backdrop.is-select .extension-dialog.is-select",
      );
      floatingWorkspaceElements.current = Array.from(
        floatingElements ?? [],
        (element) => ({
          element,
          leftWidth: element.style.getPropertyValue("--left-panel-width"),
          rightWidth: element.style.getPropertyValue("--right-panel-width"),
        }),
      );
      document.body.classList.add("is-resizing");
      document.body.classList.add("is-resizing-panels");
    };
  const toggleMaximize = async () => {
    if (await appWindow.isMaximized()) {
      await appWindow.unmaximize();
      setWindowMaximized(false);
    } else {
      await appWindow.maximize();
      setWindowMaximized(true);
    }
  };
  const toggleLeftPanel = () => {
    const hidden = !leftHidden;
    setLeftHidden(hidden);
    void updateSettingsRef.current({ leftPanelHidden: hidden }).catch(() => undefined);
  };
  const toggleRightPanel = () => {
    const hidden = !rightHidden;
    setRightHidden(hidden);
    void updateSettingsRef.current({ rightPanelHidden: hidden }).catch(() => undefined);
  };
  const dragWindow = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button === 0) void appWindow.startDragging();
  };
  const resizeWindow =
    (direction: WindowResizeDirection) =>
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0 || windowMaximized) return;
      event.preventDefault();
      event.stopPropagation();
      void appWindow.startResizeDragging(direction).catch(() => undefined);
    };
  const layoutStyle = {
    "--left-panel-width": leftHidden ? "0px" : `${leftWidth}px`,
    "--right-panel-width": rightHidden ? "0px" : `${rightWidth}px`,
  } as Record<string, string>;
  return (
    <div
      className={windowMaximized ? "app-frame is-maximized" : "app-frame"}
      ref={frameRef}
      style={layoutStyle}
    >
      {WINDOW_RESIZE_DIRECTIONS.map((direction) => (
        <div
          aria-hidden="true"
          className={`window-resize-handle is-${direction.toLowerCase()}`}
          key={direction}
          onMouseDown={resizeWindow(direction)}
        />
      ))}
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
      <main className="app-shell" ref={shellRef}>
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
              onClick={toggleLeftPanel}
              title={leftHidden ? (en ? "Show left sidebar" : "显示左侧栏") : (en ? "Hide left sidebar" : "隐藏左侧栏")}
              type="button"
            >
              <PanelLeft aria-hidden="true" size={16} strokeWidth={1.8} />
            </button>
            <button
              aria-label={rightHidden ? (en ? "Show right sidebar" : "显示右侧栏") : (en ? "Hide right sidebar" : "隐藏右侧栏")}
              className={rightHidden ? "workspace-panel-button is-collapsed" : "workspace-panel-button"}
              onClick={toggleRightPanel}
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
