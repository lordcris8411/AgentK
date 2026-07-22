import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AppShell } from "./components/layout/AppShell";
import { InspectorPanel } from "./components/layout/InspectorPanel";
import { ConversationWorkspace } from "./features/conversation/ConversationWorkspace";
import { SessionSidebar } from "./features/sessions/SessionSidebar";
import type { ReviewCall } from "./features/conversation/ReviewPanel";
import {
  desktop,
  type PiResourceChange,
  type ProjectSummary,
  type SessionSummary,
} from "./lib/desktop";
import { SettingsDialog, type SettingsPage } from "./features/settings/SettingsDialog";
import { useSettings } from "./features/settings/SettingsContext";
import { useExtensionUi } from "./features/extensions/ExtensionUiContext";
import { platform } from "./lib/platform";

const DRAFT_SESSION_PATH = "__new__";

export function App() {
  const { settings } = useSettings();
  const { cancelPending, clearSessionUi, setActiveRuntimeId } = useExtensionUi();
  const en = settings.locale === "en-US";
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [workspaceCwd, setWorkspaceCwd] = useState<string>();
  const [booting, setBooting] = useState(true);
  const [bootMessage, setBootMessage] = useState<string>();
  const [busyMessage, setBusyMessage] = useState<string>();
  const busyVersion = useRef(0);
  const busyTimer = useRef<number | undefined>(undefined);
  const busyFrame = useRef<number | undefined>(undefined);
  const [active, setActive] = useState<SessionSummary>();
  const [historySeed, setHistorySeed] = useState<{
    path: string;
    messages: Array<Record<string, unknown>>;
  }>();
  const activeRef = useRef<SessionSummary | undefined>(undefined);
  const warmupRef = useRef<{ cwd: string; ready: Promise<string> } | undefined>(
    undefined,
  );
  const runtimeIds = useRef(new Map<string, string>());
  const [runningPaths, setRunningPaths] = useState<Set<string>>(new Set());
  const [readyPath, setReadyPath] = useState<string>();
  const [connecting, setConnecting] = useState(false);
  const selectionVersion = useRef(0);
  const selectionBusy = useRef<{
    version: number;
    path: string;
    finish(): void;
  } | undefined>(undefined);
  const [error, setError] = useState<string>();
  const [reviewCalls, setReviewCalls] = useState<ReviewCall[]>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("models");
  useEffect(() => {
    const openSettings = (event: Event) => {
      const page = (event as CustomEvent<{ page?: SettingsPage }>).detail?.page;
      setSettingsPage(page ?? "models");
      setSettingsOpen(true);
    };
    const updateSessionName = (event: Event) => {
      const name = (event as CustomEvent<{ name?: string }>).detail?.name?.trim();
      const current = activeRef.current;
      if (!name || !current) return;
      const renamed = { ...current, name };
      activeRef.current = renamed;
      setActive(renamed);
      setProjects((projects) => projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((session) => session.path === current.path ? renamed : session),
      })));
    };
    window.addEventListener("agent-k-open-settings", openSettings);
    window.addEventListener("agent-k-session-name", updateSessionName);
    return () => {
      window.removeEventListener("agent-k-open-settings", openSettings);
      window.removeEventListener("agent-k-session-name", updateSessionName);
    };
  }, []);
  const beginBusy = (
    message: string,
    delay = 220,
    minimumVisible = 320,
  ) => {
    const version = ++busyVersion.current;
    const startedAt = performance.now();
    let shownAt: number | undefined;
    if (busyTimer.current !== undefined)
      window.clearTimeout(busyTimer.current);
    if (busyFrame.current !== undefined)
      window.cancelAnimationFrame(busyFrame.current);
    // A completed operation must never leave its already-visible splash on
    // screen while a newer, fast operation is running.
    setBusyMessage(undefined);
    const show = () => {
      if (busyVersion.current !== version) return;
      shownAt = performance.now();
      flushSync(() => setBusyMessage(message));
    };
    if (delay <= 0) show();
    else busyTimer.current = window.setTimeout(show, delay);
    return () => {
      if (busyVersion.current !== version) return;
      if (busyTimer.current !== undefined) {
        window.clearTimeout(busyTimer.current);
        busyTimer.current = undefined;
      }
      const now = performance.now();
      // A large IPC response can occupy the renderer when the threshold timer
      // becomes due. In that case React would otherwise receive "show" and
      // "hide" before a paint and the splash would never be visible. Use the
      // measured wall time as the source of truth and keep a triggered splash
      // visible long enough to render cleanly.
      if (shownAt === undefined && now - startedAt >= delay) {
        shownAt = now;
        flushSync(() => setBusyMessage(message));
      }
      if (shownAt !== undefined) {
        if (minimumVisible <= 0) {
          setBusyMessage(undefined);
          return;
        }
        const remaining = Math.max(0, minimumVisible - (now - shownAt));
        // Do not schedule the hide until the browser has had an explicit
        // rendering opportunity. This prevents a due timer and an IPC
        // completion from mounting and unmounting the splash between paints.
        busyFrame.current = window.requestAnimationFrame(() => {
          busyFrame.current = undefined;
          busyTimer.current = window.setTimeout(() => {
            if (busyVersion.current !== version) return;
            busyTimer.current = undefined;
            setBusyMessage(undefined);
          }, remaining);
        });
      } else {
        setBusyMessage(undefined);
      }
    };
  };
  const closeSettings = (
    changes: PiResourceChange[],
    editorSettingsChanged: boolean,
  ) => {
    setSettingsOpen(false);
    if (changes.length === 0 && !editorSettingsChanged) return;
    const cwd = activeRef.current?.cwd;
    if (!cwd) {
      if (editorSettingsChanged) {
        const finishBusy = beginBusy(
          en ? "Applying Editor settings…" : "正在应用 Editor 设置…",
          0,
          420,
        );
        void desktop.reloadPiRuntimes()
          .then(() => window.dispatchEvent(new Event("agent-k-resources-changed")))
          .catch((cause) => setError(String(cause)))
          .finally(finishBusy);
        return;
      }
      setError(en ? "Select a workspace before changing Pi resources" : "请先选择工作区再修改 Pi 资源");
      return;
    }
    const finishBusy = beginBusy(
      en ? "Applying file plugin, Extension, and Skill settings…" : "正在应用文件插件、Extension 和 Skill 设置…",
      0,
      420,
    );
    void desktop.applyPiResourceChanges(cwd, changes, editorSettingsChanged)
      .then(() => window.dispatchEvent(new Event("agent-k-resources-changed")))
      .catch((cause) => setError(String(cause)))
      .finally(finishBusy);
  };
  const reload = async () => {
    try {
      const loaded = await desktop.listProjects();
      setProjects(loaded);
      return loaded;
    } catch (cause) {
      setError(String(cause));
      return undefined;
    }
  };
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [loaded, persistedSettings] = await Promise.all([
          desktop.listProjects(),
          desktop.getSettings(),
          document.fonts.ready,
        ]);
        if (cancelled) return;
        setProjects(loaded);
        const defaultProject =
          loaded.find((project) => !project.isHome) ?? loaded[0];
        const initialCwd = defaultProject?.cwd;
        const warmWorkerCount = persistedSettings.workerPoolSize;
        const startupTheme =
          persistedSettings.theme === "system"
            ? window.matchMedia("(prefers-color-scheme: dark)").matches
              ? "dark"
              : "light"
            : persistedSettings.theme;
        const startupTotal = warmWorkerCount + 1;
        const editorMessage = en
          ? "Configuring Editor plugins…"
          : "配置编辑器插件…";
        setBootMessage(editorMessage);
        await desktop.updateStartupProgress(
          editorMessage,
          0,
          startupTotal,
          startupTheme,
        );
        await desktop.firstPartyFileFormatPlugins();
        // The main window stays hidden behind the native startup window.
        // Chromium may stop delivering animation frames to hidden windows, so
        // startup must never wait for requestAnimationFrame here.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        let completedWorkers = 0;
        const publishProgress = async () => {
          const message = en
            ? `Preparing Pi processes… ${completedWorkers}/${warmWorkerCount}`
            : `正在准备 Pi 进程… ${completedWorkers}/${warmWorkerCount}`;
          setBootMessage(message);
          await desktop
            .updateStartupProgress(
              message,
              completedWorkers + 1,
              startupTotal,
              startupTheme,
            )
            .catch(() => undefined);
        };
        await publishProgress();
        const warmedRuntimeIds = initialCwd
          ? await Promise.all(
              Array.from({ length: warmWorkerCount }, async () => {
                const runtimeId = await desktop.spawnWorker(initialCwd);
                completedWorkers += 1;
                await publishProgress();
                return runtimeId;
              }),
            )
          : [];
        if (initialCwd && warmedRuntimeIds[0]) {
          await desktop.connect(initialCwd, undefined, warmedRuntimeIds[0]);
        }
        // Start with an unpersisted draft. Prewarming only starts the Pi RPC
        // runtime; it does not write a JSONL file or materialize the session.
        if (initialCwd) {
          const draft = {
            id: "new",
            path: DRAFT_SESSION_PATH,
            cwd: initialCwd,
            name: "New session",
            preview: "",
            updatedAt: Math.floor(Date.now() / 1000),
          };
          const ready = warmedRuntimeIds[0]
            ? Promise.resolve(warmedRuntimeIds[0])
            : desktop.prepareSession(initialCwd);
          warmupRef.current = { cwd: initialCwd, ready };
          try {
            const runtimeId = await ready;
            if (!cancelled) {
              const prepared = { ...draft, runtimeId };
              activeRef.current = prepared;
              setActive(prepared);
              setActiveRuntimeId(runtimeId);
              setHistorySeed({ path: DRAFT_SESSION_PATH, messages: [] });
              setWorkspaceCwd(initialCwd);
              setReadyPath(DRAFT_SESSION_PATH);
            }
          } catch (cause) {
            if (warmupRef.current?.ready === ready)
              warmupRef.current = undefined;
            throw cause;
          }
          if (cancelled) return;
        }
      } catch (cause) {
        if (!cancelled) setError(String(cause));
      } finally {
        if (!cancelled) {
          await desktop.finishStartup().catch(() => undefined);
          setBootMessage(undefined);
          setBooting(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const select = async (session: SessionSummary) => {
    const version = ++selectionVersion.current;
    // Keep the current conversation intact while the target session is being
    // prepared. Fast switches commit without any overlay; genuinely slow
    // switches reveal the splash after the grace period.
    const finishBusy = beginBusy(
      en ? "Loading session…" : "正在载入会话…",
      0,
      0,
    );
    selectionBusy.current = { version, path: session.path, finish: finishBusy };
    let committed = false;
    setConnecting(true);
    setError(undefined);
    try {
      // Let the immediate splash reach the compositor before starting work.
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
      const knownRuntime = runtimeIds.current.get(session.path);
      const runtimeId = await desktop.connect(
        session.cwd,
        session.path,
        knownRuntime,
      );
      runtimeIds.current.set(session.path, runtimeId);
      const raw = (await desktop.command(
        { type: "get_messages" },
        runtimeId,
      )) as {
        messages?: Array<Record<string, unknown>>;
      };
      if (version !== selectionVersion.current) return;
      const connectedSession = { ...session, runtimeId };
      activeRef.current = connectedSession;
      setHistorySeed({ path: session.path, messages: raw.messages ?? [] });
      setActive(connectedSession);
      setActiveRuntimeId(runtimeId);
      setWorkspaceCwd(session.cwd);
      setReadyPath(session.path);
      committed = true;
    } catch (cause) {
      if (version === selectionVersion.current) setError(String(cause));
    } finally {
      // A successful switch remains busy until ConversationWorkspace reports
      // that the complete history has been rendered and painted. RPC latency
      // alone does not represent what the user actually waits for.
      if (!committed) {
        finishBusy();
        if (selectionBusy.current?.version === version)
          selectionBusy.current = undefined;
      }
      if (version === selectionVersion.current) setConnecting(false);
    }
  };
  const finishSessionRender = useCallback((path: string) => {
    const pending = selectionBusy.current;
    if (
      !pending ||
      pending.path !== path ||
      pending.version !== selectionVersion.current
    )
      return;
    selectionBusy.current = undefined;
    pending.finish();
  }, []);
  const createSession = (requestedCwd?: string) => {
    const cwd = requestedCwd ?? workspaceCwd ?? active?.cwd ?? projects[0]?.cwd;
    if (!cwd) {
      setError(en ? "No workspace is available; add a workspace first" : "没有可用工作区；请先打开一个 Pi 项目");
      return;
    }
    ++selectionVersion.current;
    // Always render the empty conversation immediately. Connecting Pi is not
    // allowed to delay the composer: the first send will await materialization.
    const draft = {
      id: "new",
      path: DRAFT_SESSION_PATH,
      cwd,
      name: "New session",
      preview: "",
      updatedAt: Math.floor(Date.now() / 1000),
    };
    activeRef.current = draft;
    setActive(draft);
    setActiveRuntimeId(undefined);
    setHistorySeed({ path: DRAFT_SESSION_PATH, messages: [] });
    setWorkspaceCwd(cwd);
    setReadyPath(DRAFT_SESSION_PATH);
    setError(undefined);
    // Start Pi while the user is composing. This creates no JSONL/session;
    // the real session is still materialized only on the first send.
    const ready = desktop.prepareSession(cwd);
    warmupRef.current = { cwd, ready };
    void ready
      .then((runtimeId) => {
        const current = activeRef.current;
        if (current?.path !== DRAFT_SESSION_PATH || current.cwd !== cwd) return;
        const prepared = { ...current, runtimeId };
        activeRef.current = prepared;
        setActive(prepared);
        setActiveRuntimeId(runtimeId);
        if (
          activeRef.current?.path === DRAFT_SESSION_PATH &&
          activeRef.current.cwd === cwd
        )
          setError(undefined);
      })
      .catch((cause) => {
        if (
          activeRef.current?.path === DRAFT_SESSION_PATH &&
          activeRef.current.cwd === cwd
        )
          setError(String(cause));
      });
  };

  useEffect(() => {
    let stop: (() => void) | undefined;
    void desktop.onEvent((event) => {
      const runtimeId =
        typeof event.runtimeId === "string" ? event.runtimeId : undefined;
      const sessionPath =
        typeof event.sessionFile === "string" ? event.sessionFile : undefined;
      const activePathForRuntime =
        !sessionPath && runtimeId && activeRef.current?.runtimeId === runtimeId
          ? activeRef.current.path
          : undefined;
      const eventSessionPath = sessionPath ?? activePathForRuntime;
      if (runtimeId && sessionPath) {
        for (const [path, mappedRuntime] of runtimeIds.current) {
          if (mappedRuntime === runtimeId && path !== sessionPath)
            runtimeIds.current.delete(path);
        }
        runtimeIds.current.set(sessionPath, runtimeId);
      }
      if (event.type === "agent_start" && eventSessionPath) {
        setRunningPaths((current) => new Set(current).add(eventSessionPath));
      }
      if (
        (event.type === "agent_settled" || event.type === "bridge_closed") &&
        runtimeId
      ) {
        setRunningPaths((current) => {
          const next = new Set(current);
          for (const [path, id] of runtimeIds.current)
            if (id === runtimeId) next.delete(path);
          return next;
        });
      }
      if (event.type !== "session_changed" || !runtimeId || !sessionPath)
        return;
      const current = activeRef.current;
      if (current?.runtimeId !== runtimeId) {
        void reload();
        return;
      }
      const previousPath = current.path;
      const next = {
        ...current,
        id:
          typeof event.sessionId === "string" ? event.sessionId : current.id,
        path: sessionPath,
      };
      runtimeIds.current.delete(previousPath);
      runtimeIds.current.set(sessionPath, runtimeId);
      activeRef.current = next;
      setActive(next);
      setReadyPath(sessionPath);
      setHistorySeed(undefined);
      setRunningPaths((paths) => {
        if (!paths.has(previousPath)) return paths;
        const moved = new Set(paths);
        moved.delete(previousPath);
        moved.add(sessionPath);
        return moved;
      });
      void reload();
    }).then((unlisten) => {
      stop = unlisten;
    });
    return () => stop?.();
  }, []);
  const nameNewSession = (message: string) => {
    const current = activeRef.current;
    if (!current || current.name !== "New session") return;
    const text = message.replace(/\s+/g, " ").trim();
    if (!text) return;
    const name = `${Array.from(text).slice(0, 42).join("")}${Array.from(text).length > 42 ? "…" : ""}`;
    const renamed = { ...current, name };
    activeRef.current = renamed;
    setActive(renamed);
    setProjects((currentProjects) =>
      currentProjects.map((project) => ({
        ...project,
        sessions: project.sessions.map((item) =>
          item.path === current.path ? renamed : item,
        ),
      })),
    );
  };
  const addWorkspace = async () => {
    setError(undefined);
    try {
      const selected = await platform.openDialog({
        directory: true,
        multiple: false,
        title: en ? "Select Agent K workspace" : "选择 Agent K 工作区",
      });
      if (!selected) return;
      if (Array.isArray(selected)) return;
      const finishBusy = beginBusy(en ? "Adding and preloading workspace…" : "正在添加并预加载工作区…");
      try {
        const cwd = await desktop.addWorkspace(selected);
        await reload();
        createSession(cwd);
        const warmup = warmupRef.current;
        if (warmup?.cwd === cwd) await warmup.ready;
      } finally {
        finishBusy();
      }
    } catch (cause) {
      setError(`添加工作区失败：${String(cause)}`);
    }
  };
  const materializeDraft = async (message: string): Promise<string | false> => {
    const draft = activeRef.current;
    if (!draft || draft.path !== DRAFT_SESSION_PATH) return message;
    const finishBusy = beginBusy(en ? "Creating session…" : "正在创建会话…");
    setConnecting(true);
    try {
      const warmup = warmupRef.current;
      const runtimeId =
        draft.runtimeId ??
        (warmup?.cwd === draft.cwd
          ? await warmup.ready
          : await desktop.prepareSession(draft.cwd));
      const state = await desktop.createSession(runtimeId);
      const refreshed = await reload();
      const saved = state.sessionFile
        ? refreshed
            ?.flatMap((project) => project.sessions)
            .find((item) => item.path === state.sessionFile)
        : undefined;
      const created =
        saved ??
        (state.sessionFile && state.sessionId
          ? {
              id: state.sessionId,
              path: state.sessionFile,
              cwd: draft.cwd,
              name: "New session",
              preview: "",
              updatedAt: Math.floor(Date.now() / 1000),
            }
          : undefined);
      if (!created)
        throw new Error("Pi did not return the newly created session");
      if (!saved)
        setProjects((current) =>
          current.map((project) =>
            project.cwd === draft.cwd &&
            !project.sessions.some((item) => item.path === created.path)
              ? { ...project, sessions: [created, ...project.sessions] }
              : project,
          ),
        );
      const materialized = { ...created, runtimeId };
      runtimeIds.current.set(created.path, runtimeId);
      activeRef.current = materialized;
      setActive(materialized);
      setActiveRuntimeId(runtimeId);
      setHistorySeed({ path: created.path, messages: [] });
      setReadyPath(created.path);
      return message;
    } catch (cause) {
      setError(String(cause));
      return false;
    } finally {
      setConnecting(false);
      finishBusy();
    }
  };
  const hideSession = async (session: SessionSummary) => {
    try {
      const runtimeId = session.runtimeId ?? runtimeIds.current.get(session.path);
      if (runtimeId) runtimeIds.current.delete(session.path);
      await desktop.hideSession(session.path, true);
      const current = activeRef.current;
      if (current?.path === session.path) createSession(current.cwd);
      await reload();
    } catch (cause) {
      setError(`删除 session 失败：${String(cause)}`);
    }
  };
  const renameSession = async (session: SessionSummary, name: string) => {
    try {
      const trimmed = name.replace(/\s+/g, " ").trim();
      if (!trimmed) return;
      if (
        activeRef.current?.path === session.path &&
        readyPath === session.path
      ) {
        await desktop.command(
          { type: "set_session_name", name: trimmed },
          activeRef.current.runtimeId,
        );
      } else {
        await desktop.renameSession(session.path, trimmed);
      }
      const renamed = { ...session, name: trimmed };
      if (activeRef.current?.path === session.path) {
        activeRef.current = { ...activeRef.current, name: trimmed };
        setActive((current) =>
          current?.path === session.path ? { ...current, name: trimmed } : current,
        );
      }
      setProjects((current) =>
        current.map((project) => ({
          ...project,
          sessions: project.sessions.map((item) =>
            item.path === session.path ? renamed : item,
          ),
        })),
      );
      await reload();
    } catch (cause) {
      setError(
        `${en ? "Unable to rename session" : "重命名会话失败"}：${String(cause)}`,
      );
      throw cause;
    }
  };
  const cloneSession = async (session: SessionSummary) => {
    const finishBusy = beginBusy(
      en ? "Duplicating session…" : "正在复制会话…",
      0,
      0,
    );
    const version = ++selectionVersion.current;
    setConnecting(true);
    setError(undefined);
    try {
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
      const runtimeId = await desktop.connect(
        session.cwd,
        session.path,
        runtimeIds.current.get(session.path),
      );
      const result = (await desktop.command({ type: "clone" }, runtimeId)) as {
        cancelled?: boolean;
      };
      if (result.cancelled) return;
      const [state, raw] = await Promise.all([
        desktop.command({ type: "get_state" }, runtimeId) as Promise<{
          sessionFile?: string;
          sessionId?: string;
        }>,
        desktop.command({ type: "get_messages" }, runtimeId) as Promise<{
          messages?: Array<Record<string, unknown>>;
        }>,
      ]);
      const refreshed = await reload();
      const created = state.sessionFile
        ? refreshed
            ?.flatMap((project) => project.sessions)
            .find((item) => item.path === state.sessionFile)
        : undefined;
      const next =
        created ??
        (state.sessionFile && state.sessionId
          ? {
              id: state.sessionId,
              path: state.sessionFile,
              cwd: session.cwd,
              name: session.name,
              preview: "",
              updatedAt: Math.floor(Date.now() / 1000),
            }
          : undefined);
      if (!next) throw new Error("Pi did not return the duplicated session");
      if (version !== selectionVersion.current) return;
      clearSessionUi(runtimeId);
      const connectedNext = { ...next, runtimeId };
      runtimeIds.current.set(next.path, runtimeId);
      activeRef.current = connectedNext;
      setActive(connectedNext);
      setActiveRuntimeId(runtimeId);
      setHistorySeed({ path: next.path, messages: raw.messages ?? [] });
      setWorkspaceCwd(next.cwd);
      setReadyPath(next.path);
    } catch (cause) {
      if (version === selectionVersion.current)
        setError(
          `${en ? "Unable to duplicate session" : "复制会话失败"}：${String(cause)}`,
        );
    } finally {
      if (version === selectionVersion.current) setConnecting(false);
      finishBusy();
    }
  };
  const openSessionFolder = async (session: SessionSummary) => {
    try {
      await desktop.openInFileManager(session.cwd);
    } catch (cause) {
      setError(
        `${en ? "Unable to open folder" : "无法打开文件夹"}：${String(cause)}`,
      );
    }
  };
  const continueInNewSession = async (
    query: string,
  ): Promise<string | false> => {
    if (!activeRef.current || activeRef.current.path === DRAFT_SESSION_PATH)
      return false;
    setConnecting(true);
    setError(undefined);
    try {
      await cancelPending();
      const runtimeId = activeRef.current.runtimeId;
      clearSessionUi(runtimeId);
      const available = (await desktop.command(
        { type: "get_fork_messages" },
        runtimeId,
      )) as { messages?: Array<{ entryId: string; text: string }> };
      const source = [...(available.messages ?? [])]
        .reverse()
        .find((message) => message.text.trim() === query.trim());
      if (!source) throw new Error("无法定位这条消息的分支节点");
      const result = (await desktop.command(
        { type: "fork", entryId: source.entryId },
        runtimeId,
      )) as { text?: string; cancelled?: boolean };
      if (result.cancelled) return false;
      const state = (await desktop.command(
        { type: "get_state" },
        runtimeId,
      )) as {
        sessionFile?: string;
        sessionId?: string;
      };
      const refreshed = await reload();
      const created = state.sessionFile
        ? refreshed
            ?.flatMap((project) => project.sessions)
            .find((item) => item.path === state.sessionFile)
        : undefined;
      const next =
        created ??
        (state.sessionFile && state.sessionId
          ? {
              id: state.sessionId,
              path: state.sessionFile,
              cwd: activeRef.current.cwd,
              name: "New session",
              preview: "",
              updatedAt: Math.floor(Date.now() / 1000),
            }
          : undefined);
      if (!next) throw new Error("Pi 没有返回新任务的 session");
      const connectedNext = { ...next, runtimeId };
      runtimeIds.current.set(next.path, runtimeId!);
      activeRef.current = connectedNext;
      setActive(connectedNext);
      setActiveRuntimeId(runtimeId);
      setHistorySeed({ path: next.path, messages: [] });
      setWorkspaceCwd(next.cwd);
      setReadyPath(next.path);
      return result.text ?? query;
    } catch (cause) {
      setError(`无法在新任务中继续：${String(cause)}`);
      return false;
    } finally {
      setConnecting(false);
    }
  };
  return (
    <>
      <AppShell
        inspector={
          <InspectorPanel
            onCloseReview={() => setReviewCalls(undefined)}
            onError={setError}
            review={reviewCalls}
            root={active?.cwd}
          />
        }
        sidebar={
          <SessionSidebar
            activePath={active?.path}
            onAddWorkspace={() => void addWorkspace()}
            onClone={cloneSession}
            onDelete={hideSession}
            onNew={createSession}
            onOpenFolder={openSessionFolder}
            onRename={renameSession}
            onSelect={select}
            onSelectProject={setWorkspaceCwd}
            onSettings={() => {
              setSettingsPage("models");
              setSettingsOpen(true);
            }}
            projects={projects}
            runningPaths={runningPaths}
          />
        }
      >
        <ConversationWorkspace
          beforeSend={materializeDraft}
          connected={Boolean(active && readyPath === active.path)}
          connecting={connecting}
          error={error}
          initialMessages={
            historySeed && historySeed.path === active?.path
              ? historySeed.messages
              : undefined
          }
          onError={setError}
          onHistoryReady={finishSessionRender}
          onContinueInNewSession={continueInNewSession}
          onReview={setReviewCalls}
          onUserMessage={nameNewSession}
          session={active}
        />
      </AppShell>
      {(booting || busyMessage) && (
        <div aria-live="polite" className="startup-splash">
          <div className="splash-card">
            <span className="splash-mark">K</span>
            <div>
              <strong>Agent K</strong>
              <p>{busyMessage ?? bootMessage ?? (en ? "Preloading sessions and workspaces…" : "正在预加载会话与工作区…")}</p>
            </div>
            <span aria-hidden="true" className="splash-loader" />
          </div>
        </div>
      )}
      <SettingsDialog
        cwd={active?.cwd}
        initialPage={settingsPage}
        onClose={closeSettings}
        open={settingsOpen}
        runtimeId={active?.runtimeId}
        sessionId={active?.path === DRAFT_SESSION_PATH ? undefined : active?.id}
      />
    </>
  );
}
