import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { desktop } from "../lib/desktop";

type DirectoryState = { path: string; parent: string; directories: string[]; files: string[]; drives: string[] };

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
}

function childPath(directory: string, name: string): string {
  const windowsPath = /^[A-Za-z]:[\\/]/.test(directory) || directory.startsWith("\\\\");
  const separator = windowsPath ? "\\" : "/";
  const base = windowsPath
    ? directory.replace(/[\\/]+$/, "")
    : directory.replace(/\/+$/, "");
  return `${base}${separator}${name}`;
}

export function DirectoryPickerDialog({ acceptedFileExtensions, initialPath, onCancel, onSelect, restrictedRoot, selectFiles = false, title }: { acceptedFileExtensions?: readonly string[]; initialPath?: string; onCancel(): void; onSelect(path: string): void; restrictedRoot?: string; selectFiles?: boolean; title: string }) {
  const [state, setState] = useState<DirectoryState>();
  const [pathInput, setPathInput] = useState(initialPath ?? "");
  const [error, setError] = useState<string>();
  const [creatingDirectory, setCreatingDirectory] = useState(false);
  const [directoryName, setDirectoryName] = useState("");
  const [directoryError, setDirectoryError] = useState<string>();
  const [directoryBusy, setDirectoryBusy] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | undefined>(undefined);
  const load = (path?: string) => {
    const target = path?.trim();
    if (target && restrictedRoot) {
      const root = normalizedPath(restrictedRoot);
      const candidate = normalizedPath(target);
      if (candidate !== root && !candidate.startsWith(`${root}/`)) {
        setError("只能选择当前项目内的目录");
        return;
      }
    }
    setError(undefined);
    void desktop.browseDirectories(target).then((next) => {
      setState(next);
      setPathInput(next.path);
      setCreatingDirectory(false);
      setDirectoryName("");
      setDirectoryError(undefined);
    }).catch((cause) => setError(String(cause)));
  };
  const submitPathInput = () => {
    const target = pathInput.trim();
    const acceptedFile = selectFiles && target && (
      !acceptedFileExtensions ||
      acceptedFileExtensions.some((extension) => target.toLowerCase().endsWith(extension.toLowerCase()))
    );
    if (acceptedFile) {
      onSelect(target);
      return;
    }
    load(target);
  };
  const createDirectory = () => {
    if (!state || directoryBusy) return;
    const name = directoryName.trim();
    if (
      !name ||
      name === "." ||
      name === ".." ||
      /[<>:"/\\|?*\u0000-\u001f]/u.test(name) ||
      /[. ]$/u.test(name)
    ) {
      setDirectoryError("请输入有效的目录名称");
      return;
    }
    setDirectoryBusy(true);
    setDirectoryError(undefined);
    void desktop.createBrowsedDirectory(state.path, name).then((path) => {
      load(path);
    }).catch((cause) => {
      setDirectoryError(String(cause));
    }).finally(() => setDirectoryBusy(false));
  };
  useEffect(() => load(initialPath), [initialPath]);
  const atRestrictedRoot = !!state && !!restrictedRoot && normalizedPath(state.path) === normalizedPath(restrictedRoot);
  return createPortal(
    <div className="directory-picker-backdrop">
      <section aria-modal="true" className="directory-picker" role="dialog" style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}>
        <header onPointerDown={(event) => { if ((event.target as Element).closest("button")) return; drag.current = { x: event.clientX - offset.x, y: event.clientY - offset.y }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (drag.current) setOffset({ x: event.clientX - drag.current.x, y: event.clientY - drag.current.y }); }} onPointerUp={() => { drag.current = undefined; }}>
          <strong>{title}</strong><button onClick={onCancel} type="button"><i className="fa-solid fa-xmark" /></button>
        </header>
        <div className="directory-picker-path">
          <span>路径</span>
          <span className="directory-picker-path-controls">
            <input aria-label={selectFiles ? "文件或目录路径" : "目录路径"} onChange={(event) => setPathInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submitPathInput(); } }} value={pathInput} />
            <button aria-label="新建目录" disabled={!state || directoryBusy} onClick={() => { setCreatingDirectory(true); setDirectoryError(undefined); }} title="新建目录" type="button"><i className="fa-solid fa-folder-plus" /></button>
          </span>
        </div>
        {creatingDirectory && (
          <div className="directory-picker-create">
            <input aria-label="新目录名称" autoFocus onChange={(event) => { setDirectoryName(event.target.value); setDirectoryError(undefined); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); createDirectory(); } else if (event.key === "Escape") { setCreatingDirectory(false); setDirectoryName(""); setDirectoryError(undefined); } }} placeholder="新目录名称" value={directoryName} />
            <button disabled={directoryBusy || !directoryName.trim()} onClick={createDirectory} type="button">{directoryBusy ? "创建中…" : "创建"}</button>
            <button disabled={directoryBusy} onClick={() => { setCreatingDirectory(false); setDirectoryName(""); setDirectoryError(undefined); }} type="button">取消</button>
            {directoryError && <small>{directoryError}</small>}
          </div>
        )}
        {state?.drives.length && !restrictedRoot ? <label className="directory-picker-drives">驱动器<select onChange={(event) => load(event.target.value)} value={state.drives.find((drive) => state.path.toLowerCase().startsWith(drive.toLowerCase())) ?? state.drives[0]}>{state.drives.map((drive) => <option key={drive} value={drive}>{drive}</option>)}</select></label> : null}
        {error ? <p>{error}</p> : <div className="directory-picker-list"><button disabled={atRestrictedRoot} onClick={() => state && load(state.parent)} type="button">..</button>{state?.directories.map((name) => <button key={name} onClick={() => state && load(childPath(state.path, name))} type="button"><i className="fa-regular fa-folder" /> {name}</button>)}{selectFiles && state?.files.filter((name) => !acceptedFileExtensions || acceptedFileExtensions.some((extension) => name.toLowerCase().endsWith(extension.toLowerCase()))).map((name) => <button className="directory-picker-file" key={name} onClick={() => state && onSelect(childPath(state.path, name))} type="button"><i className="fa-regular fa-file-zipper" /> {name}</button>)}</div>}
        {!selectFiles && <footer><button disabled={!state} onClick={() => state && onSelect(state.path)} type="button">选择此目录</button></footer>}
      </section>
    </div>,
    document.body,
  );
}
