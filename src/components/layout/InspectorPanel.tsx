import { createPortal } from "react-dom";
import {
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { desktop, type FileEntry } from "../../lib/desktop";
import { desktopWindow, platform } from "../../lib/platform";
import { ProjectConsole } from "./ProjectConsole";
import {
  ReviewPanel,
  type ReviewCall,
} from "../../features/conversation/ReviewPanel";
import { useSettings } from "../../features/settings/SettingsContext";
import {
  fileMatchContext,
  languageIdFor,
  resolveFileFormat,
} from "../../features/file-formats/builtins";
import type { FileFormatPlugin } from "../../features/file-formats/sdk";
import {
  PluginEditorFrame,
  preloadEditorPluginDependencies,
  type PluginEditorHandle,
} from "../../features/file-formats/PluginEditorFrame";

type Tab = {
  binary?: ArrayBuffer;
  path: string;
  content: string;
  saved: string;
  unsupported?: boolean;
  previewBytes?: number;
  previewCodec?: string;
  mimeType?: string;
  format?: FileFormatPlugin;
  previewMode?: boolean;
  runtimeDirty?: boolean;
  webPreviewUrl?: string;
  webPreviewReloadToken?: number;
};
type WorkspaceEditorState = {
  active?: string;
  tabs: Tab[];
};
type PluginEditorProps = ComponentPropsWithoutRef<typeof PluginEditorFrame>;
const EDITOR_RUNTIME_CACHE_LIMIT = 40;
type PluginMenuAction = { id: string; label: string; pluginId: string };

async function createPluginMenuActions(
  root: string,
  entry: FileEntry,
  plugins: readonly FileFormatPlugin[],
): Promise<PluginMenuAction[]> {
  let packageJson: string | undefined;
  let directoryEntries: string[] = [];
  if (entry.isDir) {
    try { packageJson = await desktop.read(root, `${entry.path ? `${entry.path}/` : ""}package.json`); } catch { /* optional context */ }
    try {
      directoryEntries = (await desktop.directory(root, entry.path)).children
        .map((child) => child.name);
    } catch { /* optional context */ }
  }
  const viteConfig = entry.isDir && await Promise.all(["vite.config.js", "vite.config.ts", "vite.config.mjs", "vite.config.cjs"].map(async (name) => {
    try { await desktop.read(root, `${entry.path ? `${entry.path}/` : ""}${name}`); return true; } catch { return false; }
  })).then((matches) => matches.some(Boolean));
  const context = { absolutePath: absoluteWorkspacePath(root, entry.path), directoryEntries, isDirectory: entry.isDir, packageJson, path: entry.path, viteConfig };
  const results = await Promise.all(plugins.filter((plugin) => plugin.runtime.menu).map(async (plugin) => {
    const runtime = await desktop.editorPluginRuntime(root, plugin.id);
    const menuJavascript = runtime.menuJavascript;
    if (!menuJavascript) return [];
    return await new Promise<PluginMenuAction[]>((resolve) => {
      const nonce = `${Date.now()}-${Math.random()}`;
      const frame = document.createElement("iframe");
      frame.hidden = true;
      frame.sandbox.add("allow-scripts");
      const finish = (value: PluginMenuAction[]) => { window.removeEventListener("message", receive); frame.remove(); resolve(value); };
      const receive = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow || event.data?.nonce !== nonce) return;
        if (!Array.isArray(event.data.items)) return;
        const items = event.data.items;
        finish(items.flatMap((item: unknown): PluginMenuAction[] => item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" && typeof (item as { label?: unknown }).label === "string" ? [{ id: (item as { id: string }).id, label: (item as { label: string }).label, pluginId: plugin.id }] : []));
      };
      window.addEventListener("message", receive);
      window.setTimeout(() => finish([]), 800);
      const source = menuJavascript.replace(/<\/script/gi, "<\\/script");
      frame.srcdoc = `<script>${source}</script><script>window.addEventListener('message',async e=>{try{const fn=globalThis.AgentKContextMenu;const items=typeof fn==='function'?await fn(e.data.context):[];parent.postMessage({nonce:e.data.nonce,items},'*')}catch{parent.postMessage({nonce:e.data.nonce,items:[]},'*')}});parent.postMessage({nonce:${JSON.stringify(nonce)},ready:true},'*')</script>`;
      document.body.append(frame);
      const ready = (event: MessageEvent) => { if (event.source === frame.contentWindow && event.data?.nonce === nonce && event.data.ready) { window.removeEventListener("message", ready); frame.contentWindow?.postMessage({ nonce, context }, "*"); } };
      window.addEventListener("message", ready);
    });
  }));
  return results.flat();
}

function insertCachedEditorRuntime(
  keys: string[],
  activeKey: string,
  recency: string[],
): string[] {
  if (keys.includes(activeKey)) return keys;
  if (keys.length < EDITOR_RUNTIME_CACHE_LIMIT) return [...keys, activeKey];
  const evictionKey =
    recency.find((key) => keys.includes(key)) ?? keys[0];
  return [
    ...keys.filter((key) => key !== evictionKey),
    activeKey,
  ];
}

function CachedPluginEditor({
  active,
  activeEditorRef,
  frameProps,
}: {
  active: boolean;
  activeEditorRef: { current: PluginEditorHandle | null };
  frameProps?: PluginEditorProps;
}) {
  const editorRef = useRef<PluginEditorHandle | null>(null);
  const lastFrameProps = useRef<PluginEditorProps | undefined>(frameProps);
  if (frameProps) lastFrameProps.current = frameProps;

  useEffect(() => {
    if (active) activeEditorRef.current = editorRef.current;
    else if (activeEditorRef.current === editorRef.current)
      activeEditorRef.current = null;
    return () => {
      if (activeEditorRef.current === editorRef.current)
        activeEditorRef.current = null;
    };
  }, [active, activeEditorRef]);

  const retainedProps = lastFrameProps.current;
  if (!retainedProps) return null;
  return (
    <div
      aria-hidden={!active}
      className={`cached-plugin-editor${active ? " is-active" : " is-hidden"}`}
    >
      <PluginEditorFrame {...retainedProps} ref={editorRef} />
    </div>
  );
}
function detectVideoCodec(data: ArrayBuffer) {
  const bytes = new Uint8Array(data);
  const windowSize = 8 * 1024 * 1024;
  const decoder = new TextDecoder("latin1");
  const searchable = [
    decoder.decode(bytes.subarray(0, Math.min(bytes.length, windowSize))),
    bytes.length > windowSize
      ? decoder.decode(bytes.subarray(Math.max(0, bytes.length - windowSize)))
      : "",
  ];
  const signatures: Array<[string, string]> = [
    ["V_MPEGH/ISO/HEVC", "H.265 / HEVC"],
    ["V_MPEG4/ISO/AVC", "H.264 / AVC"],
    ["hvc1", "H.265 / HEVC"],
    ["hev1", "H.265 / HEVC"],
    ["HEVC", "H.265 / HEVC"],
    ["avc1", "H.264 / AVC"],
    ["avc3", "H.264 / AVC"],
    ["H264", "H.264 / AVC"],
    ["V_AV1", "AV1"],
    ["av01", "AV1"],
    ["V_VP9", "VP9"],
    ["vp09", "VP9"],
    ["V_VP8", "VP8"],
    ["vp08", "VP8"],
    ["mp4v", "MPEG-4 Part 2"],
    ["XVID", "MPEG-4 Part 2 (Xvid)"],
    ["DIVX", "MPEG-4 Part 2 (DivX)"],
    ["theora", "Theora"],
  ];
  return signatures.find(([signature]) =>
    searchable.some((chunk) => chunk.includes(signature)),
  )?.[1];
}
function replacePathName(path: string, name: string) {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator < 0 ? name : `${path.slice(0, separator + 1)}${name}`;
}
function absoluteWorkspacePath(root: string, relativePath: string) {
  if (!relativePath) return root;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${relativePath.replace(/[\\/]/g, separator)}`;
}

function relativeWorkspacePath(root: string, path: string): string | undefined {
  const requested = path.trim().replaceAll("\\", "/");
  if (!requested) return "";
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/, "");
  const isAbsolute = /^(?:[a-z]:\/|\/\/|\/)/i.test(requested);
  if (isAbsolute) {
    const rootKey = normalizedRoot.toLocaleLowerCase("en-US");
    const requestedKey = requested.toLocaleLowerCase("en-US");
    if (!requestedKey.startsWith(`${rootKey}/`)) return undefined;
    return requested.slice(normalizedRoot.length + 1);
  }
  const relative = requested.replace(/^\.\//, "");
  return relative.split("/").some((part) => part === "..") ? undefined : relative;
}
function pathIsWithin(path: string, parent: string) {
  return (
    path === parent ||
    path.startsWith(`${parent}/`) ||
    path.startsWith(`${parent}\\`)
  );
}
function mergeFileTree(fresh: FileEntry, previous?: FileEntry): FileEntry {
  if (!previous || fresh.path !== previous.path || !fresh.isDir) return fresh;
  if (!fresh.loaded && previous.loaded)
    return { ...fresh, children: previous.children, loaded: true };
  if (!fresh.loaded || !previous.loaded) return fresh;
  const previousChildren = new Map(
    previous.children.map((entry) => [entry.path, entry]),
  );
  return {
    ...fresh,
    children: fresh.children.map((entry) =>
      mergeFileTree(entry, previousChildren.get(entry.path)),
    ),
  };
}
function loadedDirectoryPaths(entry?: FileEntry): string[] {
  if (!entry?.isDir || !entry.loaded) return [];
  return [
    ...(entry.path ? [entry.path] : []),
    ...entry.children.flatMap(loadedDirectoryPaths),
  ];
}
function replaceTreeEntry(
  tree: FileEntry,
  path: string,
  replacement: FileEntry,
): FileEntry {
  if (tree.path === path) return replacement;
  if (!tree.isDir) return tree;
  return {
    ...tree,
    children: tree.children.map((entry) =>
      replaceTreeEntry(entry, path, replacement),
    ),
  };
}
const languageFor = (path: string) => {
  return languageIdFor(path);
};
function FileIcon({ path }: { path: string }) {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const extension = name.split(".").pop() ?? "";
  let icon = "fa-regular fa-file";
  let kind = "generic";
  if (
    name === "package.json" ||
    name === "cargo.toml" ||
    name.endsWith("lock")
  ) {
    icon = "fa-solid fa-cube";
    kind = "package";
  } else if (name.startsWith(".git")) {
    icon = "fa-solid fa-code-branch";
    kind = "git";
  } else if (
    ["html", "htm", "css", "scss", "sass", "less", "vue", "svelte"].includes(
      extension,
    )
  ) {
    icon = "fa-solid fa-globe";
    kind = "web";
  } else if (
    [
      "py",
      "pyw",
      "js",
      "jsx",
      "ts",
      "tsx",
      "rs",
      "go",
      "java",
      "c",
      "cc",
      "cpp",
      "cxx",
      "h",
      "hh",
      "hpp",
      "hxx",
      "cs",
      "sh",
      "bash",
      "zsh",
      "ps1",
      "bat",
      "cmd",
      "php",
      "rb",
      "swift",
      "kt",
      "kts",
      "dart",
      "lua",
      "r",
      "sql",
      "graphql",
      "gql",
    ].includes(extension)
  ) {
    icon = "fa-regular fa-file-code";
    kind = "code";
  } else if (["md", "mdx", "txt", "log", "rtf"].includes(extension)) {
    icon = "fa-regular fa-file-lines";
    kind = "text";
  } else if (
    ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"].includes(
      extension,
    )
  ) {
    icon = "fa-regular fa-file-image";
    kind = "image";
  } else if (
    [
      "mp3",
      "wav",
      "flac",
      "ogg",
      "oga",
      "m4a",
      "aac",
      "wma",
      "opus",
      "mid",
      "midi",
    ].includes(extension)
  ) {
    icon = "fa-regular fa-file-audio";
    kind = "audio";
  } else if (
    [
      "mp4",
      "m4v",
      "mkv",
      "mov",
      "avi",
      "webm",
      "wmv",
      "flv",
      "mpeg",
      "mpg",
      "3gp",
      "ogv",
      "ts",
      "mts",
      "m2ts",
    ].includes(extension)
  ) {
    icon = "fa-regular fa-file-video";
    kind = "video";
  } else if (
    [
      "obj",
      "fbx",
      "gltf",
      "glb",
      "stl",
      "dae",
      "3ds",
      "blend",
      "ply",
      "usdz",
      "step",
      "stp",
      "iges",
      "igs",
    ].includes(extension)
  ) {
    icon = "fa-solid fa-cube";
    kind = "model-3d";
  } else if (extension === "pdf") {
    icon = "fa-regular fa-file-pdf";
    kind = "pdf";
  } else if (["zip", "7z", "rar", "tar", "gz", "bz2"].includes(extension)) {
    icon = "fa-regular fa-file-zipper";
    kind = "archive";
  } else if (["csv", "tsv", "xls", "xlsx"].includes(extension)) {
    icon = "fa-solid fa-table";
    kind = "data";
  } else if (["db", "sqlite", "sqlite3"].includes(extension)) {
    icon = "fa-solid fa-database";
    kind = "data";
  } else if (
    ["json", "jsonc", "yaml", "yml", "toml", "xml", "ini"].includes(extension)
  ) {
    icon = "fa-solid fa-sliders";
    kind = "config";
  }
  return (
    <i aria-hidden="true" className={`${icon} file-type-icon is-${kind}`} />
  );
}
function Tree({
  entry,
  loadDirectory,
  open,
  dropTarget,
  selectedPath,
  select,
  shouldSuppressClick,
  showContextMenu,
  startPointerDrag,
}: {
  entry: FileEntry;
  loadDirectory(path: string): void;
  open(path: string): void;
  dropTarget: string | null;
  selectedPath?: string;
  select(entry: FileEntry): void;
  shouldSuppressClick(): boolean;
  showContextMenu(entry: FileEntry, event: ReactMouseEvent): void;
  startPointerDrag(event: ReactPointerEvent, entry: FileEntry): void;
}) {
  const [expanded, setExpanded] = useState(entry.path === "");
  return entry.isDir ? (
    <details
      className={entry.path === dropTarget ? "drop-target" : undefined}
      data-directory-path={entry.path}
      open={expanded}
      onToggle={(event) => {
        const isOpen = (event.currentTarget as HTMLDetailsElement).open;
        setExpanded(isOpen);
        if (isOpen && !entry.loaded)
          loadDirectory(entry.path);
      }}
    >
      <summary
        className={entry.path === selectedPath ? "selected" : undefined}
        onClick={(event) => {
          event.preventDefault();
          if (shouldSuppressClick()) return;
          select(entry);
        }}
        onContextMenu={(event) => showContextMenu(entry, event)}
        onPointerDown={(event) => {
          if (!entry.path || event.target instanceof Element && event.target.closest(".tree-folder-toggle")) return;
          startPointerDrag(event, entry);
        }}
      >
        <span
          aria-label="展开或收起文件夹"
          className="tree-folder-toggle"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const details = event.currentTarget.closest(
              "details",
            ) as HTMLDetailsElement | null;
            if (details) details.open = !details.open;
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            const details = event.currentTarget.closest(
              "details",
            ) as HTMLDetailsElement | null;
            if (details) details.open = !details.open;
          }}
          role="button"
          tabIndex={0}
          title="展开或收起文件夹"
        >
          <i
            aria-hidden="true"
            className="fa-solid fa-chevron-right tree-chevron"
          />
          <span aria-hidden="true" className="tree-folder-icons">
            <i className="fa-regular fa-folder folder-closed" />
            <i className="fa-regular fa-folder-open folder-open" />
          </span>
        </span>
        <span>{entry.name}</span>
      </summary>
      {entry.children.map((child) => (
        <Tree
          entry={child}
          key={child.path}
          loadDirectory={loadDirectory}
          open={open}
          dropTarget={dropTarget}
          selectedPath={selectedPath}
          select={select}
          shouldSuppressClick={shouldSuppressClick}
          showContextMenu={showContextMenu}
          startPointerDrag={startPointerDrag}
        />
      ))}
    </details>
  ) : (
    <button
      className={`file-node${entry.path === selectedPath ? " selected" : ""}`}
      onClick={() => {
        if (shouldSuppressClick()) return;
        select(entry);
        open(entry.path);
      }}
      onContextMenu={(event) => showContextMenu(entry, event)}
      onPointerDown={(event) => startPointerDrag(event, entry)}
      type="button"
    >
      <FileIcon path={entry.path} />
      <span>{entry.name}</span>
    </button>
  );
}
export function InspectorPanel({
  root,
  onError,
  review,
  onCloseReview,
}: {
  root?: string;
  onError(message: string): void;
  review?: ReviewCall[];
  onCloseReview(): void;
}) {
  const { settings, resolvedTheme, t, update: updateSettings } = useSettings();
  const en = settings.locale === "en-US";
  const [tree, setTree] = useState<FileEntry>();
  const [fileFormatPlugins, setFileFormatPlugins] = useState<FileFormatPlugin[]>([]);
  const [loading, setLoading] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [editorRuntimeKeys, setEditorRuntimeKeys] = useState<string[]>([]);
  const editorRuntimeRecency = useRef<string[]>([]);
  const [active, setActive] = useState<string>();
  const [lineNavigation, setLineNavigation] = useState<{
    line: number;
    path: string;
    requestId: number;
  }>();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [filtering, setFiltering] = useState(false);
  const [explorerWidth, setExplorerWidth] = useState(190);
  const [newFileDialogOpen, setNewFileDialogOpen] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  const [createAsDirectory, setCreateAsDirectory] = useState(false);
  const [creatingFile, setCreatingFile] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<FileEntry>();
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [mutatingPath, setMutatingPath] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [pointerDrag, setPointerDrag] = useState<{
    canDrop: boolean;
    isDir: boolean;
    label: string;
    path: string;
    x: number;
    y: number;
  }>();
  const pointerDragCleanup = useRef<() => void>(() => undefined);
  const suppressTreeClickUntil = useRef(0);
  const [contextMenu, setContextMenu] = useState<{
    entry: FileEntry;
    x: number;
    y: number;
  }>();
  const [pluginMenuActions, setPluginMenuActions] = useState<PluginMenuAction[]>([]);
  const inspectorRef = useRef<HTMLElement>(null);
  const pluginEditorRef = useRef<PluginEditorHandle | null>(null);
  const activePathRef = useRef<string | undefined>(undefined);
  const activationRequest = useRef(0);
  const resizingExplorer = useRef(false);
  const refreshInFlight = useRef(new Set<string>());
  const currentRoot = useRef(root);
  const tabsRoot = useRef(root);
  const workspaceEditorStates = useRef(new Map<string, WorkspaceEditorState>());
  const treeRef = useRef<FileEntry | undefined>(undefined);
  currentRoot.current = root;
  treeRef.current = tree;
  activePathRef.current = active;
  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!resizingExplorer.current || !inspectorRef.current) return;
      const left = inspectorRef.current.getBoundingClientRect().left;
      setExplorerWidth(
        Math.max(
          110,
          Math.min(
            inspectorRef.current.clientWidth - 120,
            event.clientX - left,
          ),
        ),
      );
    };
    const stop = () => {
      resizingExplorer.current = false;
      document.body.classList.remove("is-resizing");
      window.dispatchEvent(new CustomEvent("agent-k-editor-layout-suspended", { detail: false }));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };
  }, []);
  useEffect(() => () => pointerDragCleanup.current(), []);
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(undefined);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [contextMenu]);
  const refresh = (silent = false) => {
    const targetRoot = root;
    if (!targetRoot || refreshInFlight.current.has(targetRoot)) return;
    refreshInFlight.current.add(targetRoot);
    if (!silent) setLoading(true);
    void desktop
      .tree(targetRoot)
      .then(async (loaded) => {
        if (currentRoot.current !== targetRoot) return;
        const previous = treeRef.current;
        let nextTree = mergeFileTree(loaded, previous);
        const loadedPaths = loadedDirectoryPaths(previous);
        const refreshedDirectories = await Promise.all(
          loadedPaths.map(async (path) => {
            try {
              return await desktop.directory(targetRoot, path);
            } catch {
              return undefined;
            }
          }),
        );
        if (currentRoot.current !== targetRoot) return;
        for (const refreshed of refreshedDirectories) {
          if (!refreshed) continue;
          const priorDirectory = (() => {
            let found: FileEntry | undefined;
            const visit = (entry?: FileEntry) => {
              if (!entry || found) return;
              if (entry.path === refreshed.path) {
                found = entry;
                return;
              }
              entry.children.forEach(visit);
            };
            visit(previous);
            return found;
          })();
          nextTree = replaceTreeEntry(
            nextTree,
            refreshed.path,
            mergeFileTree(refreshed, priorDirectory),
          );
        }
        setTree((current) => {
          const merged = mergeFileTree(nextTree, current);
          treeRef.current = merged;
          return merged;
        });
      })
      .catch((cause) => {
        if (!silent && currentRoot.current === targetRoot)
          onError(`无法读取项目文件：${String(cause)}`);
      })
      .finally(() => {
        refreshInFlight.current.delete(targetRoot);
        if (!silent && currentRoot.current === targetRoot) setLoading(false);
      });
  };
  useEffect(() => {
    const previousRoot = tabsRoot.current;
    if (previousRoot) {
      workspaceEditorStates.current.set(previousRoot, {
        active: activePathRef.current,
        tabs,
      });
    }
    const restored = root
      ? workspaceEditorStates.current.get(root)
      : undefined;
    tabsRoot.current = root;
    activationRequest.current += 1;
    setTabs(restored?.tabs ?? []);
    setActive(restored?.active);
    activePathRef.current = restored?.active;
    setResults([]);
    setTree(undefined);
    treeRef.current = undefined;
    setSelectedEntry(undefined);
    refresh(false);
    const interval = window.setInterval(() => refresh(true), 5_000);
    return () => window.clearInterval(interval);
  }, [root]);
  useEffect(() => {
    const refreshFileFormats = () => {
      if (!root) {
        setFileFormatPlugins([]);
        return;
      }
      void desktop.fileFormatPlugins(root)
        .then((plugins) => {
          preloadEditorPluginDependencies(plugins);
          setFileFormatPlugins(
            [...plugins]
            .sort((left, right) => {
              const priority = { project: 0, user: 1, builtin: 2 } as const;
              return priority[left.scope] - priority[right.scope];
            })
            .map((plugin) => plugin as FileFormatPlugin),
          );
        })
        .catch((cause) => {
          setFileFormatPlugins([]);
          onError(`Editor 插件校验失败：${String(cause)}`);
        });
    };
    refreshFileFormats();
    window.addEventListener("agent-k-resources-changed", refreshFileFormats);
    return () => window.removeEventListener("agent-k-resources-changed", refreshFileFormats);
  }, [root]);
  useEffect(() => {
    const searchQuery = query.trim();
    if (!root || !searchQuery) {
      setResults([]);
      setFiltering(false);
      return;
    }
    setFiltering(true);
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void desktop
        .search(root, searchQuery)
        .then((matches) => {
          if (!cancelled) setResults(matches);
        })
        .catch((cause) => {
          if (!cancelled) onError(`搜索失败：${String(cause)}`);
        })
        .finally(() => {
          if (!cancelled) setFiltering(false);
        });
    }, 320);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [query, root]);
  const loadDirectory = async (path: string) => {
    if (!root) return;
    try {
      const loaded = await desktop.directory(root, path);
      const replace = (entry: FileEntry): FileEntry =>
        entry.path === path
          ? loaded
          : { ...entry, children: entry.children.map(replace) };
      setTree((current) => {
        const next = current ? replace(current) : current;
        treeRef.current = next;
        return next;
      });
    } catch (cause) {
      onError(`无法读取目录：${String(cause)}`);
    }
  };
  const activateTab = (path: string) => {
    const previousPath = activePathRef.current;
    const request = ++activationRequest.current;
    const finish = () => {
      if (request !== activationRequest.current) return;
      activePathRef.current = path;
      setActive(path);
    };
    const previousTab = tabs.find((tab) => tab.path === previousPath);
    if (
      previousPath !== path &&
      previousTab?.format?.editor === "plugin" &&
      previousTab.runtimeDirty &&
      pluginEditorRef.current
    ) {
      void pluginEditorRef.current.readContent()
        .then((content) => {
          setTabs((currentTabs) => currentTabs.map((tab) =>
            tab.path === previousPath ? { ...tab, content } : tab,
          ));
        })
        .catch(() => undefined)
        .finally(finish);
      return;
    }
    finish();
  };
  useEffect(() => {
    if (!active) {
      window.dispatchEvent(new CustomEvent("agent-k-file-format-capabilities", { detail: undefined }));
      return;
    }
    if (active.startsWith("web-preview:")) {
      window.dispatchEvent(new CustomEvent("agent-k-file-format-capabilities", {
        detail: {
          capabilities: [{
            id: "capture-preview",
            description: "Save the currently visible web-project preview as a PNG image.",
          }],
          name: "Web project preview",
          path: active.slice("web-preview:".length),
          skillEnabled: true,
        },
      }));
      return;
    }
    const plugin = root ? resolveFileFormat(
      fileMatchContext(active, absoluteWorkspacePath(root, active)),
      fileFormatPlugins,
      settings.disabledFileEditors,
    ) : undefined;
    if (!plugin) {
      window.dispatchEvent(new CustomEvent("agent-k-file-format-capabilities", { detail: undefined }));
      return;
    }
    const skillEnabled =
      plugin.skillEnabled !== false &&
      !settings.disabledFileEditorSkills.includes(plugin.id);
    window.dispatchEvent(new CustomEvent("agent-k-file-format-capabilities", {
      detail: {
        capabilities: skillEnabled ? plugin.capabilities ?? [] : [],
        name: plugin.name,
        path: active,
        pluginId: plugin.id,
        skillEnabled,
      },
    }));
  }, [active, fileFormatPlugins, root, settings.disabledFileEditors, settings.disabledFileEditorSkills]);
  const open = async (path: string) => {
    if (!root || tabs.some((tab) => tab.path === path)) {
      activateTab(path);
      return;
    }
    const match = fileMatchContext(path, absoluteWorkspacePath(root, path));
    // An agent can request an open action before the asynchronous plugin
    // discovery effect has completed. Do not turn that temporary empty list
    // into a permanent unsupported tab.
    let plugins = fileFormatPlugins;
    if (!plugins.length) {
      try {
        plugins = (await desktop.fileFormatPlugins(root)) as FileFormatPlugin[];
        preloadEditorPluginDependencies(plugins);
        setFileFormatPlugins(plugins);
      } catch (cause) {
        onError(`Editor 插件校验失败：${String(cause)}`);
        return;
      }
    }
    const format = resolveFileFormat(match, plugins, settings.disabledFileEditors);
    if (!format) {
      setTabs((current) => [...current, { path, content: "", saved: "", unsupported: true }]);
      activateTab(path);
      return;
    }
    const previewKind = format.mediaKind;
    if (format.editor === "plugin" && previewKind) {
      try {
        const data = await desktop.readBinary(root, path);
        setTabs((current) => [
          ...current,
          {
            binary: data,
            content: "",
            path,
            previewBytes: data.byteLength,
            previewCodec:
              previewKind === "video" ? detectVideoCodec(data) : undefined,
            mimeType: match.mimeType,
            saved: "",
            format,
          },
        ]);
        activateTab(path);
      } catch (cause) {
        onError(`无法预览文件：${String(cause)}`);
      }
      return;
    }
    if (!(format.editable === true || path.toLowerCase().endsWith(".lock"))) {
      setTabs((current) => [
        ...current,
        { path, content: "", saved: "", unsupported: true, format, mimeType: match.mimeType },
      ]);
      activateTab(path);
      return;
    }
    try {
      const content = await desktop.read(root, path);
      setTabs((current) => [
        ...current,
        { path, content, saved: content, format, mimeType: match.mimeType },
      ]);
      activateTab(path);
    } catch (cause) {
      onError(`无法打开文件：${String(cause)}`);
    }
  };
  useEffect(() => {
    const openReferencedLine = (event: Event) => {
      const detail = (event as CustomEvent<{ line?: number; path?: string }>).detail;
      if (!detail?.path || !detail.line) return;
      const target = {
        line: Math.max(1, Math.floor(detail.line)),
        path: detail.path.replaceAll("\\", "/"),
        requestId: Date.now() + Math.random(),
      };
      setLineNavigation(target);
      void open(target.path);
    };
    window.addEventListener("agent-k-open-file-line", openReferencedLine);
    return () =>
      window.removeEventListener("agent-k-open-file-line", openReferencedLine);
  }, [root, tabs]);
  useEffect(() => {
    const runWebProject = (event: Event) => {
      const detail = (event as CustomEvent<{ action?: string; path?: string }>).detail;
      if (detail?.action !== "run-web-project" || !root || typeof detail.path !== "string") return;
      const projectPath = relativeWorkspacePath(root, detail.path);
      if (projectPath === undefined) return;
      void desktop.startWebProject(root, projectPath).then(({ url }) => {
        const path = `web-preview:${projectPath}`;
        setTabs((currentTabs) => currentTabs.some((tab) => tab.path === path)
          ? currentTabs.map((tab) => tab.path === path ? { ...tab, webPreviewUrl: url } : tab)
          : [...currentTabs, { content: "", path, saved: "", webPreviewUrl: url }]);
        activateTab(path);
      }).catch((cause) => onError(`无法启动 Web 项目：${String(cause)}`));
    };
    window.addEventListener("agent-k-file-format-action", runWebProject);
    return () => window.removeEventListener("agent-k-file-format-action", runWebProject);
  }, [root, tabs]);
  useEffect(() => {
    const openFromAgent = (event: Event) => {
      const detail = (event as CustomEvent<{
        action?: string;
        path?: string;
        preview?: boolean;
      }>).detail;
      if (detail?.action !== "open" || !root || typeof detail.path !== "string") return;
      const path = relativeWorkspacePath(root, detail.path);
      if (!path) return;
      void open(path).then(() => {
        if (detail.preview !== true) return;
        setTabs((currentTabs) => currentTabs.map((tab) =>
          tab.path === path ? { ...tab, previewMode: true } : tab,
        ));
      });
    };
    window.addEventListener("agent-k-file-format-action", openFromAgent);
    return () => window.removeEventListener("agent-k-file-format-action", openFromAgent);
  }, [root, tabs]);
  useEffect(() => {
    if (
      !lineNavigation ||
      lineNavigation.path !== active?.replaceAll("\\", "/")
    ) return;
    const frame = requestAnimationFrame(() => {
      setTabs((currentTabs) => currentTabs.map((tab) =>
        tab.path.replaceAll("\\", "/") === lineNavigation.path
          ? { ...tab, previewMode: false }
          : tab,
      ));
      pluginEditorRef.current?.navigate(lineNavigation.line, 1);
    });
    return () => cancelAnimationFrame(frame);
  }, [active, lineNavigation, tabs]);
  const closeTab = (tab: Tab) => {
    const closingIndex = tabs.findIndex((item) => item.path === tab.path);
    const remainingTabs = tabs.filter((item) => item.path !== tab.path);
    setTabs(remainingTabs);
    if (active === tab.path) {
      const nextActive = remainingTabs[
        Math.min(closingIndex, remainingTabs.length - 1)
      ]?.path;
      activationRequest.current += 1;
      activePathRef.current = nextActive;
      setActive(nextActive);
    }
  };
  const current = tabsRoot.current === root
    ? tabs.find((tab) => tab.path === active)
    : undefined;
  const captureRenderedPreview = (requestedOutputPath?: string) => {
    const target = current?.webPreviewUrl
      ? inspectorRef.current?.querySelector<HTMLElement>(".web-project-preview")
      : current?.previewMode && current.format?.id === "agent-k.html"
        ? inspectorRef.current?.querySelector<HTMLElement>(".cached-plugin-editor.is-active .plugin-editor-frame")
        : undefined;
    if (!target) {
      onError(en ? "Open an HTML or web-project preview before capturing it." : "请先打开 HTML 或网站预览，再进行抓图。");
      return Promise.resolve(undefined);
    }
    const bounds = target.getBoundingClientRect();
    if (!root) {
      onError(en ? "A project is required to save the preview screenshot." : "抓图需要先打开一个项目。");
      return Promise.resolve(undefined);
    }
    const baseName = (current?.path ?? "agent-k-preview")
      .replace(/^web-preview:/, "")
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]+$/, "") || "agent-k-preview";
    const fallbackOutputPath = `screenshot/${baseName}-preview-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    const relativeOutputPath = relativeWorkspacePath(root, requestedOutputPath ?? fallbackOutputPath);
    if (!relativeOutputPath || !relativeOutputPath.toLowerCase().endsWith(".png")) {
      onError(en ? "Preview screenshots must be saved as PNG files inside the current project." : "预览截图必须保存为当前项目内的 PNG 文件。");
      return Promise.resolve(undefined);
    }
    return desktopWindow.capturePreview({
      height: Math.round(bounds.height),
      width: Math.round(bounds.width),
      x: Math.round(bounds.left),
      y: Math.round(bounds.top),
    }, absoluteWorkspacePath(root, relativeOutputPath)).catch((cause) => {
      onError(`${en ? "Unable to capture preview" : "抓图失败"}：${String(cause)}`);
      return undefined;
    });
  };
  useEffect(() => {
    const captureFromAgent = (event: Event) => {
      const detail = (event as CustomEvent<{ action?: string; outputPath?: string }>).detail;
      if (detail?.action === "capture-preview") void captureRenderedPreview(detail.outputPath);
    };
    window.addEventListener("agent-k-file-format-action", captureFromAgent);
    return () => window.removeEventListener("agent-k-file-format-action", captureFromAgent);
  }, [current]);
  useEffect(() => {
    const getPreviewConsole = (event: Event) => {
      const request = event as CustomEvent<{
        limit?: number;
        respond?: (value: string) => void;
      }>;
      if (typeof request.detail?.respond !== "function") return;
      const respond = request.detail.respond;
      event.preventDefault();
      if (!current?.webPreviewUrl) {
        respond(en
          ? "No active Agent K web-project preview is available."
          : "当前没有打开 Agent K 网站预览。");
        return;
      }
      void desktopWindow.getPreviewConsole(current.webPreviewUrl, request.detail.limit).then((entries) => {
        respond(entries.length
          ? entries.map((entry) => {
              const location = entry.frameUrl
                ? `${entry.frameUrl}${entry.line === undefined ? "" : `:${entry.line + 1}${entry.column === undefined ? "" : `:${entry.column + 1}`}`}`
                : "";
              return `[${entry.level}] ${entry.text}${location ? `\n  at ${location}` : ""}`;
            }).join("\n")
          : (en ? "No console output has been captured for this preview yet." : "此预览目前没有捕获到控制台输出。"));
      }).catch((cause) => respond(`Unable to read preview console: ${String(cause)}`));
    };
    window.addEventListener("agent-k-preview-console-request", getPreviewConsole);
    return () => window.removeEventListener("agent-k-preview-console-request", getPreviewConsole);
  }, [current, en]);
  const activeEditorRuntimeKey =
    root && current?.format?.editor === "plugin"
      ? `${root}\0${current.format.id}\0${current.path}`
      : undefined;
  const displayedEditorRuntimeKeys = activeEditorRuntimeKey
    ? insertCachedEditorRuntime(
        editorRuntimeKeys,
        activeEditorRuntimeKey,
        editorRuntimeRecency.current,
      )
    : editorRuntimeKeys;
  useEffect(() => {
    if (!activeEditorRuntimeKey) return;
    const recency = editorRuntimeRecency.current;
    setEditorRuntimeKeys((keys) =>
      insertCachedEditorRuntime(keys, activeEditorRuntimeKey, recency),
    );
    editorRuntimeRecency.current = [
      ...recency.filter((key) => key !== activeEditorRuntimeKey),
      activeEditorRuntimeKey,
    ];
  }, [activeEditorRuntimeKey]);
  const update = (content: string) =>
    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        tab.path === active ? { ...tab, content } : tab,
      ),
    );
  const persistContent = async (tab: Tab, content: string): Promise<boolean> => {
    if (!root) return false;
    try {
      await desktop.write(root, tab.path, content);
      setTabs((currentTabs) =>
        currentTabs.map((candidate) =>
          candidate.path === tab.path
            ? { ...candidate, content, runtimeDirty: false, saved: content }
            : candidate,
        ),
      );
      if (tab.path === activePathRef.current)
        pluginEditorRef.current?.markSaved(content);
      return true;
    } catch (cause) {
      onError(`保存失败：${String(cause)}`);
      return false;
    }
  };
  const save = async (): Promise<boolean> => {
    if (!root || !current || current.unsupported)
      return false;
    try {
      const content = current.format?.editor === "plugin"
        ? await pluginEditorRef.current?.readContent() ?? current.content
        : current.content;
      return persistContent(current, content);
    } catch (cause) {
      onError(`无法读取编辑器内容：${String(cause)}`);
      return false;
    }
  };
  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s")
        return;
      if (!current || current.unsupported) return;
      event.preventDefault();
      void save();
    };
    window.addEventListener("keydown", saveShortcut);
    return () => window.removeEventListener("keydown", saveShortcut);
  }, [current, root]);
  const undo = () => {
    if (!current || current.unsupported) return;
    // The toolbar action means "discard the unsaved edit", rather than a
    // single Monaco history step. Keeping React and Monaco on the saved value
    // also clears the tab's dirty marker deterministically.
    update(current.saved);
    if (current.format?.editor === "plugin") {
      pluginEditorRef.current?.setContent(current.saved);
      setTabs((currentTabs) => currentTabs.map((tab) =>
        tab.path === current.path ? { ...tab, runtimeDirty: false } : tab,
      ));
    }
  };
  const showContextMenu = (entry: FileEntry, event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const bounds = inspectorRef.current?.getBoundingClientRect();
    const localX = bounds ? event.clientX - bounds.left : event.clientX;
    const localY = bounds ? event.clientY - bounds.top : event.clientY;
    const availableWidth = bounds?.width ?? window.innerWidth;
    const availableHeight = bounds?.height ?? window.innerHeight;
    setSelectedEntry(entry);
    setPluginMenuActions([]);
    setContextMenu({
      entry,
      x: Math.max(6, Math.min(localX, availableWidth - 224)),
      y: Math.max(6, Math.min(localY, availableHeight - 196)),
    });
    if (root) void createPluginMenuActions(root, entry, fileFormatPlugins)
      .then(setPluginMenuActions)
      .catch(() => setPluginMenuActions([]));
  };
  const openInFileManager = async (entry: FileEntry) => {
    try {
      if (!root) return;
      await desktop.openInFileManager(root, entry.path);
    } catch (cause) {
      onError(`无法在文件管理器中打开：${String(cause)}`);
    }
  };
  const openInTerminal = async (entry: FileEntry) => {
    if (!root) return;
    try {
      await desktop.openTerminal(root, entry.path);
    } catch (cause) {
      onError(`无法打开控制台：${String(cause)}`);
    }
  };
  const createFile = () => {
    if (!root) return;
    setNewFilePath("");
    setCreateAsDirectory(false);
    setNewFileDialogOpen(true);
  };
  const closeNewFileDialog = () => {
    if (creatingFile) return;
    setNewFileDialogOpen(false);
    setNewFilePath("");
    setCreateAsDirectory(false);
  };
  const confirmCreateFile = async () => {
    const name = newFilePath.trim();
    if (!root || !name || creatingFile) return;
    if (name === "." || name === ".." || /[\\/]/.test(name)) {
      onError("名称不能包含路径分隔符，也不能是 . 或 ..");
      return;
    }
    const normalizedSelection = selectedEntry?.path.replaceAll("\\", "/") ?? "";
    const selectedDirectory = selectedEntry?.isDir
      ? normalizedSelection
      : normalizedSelection.includes("/")
        ? normalizedSelection.slice(0, normalizedSelection.lastIndexOf("/"))
        : "";
    const path = selectedDirectory ? `${selectedDirectory}/${name}` : name;
    setCreatingFile(true);
    try {
      if (createAsDirectory) await desktop.mkdir(root, path);
      else await desktop.write(root, path, "");
      setNewFileDialogOpen(false);
      setNewFilePath("");
      setCreateAsDirectory(false);
      refresh(false);
      if (!createAsDirectory) await open(path);
    } catch (cause) {
      onError(
        `新建${createAsDirectory ? "文件夹" : "文件"}失败：${String(cause)}`,
      );
    } finally {
      setCreatingFile(false);
    }
  };
  const openRenameDialog = (entry = selectedEntry) => {
    if (!entry?.path) return;
    setSelectedEntry(entry);
    setRenameName(entry.name);
    setRenameDialogOpen(true);
  };
  const closeRenameDialog = () => {
    if (mutatingPath) return;
    setRenameDialogOpen(false);
    setRenameName("");
  };
  const confirmRename = async () => {
    const name = renameName.trim();
    if (!root || !selectedEntry?.path || !name || mutatingPath) return;
    const oldPath = selectedEntry.path;
    const newPath = replacePathName(oldPath, name);
    if (newPath === oldPath) {
      closeRenameDialog();
      return;
    }
    setMutatingPath(true);
    try {
      await desktop.move(root, oldPath, newPath);
      const remap = (path: string) =>
        pathIsWithin(path, oldPath)
          ? `${newPath}${path.slice(oldPath.length)}`
          : path;
      setTabs((currentTabs) =>
        currentTabs.map((tab) => ({ ...tab, path: remap(tab.path) })),
      );
      setActive((current) => (current ? remap(current) : current));
      setSelectedEntry({ ...selectedEntry, path: newPath, name });
      setRenameDialogOpen(false);
      setRenameName("");
      refresh(false);
    } catch (cause) {
      onError(`重命名失败：${String(cause)}`);
    } finally {
      setMutatingPath(false);
    }
  };
  const confirmDelete = async () => {
    if (!root || !selectedEntry?.path || mutatingPath) return;
    const deletedPath = selectedEntry.path;
    setMutatingPath(true);
    try {
      await desktop.trash(root, deletedPath);
      setTabs((currentTabs) =>
        currentTabs.filter((tab) => !pathIsWithin(tab.path, deletedPath)),
      );
      setActive((current) =>
        current && pathIsWithin(current, deletedPath) ? undefined : current,
      );
      setSelectedEntry(undefined);
      setDeleteDialogOpen(false);
      refresh(false);
    } catch (cause) {
      onError(`删除失败：${String(cause)}`);
    } finally {
      setMutatingPath(false);
    }
  };
  const moveEntry = async (sourcePath: string, targetDirectory: string) => {
    if (!root || mutatingPath) return;
    const normalizedSource = sourcePath.replaceAll("\\", "/");
    const normalizedTarget = targetDirectory.replaceAll("\\", "/");
    if (
      normalizedTarget === normalizedSource ||
      normalizedTarget.startsWith(`${normalizedSource}/`)
    ) {
      onError("不能将文件夹移动到其自身内部");
      return;
    }
    const name = normalizedSource.split("/").pop();
    if (!name) return;
    const destination = normalizedTarget ? `${normalizedTarget}/${name}` : name;
    if (destination === normalizedSource) return;
    setMutatingPath(true);
    try {
      await desktop.move(root, sourcePath, destination);
      const remap = (path: string) =>
        pathIsWithin(path, sourcePath)
          ? `${destination}${path.slice(sourcePath.length)}`
          : path;
      setTabs((currentTabs) =>
        currentTabs.map((tab) => ({ ...tab, path: remap(tab.path) })),
      );
      setActive((current) => (current ? remap(current) : current));
      setSelectedEntry((current) =>
        current && pathIsWithin(current.path, sourcePath)
          ? {
              ...current,
              name: current.path === sourcePath ? name : current.name,
              path: remap(current.path),
            }
          : current,
      );
      refresh(false);
    } catch (cause) {
      onError(`移动失败：${String(cause)}`);
    } finally {
      setMutatingPath(false);
    }
  };
  const directoryAtPoint = (x: number, y: number) => {
    const element = document.elementFromPoint(x, y);
    const directory = element?.closest<HTMLElement>("[data-directory-path]");
    if (directory) return directory.dataset.directoryPath ?? "";
    return element?.closest(".file-tree-scroll") ? "" : null;
  };
  const startPointerDrag = (
    downEvent: ReactPointerEvent,
    sourceEntry: FileEntry,
  ) => {
    if (downEvent.button !== 0 || !sourceEntry.path || mutatingPath) return;
    pointerDragCleanup.current();
    const pointerId = downEvent.pointerId;
    const startX = downEvent.clientX;
    const startY = downEvent.clientY;
    let dragging = false;
    let targetDirectory: string | null = null;
    let canDropTarget = false;
    const sourceElement = downEvent.currentTarget as HTMLElement;
    sourceElement.setPointerCapture?.(pointerId);
    const cleanup = () => {
      window.removeEventListener("pointermove", handleMove, true);
      window.removeEventListener("pointerup", handleEnd, true);
      window.removeEventListener("pointercancel", handleEnd, true);
      sourceElement.releasePointerCapture?.(pointerId);
      document.body.classList.remove("is-tree-dragging");
      document.body.classList.remove("tree-drag-can-drop");
      setPointerDrag(undefined);
      setDropTarget(null);
      pointerDragCleanup.current = () => undefined;
    };
    const handleMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      if (!dragging && Math.hypot(event.clientX - startX, event.clientY - startY) < 5)
        return;
      dragging = true;
      event.preventDefault();
      targetDirectory = directoryAtPoint(event.clientX, event.clientY);
      const normalizedSource = sourceEntry.path.replaceAll("\\", "/");
      const normalizedTarget = targetDirectory?.replaceAll("\\", "/");
      const sourceParent = normalizedSource.includes("/")
        ? normalizedSource.slice(0, normalizedSource.lastIndexOf("/"))
        : "";
      const canDrop =
        normalizedTarget !== undefined &&
        normalizedTarget !== normalizedSource &&
        !normalizedTarget.startsWith(`${normalizedSource}/`) &&
        normalizedTarget !== sourceParent;
      canDropTarget = canDrop;
      document.body.classList.add("is-tree-dragging");
      document.body.classList.toggle("tree-drag-can-drop", canDrop);
      setDropTarget(canDrop ? targetDirectory : null);
      setPointerDrag({
        canDrop,
        isDir: sourceEntry.isDir,
        label: sourceEntry.name,
        path: sourceEntry.path,
        x: event.clientX,
        y: event.clientY,
      });
    };
    const handleEnd = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      if (dragging) {
        event.preventDefault();
        event.stopPropagation();
        suppressTreeClickUntil.current = Date.now() + 300;
      }
      const destination = targetDirectory;
      cleanup();
      if (dragging && canDropTarget && destination !== null)
        void moveEntry(sourceEntry.path, destination);
    };
    pointerDragCleanup.current = cleanup;
    window.addEventListener("pointermove", handleMove, {
      capture: true,
      passive: false,
    });
    window.addEventListener("pointerup", handleEnd, true);
    window.addEventListener("pointercancel", handleEnd, true);
  };
  useEffect(() => {
    if (!root) return;
    const directoryAt = (position: { x: number; y: number }) => {
      const element = document.elementFromPoint(
        position.x,
        position.y,
      );
      const directory = element?.closest<HTMLElement>("[data-directory-path]");
      if (directory) return directory.dataset.directoryPath ?? "";
      return element?.closest(".file-explorer") ? "" : null;
    };
    const dragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      setDropTarget(directoryAt({ x: event.clientX, y: event.clientY }));
    };
    const dragLeave = (event: DragEvent) => {
      if (!event.relatedTarget) setDropTarget(null);
    };
    const drop = (event: DragEvent) => {
      const target = directoryAt({ x: event.clientX, y: event.clientY });
      if (target === null || !event.dataTransfer?.files.length) return;
      event.preventDefault();
      setDropTarget(null);
      const paths = Array.from(event.dataTransfer.files)
        .map(platform.pathForFile)
        .filter(Boolean);
      void desktop
        .importPaths(root, target, paths)
        .then(() => refresh(false))
        .catch((cause) => onError(`复制外部文件失败：${String(cause)}`));
    };
    window.addEventListener("dragover", dragOver);
    window.addEventListener("dragleave", dragLeave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", dragOver);
      window.removeEventListener("dragleave", dragLeave);
      window.removeEventListener("drop", drop);
    };
  }, [root]);
  const activePluginEditorProps: PluginEditorProps | undefined =
    current?.format?.editor === "plugin" && root
      ? {
          actions: ["agent-k.html", "agent-k.markdown"].includes(current.format.id)
            ? [{
                id: "set-preview",
                parameters: { enabled: current.previewMode === true },
              }]
            : [],
          absolutePath: absoluteWorkspacePath(root, current.path),
          binary: current.binary,
          byteSize: current.previewBytes,
          codec: current.previewCodec,
          content: current.content,
          language: current.format.languageId ?? languageFor(current.path),
          locale: settings.locale,
          mimeType: current.mimeType ?? fileMatchContext(
            current.path,
            absoluteWorkspacePath(root, current.path),
          ).mimeType,
          onContentChange(content) {
            setTabs((currentTabs) => currentTabs.map((tab) =>
              tab.path === current.path ? { ...tab, content } : tab,
            ));
          },
          onDirtyChange(dirty) {
            setTabs((currentTabs) => currentTabs.map((tab) =>
              tab.path === current.path ? { ...tab, runtimeDirty: dirty } : tab,
            ));
          },
          onError,
          onReferenceLine(line) {
            window.dispatchEvent(new CustomEvent("agent-k-add-line-reference", {
              detail: { line, path: current.path },
            }));
          },
          onSaveRequest(content) {
            void persistContent(current, content);
          },
          path: current.path,
          plugin: current.format,
          readOnly: current.format.editable !== true,
          root,
          theme: resolvedTheme,
          wordWrap: settings.editorWordWrap,
        }
      : undefined;
  return (
    <aside className="inspector-panel" ref={inspectorRef}>
      {review ? (
        <div className="inspector-review-overlay">
          <ReviewPanel
            calls={review}
            onClose={onCloseReview}
            onError={onError}
            root={root}
          />
        </div>
      ) : null}
      <div
        className="editor-body"
        style={
          { "--explorer-width": `${explorerWidth}px` } as Record<string, string>
        }
      >
        <aside className="file-explorer">
          <form
            className="inspector-search"
            onSubmit={(event) => {
              event.preventDefault();
            }}
            role="search"
          >
            <input
              aria-label={en ? "Search project" : "搜索项目"}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={en ? "Search project" : "搜索项目"}
              value={query}
            />
            <span aria-hidden="true" className="inspector-search-icon">
              <i aria-hidden="true" className="fa-solid fa-magnifying-glass" />
            </span>
          </form>
          <div
            className="file-tree-scroll"
            onContextMenu={(event) => {
              if (tree && event.target === event.currentTarget)
                showContextMenu(tree, event);
            }}
          >
            {!query.trim() && tree ? (
              <Tree
                entry={tree}
                loadDirectory={(path) => void loadDirectory(path)}
                open={(path) => void open(path)}
                dropTarget={dropTarget}
                selectedPath={selectedEntry?.path}
                select={setSelectedEntry}
                shouldSuppressClick={() =>
                  Date.now() < suppressTreeClickUntil.current
                }
                showContextMenu={showContextMenu}
                startPointerDrag={startPointerDrag}
              />
            ) : !query.trim() && loading ? (
              (en ? "Reading project…" : "正在读取项目…")
            ) : !query.trim() ? (
              (en ? "Select a session" : "选择 session")
            ) : filtering ? (
              <p className="file-filter-empty">正在筛选…</p>
            ) : results.length ? (
              results.map((path) => (
                <button
                  className="file-node search-result"
                  key={path}
                  onClick={() => {
                    const entry = {
                      children: [],
                      isDir: false,
                      loaded: true,
                      name: path.split(/[\\/]/).pop() ?? path,
                      path,
                    };
                    setSelectedEntry(entry);
                    void open(path);
                  }}
                  onContextMenu={(event) =>
                    showContextMenu(
                      {
                        children: [],
                        isDir: false,
                        loaded: true,
                        name: path.split(/[\\/]/).pop() ?? path,
                        path,
                      },
                      event,
                    )
                  }
                  type="button"
                >
                  <FileIcon path={path} />
                  <span>{path}</span>
                </button>
              ))
            ) : (
              <p className="file-filter-empty">没有匹配的文件</p>
            )}
          </div>
          {pointerDrag
            ? createPortal(
                <div
                  className={`tree-drag-ghost${pointerDrag.canDrop ? " can-drop" : ""}`}
                  style={{ left: pointerDrag.x + 11, top: pointerDrag.y + 13 }}
                  title={pointerDrag.label}
                >
                  {pointerDrag.isDir ? (
                    <i
                      aria-hidden="true"
                      className="fa-regular fa-folder tree-drag-folder-icon"
                    />
                  ) : (
                    <FileIcon path={pointerDrag.path} />
                  )}
                </div>,
                document.body,
              )
            : null}
        </aside>
        <div
          aria-label={en ? "Resize file tree" : "调整文件树宽度"}
          className="editor-resizer"
          onMouseDown={(event) => {
            event.preventDefault();
            resizingExplorer.current = true;
            document.body.classList.add("is-resizing");
            window.dispatchEvent(new CustomEvent("agent-k-editor-layout-suspended", { detail: true }));
          }}
          role="separator"
        />
        <section className="editor-area">
          <div className="tab-strip">
            {tabs.map((tab) => (
              <button
                className={tab.path === active ? "file-tab active" : "file-tab"}
                key={tab.path}
                onClick={() => activateTab(tab.path)}
                type="button"
              >
                {tab.path.split(/[\\/]/).pop()}
                {tab.content !== tab.saved || tab.runtimeDirty ? " •" : ""}
                <span
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab);
                  }}
                >
                  ×
                </span>
              </button>
            ))}
          </div>
          {current && !current.unsupported && current.format?.editable ? (
            <div className="editor-floating-actions">
              <>
                  {["agent-k.html", "agent-k.markdown"].includes(current.format.id) ? (
                    <button
                      aria-pressed={current.previewMode === true}
                      className={current.previewMode ? "is-active" : undefined}
                      onClick={() => {
                        const enabled = current.previewMode !== true;
                        setTabs((currentTabs) => currentTabs.map((tab) =>
                          tab.path === current.path
                            ? { ...tab, previewMode: enabled }
                            : tab,
                        ));
                      }}
                      title={current.previewMode
                        ? en ? "Return to editor" : "返回编辑器"
                        : en ? "Preview" : "预览"}
                      type="button"
                    >
                      <i
                        aria-hidden="true"
                        className={current.previewMode
                          ? "fa-regular fa-pen-to-square"
                          : "fa-regular fa-eye"}
                      />
                      {current.previewMode
                        ? en ? "Edit" : "编辑"
                        : en ? "Preview" : "预览"}
                    </button>
                  ) : null}
                  {current.previewMode && current.format.id === "agent-k.html" && root ? (
                    <button
                      className="external-browser-action"
                      onClick={() => void desktop.startPreview(root, current.path, current.content)
                        .then((url) => desktop.openExternalUrl(url, settings.browserId))
                        .catch((cause) => onError(`无法在外部浏览器中打开：${String(cause)}`))}
                      title={en ? "Open in external browser" : "在外部浏览器中打开"}
                      type="button"
                    >
                      <i aria-hidden="true" className="fa-solid fa-arrow-up-right-from-square" />
                      {en ? "Browser" : "外部浏览器"}
                    </button>
                  ) : null}
                  {current.previewMode && current.format.id === "agent-k.html" ? (
                    <button
                      onClick={() => void captureRenderedPreview()}
                      title={en ? "Capture preview as PNG" : "抓取预览图像 (PNG)"}
                      type="button"
                    >
                      <i aria-hidden="true" className="fa-solid fa-camera" />
                      {en ? "Capture" : "抓图"}
                    </button>
                  ) : null}
                  {current.previewMode && current.format.id === "agent-k.html" ? (
                    <button
                      onClick={() => {
                        setTabs((currentTabs) => currentTabs.map((tab) =>
                          tab.path === current.path ? { ...tab, previewMode: false } : tab,
                        ));
                        window.requestAnimationFrame(() => {
                          setTabs((currentTabs) => currentTabs.map((tab) =>
                            tab.path === current.path ? { ...tab, previewMode: true } : tab,
                          ));
                        });
                      }}
                      title={en ? "Refresh preview" : "刷新预览"}
                      type="button"
                    >
                      <i aria-hidden="true" className="fa-solid fa-rotate-right" />
                      {en ? "Refresh" : "刷新"}
                    </button>
                  ) : null}
                  {!current.previewMode ? (
                    <button
                      aria-label={t("revertFile")}
                      disabled={current.content === current.saved && !current.runtimeDirty}
                      onClick={undo}
                      title={
                        en
                          ? "Revert to the last saved version"
                          : "恢复到最近保存的版本"
                      }
                      type="button"
                    >
                      <i aria-hidden="true" className="fa-solid fa-rotate-left" />
                      {t("revertFile")}
                    </button>
                  ) : null}
                  <button
                    aria-pressed={settings.editorWordWrap}
                    className={settings.editorWordWrap ? "is-active" : undefined}
                    onClick={() =>
                      void updateSettings({
                        editorWordWrap: !settings.editorWordWrap,
                      }).catch((cause) => onError(`无法保存自动换行设置：${String(cause)}`))
                    }
                    title={
                      en
                        ? "Toggle word wrap"
                        : "切换自动换行"
                    }
                    type="button"
                  >
                    <i aria-hidden="true" className="fa-solid fa-text-width" />
                    {en ? "Wrap" : "自动换行"}
                  </button>
                  {!current.previewMode ? (
                    <button
                      className="primary"
                      disabled={current.content === current.saved && !current.runtimeDirty}
                      onClick={() => void save()}
                      title={en ? "Save (Ctrl+S)" : "保存 (Ctrl+S)"}
                      type="button"
                    >
                      <i aria-hidden="true" className="fa-regular fa-floppy-disk" />
                      {t("save")}
                    </button>
                  ) : null}
              </>
            </div>
          ) : null}
          {current?.webPreviewUrl ? (
            <>
              <div className="web-project-preview-actions">
                <span>{en ? "Web Preview" : "网站预览"}</span>
                <div className="web-project-preview-left-actions">
                  <button
                    onClick={() => void desktop.openExternalUrl(current.webPreviewUrl!, settings.browserId)
                      .catch((cause) => onError(`无法在外部浏览器中打开：${String(cause)}`))}
                    title={en ? "Open in external browser" : "在外部浏览器中打开"}
                    type="button"
                  >
                    <i aria-hidden="true" className="fa-solid fa-arrow-up-right-from-square" />
                    {en ? "Browser" : "外部浏览器"}
                  </button>
                  <button
                    onClick={() => setTabs((currentTabs) => currentTabs.map((tab) =>
                      tab.path === current.path
                        ? { ...tab, webPreviewReloadToken: Date.now() }
                        : tab,
                    ))}
                    title={en ? "Refresh preview" : "刷新预览"}
                    type="button"
                  >
                    <i aria-hidden="true" className="fa-solid fa-rotate-right" />
                    {en ? "Refresh" : "刷新"}
                  </button>
                  <button
                    onClick={() => void captureRenderedPreview()}
                    title={en ? "Capture preview as PNG" : "抓取预览图像 (PNG)"}
                    type="button"
                  >
                    <i aria-hidden="true" className="fa-solid fa-camera" />
                    {en ? "Capture" : "抓图"}
                  </button>
                </div>
              </div>
              <iframe
                allow="autoplay; fullscreen"
                className="web-project-preview"
                key={current.webPreviewReloadToken ?? 0}
                src={current.webPreviewUrl}
                title={en ? "Web project preview" : "Web 项目预览"}
              />
            </>
          ) : current?.unsupported ? (
            <div className="unsupported-editor">
              <i aria-hidden="true" className="fa-regular fa-file" />
              <strong>暂不支持此文件类型</strong>
              <p>
                {current.path.split(/[\\/]/).pop()} 无法在文本编辑器中预览或编辑
              </p>
            </div>
          ) : !activePluginEditorProps ? (
            <p className="empty-editor">从左侧打开一个文件</p>
          ) : null}
          {displayedEditorRuntimeKeys.map((cacheKey) => (
            <CachedPluginEditor
              active={cacheKey === activeEditorRuntimeKey}
              activeEditorRef={pluginEditorRef}
              frameProps={cacheKey === activeEditorRuntimeKey
                ? activePluginEditorProps
                : undefined}
              key={cacheKey}
            />
          ))}
        </section>
      </div>
      <ProjectConsole onError={onError} root={root} />
      {contextMenu && (
        <div
          className="file-context-menu"
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => event.stopPropagation()}
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => {
              setSelectedEntry(contextMenu.entry);
              setContextMenu(undefined);
              createFile();
            }}
            role="menuitem"
            type="button"
          >
            <i className="fa-regular fa-file" />
            新建
          </button>
          <button
            disabled={!contextMenu.entry.path || mutatingPath}
            onClick={() => {
              const entry = contextMenu.entry;
              setContextMenu(undefined);
              openRenameDialog(entry);
            }}
            role="menuitem"
            type="button"
          >
            <i className="fa-regular fa-pen-to-square" />
            重命名
          </button>
          <button
            disabled={!contextMenu.entry.path || mutatingPath}
            onClick={() => {
              setSelectedEntry(contextMenu.entry);
              setContextMenu(undefined);
              setDeleteDialogOpen(true);
            }}
            role="menuitem"
            type="button"
          >
            <i className="fa-regular fa-trash-can" />
            删除
          </button>
          <button
            disabled={contextMenu.entry.isDir || !contextMenu.entry.path || !root}
            onClick={() => {
              if (!root) return;
              const path = absoluteWorkspacePath(root, contextMenu.entry.path);
              setContextMenu(undefined);
              window.dispatchEvent(
                new CustomEvent("agent-k-add-attachment", {
                  detail: { path },
                }),
              );
            }}
            role="menuitem"
            type="button"
          >
            <i className="fa-solid fa-paperclip" />
            {en ? "Add to conversation" : "添加到对话"}
          </button>
          <div className="file-context-separator" />
          <button
            onClick={() => {
              const entry = contextMenu.entry;
              setContextMenu(undefined);
              void openInFileManager(entry);
            }}
            role="menuitem"
            type="button"
          >
            <i className="fa-regular fa-folder-open" />
            在文件管理器中打开
          </button>
          <button
            onClick={() => {
              const entry = contextMenu.entry;
              setContextMenu(undefined);
              void openInTerminal(entry);
            }}
            role="menuitem"
            type="button"
          >
            <i className="fa-solid fa-terminal" />
            在外部控制台中打开目录
          </button>
          {pluginMenuActions.map((action) => (
            <button
              key={`${action.pluginId}:${action.id}`}
              onClick={() => {
                window.dispatchEvent(new CustomEvent("agent-k-file-format-action", {
                  detail: { action: action.id, path: contextMenu.entry.path, pluginId: action.pluginId },
                }));
                setContextMenu(undefined);
              }}
              role="menuitem"
              type="button"
            >
              <i className={`fa-solid ${action.id === "compile-cmake-project" ? "fa-hammer" : "fa-puzzle-piece"}`} />
              {action.label}
            </button>
          ))}
        </div>
      )}
      {newFileDialogOpen ? (
        <div
          className="inspector-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeNewFileDialog();
          }}
        >
          <form
            aria-labelledby="new-file-dialog-title"
            aria-modal="true"
            className="inspector-dialog"
            onKeyDown={(event) => {
              if (event.key === "Escape") closeNewFileDialog();
            }}
            onSubmit={(event) => {
              event.preventDefault();
              void confirmCreateFile();
            }}
            role="dialog"
          >
            <header>
              <span aria-hidden="true" className="inspector-dialog-icon">
                +
              </span>
              <div>
                <h2 id="new-file-dialog-title">
                  新建{createAsDirectory ? "文件夹" : "文件"}
                </h2>
                <p>
                  在当前工作区创建一个
                  {createAsDirectory ? "文件夹" : "空文件"}
                </p>
              </div>
            </header>
            <label htmlFor="new-file-path">
              {createAsDirectory ? "文件夹名称" : "文件名称"}
            </label>
            <input
              autoFocus
              id="new-file-path"
              onChange={(event) => setNewFilePath(event.target.value)}
              placeholder={
                createAsDirectory ? "例如 components" : "例如 NewFile.tsx"
              }
              spellCheck={false}
              value={newFilePath}
            />
            <small>
              创建位置：
              {selectedEntry?.isDir && selectedEntry.path
                ? selectedEntry.path
                : "项目根目录"}
            </small>
            <label className="inspector-dialog-check">
              <input
                checked={createAsDirectory}
                disabled={creatingFile}
                onChange={(event) => setCreateAsDirectory(event.target.checked)}
                type="checkbox"
              />
              <span>新建文件夹</span>
            </label>
            <footer>
              <button
                disabled={creatingFile}
                onClick={closeNewFileDialog}
                type="button"
              >
                取消
              </button>
              <button
                className="primary"
                disabled={
                  !newFilePath.trim() ||
                  newFilePath.trim() === "." ||
                  newFilePath.trim() === ".." ||
                  /[\\/]/.test(newFilePath) ||
                  creatingFile
                }
                type="submit"
              >
                {creatingFile ? "正在创建…" : "创建"}
              </button>
            </footer>
          </form>
        </div>
      ) : null}
      {renameDialogOpen && selectedEntry ? (
        <div
          className="inspector-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeRenameDialog();
          }}
        >
          <form
            aria-labelledby="rename-dialog-title"
            aria-modal="true"
            className="inspector-dialog"
            onKeyDown={(event) => {
              if (event.key === "Escape") closeRenameDialog();
            }}
            onSubmit={(event) => {
              event.preventDefault();
              void confirmRename();
            }}
            role="dialog"
          >
            <header>
              <span aria-hidden="true" className="inspector-dialog-icon">
                <i className="fa-solid fa-pen" />
              </span>
              <div>
                <h2 id="rename-dialog-title">重命名</h2>
                <p>修改“{selectedEntry.name}”的名称</p>
              </div>
            </header>
            <label htmlFor="rename-path-name">新名称</label>
            <input
              autoFocus
              id="rename-path-name"
              onChange={(event) => setRenameName(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              spellCheck={false}
              value={renameName}
            />
            <footer>
              <button
                disabled={mutatingPath}
                onClick={closeRenameDialog}
                type="button"
              >
                取消
              </button>
              <button
                className="primary"
                disabled={!renameName.trim() || mutatingPath}
                type="submit"
              >
                {mutatingPath ? "正在重命名…" : "重命名"}
              </button>
            </footer>
          </form>
        </div>
      ) : null}
      {deleteDialogOpen && selectedEntry ? (
        <div
          className="inspector-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !mutatingPath)
              setDeleteDialogOpen(false);
          }}
        >
          <form
            aria-labelledby="delete-dialog-title"
            aria-modal="true"
            className="inspector-dialog"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !mutatingPath)
                setDeleteDialogOpen(false);
            }}
            onSubmit={(event) => {
              event.preventDefault();
              void confirmDelete();
            }}
            role="dialog"
          >
            <header>
              <span aria-hidden="true" className="inspector-dialog-icon">
                <i className="fa-regular fa-trash-can" />
              </span>
              <div>
                <h2 id="delete-dialog-title">
                  删除{selectedEntry.isDir ? "文件夹" : "文件"}
                </h2>
                <p>“{selectedEntry.name}”将被移入系统回收站</p>
              </div>
            </header>
            <footer>
              <button
                disabled={mutatingPath}
                onClick={() => setDeleteDialogOpen(false)}
                type="button"
              >
                取消
              </button>
              <button className="danger" disabled={mutatingPath} type="submit">
                {mutatingPath ? "正在删除…" : "移入回收站"}
              </button>
            </footer>
          </form>
        </div>
      ) : null}
    </aside>
  );
}
