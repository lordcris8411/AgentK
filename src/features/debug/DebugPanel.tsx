import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { desktop } from "../../lib/desktop";
import { desktopWindow, platform } from "../../lib/platform";
import { useSettings } from "../settings/SettingsContext";
import { emptyDebugSnapshot, type DebugBreakpoint, type DebugProcess, type DebugSnapshot, type DebugVariable, type DebugWatch } from "./types";
import { appendConsoleHistory, debugLayoutGeometry, defaultDebugProject, loadDebugProject, loadDebugProviderConfiguration, navigateConsoleHistory, saveDebugProject, saveDebugProviderConfiguration, type DebugPanelId } from "./persistence";
import { isLocalDebugScope } from "./scopes";

const DebugServerContext = createContext("");
const DebugSessionContext = createContext<string | undefined>(undefined);
type DebugConfigurationCandidate = { built?: boolean; id: string; name: string; program?: string };
type CMakeBuildConfiguration = "Debug" | "Release" | "RelWithDebInfo" | "MinSizeRel";
type DebuggerToolProgress = { bytes?: number; stage: string; total?: number };
const CMAKE_BUILD_CONFIGURATIONS: CMakeBuildConfiguration[] = ["Debug", "Release", "RelWithDebInfo", "MinSizeRel"];

type VariableFormat = "decimal" | "hex" | "natural";
type VariableColumnWidths = [number, number, number, number];

function pointerType(type?: string): boolean { return Boolean(type && /\*/u.test(type)); }
function registerGroup(variable: DebugVariable): boolean { return variable.variablesReference > 0 && /register|vector extension/i.test(variable.name); }
function variableDisplay(variable: Pick<DebugVariable, "memoryReference" | "type" | "value">, format: VariableFormat): string {
  if (format === "natural") return pointerType(variable.type) && variable.memoryReference ? variable.memoryReference : variable.value;
  const source = pointerType(variable.type) && variable.memoryReference ? variable.memoryReference : variable.value;
  const match = /^(-?(?:0x[\da-f]+|\d+))$/iu.exec(source.trim());
  if (!match) return source;
  try {
    const value = BigInt(match[1]!);
    return format === "hex" ? `${value < 0 ? "-" : ""}0x${(value < 0 ? -value : value).toString(16)}` : value.toString(10);
  } catch { return source; }
}

function useVariableAddress(type: string | undefined, memoryReference: string | undefined, expression: string): string | undefined {
  const languageServerId = useContext(DebugServerContext);
  const sessionId = useContext(DebugSessionContext);
  const pointer = pointerType(type);
  const addressOfResult = pointer && /^\s*&/u.test(expression);
  const [address, setAddress] = useState<string | undefined>(pointer ? undefined : memoryReference);
  useEffect(() => {
    let disposed = false;
    if (!pointer) { setAddress(memoryReference); return () => { disposed = true; }; }
    if (addressOfResult || !expression.trim()) { setAddress(undefined); return () => { disposed = true; }; }
    setAddress(undefined);
    void (async () => {
      for (let attempt = 0; attempt < 3 && !disposed; attempt++) {
        try {
          const value = await desktop.languageServerCall(languageServerId, "debugEvaluate", `&(${expression})`, "watch", sessionId);
          if (!disposed) setAddress((value as { memoryReference?: string }).memoryReference);
          return;
        } catch {
          if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 100));
        }
      }
      if (!disposed) setAddress(undefined);
    })();
    return () => { disposed = true; };
  }, [addressOfResult, expression, languageServerId, memoryReference, pointer, sessionId]);
  return address;
}

function variableColumnStyle(widths: VariableColumnWidths): React.CSSProperties {
  return {
    "--debug-address-width": `${widths[2]}fr`,
    "--debug-name-width": `${widths[0]}fr`,
    "--debug-type-width": `${widths[3]}fr`,
    "--debug-value-width": `${widths[1]}fr`,
  } as React.CSSProperties;
}

function VariableColumns({ en, setWidths, watch, widths }: {
  en: boolean; setWidths(value: VariableColumnWidths): void; watch?: boolean; widths: VariableColumnWidths;
}) {
  const beginResize = (index: 0 | 1 | 2, event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = event.clientX;
    const container = event.currentTarget.parentElement?.parentElement?.getBoundingClientRect().width ?? 1;
    const initial = [...widths] as VariableColumnWidths;
    const total = initial.reduce((sum, value) => sum + value, 0);
    const move = (moveEvent: PointerEvent) => {
      const delta = (moveEvent.clientX - start) / Math.max(container, 1) * total;
      const minimum = .35;
      const bounded = Math.max(minimum - initial[index], Math.min(initial[index + 1] - minimum, delta));
      const next = [...initial] as VariableColumnWidths;
      next[index] = initial[index] + bounded;
      next[index + 1] = initial[index + 1] - bounded;
      setWidths(next);
    };
    const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };
  const labels = en ? [watch ? "Expression" : "Name", "Value", "Address", "Type"] : [watch ? "表达式" : "名称", "值", "地址", "类型"];
  return <div className={`debug-variable-columns${watch ? " is-watch" : ""}`}><span />{labels.map((label, index) => <span key={label}>{label}{index < 3 ? <button aria-label={en ? `Resize ${label}` : `调整${label}宽度`} className="debug-variable-column-resizer" onPointerDown={(event) => beginResize(index as 0 | 1 | 2, event)} type="button" /> : null}</span>)}{watch ? <span /> : null}</div>;
}

