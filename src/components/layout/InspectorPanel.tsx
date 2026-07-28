import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  memo,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { desktop, type FileEntry, type LanguageServerPlugin, type LanguageServerProject } from "../../lib/desktop";
import { desktopWindow, platform } from "../../lib/platform";
import { ProjectConsole } from "./ProjectConsole";
import { DirectoryPickerDialog } from "../DirectoryPickerDialog";
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
  externalChanged?: boolean;
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
const ADVANCED_SEARCH_RESULT_HEIGHT = 48;
const ADVANCED_SEARCH_RESULT_OVERSCAN = 5;
const AdvancedSearchResults = memo(function AdvancedSearchResults({ items, onOpen, searched, searching }: { items: Array<{ path: string; line: number; preview: string }>; onOpen(path: string): void; searched: boolean; searching: boolean }) {
  const [scrollTop, setScrollTop] = useState(0);
  useEffect(() => setScrollTop(0), [items]);
  const first = Math.max(0, Math.floor(scrollTop / ADVANCED_SEARCH_RESULT_HEIGHT) - ADVANCED_SEARCH_RESULT_OVERSCAN);
  const visible = Math.ceil(270 / ADVANCED_SEARCH_RESULT_HEIGHT) + ADVANCED_SEARCH_RESULT_OVERSCAN * 2;
  const last = Math.min(items.length, first + visible);
  return <div className="advanced-search-results" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>{searched && !searching && !items.length ? <p>没有找到匹配内容</p> : null}<div className="advanced-search-results-viewport" style={{ height: items.length * ADVANCED_SEARCH_RESULT_HEIGHT }}>{items.slice(first, last).map((item, offset) => { const index = first + offset; return <button className="advanced-search-result" key={`${item.path}:${item.line}`} onClick={() => onOpen(item.path)} style={{ transform: `translateY(${index * ADVANCED_SEARCH_RESULT_HEIGHT}px)` }} type="button"><strong>{item.path}:{item.line}</strong><span>{item.preview}</span></button>; })}</div></div>;
}, (previous, next) => previous.items === next.items && previous.searched === next.searched && previous.searching === next.searching);

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function createPluginMenuActions(
  root: string,
  entry: FileEntry,
  plugins: readonly FileFormatPlugin[],
): Promise<PluginMenuAction[]> {
  let packageJson: string | undefined;
  let directoryEntries: string[] = [];
  if (entry.isDir) {
    try {
      directoryEntries = (await desktop.directory(root, entry.path)).children
        .map((child) => child.name);
    } catch { /* optional context */ }
    if (directoryEntries.some((name) => name.toLowerCase() === "package.json")) {
      try { packageJson = await desktop.read(root, `${entry.path ? `${entry.path}/` : ""}package.json`); } catch { /* optional context */ }
    }
  }
  const directoryEntryNames = new Set(directoryEntries.map((name) => name.toLowerCase()));
  const viteConfig = entry.isDir && ["vite.config.js", "vite.config.ts", "vite.config.mjs", "vite.config.cjs"]
    .some((name) => directoryEntryNames.has(name));
  const context = { absolutePath: absoluteWorkspacePath(root, entry.path), directoryEntries, isDirectory: entry.isDir, packageJson, path: entry.path, viteConfig };
  const results = await Promise.all(plugins.filter((plugin) => plugin.runtime.menu && (!entry.isDir || !plugin.contextMarkers?.length || plugin.contextMarkers.some((marker) => directoryEntryNames.has(marker.toLowerCase())))).map(async (plugin) => {
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
  if (!previous || fresh.path !== previous.path || fresh.isDir !== previous.isDir)
    return fresh;
  if (!fresh.isDir)
    return fresh.name === previous.name && fresh.loaded === previous.loaded
      ? previous
      : fresh;
  if (!fresh.loaded && previous.loaded) return previous;
  if (!fresh.loaded || !previous.loaded)
    return fresh.name === previous.name &&
      fresh.loaded === previous.loaded &&
      fresh.children.length === previous.children.length
      ? previous
      : fresh;
  const previousChildren = new Map(
    previous.children.map((entry) => [entry.path, entry]),
  );
  const children = fresh.children.map((entry) =>
    mergeFileTree(entry, previousChildren.get(entry.path)),
  );
  if (
    fresh.name === previous.name &&
    fresh.loaded === previous.loaded &&
    children.length === previous.children.length &&
    children.every((entry, index) => entry === previous.children[index])
  ) return previous;
  return { ...fresh, children };
}
function replaceTreeEntry(
  tree: FileEntry,
  path: string,
  replacement: FileEntry,
): FileEntry {
  if (tree.path === path) return replacement;
  if (!tree.isDir) return tree;
  const children = tree.children.map((entry) =>
    replaceTreeEntry(entry, path, replacement),
  );
  return children.every((entry, index) => entry === tree.children[index])
    ? tree
    : { ...tree, children };
}
function findTreeEntry(tree: FileEntry | undefined, path: string): FileEntry | undefined {
  if (!tree) return undefined;
  if (tree.path === path) return tree;
  if (!tree.isDir) return undefined;
  for (const child of tree.children) {
    const found = findTreeEntry(child, path);
    if (found) return found;
  }
  return undefined;
}
function parentDirectoryPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "" : normalized.slice(0, separator);
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

function isCMakeSolutionDirectory(entry: FileEntry): boolean {
  return entry.isDir && entry.children.some(
    (child) => !child.isDir && ["cmakelists.txt", "cmakelist.txt"].includes(child.name.toLowerCase()),
  );
}

function isWebProjectDirectory(entry: FileEntry): boolean {
  if (!entry.isDir) return false;
  const names = new Set(entry.children.filter((child) => !child.isDir).map((child) => child.name.toLowerCase()));
  return ["vite.config.js", "vite.config.ts", "vite.config.mjs", "vite.config.cjs"].some((name) => names.has(name))
    || names.has("package.json") && names.has("index.html");
}

const Tree = memo(function Tree({
  entry,
  languageProjectsByPath,
  loadDirectory,
  open,
  dropTarget,
  select,
  shouldSuppressClick,
  showContextMenu,
  startPointerDrag,
}: {
  entry: FileEntry;
  languageProjectsByPath: ReadonlyMap<string, Pick<LanguageServerProject, "indexProgress" | "status">>;
  loadDirectory(path: string): void;
  open(path: string): void;
  dropTarget: string | null;
  select(entry: FileEntry, element: HTMLElement): void;
  shouldSuppressClick(): boolean;
  showContextMenu(entry: FileEntry, event: ReactMouseEvent): void;
  startPointerDrag(event: ReactPointerEvent, entry: FileEntry): void;
}) {
  const [expanded, setExpanded] = useState(entry.path === "");
  const cmakeSolution = isCMakeSolutionDirectory(entry);
  const webProject = !cmakeSolution && isWebProjectDirectory(entry);
  const languageProject = languageProjectsByPath.get(entry.path.replaceAll("\\", "/").toLocaleLowerCase("en-US"));
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
        data-tree-path={entry.path}
        onClick={(event) => {
          event.preventDefault();
          if (shouldSuppressClick()) return;
          select(entry, event.currentTarget);
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
          <span
            aria-hidden="true"
            className={`tree-folder-icons${cmakeSolution ? " cmake-solution-icon" : webProject ? " web-project-icon" : ""}`}
            title={cmakeSolution ? "CMake C++ project" : webProject ? "Web project" : undefined}
          >
            {cmakeSolution ? (
              <span className="cmake-cpp-badge">C++</span>
            ) : webProject ? (
              <i className="fa-solid fa-globe" />
            ) : <>
              <i className="fa-regular fa-folder folder-closed" />
              <i className="fa-regular fa-folder-open folder-open" />
            </>}
          </span>
        </span>
        <span className="tree-entry-label"><span>{entry.name}</span>{languageProject ? <span className={`tree-language-project-status is-${languageProject.status}`}>({languageProject.status}{languageProject.status === "indexing" && languageProject.indexProgress ? ` ${languageProject.indexProgress}` : ""})</span> : null}</span>
      </summary>
      {entry.children.map((child) => (
        <Tree
          entry={child}
          key={child.path}
          languageProjectsByPath={languageProjectsByPath}
          loadDirectory={loadDirectory}
          open={open}
          dropTarget={dropTarget}
          select={select}
          shouldSuppressClick={shouldSuppressClick}
          showContextMenu={showContextMenu}
          startPointerDrag={startPointerDrag}
        />
      ))}
    </details>
  ) : (
    <button
      className="file-node"
      data-tree-path={entry.path}
      onClick={(event) => {
        if (shouldSuppressClick()) return;
        select(entry, event.currentTarget);
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
});
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
  const { activeTheme, settings, resolvedTheme, t, update: updateSettings } = useSettings();
  const en = settings.locale === "en-US";
  const [tree, setTree] = useState<FileEntry>();
  const [fileFormatPlugins, setFileFormatPlugins] = useState<FileFormatPlugin[]>([]);
  const [loading, setLoading] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [editorRuntimeKeys, setEditorRuntimeKeys] = useState<string[]>([]);
  const [editorRuntimeRevision, setEditorRuntimeRevision] = useState(0);
  const editorRuntimeRecency = useRef<string[]>([]);
  const [active, setActive] = useState<string>();
  const [lineNavigation, setLineNavigation] = useState<{
    column: number;
    line: number;
    path: string;
    requestId: number;
  }>();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [advancedSearchOpen, setAdvancedSearchOpen] = useState(false);
  const [advancedDirectory, setAdvancedDirectory] = useState("**");
  const [advancedFilePattern, setAdvancedFilePattern] = useState("*.c;*.cc;*.cpp;*.cxx;*.h;*.hpp;*.js;*.jsx;*.ts;*.tsx;*.json;*.md;*.txt;*.py;*.java;*.cs;*.go;*.rs;*.html;*.css;*.xml;*.yaml;*.yml;*.toml;*.cmake");
  const [advancedResults, setAdvancedResults] = useState<Array<{ path: string; line: number; preview: string }>>([]);
  const [advancedSearching, setAdvancedSearching] = useState(false);
  const [advancedSearched, setAdvancedSearched] = useState(false);
  const [advancedSearchSeed, setAdvancedSearchSeed] = useState("");
  const [advancedSearchHistory, setAdvancedSearchHistory] = useState<string[]>([]);
  const [advancedHistoryOpen, setAdvancedHistoryOpen] = useState(false);
  const [advancedWholeWord, setAdvancedWholeWord] = useState(false);
  const [advancedCaseSensitive, setAdvancedCaseSensitive] = useState(false);
  const [advancedProgress, setAdvancedProgress] = useState("");
  const [advancedDirectoryPickerOpen, setAdvancedDirectoryPickerOpen] = useState(false);
  const advancedDialogRef = useRef<HTMLFormElement>(null);
  const advancedDialogOffset = useRef({ x: 0, y: 0 });
  const advancedDialogDrag = useRef<{ x: number; y: number } | undefined>(undefined);
  const advancedQueryRef = useRef<HTMLInputElement>(null);
  const latestEditorSelection = useRef("");
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
  const [cppProgress, setCppProgress] = useState<{ languageServerId?: string; detail?: string; error?: string; log?: string; rate?: number; stage: string; bytes?: number; total?: number }>();
  const [cppDiagnostics, setCppDiagnostics] = useState<Record<string, Array<Record<string, unknown>>>>({});
  const [languageProjects, setLanguageProjects] = useState<LanguageServerProject[]>([]);
  const languageProjectsByTreePath = useMemo(() => {
    const projects = new Map<string, Pick<LanguageServerProject, "indexProgress" | "status">>();
    if (!root) return projects;
    const rootKey = root.replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase("en-US");
    for (const project of languageProjects) {
      const projectKey = project.root.replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase("en-US");
      const path = projectKey === rootKey ? "" : relativeWorkspacePath(root, project.root);
      if (path !== undefined) projects.set(path.replaceAll("\\", "/").toLocaleLowerCase("en-US"), project);
    }
    return projects;
  }, [languageProjects, root]);
  const [languagePlugins, setLanguagePlugins] = useState<LanguageServerPlugin[]>([]);
  const [cppProjectsDialogOpen, setCppProjectsDialogOpen] = useState(false);
  const [cppTraceDialogText, setCppTraceDialogText] = useState<string>();
  const [cppTraceCopied, setCppTraceCopied] = useState(false);
  const inspectorRef = useRef<HTMLElement>(null);
  const fileTreeRef = useRef<HTMLDivElement>(null);
  const editorBodyRef = useRef<HTMLDivElement>(null);
  const pluginEditorRef = useRef<PluginEditorHandle | null>(null);
  const activePathRef = useRef<string | undefined>(undefined);
  const tabsRef = useRef<Tab[]>([]);
  const localWrites = useRef(new Map<string, string>());
  const activationRequest = useRef(0);
  const resizingExplorer = useRef(false);
  const explorerWidthRef = useRef(explorerWidth);
  const explorerResizeFrame = useRef<number | undefined>(undefined);
  const pendingExplorerWidth = useRef<number | undefined>(undefined);
  const currentRoot = useRef(root);
  const tabsRoot = useRef(root);
  const workspaceEditorStates = useRef(new Map<string, WorkspaceEditorState>());
  const treeRef = useRef<FileEntry | undefined>(undefined);
  const selectedEntryRef = useRef<FileEntry | undefined>(undefined);
  currentRoot.current = root;
  treeRef.current = tree;
  activePathRef.current = active;
  tabsRef.current = tabs;
  explorerWidthRef.current = explorerWidth;
  useEffect(() => {
    const stop = desktop.onEvent((event) => {
      if (event.type !== "language_server_progress") return;
      const value = event as { bytes?: unknown; detail?: unknown; error?: unknown; languageServerId?: unknown; rate?: unknown; stage?: unknown; total?: unknown };
      if (typeof value.stage !== "string") return;
      const stage = value.stage;
      const rawDetail = typeof value.detail === "string" ? value.detail : undefined;
      setCppProgress((previous) => ({
        stage, ...(typeof value.languageServerId === "string" ? { languageServerId: value.languageServerId } : {}),
        ...(rawDetail ? { detail: stage === "configuring" ? (en ? "Configuring project…" : "正在配置工程…") : rawDetail } : {}),
        ...(typeof value.bytes === "number" ? { bytes: value.bytes } : {}),
        ...(typeof value.total === "number" ? { total: value.total } : {}),
        ...(typeof value.rate === "number" ? { rate: value.rate } : {}),
        ...(typeof value.error === "string" ? { error: value.error } : {}),
        ...(stage === "configuring" && rawDetail ? { log: `${previous?.log ?? ""}${rawDetail}`.slice(-16_000) } : {}),
      }));
      if (value.stage === "ready") window.setTimeout(() => setCppProgress(undefined), 900);
    });
    return stop;
  }, [en]);
  useEffect(() => {
    const stop = desktop.onEvent((event) => {
      if (event.type !== "language_server_diagnostics" || typeof event.file !== "string" || !Array.isArray(event.diagnostics)) return;
      const diagnostics = event.diagnostics as unknown[];
      const key = event.file.replaceAll("\\", "/").toLowerCase();
      setCppDiagnostics((current) => ({ ...current, [key]: diagnostics.filter((item): item is Record<string, unknown> => !!item && typeof item === "object") }));
    });
    return stop;
  }, []);
  useEffect(() => {
    const show = () => setCppProjectsDialogOpen(true);
    window.addEventListener("agent-k-show-cpp-projects", show);
    return () => window.removeEventListener("agent-k-show-cpp-projects", show);
  }, []);
  useEffect(() => {
    const show = (event: Event) => {
      const text = (event as CustomEvent<unknown>).detail;
      if (typeof text === "string") { setCppTraceCopied(false); setCppTraceDialogText(text); }
    };
    window.addEventListener("agent-k-show-cpp-lsp-trace", show);
    return () => window.removeEventListener("agent-k-show-cpp-lsp-trace", show);
  }, []);
  useEffect(() => {
    let disposed = false;
    const refresh = () => void desktop.listLanguageServerProjects().then((projects) => { if (!disposed) setLanguageProjects(projects); });
    void desktop.listLanguageServerPlugins().then((plugins) => { if (!disposed) setLanguagePlugins(plugins); });
    refresh();
    const stop = desktop.onEvent((event) => {
      if (event.type === "language_server_project" || event.type === "language_server_project_removed") refresh();
    });
    return () => { disposed = true; stop(); };
  }, []);
  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!resizingExplorer.current || !inspectorRef.current) return;
      const left = inspectorRef.current.getBoundingClientRect().left;
      pendingExplorerWidth.current = Math.max(110, Math.min(inspectorRef.current.clientWidth - 120, event.clientX - left));
      if (explorerResizeFrame.current !== undefined) return;
      explorerResizeFrame.current = requestAnimationFrame(() => {
        explorerResizeFrame.current = undefined;
        const width = pendingExplorerWidth.current;
        if (width === undefined) return;
        explorerWidthRef.current = width;
        editorBodyRef.current?.style.setProperty("--explorer-width", `${width}px`);
      });
    };
    const stop = () => {
      if (!resizingExplorer.current) return;
      if (explorerResizeFrame.current !== undefined) {
        cancelAnimationFrame(explorerResizeFrame.current);
        explorerResizeFrame.current = undefined;
      }
      if (pendingExplorerWidth.current !== undefined) {
        explorerWidthRef.current = pendingExplorerWidth.current;
        editorBodyRef.current?.style.setProperty("--explorer-width", `${pendingExplorerWidth.current}px`);
        pendingExplorerWidth.current = undefined;
      }
      resizingExplorer.current = false;
      document.body.classList.remove("is-resizing");
      window.dispatchEvent(new CustomEvent("agent-k-editor-layout-suspended", { detail: false }));
      setExplorerWidth(explorerWidthRef.current);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      if (explorerResizeFrame.current !== undefined)
        cancelAnimationFrame(explorerResizeFrame.current);
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
    if (!targetRoot) return;
    if (!silent) setLoading(true);
    void desktop
      .tree(targetRoot)
      .then((loaded) => {
        if (currentRoot.current !== targetRoot) return;
        setTree((current) => {
          const merged = mergeFileTree(loaded, current);
          treeRef.current = merged;
          return merged;
        });
      })
      .catch((cause) => {
        if (!silent && currentRoot.current === targetRoot)
          onError(`无法读取项目文件：${String(cause)}`);
      })
      .finally(() => {
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
    selectedEntryRef.current = undefined;
    setSelectedEntry(undefined);
    refresh();
  }, [root]);
  useEffect(() => {
    void desktop.watchWorkspace(root);
    return () => { void desktop.watchWorkspace(); };
  }, [root]);
  useEffect(() => {
    const normalize = (path: string) => path.replaceAll("\\", "/").toLocaleLowerCase("en-US");
    const pendingDirectories = new Set<string>();
    let refreshTimer: number | undefined;
    let refreshing = false;
    let disposed = false;
    const flushDirectoryRefreshes = async () => {
      refreshTimer = undefined;
      if (refreshing || disposed || !root) return;
      const currentTree = treeRef.current;
      const paths = [...pendingDirectories].filter((path) => {
        const entry = findTreeEntry(currentTree, path);
        return entry?.isDir && entry.loaded;
      });
      pendingDirectories.clear();
      if (!paths.length) return;
      refreshing = true;
      try {
        const refreshed = await Promise.all(paths.map(async (path) => {
          try {
            return await desktop.directory(root, path, 1);
          } catch {
            // A rename/delete event may make the old parent disappear before
            // its coalesced refresh runs. Its surviving parent event will
            // update the visible tree.
            return undefined;
          }
        }));
        if (disposed || currentRoot.current !== root) return;
        setTree((current) => {
          let next = current;
          for (const fresh of refreshed) {
            if (!fresh || !next) continue;
            const previous = findTreeEntry(next, fresh.path);
            if (!previous?.isDir || !previous.loaded) continue;
            next = replaceTreeEntry(next, fresh.path, mergeFileTree(fresh, previous));
          }
          treeRef.current = next;
          return next;
        });
      } finally {
        refreshing = false;
        if (!disposed && pendingDirectories.size && refreshTimer === undefined)
          refreshTimer = window.setTimeout(() => void flushDirectoryRefreshes(), 120);
      }
    };
    const scheduleDirectoryRefresh = (path: string) => {
      pendingDirectories.add(parentDirectoryPath(path));
      if (refreshTimer !== undefined || refreshing) return;
      refreshTimer = window.setTimeout(() => void flushDirectoryRefreshes(), 120);
    };
    const stop = desktop.onEvent((event) => {
      if (event.type === "advanced_search_progress" && event.root === root && typeof event.path === "string") {
        setAdvancedProgress(String(event.path));
        return;
      }
      if (event.type !== "workspace_file_changed" || event.root !== root || typeof event.path !== "string" || !root) return;
      const path = event.path;
      if (event.kind === "rename") scheduleDirectoryRefresh(path);
      const tab = tabsRef.current.find((candidate) => normalize(candidate.path) === normalize(path));
      if (!tab || tab.unsupported || tab.binary) return;
      void desktop.read(root, path).then((content) => {
        const currentTab = tabsRef.current.find((candidate) => normalize(candidate.path) === normalize(path));
        if (!currentTab) return;
        const expected = localWrites.current.get(normalize(path));
        if (expected === content) { localWrites.current.delete(normalize(path)); return; }
        if (currentTab.content !== currentTab.saved || currentTab.runtimeDirty) {
          setTabs((currentTabs) => currentTabs.map((candidate) => normalize(candidate.path) === normalize(path) ? { ...candidate, externalChanged: true } : candidate));
          return;
        }
        setTabs((currentTabs) => currentTabs.map((candidate) => normalize(candidate.path) === normalize(path) ? { ...candidate, content, externalChanged: false, saved: content } : candidate));
        if (currentTab.format?.editor === "plugin") {
          if (normalize(activePathRef.current ?? "") === normalize(path)) {
            pluginEditorRef.current?.setContent(content);
          } else {
            // A cached iframe retains its own Monaco model while hidden. Drop
            // only this clean inactive runtime so reopening the tab creates a
            // fresh model from the externally modified disk contents.
            const runtimePrefix = `${root}\0${currentTab.format.id}\0${currentTab.path}\0`;
            setEditorRuntimeKeys((keys) =>
              keys.filter((key) => !key.startsWith(runtimePrefix)),
            );
            editorRuntimeRecency.current = editorRuntimeRecency.current.filter(
              (key) => !key.startsWith(runtimePrefix),
            );
          }
        }
      }).catch(() => undefined);
    });
    return () => {
      disposed = true;
      stop();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
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
    const reloadFileFormats = () => {
      void (async () => {
        const activePath = activePathRef.current;
        const activeTab = tabsRef.current.find((tab) => tab.path === activePath);
        if (activeTab?.format?.editor === "plugin" && pluginEditorRef.current) {
          try {
            const content = await pluginEditorRef.current.readContent();
            setTabs((currentTabs) => currentTabs.map((tab) =>
              tab.path === activePath ? { ...tab, content } : tab,
            ));
          } catch {
            // Keep the last host-side content if the old iframe has already
            // stopped while resources are being reloaded.
          }
        }
        editorRuntimeRecency.current = [];
        setEditorRuntimeKeys([]);
        setEditorRuntimeRevision((revision) => revision + 1);
        refreshFileFormats();
      })();
    };
    refreshFileFormats();
    window.addEventListener("agent-k-resources-changed", reloadFileFormats);
    return () => window.removeEventListener("agent-k-resources-changed", reloadFileFormats);
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
  useEffect(() => {
    const openAdvancedSearch = (event?: Event) => {
      const detail = (event as CustomEvent<unknown> | undefined)?.detail;
      const selectedText = (typeof detail === "string" ? detail : latestEditorSelection.current).trim();
      // The dialog is mounted afresh each time, so its DOM transform starts at
      // zero as well. Reset the retained drag coordinates before calculating
      // the next pointer grab offset or the first move will jump by the old
      // translation.
      advancedDialogDrag.current = undefined;
      advancedDialogOffset.current = { x: 0, y: 0 };
      advancedDialogRef.current?.style.removeProperty("transform");
      setAdvancedSearchSeed(selectedText);
      setAdvancedSearchOpen(true);
      setAdvancedHistoryOpen(false);
    };
    const updateEditorSelection = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      latestEditorSelection.current = typeof detail === "string" ? detail : "";
    };
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      openAdvancedSearch();
    };
    window.addEventListener("keydown", shortcut);
    window.addEventListener("agent-k-advanced-search", openAdvancedSearch);
    window.addEventListener("agent-k-editor-selection", updateEditorSelection);
    return () => { window.removeEventListener("keydown", shortcut); window.removeEventListener("agent-k-advanced-search", openAdvancedSearch); window.removeEventListener("agent-k-editor-selection", updateEditorSelection); };
  }, []);
  useEffect(() => {
    if (!advancedSearchOpen || !advancedQueryRef.current) return;
    advancedQueryRef.current.value = advancedSearchSeed;
    setAdvancedResults([]);
    setAdvancedSearched(false);
    setAdvancedProgress("");
    advancedQueryRef.current.focus();
    if (advancedSearchSeed) advancedQueryRef.current.select();
  }, [advancedSearchOpen, advancedSearchSeed]);
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
  const paintTreeSelection = useCallback((path?: string, target?: HTMLElement) => {
    const container = fileTreeRef.current;
    if (!container) return;
    for (const selected of container.querySelectorAll<HTMLElement>(".file-node.selected, summary.selected"))
      selected.classList.remove("selected");
    if (target && container.contains(target) && target.matches("[data-tree-path]")) {
      target.classList.add("selected");
      return;
    }
    if (path === undefined) return;
    for (const candidate of container.querySelectorAll<HTMLElement>("[data-tree-path]")) {
      if (candidate.dataset.treePath !== path) continue;
      candidate.classList.add("selected");
      break;
    }
  }, []);
  const selectTreeEntry = useCallback((entry: FileEntry, element: HTMLElement) => {
    selectedEntryRef.current = entry;
    paintTreeSelection(entry.path, element);
  }, [paintTreeSelection]);
  useLayoutEffect(() => {
    paintTreeSelection(selectedEntryRef.current?.path);
  }, [paintTreeSelection, query, tree]);
  const activateTab = (path: string) => {
    const pathKey = path.replaceAll("\\", "/").toLocaleLowerCase("en-US");
    const targetPath = tabs.find((tab) => tab.path.replaceAll("\\", "/").toLocaleLowerCase("en-US") === pathKey)?.path ?? path;
    const previousPath = activePathRef.current;
    const request = ++activationRequest.current;
    const finish = () => {
      if (request !== activationRequest.current) return;
      activePathRef.current = targetPath;
      setActive(targetPath);
    };
    const previousTab = tabs.find((tab) => tab.path === previousPath);
    if (
      previousPath !== targetPath &&
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
    const pathKey = path.replaceAll("\\", "/").toLocaleLowerCase("en-US");
    const alreadyOpen = (tab: Tab) => tab.path.replaceAll("\\", "/").toLocaleLowerCase("en-US") === pathKey;
    const appendTab = (tab: Tab) => setTabs((current) => current.some(alreadyOpen) ? current : [...current, tab]);
    if (!root || tabs.some(alreadyOpen)) {
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
      appendTab({ path, content: "", saved: "", unsupported: true });
      activateTab(path);
      return;
    }
    const previewKind = format.mediaKind;
    if (format.editor === "plugin" && previewKind) {
      try {
        const data = await desktop.readBinary(root, path);
        appendTab({ binary: data, content: "", path, previewBytes: data.byteLength, previewCodec: previewKind === "video" ? detectVideoCodec(data) : undefined, mimeType: match.mimeType, saved: "", format });
        activateTab(path);
      } catch (cause) {
        onError(`无法预览文件：${String(cause)}`);
      }
      return;
    }
    if (!(format.editable === true || path.toLowerCase().endsWith(".lock"))) {
      appendTab({ path, content: "", saved: "", unsupported: true, format, mimeType: match.mimeType });
      activateTab(path);
      return;
    }
    try {
      const content = await desktop.read(root, path);
      appendTab({ path, content, saved: content, format, mimeType: match.mimeType });
      activateTab(path);
    } catch (cause) {
      onError(`无法打开文件：${String(cause)}`);
    }
  };
  useEffect(() => {
    const openReferencedLine = (event: Event) => {
      const detail = (event as CustomEvent<{ column?: number; line?: number; path?: string }>).detail;
      if (!detail?.path || !detail.line) return;
      const target = {
        column: Math.max(1, Math.floor(detail.column ?? 1)),
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
      pluginEditorRef.current?.navigate(lineNavigation.line, lineNavigation.column);
      setLineNavigation((current) =>
        current?.requestId === lineNavigation.requestId ? undefined : current,
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [active, lineNavigation, tabs]);
  const closeTab = (tab: Tab) => {
    const closingIndex = tabs.findIndex((item) => item.path === tab.path);
    const remainingTabs = tabs.filter((item) => item.path !== tab.path);
    // Keep the recently used plugin runtime alive until the bounded LRU cache
    // evicts it. Destroying an iframe here synchronously tears down Monaco and
    // its workers on the click path, which makes closing a code tab hitch.
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
  const currentLanguageProject = root && current
    ? languageProjects.filter((project) => {
      const file = absoluteWorkspacePath(root, current.path).replaceAll("\\", "/").toLowerCase(); const projectRoot = project.root.replaceAll("\\", "/").toLowerCase(); return file.startsWith(`${projectRoot}/`) || file === projectRoot;
    }).sort((a, b) => b.root.length - a.root.length)[0]
    : undefined;
  const contextLanguageProject = root && contextMenu?.entry.isDir
    ? languageProjects.find((project) => project.root.replaceAll("\\", "/").toLowerCase() === absoluteWorkspacePath(root, contextMenu.entry.path).replaceAll("\\", "/").toLowerCase())
    : undefined;
  const contextLanguagePlugin = contextMenu?.entry.isDir
    ? languagePlugins.find((plugin) => plugin.projectMarkers.some((marker) => contextMenu.entry.children.some((child) => child.name.toLowerCase() === marker.toLowerCase())))
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
      // A C++ editor created before clangd becomes available has already
      // completed its didOpen attempt. Background indexing does not prevent
      // clangd from serving an opened translation unit, so both indexing and
      // ready identify an available editor service. Keeping the same identity
      // across that transition also avoids recreating Monaco at index finish.
      ? `${root}\0${current.format.id}\0${current.path}\0${currentLanguageProject && (currentLanguageProject.status === "ready" || currentLanguageProject.status === "indexing") ? currentLanguageProject.root : "no-language-service"}\0runtime-${editorRuntimeRevision}`
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
      localWrites.current.set(tab.path.replaceAll("\\", "/").toLocaleLowerCase("en-US"), content);
      await desktop.write(root, tab.path, content);
      setTabs((currentTabs) =>
        currentTabs.map((candidate) =>
          candidate.path === tab.path
            ? { ...candidate, content, externalChanged: false, runtimeDirty: false, saved: content }
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
    selectTreeEntry(entry, event.currentTarget as HTMLElement);
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
      const renamedEntry = { ...selectedEntry, path: newPath, name };
      selectedEntryRef.current = renamedEntry;
      setSelectedEntry(renamedEntry);
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
      selectedEntryRef.current = undefined;
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
      const selected = selectedEntryRef.current;
      if (selected && pathIsWithin(selected.path, sourcePath))
        selectedEntryRef.current = {
          ...selected,
          name: selected.path === sourcePath ? name : selected.name,
          path: remap(selected.path),
        };
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
  // A dialog toggle must not redraw a large, expanded file tree. The actual
  // handlers stay current through this ref while the props passed to Tree keep
  // stable identities for React.memo.
  const treeActionRefs = useRef({
    loadDirectory,
    open,
    showContextMenu,
    startPointerDrag,
  });
  treeActionRefs.current = { loadDirectory, open, showContextMenu, startPointerDrag };
  const treeLoadDirectory = useCallback((path: string) => treeActionRefs.current.loadDirectory(path), []);
  const treeOpen = useCallback((path: string) => treeActionRefs.current.open(path), []);
  const treeShowContextMenu = useCallback((entry: FileEntry, event: ReactMouseEvent) => treeActionRefs.current.showContextMenu(entry, event), []);
  const treeStartPointerDrag = useCallback((event: ReactPointerEvent, entry: FileEntry) => treeActionRefs.current.startPointerDrag(event, entry), []);
  const shouldSuppressTreeClick = useCallback(() => Date.now() < suppressTreeClickUntil.current, []);
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
  const currentLanguageDiagnostics = root && current
    ? cppDiagnostics[absoluteWorkspacePath(root, current.path).replaceAll("\\", "/").toLowerCase()]
    : undefined;
  const activePluginEditorProps: PluginEditorProps | undefined =
    current?.format?.editor === "plugin" && root
      ? {
          actions: [
            ...(["agent-k.html", "agent-k.markdown"].includes(current.format.id)
            ? [{
                id: "set-preview",
                parameters: { enabled: current.previewMode === true },
              }]
            : []),
            ...(currentLanguageDiagnostics ? [{ id: "set-language-diagnostics", parameters: { diagnostics: currentLanguageDiagnostics } }] : []),
          ],
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
          onLanguageRequest(method, parameters) {
            const file = absoluteWorkspacePath(root, current.path);
            const language = current.format?.languageId ?? languageFor(current.path);
            if (method === "agent-k/read-file") {
              const requested = parameters as { path?: unknown } | undefined;
              const relative = typeof requested?.path === "string"
                ? relativeWorkspacePath(root, requested.path.replace(/^file:\/\//, ""))
                : undefined;
              if (!relative) return Promise.reject(new Error("File is outside the current workspace"));
              return desktop.read(root, relative);
            }
            return method.includes("/did")
              ? desktop.languageServerNotify(language, file, method, parameters)
              : desktop.languageServerRequest(language, file, method, parameters);
          },
          onOpenFile(absolutePath, line, column) {
            const relative = relativeWorkspacePath(root, absolutePath.replace(/^file:\/\//, ""));
            if (!relative) return;
            if (line !== undefined) {
              window.dispatchEvent(new CustomEvent("agent-k-open-file-line", { detail: { column, line, path: relative } }));
              return;
            }
            void open(relative);
          },
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
          themeConfig: activeTheme,
          wordWrap: settings.editorWordWrap,
        }
      : undefined;
  const copyCppTrace = () => {
    if (!cppTraceDialogText) return;
    void platform.copyText(cppTraceDialogText).then(() => {
      setCppTraceCopied(true);
      window.setTimeout(() => setCppTraceCopied(false), 1_500);
    }).catch((cause) => onError(String(cause)));
  };
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
        ref={editorBodyRef}
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
            <button aria-label="高级查找" className="inspector-advanced-search" onClick={() => { void pluginEditorRef.current?.readSelection().then((selection) => window.dispatchEvent(new CustomEvent("agent-k-advanced-search", { detail: selection }))).catch(() => window.dispatchEvent(new CustomEvent("agent-k-advanced-search", { detail: latestEditorSelection.current }))); if (!pluginEditorRef.current) window.dispatchEvent(new CustomEvent("agent-k-advanced-search", { detail: latestEditorSelection.current })); }} type="button"><i className="fa-solid fa-sliders" /></button>
          </form>
          {advancedSearchOpen ? createPortal(<div className="advanced-search-backdrop"><form ref={advancedDialogRef} className="advanced-project-search" onSubmit={(event) => { event.preventDefault(); const query = advancedQueryRef.current?.value.trim() ?? ""; if (!root || !query || advancedSearching) return; setAdvancedSearchHistory((history) => [query, ...history.filter((item) => item !== query)].slice(0, 12)); setAdvancedHistoryOpen(false); setAdvancedSearching(true); setAdvancedSearched(true); setAdvancedResults([]); setAdvancedProgress(""); void desktop.advancedSearch(root, { caseSensitive: advancedCaseSensitive, directory: advancedDirectory, filePattern: advancedFilePattern, query, wholeWord: advancedWholeWord }).then(setAdvancedResults).catch((cause) => onError(`高级查找失败：${String(cause)}`)).finally(() => setAdvancedSearching(false)); }}>
            <header onLostPointerCapture={() => { advancedDialogDrag.current = undefined; }} onPointerCancel={() => { advancedDialogDrag.current = undefined; }} onPointerDown={(event) => { if ((event.target as Element).closest("button")) return; advancedDialogDrag.current = { x: event.clientX - advancedDialogOffset.current.x, y: event.clientY - advancedDialogOffset.current.y }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (!advancedDialogDrag.current) return; const offset = { x: event.clientX - advancedDialogDrag.current.x, y: event.clientY - advancedDialogDrag.current.y }; advancedDialogOffset.current = offset; if (advancedDialogRef.current) advancedDialogRef.current.style.transform = `translate(${offset.x}px, ${offset.y}px)`; }} onPointerUp={() => { advancedDialogDrag.current = undefined; }}><strong>在项目中查找</strong><button aria-label="关闭高级查找" onClick={() => setAdvancedSearchOpen(false)} type="button"><i className="fa-solid fa-xmark" /></button></header>
            <label>查找内容<span className="advanced-query-input"><input ref={advancedQueryRef} onInput={() => { if (advancedResults.length || advancedSearched) { setAdvancedResults([]); setAdvancedSearched(false); setAdvancedProgress(""); } }} placeholder="输入要查找的文本" required /><button aria-expanded={advancedHistoryOpen} aria-label="显示查找历史" onClick={() => setAdvancedHistoryOpen((open) => !open)} type="button"><i className="fa-solid fa-chevron-down" /></button>{advancedHistoryOpen ? <span className="advanced-search-history">{advancedSearchHistory.length ? advancedSearchHistory.map((item) => <button key={item} onClick={() => { if (advancedQueryRef.current) advancedQueryRef.current.value = item; if (advancedResults.length || advancedSearched) { setAdvancedResults([]); setAdvancedSearched(false); setAdvancedProgress(""); } setAdvancedHistoryOpen(false); advancedQueryRef.current?.focus(); }} type="button">{item}</button>) : <small>暂无查找历史</small>}</span> : null}</span></label>
            <div className="advanced-search-options"><label><input checked={advancedWholeWord} onChange={(event) => setAdvancedWholeWord(event.target.checked)} type="checkbox" /> 全字匹配</label><label><input checked={advancedCaseSensitive} onChange={(event) => setAdvancedCaseSensitive(event.target.checked)} type="checkbox" /> 区分大小写</label></div>
            <div className="advanced-search-filters"><label>目录（glob）<span className="advanced-directory-input"><input onChange={(event) => setAdvancedDirectory(event.target.value)} placeholder="例如 Editor/**" value={advancedDirectory} /><button onClick={() => setAdvancedDirectoryPickerOpen(true)} type="button"><i className="fa-regular fa-folder-open" /></button></span></label><label>文件类型（glob）<input onChange={(event) => setAdvancedFilePattern(event.target.value)} placeholder="例如 *.cpp;*.h" value={advancedFilePattern} /></label></div>
            <footer><span title={advancedProgress}>{advancedSearching ? `正在搜索：${advancedProgress || "准备中…"}` : advancedResults.length ? `${advancedResults.length} 个结果` : "最多显示 500 个结果"}</span><button disabled={advancedSearching} type="submit">{advancedSearching ? "查找中…" : "查找"}</button></footer>
            <AdvancedSearchResults items={advancedResults} onOpen={(path) => { void open(path); setAdvancedSearchOpen(false); }} searched={advancedSearched} searching={advancedSearching} />
          </form></div>, document.body) : null}
          {advancedDirectoryPickerOpen && root ? <DirectoryPickerDialog initialPath={root} onCancel={() => setAdvancedDirectoryPickerOpen(false)} onSelect={(path) => { const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase(); const normalizedPath = path.replaceAll("\\", "/").replace(/\/$/, ""); const candidate = normalizedPath.toLowerCase(); if (candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}/`)) { onError("选择的目录不在当前项目中"); return; } const relative = normalizedPath.slice(normalizedRoot.length).replace(/^\//, ""); setAdvancedDirectory(relative ? `${relative}/**` : "**"); setAdvancedDirectoryPickerOpen(false); }} restrictedRoot={root} title="选择搜索目录" /> : null}
          <div
            className="file-tree-scroll"
            ref={fileTreeRef}
            onContextMenu={(event) => {
              if (tree && event.target === event.currentTarget)
                showContextMenu(tree, event);
            }}
          >
            {!query.trim() && tree ? (
              <Tree
                entry={tree}
                languageProjectsByPath={languageProjectsByTreePath}
                loadDirectory={treeLoadDirectory}
                open={treeOpen}
                dropTarget={dropTarget}
                select={selectTreeEntry}
                shouldSuppressClick={shouldSuppressTreeClick}
                showContextMenu={treeShowContextMenu}
                startPointerDrag={treeStartPointerDrag}
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
                  data-tree-path={path}
                  onClick={(event) => {
                    const entry = {
                      children: [],
                      isDir: false,
                      loaded: true,
                      name: path.split(/[\\/]/).pop() ?? path,
                      path,
                    };
                    selectTreeEntry(entry, event.currentTarget);
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
                title={tab.externalChanged ? (en ? "Changed on disk; local edits were preserved" : "磁盘文件已变更；已保留本地未保存修改") : undefined}
                type="button"
              >
                {tab.path.split(/[\\/]/).pop()}
                {tab.content !== tab.saved || tab.runtimeDirty ? " •" : ""}
                {tab.externalChanged ? " ↻" : ""}
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
                  {currentLanguageProject ? <span className={`cpp-inline-status is-${currentLanguageProject.status}`} title={currentLanguageProject.error ?? `${currentLanguageProject.languageServerName} · ${currentLanguageProject.name} · ${currentLanguageProject.status}`}>
                    <i aria-hidden="true" className="fa-solid fa-code" /><span>{currentLanguageProject.languageServerName} · {currentLanguageProject.name} · {currentLanguageProject.status}{currentLanguageProject.status === "indexing" && currentLanguageProject.indexProgress ? ` ${currentLanguageProject.indexProgress}` : ""}</span>
                    {currentLanguageProject.status === "indexing" ? <span aria-hidden="true" className="cpp-inline-status-spinner" /> : null}
                  </span> : null}
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
          {contextMenu.entry.isDir && (contextLanguageProject ? (
            <button
              onClick={() => {
                setContextMenu(undefined);
                void desktop.languageServerCall(contextLanguageProject.languageServerId, "unload", contextLanguageProject.root).catch((cause) => onError(String(cause)));
              }}
              role="menuitem"
              type="button"
            >
              <i className="fa-solid fa-code" />
              {contextLanguageProject ? (languagePlugins.find((plugin) => plugin.id === contextLanguageProject.languageServerId)?.projectMenu?.unloadLabel ?? (en ? "Unload language project" : "卸载语言工程")) : null}
            </button>
          ) : contextLanguagePlugin ? (
            <button
              onClick={() => {
                if (!root) return;
                const path = contextMenu.entry.path;
                setContextMenu(undefined);
                setCppProgress({ languageServerId: contextLanguagePlugin.id, stage: "preparing", detail: en ? `Preparing ${contextLanguagePlugin.displayName}…` : `正在准备 ${contextLanguagePlugin.displayName}…` });
                void desktop.languageServerCall(contextLanguagePlugin.id, "load", absoluteWorkspacePath(root, path)).then((result) => {
                  const project = result as LanguageServerProject;
                  if (project.status === "failed") setCppProgress((current) => ({ ...(current ?? { stage: "failed" }), stage: "failed", error: project.error }));
                  else setCppProgress(undefined);
                }).catch((cause) => setCppProgress({ stage: "failed", error: String(cause) }));
              }}
              role="menuitem"
              type="button"
            >
              <i className="fa-solid fa-code" />
              {contextLanguagePlugin.projectMenu?.loadLabel ?? (en ? `Load ${contextLanguagePlugin.displayName} project` : `加载 ${contextLanguagePlugin.displayName} 工程`)}
            </button>
          ) : null)}
          {contextLanguagePlugin?.projectMenu?.actions?.map((action) => (
            <button
              key={`${contextLanguagePlugin.id}:${action.id}`}
              onClick={() => {
                window.dispatchEvent(new CustomEvent("agent-k-file-format-action", {
                  detail: { action: `language-server:${contextLanguagePlugin.id}:${action.method}`, path: contextMenu.entry.path },
                }));
                setContextMenu(undefined);
              }}
              role="menuitem"
              type="button"
            >
              <i className="fa-solid fa-hammer" />
              {action.label}
            </button>
          ))}
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
      {cppProgress ? createPortal(
        <div className="inspector-dialog-backdrop is-viewport">
          <section aria-modal="true" className="inspector-dialog cpp-progress-dialog" role="dialog">
            <header><span aria-hidden="true" className="inspector-dialog-icon"><i className="fa-solid fa-code" /></span><div><h2>{cppProgress.stage === "failed" ? (en ? "Language project load failed" : "语言工程加载失败") : (en ? "Preparing language project" : "正在准备语言工程")}</h2><p>{cppProgress.detail ?? cppProgress.stage}</p></div><button aria-label={cppProgress.stage === "failed" ? (en ? "Close" : "关闭") : (en ? "Cancel language project load" : "取消加载语言工程")} className="cpp-progress-close" disabled={cppProgress.stage === "cancelling"} onClick={() => { if (cppProgress.stage === "failed") { setCppProgress(undefined); return; } setCppProgress((current) => current ? { ...current, stage: "cancelling", detail: en ? "Cancelling…" : "正在取消…" } : current); if (cppProgress.languageServerId) void desktop.languageServerCall(cppProgress.languageServerId, "cancel").catch((cause) => setCppProgress({ stage: "failed", error: String(cause) })); }} type="button"><i aria-hidden="true" className="fa-solid fa-xmark" /></button></header>
            {cppProgress.total ? <progress className="cpp-toolchain-progress" max={cppProgress.total} value={Math.min(cppProgress.bytes ?? 0, cppProgress.total)} /> : <p>{en ? "Working…" : "处理中…"}</p>}
            {cppProgress.bytes !== undefined ? <small>{formatMegabytes(cppProgress.bytes)}{cppProgress.total ? ` / ${formatMegabytes(cppProgress.total)} · ${(Math.min(cppProgress.bytes, cppProgress.total) / cppProgress.total * 100).toFixed(2)}%` : ""}{cppProgress.rate !== undefined ? ` · ${formatMegabytes(cppProgress.rate)}/s` : ""}</small> : null}
            {cppProgress.error ? <p>{cppProgress.error}</p> : null}
            {cppProgress.log ? <details><summary>{en ? "Configuration output" : "工程配置输出"}</summary><pre className="cpp-progress-log">{cppProgress.log}</pre></details> : null}
          </section>
        </div>,
        document.body,
      ) : null}
      {cppProjectsDialogOpen ? createPortal(
        <div className="inspector-dialog-backdrop is-viewport" onMouseDown={(event) => { if (event.target === event.currentTarget) setCppProjectsDialogOpen(false); }}>
          <section aria-modal="true" className="inspector-dialog" role="dialog">
            <header><span aria-hidden="true" className="inspector-dialog-icon"><i className="fa-solid fa-code" /></span><div><h2>{en ? "Active language projects" : "已加载的语言工程"}</h2><p>{languageProjects.length ? (en ? `${languageProjects.length} projects` : `${languageProjects.length} 个工程`) : (en ? "No projects loaded" : "当前没有已加载工程")}</p></div><button aria-label={en ? "Close" : "关闭"} className="inspector-dialog-close" onClick={() => setCppProjectsDialogOpen(false)} type="button"><i aria-hidden="true" className="fa-solid fa-xmark" /></button></header>
            {languageProjects.map((project) => <div className="cpp-project-row" key={`${project.languageServerId}:${project.root}`}><div className="cpp-project-row-heading"><strong>{project.name}</strong><div className="cpp-project-row-actions"><button aria-label={en ? "Restart language project" : "重启语言工程"} onClick={() => void desktop.languageServerCall(project.languageServerId, "restart", project.root)} title={en ? "Restart" : "重启"} type="button"><i aria-hidden="true" className="fa-solid fa-arrow-rotate-right" /></button><button aria-label={en ? "Unload language project" : "卸载语言工程"} onClick={() => void desktop.languageServerCall(project.languageServerId, "unload", project.root)} title={en ? "Unload" : "卸载"} type="button"><i aria-hidden="true" className="fa-solid fa-arrow-right-from-bracket" /></button></div></div><small>{project.languageServerName} · {project.root}</small><span className={`is-${project.status}`}>{project.status}{project.error ? ` · ${project.error}` : ""}</span></div>)}
          </section>
        </div>,
        document.body,
      ) : null}
      {cppTraceDialogText ? (
        <div className="inspector-dialog-backdrop">
          <section aria-modal="true" className="inspector-dialog cpp-trace-dialog" role="dialog">
            <header><span aria-hidden="true" className="inspector-dialog-icon"><i className="fa-solid fa-wave-square" /></span><div><h2>{en ? "C++ LSP trace" : "C++ LSP 跟踪记录"}</h2><p>{en ? "Recent language-service messages" : "最近的语言服务消息"}</p></div><button aria-label={en ? "Close" : "关闭"} className="inspector-dialog-close" onClick={() => { setCppTraceCopied(false); setCppTraceDialogText(undefined); }} type="button"><i aria-hidden="true" className="fa-solid fa-xmark" /></button></header>
            <div className="cpp-trace-output-wrap"><textarea aria-label={en ? "C++ LSP trace" : "C++ LSP 跟踪记录"} className="cpp-trace-output" readOnly spellCheck={false} value={cppTraceDialogText} wrap="soft" /><button aria-label={cppTraceCopied ? (en ? "Copied" : "已复制") : (en ? "Copy trace" : "复制跟踪记录")} className={`cpp-trace-copy${cppTraceCopied ? " is-copied" : ""}`} onClick={copyCppTrace} title={cppTraceCopied ? (en ? "Copied" : "已复制") : (en ? "Copy" : "复制")} type="button"><i aria-hidden="true" className={cppTraceCopied ? "fa-solid fa-check" : "fa-regular fa-copy"} /></button></div>
          </section>
        </div>
      ) : null}
    </aside>
  );
}
