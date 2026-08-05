import { useEffect, useRef, useState } from "react";
import { emptyDebugSnapshot, type DebugSnapshot } from "../../features/debug/types";
import { loadDebugProject, mergePersistedDebugBreakpoints, saveDebugProject, type PersistedDebugBreakpoint } from "../../features/debug/persistence";
import { debugProviderForFile, debugProviders, rankDebugProviders, type DebugProvider } from "../../features/debug/providers";
import { useSettings } from "../../features/settings/SettingsContext";
import { desktop } from "../../lib/desktop";
import { desktopWindow } from "../../lib/platform";
import { ProjectConsole } from "./ProjectConsole";

function persistProviderSnapshot(root: string, languageServerId: string, snapshot: DebugSnapshot, providers: DebugProvider[]): void {
  const saved = loadDebugProject(root);
  const breakpoints = snapshot.breakpoints.map(({ condition, enabled, file, hitCondition, line, logMessage }) => ({
    enabled, file, line,
    ...(condition ? { condition } : {}),
    ...(hitCondition ? { hitCondition } : {}),
    ...(logMessage ? { logMessage } : {}),
  }));
  saveDebugProject(root, {
    ...saved,
    breakpoints: mergePersistedDebugBreakpoints(saved.breakpoints, breakpoints,
      (file) => debugProviderForFile(providers, file)?.languageServerId === languageServerId),
    ...(saved.providerIdentity.startsWith(`${languageServerId}:`) ? { exceptionFilters: snapshot.exceptionFilters } : {}),
    ...(saved.providerIdentity.startsWith(`${languageServerId}:`) ? { functionBreakpoints: snapshot.functionBreakpoints.map(({ condition, hitCondition, name }) => ({
      name, ...(condition ? { condition } : {}), ...(hitCondition ? { hitCondition } : {}),
    })) } : {}),
  });
}

