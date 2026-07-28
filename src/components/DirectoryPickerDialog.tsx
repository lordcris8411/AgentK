import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { desktop } from "../lib/desktop";

type DirectoryState = { path: string; parent: string; directories: string[]; files: string[]; drives: string[] };

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
}

export function DirectoryPickerDialog({ acceptedFileExtensions, initialPath, onCancel, onSelect, restrictedRoot, selectFiles = false, title }: { acceptedFileExtensions?: readonly string[]; initialPath?: string; onCancel(): void; onSelect(path: string): void; restrictedRoot?: string; selectFiles?: boolean; title: string }) {
  const [state, setState] = useState<DirectoryState>();
  const [pathInput, setPathInput] = useState(initialPath ?? "");
  const [error, setError] = useState<string>();
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
    }).catch((cause) => setError(String(cause)));
  };
  useEffect(() => load(initialPath), [initialPath]);
  const atRestrictedRoot = !!state && !!restrictedRoot && normalizedPath(state.path) === normalizedPath(restrictedRoot);
  return createPortal(
    <div className="directory-picker-backdrop">
      <section aria-modal="true" className="directory-picker" role="dialog" style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}>
        <header onPointerDown={(event) => { if ((event.target as Element).closest("button")) return; drag.current = { x: event.clientX - offset.x, y: event.clientY - offset.y }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (drag.current) setOffset({ x: event.clientX - drag.current.x, y: event.clientY - drag.current.y }); }} onPointerUp={() => { drag.current = undefined; }}>
          <strong>{title}</strong><button onClick={onCancel} type="button"><i className="fa-solid fa-xmark" /></button>
        </header>
        <label className="directory-picker-path">路径<input aria-label="目录路径" onChange={(event) => setPathInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); load(pathInput); } }} value={pathInput} /></label>
        {state?.drives.length && !restrictedRoot ? <label className="directory-picker-drives">驱动器<select onChange={(event) => load(event.target.value)} value={state.drives.find((drive) => state.path.toLowerCase().startsWith(drive.toLowerCase())) ?? state.drives[0]}>{state.drives.map((drive) => <option key={drive} value={drive}>{drive}</option>)}</select></label> : null}
        {error ? <p>{error}</p> : <div className="directory-picker-list"><button disabled={atRestrictedRoot} onClick={() => state && load(state.parent)} type="button">..</button>{state?.directories.map((name) => <button key={name} onClick={() => state && load(`${state.path}\\${name}`)} type="button"><i className="fa-regular fa-folder" /> {name}</button>)}{selectFiles && state?.files.filter((name) => !acceptedFileExtensions || acceptedFileExtensions.some((extension) => name.toLowerCase().endsWith(extension.toLowerCase()))).map((name) => <button className="directory-picker-file" key={name} onClick={() => state && onSelect(`${state.path}\\${name}`)} type="button"><i className="fa-regular fa-file-zipper" /> {name}</button>)}</div>}
        {!selectFiles && <footer><button disabled={!state} onClick={() => state && onSelect(state.path)} type="button">选择此目录</button></footer>}
      </section>
    </div>,
    document.body,
  );
}
