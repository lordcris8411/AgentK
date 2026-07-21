import Editor, { DiffEditor } from "@monaco-editor/react";
import { defineAgentKTheme } from "../../lib/monacoTheme";
import { registerResponsiveMonacoEditor } from "../../lib/responsiveMonaco";
import { useMemo, useState } from "react";
import { desktop } from "../../lib/desktop";
import { useSettings } from "../settings/SettingsContext";

export type ReviewCall = { name: string; args: Record<string, unknown> };

function pathOf(call: ReviewCall) {
  return [call.args.path, call.args.filePath, call.args.file_path, call.args.to].find((value): value is string => typeof value === "string") ?? "文件";
}

function pathIsInProject(root: string | undefined, path: string): boolean {
  if (!root) return false;
  if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(path)) return true;
  const normalizedRoot = root.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
  const normalizedPath = path.replaceAll("/", "\\").toLowerCase();
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}\\`);
}

function versionsFor(call: ReviewCall) {
  if (typeof call.args.aggregateOriginal === "string" && typeof call.args.aggregateModified === "string") return { original: call.args.aggregateOriginal, modified: call.args.aggregateModified };
  if (call.name === "write") return { original: "", modified: typeof call.args.content === "string" ? call.args.content : "" };
  const edits = Array.isArray(call.args.edits) ? call.args.edits : [{ oldText: call.args.oldText, newText: call.args.newText }];
  const changes = edits.map((edit) => {
    const change = edit as Record<string, unknown>;
    return { oldText: typeof change.oldText === "string" ? change.oldText : "", newText: typeof change.newText === "string" ? change.newText : "" };
  });
  return { original: changes.map((change) => change.oldText).join("\n\n"), modified: changes.map((change) => change.newText).join("\n\n") };
}

function languageFor(path: string) { const extension = path.split(".").pop()?.toLowerCase(); return ({ py: "python", pyw: "python", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", md: "markdown", yml: "yaml", yaml: "yaml", sh: "shell", ps1: "powershell", rs: "rust", css: "css", html: "html", xml: "xml" } as Record<string, string>)[extension ?? ""] ?? "plaintext"; }

export function ReviewPanel({ calls, root, onClose, onError }: { calls: ReviewCall[]; root?: string; onClose(): void; onError(message: string): void }) {
  const editorTheme = useSettings().resolvedTheme === "dark" ? "agent-k-dark" : "agent-k-light";
  const [selected, setSelected] = useState(0);
  const [reverted, setReverted] = useState<Set<number>>(() => new Set());
  const call = calls[selected];
  const canUndo = Boolean(
    root && call?.name === "edit" && pathIsInProject(root, pathOf(call)),
  );
  const versions = useMemo(() => call ? versionsFor(call) : { original: "", modified: "" }, [call]);
  const undoEdit = async () => {
    if (!root || !call || call.name !== "edit" || !pathIsInProject(root, pathOf(call))) return;
    try {
      const path = pathOf(call);
      let current = await desktop.read(root, path);
      const edits = Array.isArray(call.args.edits) ? call.args.edits : [{ oldText: call.args.oldText, newText: call.args.newText }];
      for (const edit of edits) {
        const { oldText, newText } = edit as Record<string, unknown>;
        if (typeof oldText !== "string" || typeof newText !== "string" || !current.includes(newText)) throw new Error("文件已被后续修改，无法安全撤销");
        current = current.replace(newText, oldText);
      }
      await desktop.write(root, path, current);
      setReverted((currentSet) => new Set(currentSet).add(selected));
    } catch (cause) { onError(`撤销失败：${String(cause)}`); }
  };
  const registerLayout = (editor: Parameters<typeof registerResponsiveMonacoEditor>[0]) => {
    const unregister = registerResponsiveMonacoEditor(editor);
    editor.onDidDispose(unregister);
  };
  return <section aria-label="审阅变更" className="review-panel"><header><div><p>审阅</p><h2>已编辑 {calls.length} 个文件</h2></div><button aria-label="关闭审阅" onClick={onClose} type="button">×</button></header><div className="review-body"><nav>{calls.map((entry, index) => <button className={index === selected ? "active" : ""} key={`${entry.name}-${pathOf(entry)}-${index}`} onClick={() => setSelected(index)} type="button"><span>{entry.name === "write" ? "新建" : "编辑"}</span>{pathOf(entry).split(/[\\/]/).pop()}</button>)}</nav><main>{call && <><div className="review-file-header"><strong>{pathOf(call)}</strong>{call.name === "edit" && (canUndo ? <button disabled={reverted.has(selected)} onClick={() => void undoEdit()} type="button">{reverted.has(selected) ? "已撤销" : "撤销此编辑"}</button> : <span className="review-note">外部资源仅支持审阅</span>)}</div><div className={call.name === "write" ? "review-editor is-write" : "review-editor"}>{call.name === "write" ? <Editor beforeMount={defineAgentKTheme} height="100%" language={languageFor(pathOf(call))} onMount={registerLayout} options={{ automaticLayout: false, inertialScroll: true, minimap: { enabled: false }, mouseWheelScrollSensitivity: 1.5, readOnly: true, scrollbar: { alwaysConsumeMouseWheel: false, handleMouseWheel: true }, scrollBeyondLastLine: false, smoothScrolling: true, wordWrap: "on" }} theme={editorTheme} value={versions.modified} /> : <DiffEditor beforeMount={defineAgentKTheme} height="100%" language={languageFor(pathOf(call))} modified={versions.modified} onMount={registerLayout} options={{ automaticLayout: false, diffWordWrap: "on", inertialScroll: true, minimap: { enabled: false }, mouseWheelScrollSensitivity: 1.5, readOnly: true, renderSideBySide: false, scrollbar: { alwaysConsumeMouseWheel: false, handleMouseWheel: true }, scrollBeyondLastLine: false, smoothScrolling: true, wordWrap: "on" }} original={versions.original} theme={editorTheme} />}</div>{call.name === "write" && <p className="review-note">整文件写入可在此审阅；为避免覆盖后续修改，首版不提供自动撤销。</p>}</>}</main></div></section>;
}