export function DevelopmentDock({ root, onError }: { root?: string; onError(message: string): void }) {
  const { ready: settingsReady, settings, update: updateSettings } = useSettings();
  const en = settings.locale === "en-US";
  const [collapsed, setCollapsed] = useState(settings.developmentDockCollapsed);
  const [height, setHeight] = useState(settings.developmentDockHeight);
  const [terminalVisible, setTerminalVisible] = useState(settings.developmentDockTerminalVisible);
  const heightRef = useRef(height);
  const layoutRestored = useRef(false);
  const resize = useRef<{ height: number; pointerId: number; y: number } | undefined>(undefined);
  const [availableProviders, setAvailableProviders] = useState<DebugProvider[]>([]);
  const providersRef = useRef<DebugProvider[]>([]);
  const debugSnapshots = useRef(new Map<string, DebugSnapshot>());
  const debugRoot = useRef(root);
  const restoringBreakpoints = useRef<string | undefined>(undefined);
  heightRef.current = height;
  useEffect(() => {
    if (!settingsReady || layoutRestored.current) return;
    layoutRestored.current = true;
    heightRef.current = settings.developmentDockHeight;
    setHeight(settings.developmentDockHeight);
    setCollapsed(settings.developmentDockCollapsed);
    setTerminalVisible(settings.developmentDockTerminalVisible);
  }, [
    settings.developmentDockCollapsed,
    settings.developmentDockHeight,
    settings.developmentDockTerminalVisible,
    settingsReady,
  ]);
  useEffect(() => {
    let disposed = false;
    void desktop.listLanguageServerPlugins().then((plugins) => {
      if (!disposed) setAvailableProviders(debugProviders(plugins));
    }).catch(() => { if (!disposed) setAvailableProviders([]); });
    return () => { disposed = true; };
  }, []);
  useEffect(() => { providersRef.current = availableProviders; }, [availableProviders]);
  useEffect(() => { void desktopWindow.setDebugRoot(root).catch(() => undefined); }, [root]);
  useEffect(() => {
    debugRoot.current = root;
    if (!root) return;
    let disposed = false;
    restoringBreakpoints.current = root;
    const saved = loadDebugProject(root);
    const restore = async () => {
      const current = () => !disposed && debugRoot.current === root;
      const servers = [...new Set(availableProviders.map((provider) => provider.languageServerId))];
      await Promise.all(servers.map((server) => desktop.languageServerCall(server, "debugClearBreakpoints")));
      const byServerAndFile = new Map<string, Map<string, PersistedDebugBreakpoint[]>>();
      for (const breakpoint of saved.breakpoints) {
        const provider = debugProviderForFile(availableProviders, breakpoint.file);
        if (!provider) continue;
        const byFile = byServerAndFile.get(provider.languageServerId) ?? new Map<string, PersistedDebugBreakpoint[]>();
        byFile.set(breakpoint.file, [...(byFile.get(breakpoint.file) ?? []), breakpoint]);
        byServerAndFile.set(provider.languageServerId, byFile);
      }
      for (const [server, byFile] of byServerAndFile) for (const [file, breakpoints] of byFile) {
        if (!current()) return;
        await desktop.languageServerCall(server, "debugSetBreakpoints", file, breakpoints.map((item) => item.line));
        for (const breakpoint of breakpoints) {
          if (!current()) return;
          if (breakpoint.enabled && !breakpoint.condition && !breakpoint.hitCondition && !breakpoint.logMessage) continue;
          await desktop.languageServerCall(server, "debugUpdateBreakpoint", file, breakpoint.line, {
            enabled: breakpoint.enabled,
            ...(breakpoint.condition ? { condition: breakpoint.condition } : {}),
            ...(breakpoint.hitCondition ? { hitCondition: breakpoint.hitCondition } : {}),
            ...(breakpoint.logMessage ? { logMessage: breakpoint.logMessage } : {}),
          });
        }
      }
      if (!current()) return;
      const preferred = rankDebugProviders(availableProviders, undefined, saved.providerIdentity)[0];
      if (preferred) {
        await desktop.languageServerCall(preferred.languageServerId, "debugSetFunctionBreakpoints", saved.functionBreakpoints);
        if (!current()) return;
        await desktop.languageServerCall(preferred.languageServerId, "debugSetExceptionFilters", saved.exceptionFilters);
      }
      for (const server of servers) {
        if (!current()) return;
        const snapshot = await desktop.languageServerCall(server, "debugStatus") as DebugSnapshot;
        debugSnapshots.current.set(server, snapshot);
        window.dispatchEvent(new CustomEvent("agent-k-debug-state", { detail: snapshot }));
      }
    };
    void restore().catch((cause) => { if (!disposed) onError(String(cause)); }).finally(() => {
      if (restoringBreakpoints.current === root) restoringBreakpoints.current = undefined;
    });
    return () => { disposed = true; };
  }, [availableProviders, onError, root]);
  useEffect(() => {
    const stopBackend = desktop.onEvent((event) => {
      if (event.type !== "debug_session" || typeof event.languageServerId !== "string" || !event.snapshot || typeof event.snapshot !== "object") return;
      if (!providersRef.current.some((provider) => provider.languageServerId === event.languageServerId)) return;
      const snapshot = event.snapshot as DebugSnapshot;
      const previous = debugSnapshots.current.get(event.languageServerId);
      const effective = !snapshot.sessionId && previous?.sessionId ? {
        ...previous,
        breakpoints: snapshot.breakpoints,
        exceptionBreakpointFilters: snapshot.exceptionBreakpointFilters,
        exceptionFilters: snapshot.exceptionFilters,
        functionBreakpoints: snapshot.functionBreakpoints,
      } : snapshot;
      debugSnapshots.current.set(event.languageServerId, effective);
      const currentRoot = debugRoot.current;
      if (currentRoot && restoringBreakpoints.current !== currentRoot) {
        persistProviderSnapshot(currentRoot, event.languageServerId, snapshot, providersRef.current);
      }
      window.dispatchEvent(new CustomEvent("agent-k-debug-state", { detail: effective }));
    });
    const stopLocation = desktopWindow.onOpenEditorLocation((location) => {
      window.dispatchEvent(new CustomEvent("agent-k-open-file-line", { detail: location }));
    });
    const replayState = (event: Event) => {
      const detail = (event as CustomEvent<{ file?: unknown }>).detail;
      if (typeof detail?.file !== "string") return;
      const provider = debugProviderForFile(providersRef.current, detail.file);
      if (!provider) return;
      const snapshot = debugSnapshots.current.get(provider.languageServerId);
      if (snapshot) window.dispatchEvent(new CustomEvent("agent-k-debug-state", { detail: snapshot }));
    };
    const toggle = (event: Event) => {
      const detail = (event as CustomEvent<{ file?: unknown; line?: unknown }>).detail;
      if (typeof detail?.file !== "string" || typeof detail.line !== "number") return;
      const provider = debugProviderForFile(providersRef.current, detail.file);
      if (!provider) { onError(en ? "No debugger supports this file" : "没有调试器支持此文件"); return; }
      const snapshot = debugSnapshots.current.get(provider.languageServerId) ?? emptyDebugSnapshot();
      const disabled = snapshot.breakpoints.find((item) => item.file === detail.file && item.line === detail.line && item.enabled === false);
      if (disabled) {
        void desktop.languageServerCall(provider.languageServerId, "debugUpdateBreakpoint", detail.file, detail.line, { enabled: true })
          .then((value) => { if (debugRoot.current) persistProviderSnapshot(debugRoot.current, provider.languageServerId, value as DebugSnapshot, providersRef.current); })
          .catch((cause) => onError(String(cause)));
        return;
      }
      const existing = snapshot.breakpoints.filter((item) => item.file === detail.file).map((item) => item.line);
      const lines = existing.includes(detail.line) ? existing.filter((line) => line !== detail.line) : [...existing, detail.line];
      void desktop.languageServerCall(provider.languageServerId, "debugSetBreakpoints", detail.file, lines)
        .then((value) => { if (debugRoot.current) persistProviderSnapshot(debugRoot.current, provider.languageServerId, value as DebugSnapshot, providersRef.current); })
        .catch((cause) => onError(String(cause)));
    };
    window.addEventListener("agent-k-debug-state-request", replayState);
    window.addEventListener("agent-k-debug-toggle-breakpoint", toggle);
    return () => {
      stopBackend();
      stopLocation();
      window.removeEventListener("agent-k-debug-state-request", replayState);
      window.removeEventListener("agent-k-debug-toggle-breakpoint", toggle);
    };
  }, [en, onError]);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const start = resize.current;
      if (!start || start.pointerId !== event.pointerId) return;
      const next = Math.max(150, Math.min(window.innerHeight - 220, start.height + start.y - event.clientY));
      heightRef.current = next;
      setHeight(next);
    };
    const stop = () => {
      if (!resize.current) return;
      resize.current = undefined;
      document.body.classList.remove("is-resizing-console");
      void updateSettings({ developmentDockHeight: Math.round(heightRef.current) })
        .catch((cause) => onError(`${en ? "Unable to save tool window height" : "无法保存工具窗口高度"}：${String(cause)}`));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); };
  }, [en, onError, updateSettings]);
  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      void updateSettings({ developmentDockCollapsed: next })
        .catch((cause) => onError(`${en ? "Unable to save tool window state" : "无法保存工具窗口状态"}：${String(cause)}`));
      return next;
    });
  };
  const toggleTerminal = () => {
    setTerminalVisible((current) => {
      const next = !current;
      void updateSettings({ developmentDockTerminalVisible: next })
        .catch((cause) => onError(`${en ? "Unable to save terminal visibility" : "无法保存终端可见状态"}：${String(cause)}`));
      return next;
    });
  };
  return <section className={collapsed ? "development-dock is-collapsed" : "development-dock"} style={collapsed ? undefined : { flexBasis: height }}>
    {!collapsed ? <div className="development-dock-resizer" onPointerDown={(event) => { if (event.button !== 0) return; resize.current = { height, pointerId: event.pointerId, y: event.clientY }; document.body.classList.add("is-resizing-console"); }} /> : null}
    <header>
      <button aria-pressed={terminalVisible} className={terminalVisible ? "is-active" : undefined} onClick={toggleTerminal} type="button"><i className="fa-solid fa-terminal" /> {en ? "Terminal" : "终端"}</button>
      <small title={root}>{root ?? (en ? "No project selected" : "未选择项目")}</small>
      <button className="development-dock-collapse" onClick={toggleCollapsed} title={collapsed ? (en ? "Show tools" : "显示工具窗口") : (en ? "Hide tools" : "隐藏工具窗口")} type="button"><i className={`fa-solid fa-chevron-${collapsed ? "up" : "down"}`} /></button>
    </header>
    <div className="development-dock-content">
      <div className={terminalVisible ? "development-dock-pane terminal-pane" : "development-dock-pane terminal-pane is-hidden"}><ProjectConsole docked onError={onError} root={root} /></div>
      {!terminalVisible ? <p className="development-dock-empty">{en ? "Terminal is hidden" : "终端已隐藏"}</p> : null}
    </div>
  </section>;
}
