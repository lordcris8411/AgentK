import { createPortal } from "react-dom";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { ProjectSummary, SessionSummary } from "../../lib/desktop";
import { useSettings } from "../settings/SettingsContext";

type SessionAction = "delete" | "rename";

export function SessionSidebar({
  projects,
  activePath,
  onSelect,
  onDelete,
  onRename,
  onClone,
  onOpenFolder,
  onAddWorkspace,
  onNew,
  onSelectProject,
  onSettings,
  runningPaths,
}: {
  projects: ProjectSummary[];
  activePath?: string;
  onSelect(session: SessionSummary): void;
  onDelete(session: SessionSummary): void | Promise<void>;
  onRename(session: SessionSummary, name: string): void | Promise<void>;
  onClone(session: SessionSummary): void | Promise<void>;
  onOpenFolder(session: SessionSummary): void | Promise<void>;
  onAddWorkspace(): void;
  onNew(cwd?: string): void;
  onSelectProject(cwd: string): void;
  onSettings(): void;
  runningPaths: Set<string>;
}) {
  const { t } = useSettings();
  const [contextMenu, setContextMenu] = useState<{
    session: SessionSummary;
    x: number;
    y: number;
  }>();
  const [dialog, setDialog] = useState<{
    action: SessionAction;
    session: SessionSummary;
  }>();
  const [renameName, setRenameName] = useState("");
  const [busy, setBusy] = useState(false);
  const renameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(undefined);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (dialog?.action !== "rename") return;
    requestAnimationFrame(() => {
      renameInput.current?.focus();
      renameInput.current?.select();
    });
  }, [dialog]);

  const showContextMenu = (
    session: SessionSummary,
    event: ReactMouseEvent,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const width = 218;
    const height = 160;
    setContextMenu({
      session,
      x: Math.max(6, Math.min(event.clientX, window.innerWidth - width - 6)),
      y: Math.max(6, Math.min(event.clientY, window.innerHeight - height - 6)),
    });
  };

  const openRename = (session: SessionSummary) => {
    setContextMenu(undefined);
    setRenameName(session.name ?? session.id.slice(0, 8));
    setDialog({ action: "rename", session });
  };

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    if (dialog?.action !== "rename" || !renameName.trim() || busy) return;
    setBusy(true);
    try {
      await onRename(dialog.session, renameName.trim());
      setDialog(undefined);
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (dialog?.action !== "delete" || busy) return;
    setBusy(true);
    try {
      await onDelete(dialog.session);
      setDialog(undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sidebar-content">
      <div className="sidebar-header">
        <span className="brand-mark">K</span>
        <span className="brand-name">Agent K</span>
        <button
          aria-label={t("settings")}
          className="plain-icon-button settings-menu-button"
          onClick={onSettings}
          title={t("settings")}
          type="button"
        >
          <i aria-hidden="true" className="fa-solid fa-bars" />
        </button>
      </div>
      <button className="new-task-button" onClick={onAddWorkspace} type="button">
        <span aria-hidden="true">
          <i className="fa-solid fa-folder-plus" />
        </span>
        {t("addWorkspace")}
      </button>
      <p className="section-label">{t("workspaces")}</p>
      <nav className="session-list">
        {projects.map((project) => (
          <details key={project.cwd} open>
            <summary
              className="project-summary"
              onClick={() => onSelectProject(project.cwd)}
            >
              <i
                aria-hidden="true"
                className="fa-solid fa-chevron-right project-icon"
              />
              <span aria-hidden="true" className="project-folder-icons">
                <i className="fa-regular fa-folder folder-closed" />
                <i className="fa-regular fa-folder-open folder-open" />
              </span>
              <span>{project.name}</span>
              <small>{project.sessions.length}</small>
              <button
                aria-label={`在 ${project.name} 中新建 session`}
                className="project-new-session"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onNew(project.cwd);
                }}
                type="button"
              >
                ＋
              </button>
            </summary>
            <div className="project-sessions">
              {project.sessions.map((session) => {
                const running = runningPaths.has(session.path);
                return (
                  <div
                    className="session-row"
                    key={session.path}
                    onContextMenu={(event) => showContextMenu(session, event)}
                  >
                    <button
                      aria-current={
                        activePath === session.path ? "page" : undefined
                      }
                      className={
                        activePath === session.path
                          ? "session-item is-active"
                          : "session-item"
                      }
                      onClick={() => onSelect(session)}
                      type="button"
                    >
                      <span className="session-title">
                        {session.name ?? session.id.slice(0, 8)}
                      </span>
                    </button>
                    {running ? (
                      <span
                        aria-label={t("running")}
                        className="session-running-indicator"
                        role="status"
                      >
                        <i
                          aria-hidden="true"
                          className="fa-solid fa-spinner session-running-spinner"
                        />
                      </span>
                    ) : (
                      <button
                        aria-label={t("deleteSession")}
                        className="row-action"
                        onClick={(event) => {
                          event.stopPropagation();
                          setDialog({ action: "delete", session });
                        }}
                        type="button"
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </details>
        ))}
      </nav>
      <div className="sidebar-footer">
        <span className="connection-dot" />
        <span>{t("localPi")}</span>
        <span className="connection-label">{t("connected")}</span>
      </div>
      {contextMenu
        ? createPortal(
            <div
              className="file-context-menu session-context-menu"
              onContextMenu={(event) => event.preventDefault()}
              onPointerDown={(event) => event.stopPropagation()}
              role="menu"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              <button
                onClick={() => openRename(contextMenu.session)}
                role="menuitem"
                type="button"
              >
                <i className="fa-regular fa-pen-to-square" />
                {t("renameSession")}
              </button>
              <button
                onClick={() => {
                  const session = contextMenu.session;
                  setContextMenu(undefined);
                  void onClone(session);
                }}
                role="menuitem"
                type="button"
              >
                <i className="fa-regular fa-copy" />
                {t("copySession")}
              </button>
              <button
                onClick={() => {
                  const session = contextMenu.session;
                  setContextMenu(undefined);
                  void onOpenFolder(session);
                }}
                role="menuitem"
                type="button"
              >
                <i className="fa-regular fa-folder-open" />
                {t("openFolder")}
              </button>
              <div className="file-context-separator" />
              <button
                disabled={runningPaths.has(contextMenu.session.path)}
                onClick={() => {
                  setDialog({ action: "delete", session: contextMenu.session });
                  setContextMenu(undefined);
                }}
                role="menuitem"
                type="button"
              >
                <i className="fa-regular fa-trash-can" />
                {t("deleteSession")}
              </button>
            </div>,
            document.body,
          )
        : null}
      {dialog
        ? createPortal(
            <div
              className="session-dialog-backdrop"
              onPointerDown={() => !busy && setDialog(undefined)}
            >
              {dialog.action === "rename" ? (
                <form
                  className="session-dialog-card"
                  onPointerDown={(event) => event.stopPropagation()}
                  onSubmit={submitRename}
                >
                  <h2>{t("renameSession")}</h2>
                  <label>
                    {t("sessionName")}
                    <input
                      disabled={busy}
                      onChange={(event) => setRenameName(event.target.value)}
                      ref={renameInput}
                      value={renameName}
                    />
                  </label>
                  <footer>
                    <button onClick={() => setDialog(undefined)} type="button">
                      {t("cancel")}
                    </button>
                    <button
                      className="primary-button"
                      disabled={!renameName.trim() || busy}
                      type="submit"
                    >
                      {t("confirm")}
                    </button>
                  </footer>
                </form>
              ) : (
                <div
                  className="session-dialog-card"
                  onPointerDown={(event) => event.stopPropagation()}
                  role="alertdialog"
                >
                  <h2>{t("deleteSession")}</h2>
                  <p>{t("deleteSessionConfirm")}</p>
                  <strong>
                    {dialog.session.name ?? dialog.session.id.slice(0, 8)}
                  </strong>
                  <footer>
                    <button onClick={() => setDialog(undefined)} type="button">
                      {t("cancel")}
                    </button>
                    <button
                      className="danger-button"
                      disabled={busy}
                      onClick={() => void confirmDelete()}
                      type="button"
                    >
                      {t("delete")}
                    </button>
                  </footer>
                </div>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