function VariableRow({ canEdit, depth, en, onAddWatch, onError, onSnapshot, parentReference, variable }: {
  canEdit: boolean; depth: number; en: boolean; onAddWatch(expression: string): void; onError(message: string): void; onSnapshot(snapshot: DebugSnapshot): void;
  parentReference: number; variable: DebugVariable;
}) {
  const languageServerId = useContext(DebugServerContext);
  const sessionId = useContext(DebugSessionContext);
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DebugVariable[]>();
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [format, setFormat] = useState<VariableFormat>("natural");
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const [value, setValue] = useState(variable.value);
  useEffect(() => { setValue(variable.value); }, [variable.value]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("blur", close); };
  }, [menu]);
  const toggle = async () => {
    if (!variable.variablesReference) return;
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (children) return;
    setLoading(true);
    try {
      const result = await desktop.languageServerCall(languageServerId, "debugVariables", variable.variablesReference, sessionId);
      setChildren(Array.isArray(result) ? result as DebugVariable[] : []);
    } catch (cause) { onError(String(cause)); }
    finally { setLoading(false); }
  };
  const commit = async () => {
    setEditing(false);
    if (value === variable.value) return;
    try {
      const result = await desktop.languageServerCall(languageServerId, "debugSetVariable", parentReference, variable.name, value, sessionId);
      onSnapshot(result as DebugSnapshot);
    } catch (cause) { setValue(variable.value); onError(String(cause)); }
  };
  const display = variableDisplay(variable, format);
  const watchExpression = variable.evaluateName ?? variable.name;
  const address = useVariableAddress(variable.type, variable.memoryReference, watchExpression);
  return <>
    <div className="debug-variable-row" onContextMenu={(event) => { event.preventDefault(); setMenu({ x: Math.min(event.clientX, window.innerWidth - 190), y: Math.min(event.clientY, window.innerHeight - 126) }); }} style={{ paddingLeft: 8 + depth * 14 }}>
      <button className="debug-variable-toggle" disabled={!variable.variablesReference} onClick={() => void toggle()} title={en ? "Expand" : "展开"} type="button"><i className={`fa-solid fa-${loading ? "spinner fa-spin" : expanded ? "chevron-down" : "chevron-right"}`} /></button>
      <span title={variable.evaluateName ?? variable.name}>{variable.name}</span>
      {editing ? <input autoFocus onBlur={() => void commit()} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void commit(); if (event.key === "Escape") { setValue(variable.value); setEditing(false); } }} value={value} /> : <code onDoubleClick={() => { if (canEdit) setEditing(true); }} title={canEdit ? (en ? "Double-click to change" : "双击修改") : display}>{display}</code>}
      <code className="debug-variable-address" title={address}>{address ?? "—"}</code>
      <small>{variable.type}</small>
      {menu ? <div className="debug-variable-menu" onPointerDown={(event) => event.stopPropagation()} style={{ left: menu.x, top: menu.y }}>
        <button className={format === "hex" ? "is-active" : ""} onClick={() => { setFormat("hex"); setMenu(undefined); }} type="button">{en ? "Display as hexadecimal" : "以十六进制显示"}</button>
        <button className={format === "decimal" ? "is-active" : ""} onClick={() => { setFormat("decimal"); setMenu(undefined); }} type="button">{en ? "Display as decimal" : "以十进制显示"}</button>
        <button onClick={() => { onAddWatch(watchExpression); setMenu(undefined); }} type="button">{en ? "Add to Watch" : "添加到监视"}</button>
        <button disabled={!variable.memoryReference} onClick={() => { if (variable.memoryReference) void desktopWindow.openDebugTool("memory", variable.memoryReference, languageServerId, sessionId); setMenu(undefined); }} type="button">{en ? "View Memory" : "查看内存"}</button>
      </div> : null}
    </div>
    {expanded ? children?.map((child, index) => <VariableRow canEdit={canEdit} depth={depth + 1} en={en} key={`${child.name}:${index}`} onAddWatch={onAddWatch} onError={onError} onSnapshot={onSnapshot} parentReference={variable.variablesReference} variable={pointerType(variable.type) && /^\*?\$/u.test(child.name) ? { ...child, name: `*${variable.name}` } : child} />) : null}
  </>;
}

function WatchRow({ canEdit, en, onAddWatch, onError, onRemove, onSnapshot, watch }: {
  canEdit: boolean; en: boolean; onAddWatch(expression: string): void; onError(message: string): void; onRemove(): void; onSnapshot(snapshot: DebugSnapshot): void; watch: DebugWatch;
}) {
  const languageServerId = useContext(DebugServerContext);
  const sessionId = useContext(DebugSessionContext);
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DebugVariable[]>();
  const [loading, setLoading] = useState(false);
  const toggle = async () => {
    if (!watch.variablesReference) return;
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (children) return;
    setLoading(true);
    try {
      const value = await desktop.languageServerCall(languageServerId, "debugVariables", watch.variablesReference, sessionId);
      setChildren(Array.isArray(value) ? value as DebugVariable[] : []);
    } catch (cause) { onError(String(cause)); }
    finally { setLoading(false); }
  };
  const pointer = pointerType(watch.type);
  const display = pointer && watch.memoryReference ? watch.memoryReference : watch.error ?? watch.value ?? "";
  const address = useVariableAddress(watch.type, watch.memoryReference, watch.expression);
  return <div className="debug-watch">
    <div className="debug-watch-summary">
      <button className="debug-variable-toggle" disabled={!watch.variablesReference} onClick={() => void toggle()} type="button"><i className={`fa-solid fa-${loading ? "spinner fa-spin" : expanded ? "chevron-down" : "chevron-right"}`} /></button>
      <span title={watch.expression}>{watch.expression}</span><code title={display}>{display}</code><code className="debug-variable-address">{address ?? "—"}</code><small>{watch.type}</small>
      <button className="debug-watch-delete" onClick={onRemove} title={en ? "Remove watch" : "删除监视"} type="button">×</button>
    </div>
    {expanded ? children?.map((child, index) => <VariableRow canEdit={canEdit} depth={1} en={en} key={`${child.name}:${index}`} onAddWatch={onAddWatch} onError={onError} onSnapshot={onSnapshot} parentReference={watch.variablesReference!} variable={pointer && /^\*?\$/u.test(child.name) ? { ...child, name: `*${watch.expression}` } : child} />) : null}
  </div>;
}

function BreakpointRow({ breakpoint, en, onError, onOpen, onRemove, onSnapshot }: {
  breakpoint: DebugBreakpoint; en: boolean; onError(message: string): void; onOpen(): void; onRemove(): void; onSnapshot(snapshot: DebugSnapshot): void;
}) {
  const languageServerId = useContext(DebugServerContext);
  const [editing, setEditing] = useState(false);
  const [condition, setCondition] = useState(breakpoint.condition ?? "");
  const [hitCondition, setHitCondition] = useState(breakpoint.hitCondition ?? "");
  const [logMessage, setLogMessage] = useState(breakpoint.logMessage ?? "");
  useEffect(() => {
    setCondition(breakpoint.condition ?? "");
    setHitCondition(breakpoint.hitCondition ?? "");
    setLogMessage(breakpoint.logMessage ?? "");
  }, [breakpoint.condition, breakpoint.hitCondition, breakpoint.logMessage]);
  const update = async (changes: Record<string, unknown>) => {
    try {
      const result = await desktop.languageServerCall(languageServerId, "debugUpdateBreakpoint", breakpoint.file, breakpoint.line, changes);
      onSnapshot(result as DebugSnapshot);
    } catch (cause) { onError(String(cause)); }
  };
  const save = async () => {
    await update({ condition, hitCondition, logMessage });
    setEditing(false);
  };
  const details = breakpoint.logMessage
    ? `${en ? "Log" : "日志"}: ${breakpoint.logMessage}`
    : [breakpoint.condition ? `${en ? "when" : "条件"} ${breakpoint.condition}` : "", breakpoint.hitCondition ? `${en ? "hit" : "命中"} ${breakpoint.hitCondition}` : ""].filter(Boolean).join(" · ");
  return <div className={`${breakpoint.enabled ? "" : "is-disabled"} ${breakpoint.verified === false && breakpoint.enabled ? "is-unverified" : ""}`}>
    <input aria-label={en ? "Enable breakpoint" : "启用断点"} checked={breakpoint.enabled} onChange={(event) => void update({ enabled: event.target.checked })} type="checkbox" />
    <button onClick={onOpen} type="button"><span>{breakpoint.file.split(/[\\/]/).pop()}:{breakpoint.line}</span><small>{details || (breakpoint.verified === false ? breakpoint.message ?? (en ? "Unverified" : "未验证") : breakpoint.file)}</small></button>
    <button onClick={() => setEditing((value) => !value)} title={en ? "Breakpoint settings" : "断点设置"} type="button"><i className="fa-solid fa-gear" /></button>
    <button onClick={onRemove} title={en ? "Remove breakpoint" : "删除断点"} type="button">×</button>
    {editing ? <form className="debug-breakpoint-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <input onChange={(event) => setCondition(event.target.value)} placeholder={en ? "Condition, e.g. count > 3" : "条件，例如 count > 3"} value={condition} />
      <input onChange={(event) => setHitCondition(event.target.value)} placeholder={en ? "Hit condition, e.g. >= 5" : "命中条件，例如 >= 5"} value={hitCondition} />
      <input onChange={(event) => setLogMessage(event.target.value)} placeholder={en ? "Log message; {expression} is evaluated" : "日志消息；{expression} 会被计算"} value={logMessage} />
      <button type="submit">{en ? "Apply" : "应用"}</button>
    </form> : null}
  </div>;
}

