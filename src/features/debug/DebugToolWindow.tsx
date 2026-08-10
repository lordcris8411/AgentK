import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { desktop } from "../../lib/desktop";
import { desktopWindow } from "../../lib/platform";
import { emptyDebugSnapshot, type DebugInstruction, type DebugMemory, type DebugMemoryWrite, type DebugScope, type DebugSnapshot, type DebugVariable } from "./types";

const DebugServerContext = createContext("");
const DebugSessionContext = createContext<string | undefined>(undefined);
export type DebugToolKind = "disassembly" | "memory" | "registers";

function useDebugSnapshot(packId: string, sessionId?: string) {
  const [snapshot, setSnapshot] = useState<DebugSnapshot>(emptyDebugSnapshot);
  useEffect(() => {
    let disposed = false;
    setSnapshot(emptyDebugSnapshot());
    void desktop.languagePackCall(packId, "debugStatus", sessionId).then((value) => { if (!disposed) setSnapshot(value as DebugSnapshot); }).catch(() => undefined);
    const stop = desktop.onEvent((event) => {
      if (event.type === "debug_session" && event.packId === packId && event.snapshot && typeof event.snapshot === "object" && (event.snapshot as DebugSnapshot).sessionId === sessionId)
        setSnapshot(event.snapshot as DebugSnapshot);
    });
    return () => { disposed = true; stop(); };
  }, [packId, sessionId]);
  return snapshot;
}

function ToolMessage({ children }: { children: string }) {
  return <div className="debug-tool-message">{children}</div>;
}

function memoryAddress(base: string, offset: number): string {
  try { return `0x${(BigInt(base) + BigInt(offset)).toString(16)}`; }
  catch { return offset ? `${base} + ${offset}` : base; }
}

