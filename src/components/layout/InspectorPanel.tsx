import Editor from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import ReactMarkdown from "react-markdown";
import { createPortal } from "react-dom";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { desktop, type FileEntry } from "../../lib/desktop";
import { applyAgentKTheme, defineAgentKTheme } from "../../lib/monacoTheme";
import { registerResponsiveMonacoEditor } from "../../lib/responsiveMonaco";
import { platform } from "../../lib/platform";
import { MediaPreview, type PreviewKind } from "./MediaPreview";
import { ProjectConsole } from "./ProjectConsole";
import {
  ReviewPanel,
  type ReviewCall,
} from "../../features/conversation/ReviewPanel";
import { useSettings } from "../../features/settings/SettingsContext";
import {
  mediaMimeTypeFor,
  monacoLanguageFor,
  resolveFileFormat,
} from "../../features/file-formats/builtins";
import type { FileFormatPlugin } from "../../features/file-formats/sdk";

type Tab = {
  path: string;
  content: string;
  saved: string;
  unsupported?: boolean;
  previewKind?: PreviewKind;
  previewUrl?: string;
  previewBytes?: number;
  previewCodec?: string;
  previewMode?: boolean;
  documentPreviewUrl?: string;
  format?: FileFormatPlugin;
};
function mediaTypeFor(path: string) {
  return mediaMimeTypeFor(path);
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
  return monacoLanguageFor(path);
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
      "h",
      "hpp",
      "cs",
      "sh",
      "ps1",
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
  const editorTheme = resolvedTheme === "dark" ? "agent-k-dark" : "agent-k-light";
  const [tree, setTree] = useState<FileEntry>();
  const [fileFormatPlugins, setFileFormatPlugins] = useState<FileFormatPlugin[]>([]);
  const [loading, setLoading] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([]);
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
  const [refreshingPreview, setRefreshingPreview] = useState(false);
  const [loadingPreviewPath, setLoadingPreviewPath] = useState<string>();
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
  const inspectorRef = useRef<HTMLElement>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const editorContextMenuLine = useRef<number | undefined>(undefined);
  const editorViewStates = useRef(
    new Map<string, MonacoEditor.ICodeEditorViewState>(),
  );
  const activePathRef = useRef<string | undefined>(undefined);
  const resizingExplorer = useRef(false);
  const refreshInFlight = useRef(new Set<string>());
  const previewUrls = useRef(new Set<string>());
  const currentRoot = useRef(root);
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
    for (const url of previewUrls.current) URL.revokeObjectURL(url);
    previewUrls.current.clear();
    setTabs([]);
    setActive(undefined);
    activePathRef.current = undefined;
    editorViewStates.current.clear();
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
        .then((plugins) => setFileFormatPlugins(
          [...plugins]
            .sort((left, right) => left.scope === right.scope ? 0 : left.scope === "project" ? -1 : 1)
            .map((plugin) => plugin as FileFormatPlugin),
        ))
        .catch(() => setFileFormatPlugins([]));
    };
    refreshFileFormats();
    window.addEventListener("agent-k-resources-changed", refreshFileFormats);
    return () => window.removeEventListener("agent-k-resources-changed", refreshFileFormats);
  }, [root]);
  useEffect(
    () => () => {
      for (const url of previewUrls.current) URL.revokeObjectURL(url);
      previewUrls.current.clear();
    },
    [],
  );
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
    const editor = editorRef.current;
    if (previousPath && editor) {
      const viewState = editor.saveViewState();
      if (viewState) editorViewStates.current.set(previousPath, viewState);
    }
    activePathRef.current = path;
    setActive(path);
  };
  const restoreEditorView = (
    path: string,
    editor = editorRef.current,
  ) => {
    if (!editor || activePathRef.current !== path) return;
    const saved = editorViewStates.current.get(path);
    if (saved) {
      editor.restoreViewState(saved);
      return;
    }
    editor.setScrollPosition({ scrollLeft: 0, scrollTop: 0 });
    editor.setPosition({ column: 1, lineNumber: 1 });
  };
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => restoreEditorView(active));
    return () => cancelAnimationFrame(frame);
  }, [active]);
  useEffect(() => {
    if (!active) {
      window.dispatchEvent(new CustomEvent("agent-k-file-format-capabilities", { detail: undefined }));
      return;
    }
    const plugin = resolveFileFormat(active, fileFormatPlugins);
    window.dispatchEvent(new CustomEvent("agent-k-file-format-capabilities", {
      detail: {
        capabilities: plugin.capabilities ?? [],
        name: plugin.name,
        path: active,
        pluginId: plugin.id,
      },
    }));
  }, [active, fileFormatPlugins]);
  const open = async (path: string) => {
    if (!root || tabs.some((tab) => tab.path === path)) {
      activateTab(path);
      return;
    }
    const format = resolveFileFormat(path, fileFormatPlugins);
    const previewKind = format.mediaKind;
    if (previewKind) {
      try {
        const data = await desktop.readBinary(root, path);
        const previewUrl = URL.createObjectURL(
          new Blob([data], { type: format.mimeType ?? mediaTypeFor(path) }),
        );
        previewUrls.current.add(previewUrl);
        setTabs((current) => [
          ...current,
          {
            content: "",
            path,
            previewBytes: data.byteLength,
            previewCodec:
              previewKind === "video" ? detectVideoCodec(data) : undefined,
            previewKind,
            previewUrl,
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
        { path, content: "", saved: "", unsupported: true, format },
      ]);
      activateTab(path);
      return;
    }
    try {
      const content = await desktop.read(root, path);
      setTabs((current) => [...current, { path, content, saved: content, format }]);
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
    if (
      !lineNavigation ||
      lineNavigation.path !== active?.replaceAll("\\", "/")
    ) return;
    const frame = requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (
        !editor ||
        activePathRef.current?.replaceAll("\\", "/") !== lineNavigation.path
      ) return;
      const model = editor.getModel();
      const line = Math.min(
        lineNavigation.line,
        model?.getLineCount() ?? lineNavigation.line,
      );
      editor.setPosition({ column: 1, lineNumber: line });
      editor.revealLineInCenter(line);
      editor.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, lineNavigation, tabs]);
  const closeTab = (tab: Tab) => {
    if (tab.previewUrl) {
      URL.revokeObjectURL(tab.previewUrl);
      previewUrls.current.delete(tab.previewUrl);
    }
    setTabs((currentTabs) =>
      currentTabs.filter((item) => item.path !== tab.path),
    );
    if (active === tab.path) {
      activePathRef.current = undefined;
      setActive(undefined);
    }
  };
  const current = tabs.find((tab) => tab.path === active);
  const update = (content: string) =>
    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        tab.path === active ? { ...tab, content } : tab,
      ),
    );
  const save = async (): Promise<boolean> => {
    if (!root || !current || current.unsupported || current.previewKind)
      return false;
    try {
      await desktop.write(root, current.path, current.content);
      setTabs((currentTabs) =>
        currentTabs.map((tab) =>
          tab.path === current.path ? { ...tab, saved: tab.content } : tab,
        ),
      );
      return true;
    } catch (cause) {
      onError(`保存失败：${String(cause)}`);
      return false;
    }
  };
  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s")
        return;
      if (!current || current.unsupported || current.previewKind) return;
      event.preventDefault();
      void save();
    };
    window.addEventListener("keydown", saveShortcut);
    return () => window.removeEventListener("keydown", saveShortcut);
  }, [current, root]);
  const undo = () => {
    if (!current || current.unsupported || current.previewKind) return;
    // The toolbar action means "discard the unsaved edit", rather than a
    // single Monaco history step. Keeping React and Monaco on the saved value
    // also clears the tab's dirty marker deterministically.
    update(current.saved);
    editorRef.current?.setValue(current.saved);
    editorRef.current?.focus();
  };
  const toggleDocumentPreview = async () => {
    if (!current || !["markdown", "html"].includes(current.format?.editor ?? "")) return;
    if (current.previewMode) {
      setLoadingPreviewPath(undefined);
      setTabs((currentTabs) =>
        currentTabs.map((tab) =>
          tab.path === current.path ? { ...tab, previewMode: false } : tab,
        ),
      );
      return;
    }
    if (current.content !== current.saved && !(await save())) return;
    let documentPreviewUrl = current.documentPreviewUrl;
    if (current.format?.editor === "html") {
      if (!root) return;
      setLoadingPreviewPath(current.path);
      try {
        documentPreviewUrl = await desktop.startPreview(
          root,
          current.path,
          current.content,
        );
      } catch (cause) {
        setLoadingPreviewPath(undefined);
        onError(`无法启动 HTML 预览：${String(cause)}`);
        return;
      }
    }
    if (!current.previewMode) editorRef.current = null;
    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        tab.path === current.path
          ? { ...tab, documentPreviewUrl, previewMode: true }
          : tab,
      ),
    );
  };
  const refreshHtmlPreview = async () => {
    if (
      !root ||
      !current ||
      !current.previewMode ||
      current.format?.editor !== "html" ||
      refreshingPreview
    )
      return;
    setRefreshingPreview(true);
    setLoadingPreviewPath(current.path);
    try {
      const url = await desktop.startPreview(
        root,
        current.path,
        current.content,
      );
      setTabs((currentTabs) =>
        currentTabs.map((tab) =>
          tab.path === current.path
            ? {
                ...tab,
                documentPreviewUrl: `${url}?reload=${Date.now()}`,
              }
            : tab,
        ),
      );
    } catch (cause) {
      setLoadingPreviewPath(undefined);
      setRefreshingPreview(false);
      onError(`无法刷新 HTML 预览：${String(cause)}`);
    }
  };
  const openHtmlPreviewInBrowser = async () => {
    const url = current?.documentPreviewUrl;
    if (!url) return;
    try {
      await desktop.openExternalUrl(url, settings.browserId);
    } catch (cause) {
      onError(
        `${en ? "Unable to open HTML preview" : "无法在浏览器中打开 HTML 预览"}：${String(cause)}`,
      );
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
    setContextMenu({
      entry,
      x: Math.max(6, Math.min(localX, availableWidth - 224)),
      y: Math.max(6, Math.min(localY, availableHeight - 196)),
    });
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
        currentTabs.filter((tab) => {
          const removed = pathIsWithin(tab.path, deletedPath);
          if (removed && tab.previewUrl) {
            URL.revokeObjectURL(tab.previewUrl);
            previewUrls.current.delete(tab.previewUrl);
          }
          return !removed;
        }),
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
  if (review)
    return (
      <aside className="inspector-panel" ref={inspectorRef}>
        <ReviewPanel
          calls={review}
          onClose={onCloseReview}
          onError={onError}
          root={root}
        />
      </aside>
    );
  return (
    <aside className="inspector-panel" ref={inspectorRef}>
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
                {tab.content !== tab.saved ? " •" : ""}
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
          {current && !current.unsupported && !current.previewKind ? (
            <div className="editor-floating-actions">
              {["markdown", "html"].includes(current.format?.editor ?? "") ? (
                <button
                  aria-pressed={Boolean(current.previewMode)}
                  onClick={() => void toggleDocumentPreview()}
                  title={
                    current.previewMode
                      ? t("markdownEdit")
                      : t("markdownPreview")
                  }
                  type="button"
                >
                  <i
                    aria-hidden="true"
                    className={
                      current.previewMode
                        ? "fa-regular fa-pen-to-square"
                        : "fa-regular fa-eye"
                    }
                  />
                  {current.previewMode
                    ? t("markdownEdit")
                    : t("markdownPreview")}
                </button>
              ) : null}
              {!current.previewMode ? (
                <>
                  <button
                    aria-label={t("revertFile")}
                    disabled={current.content === current.saved}
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
                  <button
                    className="primary"
                    disabled={current.content === current.saved}
                    onClick={() => void save()}
                    title={en ? "Save (Ctrl+S)" : "保存 (Ctrl+S)"}
                    type="button"
                  >
                    <i aria-hidden="true" className="fa-regular fa-floppy-disk" />
                    {t("save")}
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
          {current?.previewMode && current.format?.editor === "html" ? (
            <div className="html-preview-actions">
              <button
                aria-label={en ? "Refresh HTML preview" : "刷新 HTML 预览"}
                disabled={refreshingPreview}
                onClick={() => void refreshHtmlPreview()}
                title={en ? "Refresh HTML preview" : "刷新 HTML 预览"}
                type="button"
              >
                <i
                  aria-hidden="true"
                  className={`fa-solid fa-rotate-right${
                    refreshingPreview ? " fa-spin" : ""
                  }`}
                />
              </button>
              <button
                disabled={!current.documentPreviewUrl}
                onClick={() => void openHtmlPreviewInBrowser()}
                title={t("openInBrowser")}
                type="button"
              >
                <i
                  aria-hidden="true"
                  className="fa-solid fa-arrow-up-right-from-square"
                />
                <span>{t("openInBrowser")}</span>
              </button>
            </div>
          ) : null}
          {current?.previewKind && current.previewUrl ? (
            <MediaPreview
              byteSize={current.previewBytes}
              codec={current.previewCodec}
              kind={current.previewKind}
              name={current.path.split(/[\\/]/).pop() ?? current.path}
              path={current.path}
              url={current.previewUrl}
            />
          ) : current?.unsupported ? (
            <div className="unsupported-editor">
              <i aria-hidden="true" className="fa-regular fa-file" />
              <strong>暂不支持此文件类型</strong>
              <p>
                {current.path.split(/[\\/]/).pop()} 无法在文本编辑器中预览或编辑
              </p>
            </div>
          ) : current?.previewMode && current.format?.editor === "markdown" ? (
            <article className="markdown-file-preview message-content">
              <ReactMarkdown
                components={{
                  a: ({ children, href, ...props }) => (
                    <a
                      {...props}
                      href={href}
                      onClick={(event) => {
                        if (!href || !/^https?:\/\//i.test(href)) return;
                        event.preventDefault();
                        void desktop
                          .openExternalUrl(href, settings.browserId)
                          .catch((cause) => onError(String(cause)));
                      }}
                    >
                      {children}
                    </a>
                  ),
                }}
                rehypePlugins={[rehypeKatex]}
                remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
              >
                {current.content}
              </ReactMarkdown>
            </article>
          ) : current?.previewMode && current.format?.editor === "html" ? (
            <div className="html-preview-stage">
              <iframe
                className="html-file-preview"
                onError={() => {
                  setLoadingPreviewPath(undefined);
                  setRefreshingPreview(false);
                }}
                onLoad={() => {
                  setLoadingPreviewPath((path) =>
                    path === current.path ? undefined : path,
                  );
                  setRefreshingPreview(false);
                }}
                sandbox="allow-scripts"
                src={current.documentPreviewUrl}
                title={`${current.path.split(/[\\/]/).pop() ?? current.path} HTML preview`}
              />
              {loadingPreviewPath === current.path ? (
                <div
                  aria-label={en ? "Loading HTML preview" : "正在加载 HTML 预览"}
                  className="html-preview-loading"
                  role="status"
                >
                  <span className="html-preview-loader" />
                  <span>{en ? "Loading preview…" : "正在加载预览…"}</span>
                </div>
              ) : null}
            </div>
          ) : current ? (
            <>
              <Editor
                beforeMount={defineAgentKTheme}
                height="100%"
                language={current.format?.monacoLanguage ?? languageFor(current.path)}
                onChange={(value) => update(value ?? "")}
                onMount={(editor, monaco) => {
                  editorRef.current = editor;
                  const unregisterResponsiveLayout =
                    registerResponsiveMonacoEditor(editor);
                  applyAgentKTheme(editor, monaco);
                  editor.onContextMenu((event) => {
                    editorContextMenuLine.current = event.target.position?.lineNumber;
                  });
                  editor.addAction({
                    contextMenuGroupId: "navigation",
                    contextMenuOrder: 1.25,
                    id: "agent-k-add-line-to-conversation",
                    label: en
                      ? "Add this line to conversation"
                      : "添加本行到对话",
                    run: (sourceEditor) => {
                      const path = activePathRef.current;
                      const line =
                        editorContextMenuLine.current ??
                        sourceEditor.getPosition()?.lineNumber;
                      editorContextMenuLine.current = undefined;
                      if (!path || !line) return;
                      window.dispatchEvent(
                        new CustomEvent("agent-k-add-line-reference", {
                          detail: { line, path },
                        }),
                      );
                    },
                  });
                  editor.onDidDispose(() => {
                    unregisterResponsiveLayout();
                    if (editorRef.current === editor) editorRef.current = null;
                  });
                  requestAnimationFrame(() => restoreEditorView(current.path, editor));
                }}
                options={{
                  automaticLayout: false,
                  inertialScroll: true,
                  minimap: { enabled: false },
                  mouseWheelScrollSensitivity: 1.5,
                  scrollbar: {
                    alwaysConsumeMouseWheel: false,
                    handleMouseWheel: true,
                  },
                  smoothScrolling: true,
                  wordWrap: settings.editorWordWrap ? "on" : "off",
                }}
                path={
                  root
                    ? absoluteWorkspacePath(root, current.path)
                    : current.path
                }
                saveViewState
                theme={editorTheme}
                value={current.content}
              />
            </>
          ) : (
            <p className="empty-editor">从左侧打开一个文件</p>
          )}
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
          {(() => {
            const plugin = resolveFileFormat(contextMenu.entry.path, fileFormatPlugins);
            return plugin.contextActions
              ?.filter((action) => !action.when || action.when === "both" || (action.when === "directory") === contextMenu.entry.isDir)
              .map((action) => (
                <button
                  key={`${plugin.id}:${action.id}`}
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent("agent-k-file-format-context-action", {
                      detail: { action: action.id, path: contextMenu.entry.path, pluginId: plugin.id },
                    }));
                    setContextMenu(undefined);
                  }}
                  role="menuitem"
                  type="button"
                >
                  <i className="fa-solid fa-puzzle-piece" />
                  {action.label}
                </button>
              ));
          })()}
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
