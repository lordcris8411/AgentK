import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Bell, PanelLeft, PanelRight, Trash2, X } from "lucide-react";
import { useSettings } from "../../features/settings/SettingsContext";
import {
  AnsiText,
  useExtensionUi,
} from "../../features/extensions/ExtensionUiContext";
import {
  resumeResponsiveMonacoLayouts,
  suspendResponsiveMonacoLayouts,
} from "../../lib/responsiveMonaco";
import {
  desktopWindow,
  type WindowResizeDirection,
} from "../../lib/platform";

interface AppShellProps {
  sidebar: ReactNode;
  inspector: ReactNode;
  children: ReactNode;
}

interface FrozenPanelContent {
  contain: string;
  element: HTMLElement;
  flex: string;
  height: string;
  transform: string;
  width: string;
  willChange: string;
}

const LEFT_PANEL_MINIMUM = 240;
const RIGHT_PANEL_MINIMUM = 420;
const WORKSPACE_MINIMUM = 780;
const RESIZERS_WIDTH = 12;
const PANEL_POINTER_INTERVAL_MS = 1000 / 60;
const PANEL_TOGGLE_LAYOUT_DELAY_MS = 260;
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
  const appWindow = desktopWindow;
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
  const frameRef = useRef<HTMLDivElement | null>(null);
  const panelResizeFrame = useRef<number | undefined>(undefined);
  const panelCommitFrame = useRef<number | undefined>(undefined);
  const panelToggleTimer = useRef<number | undefined>(undefined);
  const frozenPanelContents = useRef<FrozenPanelContent[]>([]);
  const panelPreviewRef = useRef<HTMLDivElement | null>(null);
  const panelPreviewX = useRef(0);
  const pendingPanelClientX = useRef<number | undefined>(undefined);
  const panelArmMoveHandlerRef = useRef<(() => void) | undefined>(
    undefined,
  );
  const panelStopHandlerRef = useRef<((event?: Event) => void) | undefined>(
    undefined,
  );
  leftHiddenRef.current = leftHidden;
  rightHiddenRef.current = rightHidden;
  updateSettingsRef.current = updateSettings;

  const freezeHeavyPanelContents = () => {
    if (frozenPanelContents.current.length) return;
    const elements = frameRef.current?.querySelectorAll<HTMLElement>(
      ".message-list",
    );
    frozenPanelContents.current = Array.from(elements ?? [], (element) => {
      const bounds = element.getBoundingClientRect();
      const frozen = {
        contain: element.style.contain,
        element,
        flex: element.style.flex,
        height: element.style.height,
        transform: element.style.transform,
        width: element.style.width,
        willChange: element.style.willChange,
      };
      element.style.contain = "strict";
      element.style.flex = `0 0 ${bounds.height}px`;
      element.style.height = `${bounds.height}px`;
      element.style.width = `${bounds.width}px`;
      element.style.transform = "translate3d(0, 0, 0)";
      element.style.willChange = "transform";
      return frozen;
    });
  };
  const releaseHeavyPanelContents = () => {
    for (const frozen of frozenPanelContents.current) {
      frozen.element.style.contain = frozen.contain;
      frozen.element.style.flex = frozen.flex;
      frozen.element.style.height = frozen.height;
      frozen.element.style.transform = frozen.transform;
      frozen.element.style.width = frozen.width;
      frozen.element.style.willChange = frozen.willChange;
    }
    frozenPanelContents.current = [];
  };

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
      .setSize({ width: settings.windowWidth, height: settings.windowHeight })
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
    let panelMoveTimer: number | undefined;
    let panelMoveListenerArmed = false;
    const detachPanelListeners = () => {
      if (panelMoveTimer !== undefined) {
        window.clearTimeout(panelMoveTimer);
        panelMoveTimer = undefined;
      }
      window.removeEventListener("mousemove", move);
      panelMoveListenerArmed = false;
      if (panelStopHandlerRef.current) {
        window.removeEventListener("mouseup", panelStopHandlerRef.current);
        window.removeEventListener("blur", panelStopHandlerRef.current);
      }
    };
    const writePanelLayout = () => {
      const left = leftHiddenRef.current ? "0px" : `${leftWidthRef.current}px`;
      const right = rightHiddenRef.current ? "0px" : `${rightWidthRef.current}px`;
      document.documentElement.style.setProperty("--left-panel-width", left);
      document.documentElement.style.setProperty("--right-panel-width", right);
      frameRef.current?.style.setProperty("--left-panel-width", left);
      frameRef.current?.style.setProperty("--right-panel-width", right);
      if (panelPreviewRef.current)
        panelPreviewRef.current.style.transform = `translate3d(${panelPreviewX.current}px, 0, 0)`;
    };
    const finishPanelCommit = () => {
      document.body.classList.remove("is-resizing-panels");
      releaseHeavyPanelContents();
      resumeResponsiveMonacoLayouts();
      panelCommitFrame.current = undefined;
    };
    const updateDragPosition = (clientX: number) => {
      if (!drag.current) return;
      if (drag.current === "left") {
        const nextLeft = Math.max(
          LEFT_PANEL_MINIMUM,
          Math.min(
            window.innerWidth - (rightHiddenRef.current ? 0 : rightWidthRef.current) - WORKSPACE_MINIMUM - RESIZERS_WIDTH,
            clientX,
          ),
        );
        leftWidthRef.current = nextLeft;
        leftRatioRef.current = nextLeft / window.innerWidth;
        panelPreviewX.current = nextLeft;
      } else {
        const nextRight = Math.max(
          RIGHT_PANEL_MINIMUM,
          Math.min(
            window.innerWidth - (leftHiddenRef.current ? 0 : leftWidthRef.current) - WORKSPACE_MINIMUM - RESIZERS_WIDTH,
            window.innerWidth - clientX,
          ),
        );
        rightWidthRef.current = nextRight;
        rightRatioRef.current = nextRight / window.innerWidth;
        panelPreviewX.current = window.innerWidth - nextRight;
      }
    };
    const applyPanelLayout = () => {
      panelResizeFrame.current = undefined;
      const clientX = pendingPanelClientX.current;
      pendingPanelClientX.current = undefined;
      if (clientX === undefined || !drag.current) return;
      updateDragPosition(clientX);
      writePanelLayout();
    };
    const schedulePanelLayout = () => {
      if (panelResizeFrame.current !== undefined) return;
      panelResizeFrame.current = requestAnimationFrame(applyPanelLayout);
    };
    function armPanelMoveListener() {
      if (!drag.current || panelMoveListenerArmed) return;
      panelMoveListenerArmed = true;
      window.addEventListener("mousemove", move, { once: true });
    }
    function move(event: MouseEvent) {
      panelMoveListenerArmed = false;
      if (!drag.current) return;
      pendingPanelClientX.current = event.clientX;
      schedulePanelLayout();
      // Keep the listener detached between samples. A 1000 Hz mouse can then
      // invoke the renderer at most once per 16.7 ms instead of once for every
      // hardware report.
      panelMoveTimer = window.setTimeout(() => {
        panelMoveTimer = undefined;
        armPanelMoveListener();
      }, PANEL_POINTER_INTERVAL_MS);
    }
    const stop = (event?: Event) => {
      detachPanelListeners();
      if (!drag.current) return;
      if (event instanceof MouseEvent && event.type === "mouseup")
        pendingPanelClientX.current = event.clientX;
      if (panelResizeFrame.current !== undefined) {
        cancelAnimationFrame(panelResizeFrame.current);
        panelResizeFrame.current = undefined;
      }
      if (pendingPanelClientX.current !== undefined) {
        updateDragPosition(pendingPanelClientX.current);
        pendingPanelClientX.current = undefined;
        writePanelLayout();
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
      // Keep grid transitions disabled until React has committed the final
      // width, so releasing the pointer cannot animate from a stale value.
      panelCommitFrame.current = requestAnimationFrame(finishPanelCommit);
    };
    panelArmMoveHandlerRef.current = armPanelMoveListener;
    panelStopHandlerRef.current = stop;
    return () => {
      detachPanelListeners();
      if (panelResizeFrame.current !== undefined)
        cancelAnimationFrame(panelResizeFrame.current);
      if (panelCommitFrame.current !== undefined)
        cancelAnimationFrame(panelCommitFrame.current);
      if (panelToggleTimer.current !== undefined)
        window.clearTimeout(panelToggleTimer.current);
      if (restoreTimerRef.current !== undefined)
        window.clearTimeout(restoreTimerRef.current);
      finishPanelCommit();
      releaseHeavyPanelContents();
      document.body.classList.remove("is-resizing");
      document.body.classList.remove("is-resizing-panels");
      panelArmMoveHandlerRef.current = undefined;
      panelStopHandlerRef.current = undefined;
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
      if (panelToggleTimer.current !== undefined) {
        window.clearTimeout(panelToggleTimer.current);
        panelToggleTimer.current = undefined;
      }
      pendingPanelClientX.current = event.clientX;
      freezeHeavyPanelContents();
      suspendResponsiveMonacoLayouts();
      panelPreviewX.current = event.clientX;
      if (panelPreviewRef.current)
        panelPreviewRef.current.style.transform = `translate3d(${event.clientX}px, 0, 0)`;
      panelArmMoveHandlerRef.current?.();
      if (panelStopHandlerRef.current) {
        window.addEventListener("mouseup", panelStopHandlerRef.current);
        window.addEventListener("blur", panelStopHandlerRef.current);
      }
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
  const suspendMonacoForPanelToggle = () => {
    freezeHeavyPanelContents();
    suspendResponsiveMonacoLayouts();
    if (panelToggleTimer.current !== undefined)
      window.clearTimeout(panelToggleTimer.current);
    panelToggleTimer.current = window.setTimeout(() => {
      panelToggleTimer.current = undefined;
      if (!drag.current) {
        releaseHeavyPanelContents();
        resumeResponsiveMonacoLayouts();
      }
    }, PANEL_TOGGLE_LAYOUT_DELAY_MS);
  };
  const toggleLeftPanel = () => {
    suspendMonacoForPanelToggle();
    const hidden = !leftHidden;
    setLeftHidden(hidden);
    void updateSettingsRef.current({ leftPanelHidden: hidden }).catch(() => undefined);
  };
  const toggleRightPanel = () => {
    suspendMonacoForPanelToggle();
    const hidden = !rightHidden;
    setRightHidden(hidden);
    void updateSettingsRef.current({ rightPanelHidden: hidden }).catch(() => undefined);
  };
  const resizeWindow =
    (direction: WindowResizeDirection) =>
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0 || windowMaximized) return;
      event.preventDefault();
      event.stopPropagation();
      let frame: number | undefined;
      let pending = { x: event.screenX, y: event.screenY };
      const flush = () => {
        frame = undefined;
        void appWindow.updateResize(pending.x, pending.y).catch(() => undefined);
      };
      const move = (moveEvent: MouseEvent) => {
        pending = { x: moveEvent.screenX, y: moveEvent.screenY };
        if (frame === undefined) frame = requestAnimationFrame(flush);
      };
      const stop = (stopEvent: MouseEvent) => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", stop);
        if (frame !== undefined) cancelAnimationFrame(frame);
        void appWindow
          .updateResize(stopEvent.screenX, stopEvent.screenY)
          .finally(() => appWindow.endResize())
          .catch(() => undefined);
      };
      void appWindow
        .beginResize(direction, event.screenX, event.screenY)
        .catch(() => undefined);
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", stop);
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
      <div aria-hidden="true" className="panel-resize-preview" ref={panelPreviewRef} />
      <header className="window-titlebar">
        <div
          aria-label={en ? "Drag window" : "拖动窗口"}
          className="window-drag-region"
          onDoubleClick={() => void toggleMaximize()}
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