function MemoryTool({ initialTarget, snapshot }: { initialTarget?: string; snapshot: DebugSnapshot }) {
  const packId = useContext(DebugServerContext);
  const sessionId = useContext(DebugSessionContext);
  const selectedFrame = snapshot.threads.flatMap((thread) => thread.frames).find((frame) => frame.id === snapshot.selectedFrameId);
  const [reference, setReference] = useState(initialTarget ?? "");
  const [activeReference, setActiveReference] = useState("");
  const [offset, setOffset] = useState(0);
  const [memory, setMemory] = useState<DebugMemory>();
  const [draft, setDraft] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const stopped = snapshot.state === "stopped";
  const readable = snapshot.capabilities.supportsReadMemoryRequest === true;
  const writable = stopped && snapshot.sessionKind === "live" && snapshot.capabilities.supportsWriteMemoryRequest === true;
  useEffect(() => {
    if (!reference && selectedFrame?.instructionPointerReference) setReference(selectedFrame.instructionPointerReference);
  }, [reference, selectedFrame?.instructionPointerReference]);
  useEffect(() => {
    if (!stopped) { setMemory(undefined); setDraft([]); }
  }, [stopped]);
  const load = useCallback(async (nextOffset = offset, inputReference = reference) => {
    const input = inputReference.trim();
    if (!input) return;
    setBusy(true); setError(undefined);
    try {
      let resolved = input;
      if (!/^(?:0x[\da-f]+|\d+)$/iu.test(input)) {
        try {
          const evaluation = await desktop.languagePackCall(packId, "debugEvaluate", input, "watch", sessionId) as { memoryReference?: string };
          resolved = evaluation.memoryReference ?? input;
        } catch { /* Adapter-specific expressions may also be valid memory references. */ }
      }
      const result = await desktop.languagePackCall(packId, "debugReadMemory", resolved, nextOffset, 256, sessionId) as DebugMemory;
      setActiveReference(resolved); setOffset(nextOffset); setMemory(result); setDraft(result.bytes.map((byte) => byte.toString(16).padStart(2, "0")));
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }, [packId, offset, reference, sessionId]);
  useEffect(() => desktopWindow.onDebugToolTarget((target) => { setReference(target); setOffset(0); void load(0, target); }), [load]);
  useEffect(() => { if (initialTarget && stopped && readable) void load(0, initialTarget); }, [initialTarget, readable, stopped]);
  const changed = useMemo(() => new Set(draft.flatMap((value, index) => value !== memory?.bytes[index]?.toString(16).padStart(2, "0") ? [index] : [])), [draft, memory]);
  const apply = async () => {
    if (!memory || !changed.size) return;
    setBusy(true); setError(undefined);
    try {
      const indices = [...changed].sort((a, b) => a - b);
      for (let cursor = 0; cursor < indices.length;) {
        const start = indices[cursor]!;
        let end = start;
        while (cursor + 1 < indices.length && indices[cursor + 1] === end + 1) { cursor += 1; end += 1; }
        const bytes = draft.slice(start, end + 1).map((value) => Number.parseInt(value, 16));
        const result = await desktop.languagePackCall(packId, "debugWriteMemory", activeReference, offset + start, bytes, sessionId) as DebugMemoryWrite;
        if (result.bytesWritten !== bytes.length) throw new Error(`Only ${result.bytesWritten} of ${bytes.length} bytes were written`);
        cursor += 1;
      }
      await load(offset);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  if (!stopped) return <ToolMessage>调试暂停后可查看内存。</ToolMessage>;
  if (!readable) return <ToolMessage>当前调试适配器不支持读取内存。</ToolMessage>;
  const rows = Array.from({ length: 16 }, (_, row) => {
    const start = row * 16;
    const bytes = draft.slice(start, start + 16);
    const missing = Math.max(0, 16 - bytes.length);
    const address = memory ? memoryAddress(memory.address, start) : "";
    return <div className="debug-memory-row" key={row}>
      <code className="debug-memory-address">{address}</code>
      <div className="debug-memory-hex">{bytes.map((value, index) => <input aria-label={`Byte ${start + index}`} className={changed.has(start + index) ? "is-changed" : ""} disabled={!writable} key={start + index} maxLength={2} onChange={(event) => {
        const next = event.target.value.replace(/[^0-9a-f]/gi, "").slice(0, 2).toLowerCase();
        setDraft((current) => current.map((item, itemIndex) => itemIndex === start + index ? next : item));
      }} value={value} />)}{Array.from({ length: missing }, (_, index) => <span key={`missing-${index}`}>??</span>)}</div>
      <code className="debug-memory-ascii">{bytes.map((value) => { const byte = Number.parseInt(value, 16); return Number.isFinite(byte) && byte >= 32 && byte < 127 ? String.fromCharCode(byte) : "."; }).join("")}</code>
    </div>;
  });
  return <>
    <div className="debug-tool-toolbar">
      <input aria-label="Memory address or expression" onChange={(event) => setReference(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void load(0); }} placeholder="地址或表达式，例如 &value / 0x1000" value={reference} />
      <button disabled={busy || !reference.trim()} onClick={() => void load(0)} type="button"><i className="fa-solid fa-arrow-right" /> 跳转</button>
      <button disabled={busy || !memory} onClick={() => void load(offset - 256)} type="button"><i className="fa-solid fa-chevron-left" /></button>
      <button disabled={busy || !memory} onClick={() => void load(offset + 256)} type="button"><i className="fa-solid fa-chevron-right" /></button>
      <button disabled={busy || !memory} onClick={() => void load(offset)} type="button"><i className={`fa-solid fa-${busy ? "spinner fa-spin" : "rotate"}`} /></button>
      <button disabled={busy || !writable || !changed.size || draft.some((value) => value.length !== 2)} onClick={() => void apply()} type="button">应用</button>
      <button disabled={!changed.size} onClick={() => setDraft(memory?.bytes.map((byte) => byte.toString(16).padStart(2, "0")) ?? [])} type="button">取消</button>
      {snapshot.sessionKind === "dump" ? <span>Dump 只读</span> : null}
    </div>
    {error ? <div className="debug-tool-error">{error}</div> : null}
    <div className="debug-memory-view">
      {memory ? <div className="debug-memory-grid">
        <div className="debug-memory-header" aria-hidden="true">
          <span>地址</span>
          <div>{Array.from({ length: 16 }, (_, index) => <code key={index}>{index.toString(16).padStart(2, "0")}</code>)}</div>
          <span>ASCII</span>
        </div>
        {rows}
      </div> : <ToolMessage>输入地址或表达式以查看内存。</ToolMessage>}
      {memory?.unreadableBytes ? <small className="debug-memory-unreadable">{memory.unreadableBytes} 个字节不可读</small> : null}
    </div>
  </>;
}

function RegisterVariable({ canEdit, changed, parentReference, variable }: { canEdit: boolean; changed: boolean; parentReference: number; variable: DebugVariable }) {
  const packId = useContext(DebugServerContext);
  const sessionId = useContext(DebugSessionContext);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(variable.value);
  const [error, setError] = useState<string>();
  useEffect(() => setValue(variable.value), [variable.value]);
  const save = async () => {
    setEditing(false);
    if (value === variable.value) return;
    try { await desktop.languagePackCall(packId, "debugSetVariable", parentReference, variable.name, value, sessionId); }
    catch (cause) { setValue(variable.value); setError(String(cause)); }
  };
  return <div className={`debug-register-row ${changed ? "is-changed" : ""}`}>
    <span>{variable.name}</span>
    {editing ? <input autoFocus onBlur={() => void save()} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void save(); if (event.key === "Escape") { setValue(variable.value); setEditing(false); } }} value={value} />
      : <code onDoubleClick={() => { if (canEdit) setEditing(true); }}>{variable.value}</code>}
    <small>{error ?? variable.type}</small>
  </div>;
}

function RegistersTool({ snapshot }: { snapshot: DebugSnapshot }) {
  const packId = useContext(DebugServerContext);
  const sessionId = useContext(DebugSessionContext);
  const previous = useRef(new Map<string, string>());
  const [nestedGroups, setNestedGroups] = useState<DebugScope[]>([]);
  const selectedFrame = snapshot.threads.flatMap((thread) => thread.frames).find((frame) => frame.id === snapshot.selectedFrameId);
  const directScopes = selectedFrame?.scopes.filter((scope) => scope.presentationHint === "registers" || /register/i.test(scope.name)) ?? [];
  const groupVariables = selectedFrame?.scopes.flatMap((scope) => scope.variables.filter((variable) => variable.variablesReference > 0 && /register|vector extension/i.test(variable.name))) ?? [];
  const groupKey = groupVariables.map((variable) => `${variable.name}:${variable.variablesReference}`).join("|");
  useEffect(() => {
    let disposed = false;
    if (snapshot.state !== "stopped") { setNestedGroups([]); return () => { disposed = true; }; }
    void Promise.all(groupVariables.map(async (variable): Promise<DebugScope> => ({
      expensive: false,
      name: variable.name,
      variables: await desktop.languagePackCall(packId, "debugVariables", variable.variablesReference, sessionId) as DebugVariable[],
      variablesReference: variable.variablesReference,
    }))).then((groups) => { if (!disposed) setNestedGroups(groups); }).catch(() => { if (!disposed) setNestedGroups([]); });
    return () => { disposed = true; };
  }, [groupKey, packId, sessionId, snapshot.state]);
  const scopes = [...directScopes, ...nestedGroups];
  const current = new Map(scopes.flatMap((scope) => scope.variables.map((variable) => [`${scope.name}:${variable.name}`, variable.value] as const)));
  const changed = new Set([...current].flatMap(([name, value]) => previous.current.has(name) && previous.current.get(name) !== value ? [name] : []));
  useEffect(() => { if (snapshot.state === "stopped") previous.current = current; }, [snapshot.selectedFrameId, snapshot.state, groupKey, nestedGroups]);
  useEffect(() => { if (snapshot.state !== "stopped") previous.current.clear(); }, [snapshot.state]);
  if (snapshot.state !== "stopped") return <ToolMessage>调试暂停后可查看寄存器。</ToolMessage>;
  if (!scopes.length) return <ToolMessage>当前栈帧没有提供寄存器作用域。</ToolMessage>;
  const canEdit = snapshot.sessionKind === "live" && snapshot.capabilities.supportsSetVariable === true;
  return <div className="debug-registers">{scopes.map((scope) => <details key={`${scope.name}:${scope.variablesReference}`} open>
    <summary>{scope.name}<small>{canEdit ? "双击值可修改" : "只读"}</small></summary>
    {scope.variables.map((variable) => <RegisterVariable canEdit={canEdit} changed={changed.has(`${scope.name}:${variable.name}`)} key={variable.name} parentReference={scope.variablesReference} variable={variable} />)}
  </details>)}</div>;
}

function DisassemblyTool({ snapshot }: { snapshot: DebugSnapshot }) {
  const packId = useContext(DebugServerContext);
  const sessionId = useContext(DebugSessionContext);
  const selectedFrame = snapshot.threads.flatMap((thread) => thread.frames).find((frame) => frame.id === snapshot.selectedFrameId);
  const instructionPointer = selectedFrame?.instructionPointerReference ?? "";
  const [reference, setReference] = useState("");
  const [page, setPage] = useState(0);
  const [instructions, setInstructions] = useState<DebugInstruction[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const readable = snapshot.capabilities.supportsDisassembleRequest === true;
  const load = useCallback(async (nextPage = page, nextReference = reference || instructionPointer) => {
    if (!nextReference || snapshot.state !== "stopped" || !readable) return;
    setBusy(true); setError(undefined);
    try {
      const value = await desktop.languagePackCall(packId, "debugDisassemble", nextReference, nextPage * 64 - 32, 64, 0, sessionId);
      setReference(nextReference); setPage(nextPage); setInstructions(Array.isArray(value) ? value as DebugInstruction[] : []);
    } catch (cause) { setError(String(cause)); setInstructions([]); }
    finally { setBusy(false); }
  }, [instructionPointer, packId, page, readable, reference, sessionId, snapshot.state]);
  useEffect(() => { if (instructionPointer && snapshot.state === "stopped" && readable) void load(0, instructionPointer); }, [instructionPointer, readable, snapshot.state]);
  useEffect(() => { if (snapshot.state !== "stopped") setInstructions([]); }, [snapshot.state]);
  if (snapshot.state !== "stopped") return <ToolMessage>调试暂停后可查看反汇编。</ToolMessage>;
  if (!readable) return <ToolMessage>当前调试适配器不支持反汇编。</ToolMessage>;
  const canBreak = snapshot.sessionKind === "live" && snapshot.capabilities.supportsInstructionBreakpoints === true;
  const breakpointAddresses = new Set(snapshot.instructionBreakpoints.map((item) => item.address));
  const toggleBreakpoint = async (address: string) => {
    const next = breakpointAddresses.has(address) ? [...breakpointAddresses].filter((item) => item !== address) : [...breakpointAddresses, address];
    try { await desktop.languagePackCall(packId, "debugSetInstructionBreakpoints", next, sessionId); }
    catch (cause) { setError(String(cause)); }
  };
  return <>
    <div className="debug-tool-toolbar">
      <input aria-label="Instruction address" onChange={(event) => setReference(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void load(0, reference); }} placeholder="地址或指令引用" value={reference} />
      <button disabled={busy || !reference.trim()} onClick={() => void load(0, reference)} type="button">跳转</button>
      <button disabled={busy} onClick={() => void load(page - 1)} type="button"><i className="fa-solid fa-chevron-left" /></button>
      <button disabled={busy} onClick={() => void load(page + 1)} type="button"><i className="fa-solid fa-chevron-right" /></button>
      <button disabled={busy} onClick={() => void load(page)} type="button"><i className={`fa-solid fa-${busy ? "spinner fa-spin" : "rotate"}`} /></button>
      {!canBreak ? <span>{snapshot.sessionKind === "dump" ? "Dump 只读" : "指令断点不可用"}</span> : null}
    </div>
    {error ? <div className="debug-tool-error">{error}</div> : null}
    <div className="debug-disassembly">{instructions.map((item) => <div className={item.address === instructionPointer ? "is-current" : ""} key={item.address}>
      <button className={breakpointAddresses.has(item.address) ? "has-breakpoint" : ""} disabled={!canBreak} onClick={() => void toggleBreakpoint(item.address)} title="指令断点" type="button" />
      <code>{item.address}</code><code>{item.instructionBytes ?? ""}</code><code>{item.instruction}</code><span>{item.symbol}</span>
      {item.location?.path && item.line ? <button onClick={() => void desktopWindow.openEditorLocation({ column: item.column, line: item.line!, path: item.location!.path! })} type="button">{item.location.name ?? item.location.path}:{item.line}</button> : null}
    </div>)}</div>
  </>;
}

export function DebugToolWindow({ initialPackId, initialRoot: _initialRoot, initialSessionId, initialTarget, kind }: { initialPackId: string; initialRoot?: string; initialSessionId?: string; initialTarget?: string; kind: DebugToolKind }) {
  const [packId, setPackId] = useState(initialPackId);
  const [sessionId, setSessionId] = useState(initialSessionId);
  const snapshot = useDebugSnapshot(packId, sessionId);
  useEffect(() => desktopWindow.onDebugToolProvider(setPackId), []);
  useEffect(() => desktopWindow.onDebugToolSession(setSessionId), []);
  useEffect(() => {
    document.body.classList.add("is-native-debug-window");
    document.title = `Agent K — ${{ disassembly: "Disassembly", memory: "Memory", registers: "Registers" }[kind]}`;
    return () => document.body.classList.remove("is-native-debug-window");
  }, [kind]);
  return <DebugServerContext.Provider value={packId}><DebugSessionContext.Provider value={sessionId}>
    <main className="native-debug-window debug-tool-window">
      {kind === "memory" ? <MemoryTool initialTarget={initialTarget} snapshot={snapshot} /> : kind === "registers" ? <RegistersTool snapshot={snapshot} /> : <DisassemblyTool snapshot={snapshot} />}
    </main>
  </DebugSessionContext.Provider></DebugServerContext.Provider>;
}