function parseArguments(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote) quote = "";
      else if (character === "\\" && index + 1 < value.length) current += value[++index];
      else current += character;
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (/\s/.test(character)) {
      if (current) result.push(current);
      current = "";
    } else current += character;
  }
  if (current) result.push(current);
  return result;
}

function parseSourceMap(value: string): Record<string, string> {
  return Object.fromEntries(value.split(/\r?\n/u).flatMap((line): Array<[string, string]> => {
    const separator = line.indexOf("=");
    const from = separator >= 0 ? line.slice(0, separator).trim() : "";
    const to = separator >= 0 ? line.slice(separator + 1).trim() : "";
    return from && to ? [[from, to]] : [];
  }));
}

export function DebugPanel({ contextFile, languageServerId, modes, providerId, root, onError }: { contextFile?: string; languageServerId: string; modes: Array<"attach" | "dump" | "launch">; providerId: string; root?: string; onError(message: string): void }) {
  const { settings } = useSettings();
  const en = settings.locale === "en-US";
  const [snapshot, setSnapshot] = useState<DebugSnapshot>(emptyDebugSnapshot);
  const [sessions, setSessions] = useState<DebugSnapshot[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const activeSessionId = snapshot.sessionId ?? sessionId;
  const sessionIdRef = useRef<string | undefined>(undefined);
  const sessionStatesRef = useRef(new Map<string, DebugSnapshot["state"]>());
  const [creatingSession, setCreatingSession] = useState(false);
  const [mode, setMode] = useState<"launch" | "attach" | "dump">("launch");
  const [buildConfiguration, setBuildConfiguration] = useState<CMakeBuildConfiguration>("Debug");
  const [program, setProgram] = useState("");
  const [targets, setTargets] = useState<DebugConfigurationCandidate[]>([]);
  const [targetId, setTargetId] = useState("");
  const [targetsLoading, setTargetsLoading] = useState(false);
  const [targetError, setTargetError] = useState<string>();
  const targetRefreshArmed = useRef(false);
  const targetRequestVersion = useRef(0);
  const [args, setArgs] = useState("");
  const [processId, setProcessId] = useState("");
  const [dumpPath, setDumpPath] = useState("");
  const [symbolPaths, setSymbolPaths] = useState<string[]>([]);
  const [sourceMapText, setSourceMapText] = useState("");
  const [processes, setProcesses] = useState<DebugProcess[]>([]);
  const [processesLoading, setProcessesLoading] = useState(false);
  const [stopOnEntry, setStopOnEntry] = useState(false);
  const [watchInput, setWatchInput] = useState("");
  const [functionBreakpointInput, setFunctionBreakpointInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [debuggerToolProgress, setDebuggerToolProgress] = useState<DebuggerToolProgress>();
  const [consoleInput, setConsoleInput] = useState("");
  const [consoleHistory, setConsoleHistory] = useState<string[]>([]);
  const consoleHistoryIndex = useRef(0);
  const [columnPercent, setColumnPercent] = useState(50);
  const [rowPercent, setRowPercent] = useState(55);
  const [consolePercent, setConsolePercent] = useState(30);
  const [hiddenPanels, setHiddenPanels] = useState<DebugPanelId[]>([]);
  const [localColumnWidths, setLocalColumnWidths] = useState<VariableColumnWidths>([.7, 1, .75, .4]);
  const [watchColumnWidths, setWatchColumnWidths] = useState<VariableColumnWidths>([.7, 1, .75, .4]);
  const [layoutMenu, setLayoutMenu] = useState(false);
  const persistedTarget = useRef("");
  const persistenceRoot = useRef<string | undefined>(undefined);
  const layoutResize = useRef<{ initial: number; kind: "column" | "console" | "row"; pointerId: number; start: number } | undefined>(undefined);
  const selectedFrame = useMemo(() => snapshot.threads
    .flatMap((thread) => thread.frames)
    .find((frame) => frame.id === snapshot.selectedFrameId), [snapshot]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  const openSource = useCallback((path: string, line: number, column = 1, focus = true) => {
    if (!root) return;
    const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/u, "").toLocaleLowerCase("en-US");
    const workspace = normalize(root);
    const source = normalize(path);
    if (source !== workspace && !source.startsWith(`${workspace}/`)) return;
    void desktopWindow.openEditorLocation({ path, line, column, focus }).catch((cause) => onError(String(cause)));
  }, [onError, root]);

  useEffect(() => {
    persistenceRoot.current = undefined;
    if (!root) return;
    const project = loadDebugProject(root);
    const saved = loadDebugProviderConfiguration(root, `${languageServerId}:${providerId}`);
    setArgs(saved.args);
    setBuildConfiguration(saved.buildConfiguration);
    setConsoleHistory(project.consoleHistory);
    setDumpPath(saved.dumpPath);
    consoleHistoryIndex.current = project.consoleHistory.length;
    setColumnPercent(project.layout.columnPercent);
    setConsolePercent(project.layout.consolePercent);
    setHiddenPanels(project.layout.hidden);
    setRowPercent(project.layout.rowPercent);
    setMode(modes.includes(saved.mode) ? saved.mode : modes[0] ?? "launch");
    setProcessId(saved.processId);
    setProgram(saved.program);
    setSourceMapText(Object.entries(saved.sourceMap).map(([from, to]) => `${from}=${to}`).join("\n"));
    setStopOnEntry(saved.stopOnEntry);
    persistedTarget.current = saved.targetId;
    setTargetId(saved.targetId);
    setSymbolPaths(saved.symbolPaths);
    persistenceRoot.current = root;
  }, [languageServerId, modes, providerId, root]);

  useEffect(() => {
    if (!root || persistenceRoot.current !== root) return;
    saveDebugProviderConfiguration(root, `${languageServerId}:${providerId}`, {
      args, buildConfiguration, dumpPath, mode, processId, program,
      sourceMap: parseSourceMap(sourceMapText), stopOnEntry, symbolPaths, targetId,
    });
    saveDebugProject(root, {
      args,
      buildConfiguration,
      breakpoints: loadDebugProject(root).breakpoints,
      consoleHistory,
      dumpPath,
      exceptionFilters: loadDebugProject(root).exceptionFilters,
      functionBreakpoints: loadDebugProject(root).functionBreakpoints,
      layout: { columnPercent, consolePercent, hidden: hiddenPanels, rowPercent },
      mode,
      processId,
      program,
      providerIdentity: `${languageServerId}:${providerId}`,
      sourceMap: parseSourceMap(sourceMapText),
      stopOnEntry,
      targetId,
      symbolPaths,
    });
  }, [args, buildConfiguration, columnPercent, consoleHistory, consolePercent, dumpPath, hiddenPanels, languageServerId, mode, processId, program, providerId, root, rowPercent, sourceMapText, stopOnEntry, symbolPaths, targetId]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const current = layoutResize.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const delta = current.kind === "column"
        ? (event.clientX - current.start) / Math.max(window.innerWidth, 1) * 100
        : (event.clientY - current.start) / Math.max(window.innerHeight, 1) * 100;
      const next = Math.max(20, Math.min(80, current.kind === "console" ? current.initial - delta : current.initial + delta));
      if (current.kind === "column") setColumnPercent(next);
      else if (current.kind === "row") setRowPercent(next);
      else setConsolePercent(next);
    };
    const stop = () => { layoutResize.current = undefined; document.body.classList.remove("is-resizing-debug-layout"); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); };
  }, []);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("agent-k-debug-state", { detail: snapshot }));
  }, [snapshot]);

  useEffect(() => {
    let disposed = false;
    setSnapshot(emptyDebugSnapshot());
    setSessions([]);
    setSessionId(undefined);
    void Promise.all([desktop.languageServerCall(languageServerId, "debugSessions"), desktop.languageServerCall(languageServerId, "debugStatus")])
      .then(([value, current]) => {
        if (disposed) return;
        const listed = Array.isArray(value) ? value as DebugSnapshot[] : [];
        const next = listed.filter((item) => item.state !== "terminated");
        for (const stale of listed.filter((item) => item.state === "terminated" && item.sessionId))
          void desktop.languageServerCall(languageServerId, "debugCloseSession", stale.sessionId).catch(() => undefined);
        sessionStatesRef.current = new Map(next.flatMap((item) => item.sessionId ? [[item.sessionId, item.state] as const] : []));
        setSessions(next);
        const currentSnapshot = current as DebugSnapshot;
        const selected = next.find((item) => item.sessionId === currentSnapshot.sessionId) ?? next.at(-1);
        if (selected) { setSessionId(selected.sessionId); setSnapshot(selected); }
      })
      .catch(() => undefined);
    const stop = desktop.onEvent((event) => {
      if (event.type !== "debug_session" || event.languageServerId !== languageServerId) return;
      const value = event.snapshot;
      if (value && typeof value === "object") {
        const next = value as DebugSnapshot;
        if (!next.sessionId) {
          const configuration = {
            breakpoints: next.breakpoints,
            exceptionBreakpointFilters: next.exceptionBreakpointFilters,
            exceptionFilters: next.exceptionFilters,
            functionBreakpoints: next.functionBreakpoints,
          };
          setSessions((current) => current.map((item) => ({ ...item, ...configuration })));
          setSnapshot((current) => ({ ...current, ...configuration }));
          window.dispatchEvent(new CustomEvent("agent-k-debug-state", { detail: next }));
          return;
        }
        if (next.state === "terminated") {
          sessionStatesRef.current.delete(next.sessionId);
          setSessions((current) => current.filter((item) => item.sessionId !== next.sessionId));
          if (sessionIdRef.current === next.sessionId) {
            sessionIdRef.current = undefined;
            setSessionId(undefined);
            setSnapshot(emptyDebugSnapshot());
            void Promise.all([
              desktop.languageServerCall(languageServerId, "debugSessions"),
              desktop.languageServerCall(languageServerId, "debugStatus"),
            ]).then(([listed, current]) => {
              if (disposed) return;
              const remaining = (Array.isArray(listed) ? listed as DebugSnapshot[] : []).filter((item) => item.state !== "terminated");
              const currentSnapshot = current as DebugSnapshot;
              const selected = remaining.find((item) => item.sessionId === currentSnapshot.sessionId) ?? remaining.at(-1);
              setSessions(remaining);
              sessionIdRef.current = selected?.sessionId;
              setSessionId(selected?.sessionId);
              setSnapshot(selected ?? emptyDebugSnapshot());
            }).catch(() => undefined);
          }
          window.dispatchEvent(new CustomEvent("agent-k-debug-state", { detail: next }));
          return;
        }
        setSessions((current) => current.some((item) => item.sessionId === next.sessionId)
          ? current.map((item) => item.sessionId === next.sessionId ? next : item) : [...current, next]);
        const previousState = next.sessionId ? sessionStatesRef.current.get(next.sessionId) : undefined;
        if (next.sessionId) sessionStatesRef.current.set(next.sessionId, next.state);
        const breakpointHit = next.state === "stopped" && previousState !== "stopped" && (next.stopReasonKind === "breakpoint" || /breakpoint/i.test(next.stopReason ?? ""));
        if (!sessionIdRef.current || next.sessionId === sessionIdRef.current || breakpointHit) {
          setSessionId(next.sessionId);
          setSnapshot(next);
        }
        window.dispatchEvent(new CustomEvent("agent-k-debug-state", { detail: next }));
        const frame = next.threads.flatMap((thread) => thread.frames)
          .find((item) => item.id === next.selectedFrameId);
        if (next.state === "stopped" && frame?.file && frame.line)
          openSource(frame.file, frame.line, frame.column ?? 1, false);
      }
    });
    return () => { disposed = true; stop(); };
  }, [languageServerId, openSource]);

  useEffect(() => desktop.onEvent((event) => {
    if (event.type !== "language_server_progress" || event.languageServerId !== languageServerId || event.tool !== "LLDB debugger") return;
    const progress = event as { bytes?: unknown; stage?: unknown; total?: unknown };
    if (typeof progress.stage !== "string") return;
    setDebuggerToolProgress({
      stage: progress.stage,
      ...(typeof progress.bytes === "number" ? { bytes: progress.bytes } : {}),
      ...(typeof progress.total === "number" ? { total: progress.total } : {}),
    });
    if (progress.stage === "ready") window.setTimeout(() => setDebuggerToolProgress(undefined), 1_200);
  }), [languageServerId]);

  const loadTargets = useCallback((refresh = false) => {
    const version = ++targetRequestVersion.current;
    setTargets([]);
    setTargetError(undefined);
    if (!root) return () => undefined;
    let disposed = false;
    setTargetsLoading(true);
    void desktop.languageServerCall(languageServerId, "debugConfigurations", root, contextFile, refresh, buildConfiguration)
      .then((value) => {
        if (disposed || version !== targetRequestVersion.current) return;
        const next = Array.isArray(value) ? value as DebugConfigurationCandidate[] : [];
        setTargets(next);
        const preferred = persistedTarget.current;
        const selected = next.some((item) => item.id === preferred) ? preferred : next[0]?.id ?? "";
        persistedTarget.current = selected;
        setTargetId(selected);
      })
      .catch((cause) => { if (!disposed && version === targetRequestVersion.current) setTargetError(String(cause)); })
      .finally(() => { if (!disposed && version === targetRequestVersion.current) setTargetsLoading(false); });
    return () => { disposed = true; };
  }, [buildConfiguration, contextFile, languageServerId, root]);

  useEffect(() => {
    targetRefreshArmed.current = false;
    // The panel may mount after the language-project ready event, so its first
    // request must not reuse an empty discovery made during configuration.
    return loadTargets(true);
  }, [loadTargets]);

  useEffect(() => {
    const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
    const stop = desktop.onEvent((event) => {
      if (event.type !== "language_server_project" || event.languageServerId !== languageServerId) return;
      const project = event.project as { root?: unknown; status?: unknown } | undefined;
      if (!root || typeof project?.root !== "string" || normalize(project.root) !== normalize(root)) return;
      const usable = project.status === "indexing" || project.status === "ready";
      if (!usable) {
        targetRefreshArmed.current = false;
        return;
      }
      if (targetRefreshArmed.current) return;
      targetRefreshArmed.current = true;
      loadTargets(true);
    });
    return stop;
  }, [languageServerId, loadTargets, root]);

  const loadProcesses = useCallback(() => {
    setProcessesLoading(true);
    void desktop.languageServerCall(languageServerId, "debugProcesses")
      .then((value) => setProcesses(Array.isArray(value) ? value as DebugProcess[] : []))
      .catch((cause) => onError(`${en ? "Process discovery failed" : "进程发现失败"}：${String(cause)}`))
      .finally(() => setProcessesLoading(false));
  }, [en, languageServerId, onError]);
  useEffect(() => { if (mode === "attach") loadProcesses(); }, [loadProcesses, mode]);

  const call = async (method: string, ...values: unknown[]) => {
    setBusy(true);
    try {
      const sessionMethods = new Set(["debugClearOutput", "debugCommand", "debugSelectFrame", "debugStop"]);
      const value = await desktop.languageServerCall(languageServerId, method, ...values, ...(sessionMethods.has(method) && activeSessionId ? [activeSessionId] : [])) as DebugSnapshot;
      setSnapshot(value);
      if (value.sessionId) setSessions((current) => current.map((item) => item.sessionId === value.sessionId ? value : item));
    } catch (cause) {
      onError(`${en ? "Debug operation failed" : "调试操作失败"}：${String(cause)}`);
    } finally {
      setBusy(false);
    }
  };
  const startConfiguration = () => root ? {
      args: parseArguments(args),
      buildConfiguration,
      cwd: root,
      mode,
      ...(mode === "launch" ? (targetId ? { targetId } : { program }) : mode === "attach" ? { processId: Number(processId) } : { dumpPath, program, sourceMap: parseSourceMap(sourceMapText), symbolPaths }),
      root,
      ...(mode === "attach" ? { sessionName: processes.find((process) => String(process.pid) === processId)?.name ?? `Process ${processId}` } : {}),
      stopOnEntry,
    } : undefined;
  const start = async () => {
    const configuration = startConfiguration();
    if (!configuration) return;
    setBusy(true);
    try {
      const next = await desktop.languageServerCall(languageServerId, "debugStart", configuration) as DebugSnapshot;
      setSnapshot(next); setSessionId(next.sessionId); setCreatingSession(false);
      setSessions((current) => [...current.filter((item) => item.sessionId !== next.sessionId), next]);
    } catch (cause) { onError(`${en ? "Debug start failed" : "启动调试失败"}：${String(cause)}`); }
    finally { setBusy(false); }
  };
  const restart = async () => {
    const configuration = startConfiguration();
    if (!configuration) return;
    setBusy(true);
    try {
      if (activeSessionId) await desktop.languageServerCall(languageServerId, "debugCloseSession", activeSessionId);
      const result = await desktop.languageServerCall(languageServerId, "debugStart", configuration);
      const next = result as DebugSnapshot;
      setSnapshot(next); setSessionId(next.sessionId);
      setSessions((current) => [...current.filter((item) => item.sessionId !== activeSessionId && item.sessionId !== next.sessionId), next]);
    } catch (cause) { onError(`${en ? "Debug restart failed" : "重新调试失败"}：${String(cause)}`); }
    finally { setBusy(false); }
  };
  const evaluate = async () => {
    const expression = consoleInput.trim();
    if (!expression) return;
    setConsoleInput("");
    setConsoleHistory((current) => {
      const next = appendConsoleHistory(current, expression);
      consoleHistoryIndex.current = next.length;
      return next;
    });
    try {
      await desktop.languageServerCall(languageServerId, "debugEvaluate", expression, "repl", activeSessionId);
    } catch (cause) {
      onError(`${en ? "Expression evaluation failed" : "表达式计算失败"}：${String(cause)}`);
    }
  };
  const resetLayout = () => {
    const layout = defaultDebugProject().layout;
    setColumnPercent(layout.columnPercent);
    setConsolePercent(layout.consolePercent);
    setHiddenPanels([]);
    setRowPercent(layout.rowPercent);
  };
  const togglePanel = (panel: DebugPanelId) => setHiddenPanels((current) => current.includes(panel) ? current.filter((item) => item !== panel) : [...current, panel]);
  const beginLayoutResize = (kind: "column" | "console" | "row", event: React.PointerEvent) => {
    if (event.button !== 0) return;
    layoutResize.current = { initial: kind === "column" ? columnPercent : kind === "row" ? rowPercent : consolePercent, kind, pointerId: event.pointerId, start: kind === "column" ? event.clientX : event.clientY };
    document.body.classList.add("is-resizing-debug-layout");
  };
  const removeBreakpoint = (file: string, line: number) => void call("debugSetBreakpoints", file, snapshot.breakpoints.filter((item) => item.file === file && item.line !== line).map((item) => item.line));
  const active = snapshot.state === "running" || snapshot.state === "stopped" || snapshot.state === "starting";
  const stopped = snapshot.state === "stopped";
  const layout = debugLayoutGeometry(hiddenPanels, columnPercent, rowPercent, consolePercent);
  const { bottom: bottomVisible, breakpoints: breakpointsVisible, console: consoleVisible, locals: localsVisible, stack: stackVisible, top: topVisible, watch: watchVisible } = layout.visible;
  const addWatch = (expression: string) => {
    const value = expression.trim();
    if (value && !snapshot.watches.some((watch) => watch.expression === value))
      void call("debugSetWatches", [...snapshot.watches.map((watch) => watch.expression), value]);
  };
  const localScopes = selectedFrame?.scopes.filter(isLocalDebugScope) ?? [];
  const localVariables = localScopes.flatMap((scope) => scope.variables.filter((variable) => !registerGroup(variable)).map((variable) => ({ scope, variable })));
  const selectSession = async (nextId: string) => {
    setSessionId(nextId);
    try {
      const next = await desktop.languageServerCall(languageServerId, "debugSelectSession", nextId) as DebugSnapshot;
      setSnapshot(next); setCreatingSession(false);
    } catch (cause) { onError(String(cause)); }
  };
  const endSession = async (detach = false) => {
    if (!activeSessionId) return;
    setBusy(true);
    try {
      await desktop.languageServerCall(languageServerId, detach ? "debugDetachSession" : "debugCloseSession", activeSessionId);
      const value = await desktop.languageServerCall(languageServerId, "debugSessions");
      const next = (Array.isArray(value) ? value as DebugSnapshot[] : []).filter((item) => item.state !== "terminated");
      setSessions(next);
      const selected = next.at(-1);
      sessionIdRef.current = selected?.sessionId;
      setSessionId(selected?.sessionId); setSnapshot(selected ?? emptyDebugSnapshot());
    } catch (cause) { onError(String(cause)); }
    finally { setBusy(false); }
  };
  const showLaunch = creatingSession || !active;

  return <DebugServerContext.Provider value={languageServerId}><DebugSessionContext.Provider value={activeSessionId}><section className="debug-panel">
    {sessions.length ? <div className="debug-session-bar">
      <select aria-label={en ? "Debug session" : "调试会话"} onChange={(event) => void selectSession(event.target.value)} value={activeSessionId ?? ""}>{sessions.map((item) => <option key={item.sessionId} value={item.sessionId}>{item.sessionLabel ?? item.sessionId} · {item.state}</option>)}</select>
      <button onClick={() => setCreatingSession(true)} title={en ? "New debug session" : "新建调试会话"} type="button"><i className="fa-solid fa-plus" /></button>
      {creatingSession ? <button onClick={() => setCreatingSession(false)} type="button">{en ? "Cancel" : "取消"}</button> : null}
    </div> : null}
    {active ? <div className="debug-toolbar">
      <button disabled={busy} onClick={() => void endSession()} title={en ? "Stop process and close session" : "停止进程并关闭会话"} type="button"><i className="fa-solid fa-stop" /></button>
      <button disabled={busy || snapshot.sessionKind === "dump"} onClick={() => void endSession(true)} title={en ? "Detach and close session" : "分离进程并关闭会话"} type="button"><i className="fa-solid fa-link-slash" /></button>
      {active && snapshot.sessionKind !== "dump" ? <button disabled={busy} onClick={() => void restart()} title={en ? "Restart" : "重新调试"} type="button"><i className="fa-solid fa-arrow-rotate-right" /></button> : null}
      <button disabled={busy || !active || snapshot.sessionKind === "dump"} onClick={() => void call("debugCommand", snapshot.state === "running" ? "pause" : "continue")} title={snapshot.state === "running" ? (en ? "Pause" : "暂停") : (en ? "Continue" : "继续")} type="button"><i className={`fa-solid fa-${snapshot.state === "running" ? "pause" : "play"}`} /></button>
      <button disabled={busy || !stopped || snapshot.sessionKind === "dump"} onClick={() => void call("debugCommand", "next")} title={en ? "Step over" : "逐过程"} type="button"><i className="fa-solid fa-arrow-right" /></button>
      <button disabled={busy || !stopped || snapshot.sessionKind === "dump"} onClick={() => void call("debugCommand", "stepIn")} title={en ? "Step into" : "逐语句"} type="button"><i className="fa-solid fa-arrow-down" /></button>
      <button disabled={busy || !stopped || snapshot.sessionKind === "dump"} onClick={() => void call("debugCommand", "stepOut")} title={en ? "Step out" : "跳出"} type="button"><i className="fa-solid fa-arrow-up" /></button>
      <button disabled={!active} onClick={() => void desktopWindow.openDebugTool("memory", undefined, languageServerId, activeSessionId)} title={en ? "Memory" : "内存"} type="button"><i className="fa-solid fa-memory" /></button>
      <button disabled={!active} onClick={() => void desktopWindow.openDebugTool("registers", undefined, languageServerId, activeSessionId)} title={en ? "Registers" : "寄存器"} type="button"><i className="fa-solid fa-microchip" /></button>
      <button disabled={!active} onClick={() => void desktopWindow.openDebugTool("disassembly", undefined, languageServerId, activeSessionId)} title={en ? "Disassembly" : "反汇编"} type="button"><i className="fa-solid fa-code" /></button>
      <span className={`debug-state is-${snapshot.state}`}>{snapshot.adapter ? snapshot.adapter.toUpperCase() : en ? "Native debugger" : "原生调试器"} · {snapshot.state}{snapshot.stopReason ? ` · ${snapshot.stopReason}` : ""}</span>
      {active ? <div className="debug-layout-control"><button aria-expanded={layoutMenu} onClick={() => setLayoutMenu((value) => !value)} title={en ? "Tool windows" : "工具窗口"} type="button"><i className="fa-solid fa-table-cells-large" /></button>{layoutMenu ? <div className="debug-layout-menu">{(["locals", "watch", "stack", "breakpoints", "console"] as DebugPanelId[]).map((panel) => <label key={panel}><input checked={!hiddenPanels.includes(panel)} onChange={() => togglePanel(panel)} type="checkbox" />{{ locals: en ? "Locals" : "局部变量", watch: en ? "Watch" : "监视", stack: en ? "Call Stack" : "调用堆栈", breakpoints: en ? "Breakpoints" : "断点", console: en ? "Console" : "控制台" }[panel]}</label>)}<button onClick={resetLayout} type="button">{en ? "Reset layout" : "重置布局"}</button></div> : null}</div> : null}
    </div> : null}
    {showLaunch ? <div className="debug-launch-form">
      <select onChange={(event) => setMode(event.target.value as "launch" | "attach" | "dump")} value={mode}>{modes.includes("launch") ? <option value="launch">{en ? "Launch" : "启动"}</option> : null}{modes.includes("attach") ? <option value="attach">{en ? "Attach" : "附加"}</option> : null}{modes.includes("dump") ? <option value="dump">{en ? "Open dump" : "打开 Dump"}</option> : null}</select>
      {providerId === "cpp-native" ? <select aria-label={en ? "CMake build configuration" : "CMake 生成配置"} disabled={mode !== "launch" || targetsLoading} onChange={(event) => setBuildConfiguration(event.target.value as CMakeBuildConfiguration)} title={en ? "CMake build configuration" : "CMake 生成配置"} value={buildConfiguration}>{CMAKE_BUILD_CONFIGURATIONS.map((configuration) => <option key={configuration} value={configuration}>{configuration}</option>)}</select> : null}
      {mode === "launch" ? <>{targets.length ? <div className="debug-target-picker"><select onChange={(event) => { persistedTarget.current = event.target.value; setTargetId(event.target.value); }} value={targetId}>{targets.map((target) => <option key={target.id} value={target.id}>{target.name}{target.built ? "" : en ? " (not built)" : "（未构建）"}</option>)}</select><button disabled={targetsLoading} onClick={() => loadTargets(true)} title={en ? "Refresh CMake executable targets" : "刷新 CMake 可执行目标"} type="button"><i className="fa-solid fa-rotate-right" /></button></div> : <div className="debug-target-picker"><input disabled={targetsLoading} onChange={(event) => setProgram(event.target.value)} placeholder={targetsLoading ? (en ? "Reading CMake targets…" : "正在读取 CMake 目标…") : (en ? "Program path in workspace" : "工作区内的程序路径")} value={program} /><button disabled={targetsLoading} onClick={() => loadTargets(true)} title={en ? "Refresh CMake executable targets" : "刷新 CMake 可执行目标"} type="button"><i className="fa-solid fa-rotate-right" /></button></div>}<input onChange={(event) => setArgs(event.target.value)} placeholder={en ? "Arguments" : "程序参数"} value={args} /></> : mode === "attach" ? <div className="debug-target-picker"><select disabled={processesLoading} onChange={(event) => setProcessId(event.target.value)} value={processId}><option value="">{processesLoading ? (en ? "Reading processes…" : "正在读取进程…") : (en ? "Select a process" : "选择进程")}</option>{processes.map((process) => <option key={process.pid} title={process.command} value={process.pid}>{process.name} ({process.pid})</option>)}</select><button disabled={processesLoading} onClick={loadProcesses} title={en ? "Refresh processes" : "刷新进程"} type="button"><i className="fa-solid fa-rotate-right" /></button></div> : <>
        <div className="debug-target-picker"><input onChange={(event) => setDumpPath(event.target.value)} placeholder={en ? "Core / minidump path" : "Core / minidump 文件"} value={dumpPath} /><button onClick={() => void platform.openDialog({ filters: [{ name: "Dump files", extensions: ["core", "dmp", "mdmp", "*"] }], title: en ? "Open dump" : "打开 Dump" }).then((value) => { if (typeof value === "string") setDumpPath(value); })} type="button"><i className="fa-solid fa-folder-open" /></button></div>
        <div className="debug-target-picker"><input onChange={(event) => setProgram(event.target.value)} placeholder={en ? "Matching executable (required for LLDB)" : "匹配的可执行文件（LLDB 必填）"} value={program} /><button onClick={() => void platform.openDialog({ title: en ? "Select matching executable" : "选择匹配的可执行文件" }).then((value) => { if (typeof value === "string") setProgram(value); })} type="button"><i className="fa-solid fa-folder-open" /></button></div>
        <div className="debug-target-picker"><input onChange={(event) => setSymbolPaths(event.target.value.split(";").map((item) => item.trim()).filter(Boolean))} placeholder={en ? "Symbol directories, separated by ;" : "符号目录，以 ; 分隔"} value={symbolPaths.join(";")} /><button onClick={() => void platform.openDialog({ directory: true, multiple: true, title: en ? "Select symbol directories" : "选择符号目录" }).then((value) => { if (Array.isArray(value)) setSymbolPaths(value); else if (typeof value === "string") setSymbolPaths([value]); })} type="button"><i className="fa-solid fa-folder-open" /></button></div>
        <textarea onChange={(event) => setSourceMapText(event.target.value)} placeholder={en ? "Source mapping: original=local, one per line" : "源码映射：原始路径=本地路径，每行一条"} value={sourceMapText} />
      </>}
      {mode === "launch" ? <label><input checked={stopOnEntry} onChange={(event) => setStopOnEntry(event.target.checked)} type="checkbox" />{en ? "Stop at entry" : "在入口处停止"}</label> : null}
      {targetError ? <small className="debug-target-error">{en ? "Debug configuration discovery failed; enter a program path manually." : "调试配置发现失败，请手动输入程序路径。"} {targetError}</small> : null}
      {debuggerToolProgress ? <div className="debug-tool-progress"><span>{debuggerToolProgress.stage === "downloading" ? (en ? "Downloading private LLDB debugger…" : "正在下载私有 LLDB 调试器…") : debuggerToolProgress.stage === "extracting" ? (en ? "Extracting private LLDB debugger…" : "正在解压私有 LLDB 调试器…") : debuggerToolProgress.stage === "ready" ? (en ? "Private LLDB debugger is ready" : "私有 LLDB 调试器已就绪") : (en ? "Preparing private LLDB debugger…" : "正在准备私有 LLDB 调试器…")}</span>{debuggerToolProgress.total ? <progress max={debuggerToolProgress.total} value={Math.min(debuggerToolProgress.bytes ?? 0, debuggerToolProgress.total)} /> : null}</div> : null}
      {snapshot.error ? <small className="debug-error">{snapshot.error}</small> : null}
      <button className="debug-start-button" disabled={busy || targetsLoading || !root || (mode === "launch" ? !(targetId || program.trim()) : mode === "attach" ? !processId.trim() : !dumpPath.trim())} onClick={() => void start()} type="button"><i className={`fa-solid fa-${busy ? "spinner fa-spin" : "play"}`} />{en ? mode === "dump" ? "Open dump" : "Start debugging" : mode === "dump" ? "打开 Dump" : "启动调试"}</button>
    </div> : <div className="debug-windows" style={{ gridTemplateColumns: layout.columns, gridTemplateRows: layout.rows }}>
      {localsVisible ? <section className={`debug-pane-locals${watchVisible ? "" : " is-full-row"}`} style={variableColumnStyle(localColumnWidths)}><h4>{en ? "Locals" : "局部变量"}</h4><VariableColumns en={en} setWidths={setLocalColumnWidths} widths={localColumnWidths} /><div className="debug-table">{localVariables.map(({ scope, variable }, index) => <VariableRow canEdit={snapshot.sessionKind === "live" && snapshot.capabilities.supportsSetVariable === true} depth={0} en={en} key={`${scope.name}:${variable.name}:${index}`} onAddWatch={addWatch} onError={onError} onSnapshot={setSnapshot} parentReference={scope.variablesReference} variable={variable} />)}{!localVariables.length ? <p>{en ? "No variables" : "没有变量"}</p> : null}</div></section> : null}
      {watchVisible ? <section className={`debug-pane-watch${localsVisible ? "" : " is-full-row"}`} style={variableColumnStyle(watchColumnWidths)}><h4>{en ? "Watch" : "监视"}</h4><form onSubmit={(event) => { event.preventDefault(); addWatch(watchInput); setWatchInput(""); }}><input onChange={(event) => setWatchInput(event.target.value)} placeholder={en ? "Add expression" : "添加表达式"} value={watchInput} /></form><VariableColumns en={en} setWidths={setWatchColumnWidths} watch widths={watchColumnWidths} /><div className="debug-table">{snapshot.watches.map((watch) => <WatchRow canEdit={snapshot.sessionKind === "live" && snapshot.capabilities.supportsSetVariable === true} en={en} key={watch.expression} onAddWatch={addWatch} onError={onError} onRemove={() => void call("debugSetWatches", snapshot.watches.filter((item) => item.expression !== watch.expression).map((item) => item.expression))} onSnapshot={setSnapshot} watch={watch} />)}</div></section> : null}
      {localsVisible && watchVisible ? <div className="debug-layout-resizer is-column is-top" onPointerDown={(event) => beginLayoutResize("column", event)} /> : null}
      {topVisible && bottomVisible ? <div className="debug-layout-resizer is-row" onPointerDown={(event) => beginLayoutResize("row", event)} /> : null}
      {stackVisible ? <section className={`debug-pane-stack${breakpointsVisible ? "" : " is-full-row"}`}><h4>{en ? "Call Stack" : "调用堆栈"}</h4><div className="debug-stack">{snapshot.threads.map((thread) => <div key={thread.id}><strong>{thread.name}</strong>{thread.frames.map((frame) => <button className={frame.id === snapshot.selectedFrameId ? "is-active" : undefined} key={frame.id} onClick={() => void call("debugSelectFrame", thread.id, frame.id)} type="button"><span>{frame.name}</span><small>{frame.file ? `${frame.file.split(/[\\/]/).pop()}:${frame.line ?? 0}` : ""}</small></button>)}</div>)}</div></section> : null}
      {breakpointsVisible ? <section className={`debug-pane-breakpoints${stackVisible ? "" : " is-full-row"}`}><h4>{en ? "Breakpoints" : "断点"}<button disabled={!snapshot.breakpoints.length} onClick={() => void call("debugClearBreakpoints")} title={en ? "Remove all source breakpoints" : "删除全部源码断点"} type="button"><i className="fa-solid fa-trash-can" /></button></h4><div className="debug-breakpoints">{snapshot.breakpoints.map((breakpoint) => <BreakpointRow breakpoint={breakpoint} en={en} key={`${breakpoint.file}:${breakpoint.line}`} onError={onError} onOpen={() => openSource(breakpoint.file, breakpoint.line)} onRemove={() => removeBreakpoint(breakpoint.file, breakpoint.line)} onSnapshot={setSnapshot} />)}</div>{snapshot.capabilities.supportsFunctionBreakpoints === true ? <div className="debug-special-breakpoints"><strong>{en ? "Function breakpoints" : "函数断点"}</strong><form onSubmit={(event) => { event.preventDefault(); const name = functionBreakpointInput.trim(); if (!name) return; setFunctionBreakpointInput(""); void call("debugSetFunctionBreakpoints", [...snapshot.functionBreakpoints, { name }]); }}><input onChange={(event) => setFunctionBreakpointInput(event.target.value)} placeholder={en ? "Function name" : "函数名称"} value={functionBreakpointInput} /></form>{snapshot.functionBreakpoints.map((item) => <div key={item.name}><span>{item.name}</span><small>{item.message ?? (item.verified === false ? (en ? "Unverified" : "未验证") : "")}</small><button onClick={() => void call("debugSetFunctionBreakpoints", snapshot.functionBreakpoints.filter((candidate) => candidate !== item))} type="button">×</button></div>)}</div> : null}{snapshot.exceptionBreakpointFilters.length ? <div className="debug-exception-breakpoints"><strong>{en ? "Exception breakpoints" : "异常断点"}</strong>{snapshot.exceptionBreakpointFilters.map((filter) => <label key={filter.filter}><input checked={snapshot.exceptionFilters.includes(filter.filter)} onChange={(event) => void call("debugSetExceptionFilters", event.target.checked ? [...snapshot.exceptionFilters, filter.filter] : snapshot.exceptionFilters.filter((item) => item !== filter.filter))} type="checkbox" />{filter.label}</label>)}</div> : null}</section> : null}
      {stackVisible && breakpointsVisible ? <div className="debug-layout-resizer is-column is-bottom" onPointerDown={(event) => beginLayoutResize("column", event)} /> : null}
      {consoleVisible && layout.visible.tools ? <div className="debug-layout-resizer is-console" onPointerDown={(event) => beginLayoutResize("console", event)} /> : null}
      {consoleVisible ? <section className="debug-output"><h4>{en ? "Debug Console" : "调试控制台"}<button onClick={() => void call("debugClearOutput")} title={en ? "Clear" : "清空"} type="button"><i className="fa-solid fa-trash-can" /></button></h4><pre>{snapshot.output}</pre><form onSubmit={(event) => { event.preventDefault(); void evaluate(); }}><input disabled={!stopped} onChange={(event) => { consoleHistoryIndex.current = consoleHistory.length; setConsoleInput(event.target.value); }} onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); const next = navigateConsoleHistory(consoleHistory, consoleHistoryIndex.current, event.key === "ArrowUp" ? -1 : 1); consoleHistoryIndex.current = next.index; setConsoleInput(next.value); } }} placeholder={stopped ? (en ? "Evaluate expression" : "计算表达式") : (en ? "Pause to evaluate" : "暂停后可计算表达式")} value={consoleInput} /></form></section> : null}
    </div>}
  </section></DebugSessionContext.Provider></DebugServerContext.Provider>;
}
