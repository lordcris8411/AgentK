import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  desktop,
  type EditorPluginDependency,
  type EditorPluginRuntime,
  type FileFormatPluginResource,
} from "../../lib/desktop";

const EDITOR_API_VERSION = 1;
const EDITOR_CHANNEL = "agent-k-editor";
const runtimeCache = new Map<string, Promise<EditorPluginRuntime>>();
const dependencyCache = new Map<string, Promise<EditorPluginDependency>>();

type PluginMessage = {
  apiVersion?: unknown;
  channel?: unknown;
  nonce?: unknown;
  requestId?: unknown;
  type?: unknown;
  value?: unknown;
};

export type PluginEditorHandle = {
  executeAction(action: string, parameters?: Record<string, unknown>): void;
  focus(): void;
  markSaved(content: string): void;
  navigate(line: number, column?: number): void;
  readContent(): Promise<string>;
  setContent(content: string): void;
};

type PluginEditorFrameProps = {
  actions?: Array<{
    id: string;
    parameters?: Record<string, unknown>;
  }>;
  absolutePath: string;
  binary?: ArrayBuffer;
  byteSize?: number;
  codec?: string;
  content: string;
  language: string;
  locale: "en-US" | "zh-CN";
  mimeType: string;
  onDirtyChange(dirty: boolean): void;
  onContentChange(content: string): void;
  onError(message: string): void;
  onReferenceLine(line: number, column: number): void;
  onSaveRequest(content: string): void;
  path: string;
  plugin: Pick<FileFormatPluginResource, "id" | "mediaKind" | "name"> & {
    scope?: FileFormatPluginResource["scope"];
  };
  readOnly?: boolean;
  root: string;
  theme: "light" | "dark";
  wordWrap: boolean;
};

function escapeInline(value: string, closingTag: "script" | "style"): string {
  return value.replace(new RegExp(`</${closingTag}`, "gi"), `<\\/${closingTag}`);
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function runtimeFor(
  root: string,
  plugin: Pick<FileFormatPluginResource, "id"> & { scope?: FileFormatPluginResource["scope"] },
): Promise<EditorPluginRuntime> {
  const key = plugin.scope === "builtin" ? `builtin\0${plugin.id}` : `${root}\0${plugin.id}`;
  const cached = runtimeCache.get(key);
  if (cached) return cached;
  const pending = desktop.editorPluginRuntime(root, plugin.id).catch((cause) => {
    runtimeCache.delete(key);
    throw cause;
  });
  runtimeCache.set(key, pending);
  return pending;
}

function dependencyFor(dependencyId: string): Promise<EditorPluginDependency> {
  const cached = dependencyCache.get(dependencyId);
  if (cached) return cached;
  const pending = desktop.editorPluginDependency(dependencyId).catch((cause) => {
      dependencyCache.delete(dependencyId);
      throw cause;
    });
  dependencyCache.set(dependencyId, pending);
  return pending;
}

export function preloadEditorPluginDependencies(
  plugins: readonly Pick<FileFormatPluginResource, "runtime">[],
): void {
  const dependencies = new Set(
    plugins.flatMap((plugin) => plugin.runtime.dependencies ?? []),
  );
  if (!dependencies.size) return;
  window.setTimeout(() => {
    for (const dependencyId of dependencies)
      void dependencyFor(dependencyId).catch(() => undefined);
  }, 250);
}

export const PluginEditorFrame = forwardRef<PluginEditorHandle, PluginEditorFrameProps>(
  function PluginEditorFrame(
    {
      actions = [],
      absolutePath,
      content,
      binary,
      byteSize,
      codec,
      language,
      locale,
      mimeType,
      onDirtyChange,
      onContentChange,
      onError,
      onReferenceLine,
      onSaveRequest,
      path,
      plugin,
      readOnly = false,
      root,
      theme,
      wordWrap,
    },
    forwardedRef,
  ) {
    const frameRef = useRef<HTMLIFrameElement>(null);
    const initializedDocumentRef = useRef<string | undefined>(undefined);
    const nonceRef = useRef(crypto.randomUUID());
    const pendingReads = useRef(new Map<string, (content: string) => void>());
    const [frameUrl, setFrameUrl] = useState<string>();
    const [ready, setReady] = useState(false);
    const [loadError, setLoadError] = useState<string>();
    const serializedActions = JSON.stringify(actions);

    const send = (type: string, value?: unknown, requestId?: string) => {
      frameRef.current?.contentWindow?.postMessage({
        apiVersion: EDITOR_API_VERSION,
        channel: EDITOR_CHANNEL,
        nonce: nonceRef.current,
        requestId,
        type,
        value,
      }, "*");
    };

    const documentIdentity = `${plugin.id}\0${absolutePath}`;
    const initialize = () => {
      initializedDocumentRef.current = documentIdentity;
      send("initialize", {
        absolutePath,
        binary,
        byteSize,
        codec,
        content,
        fileName: path.split(/[\\/]/).pop() ?? path,
        language,
        locale,
        mediaKind: plugin.mediaKind,
        mimeType,
        path,
        readOnly,
        theme,
        wordWrap,
      });
    };

    useEffect(() => {
      let disposed = false;
      let htmlUrl: string | undefined;
      initializedDocumentRef.current = undefined;
      setFrameUrl(undefined);
      setLoadError(undefined);
      setReady(false);
      void runtimeFor(root, plugin)
        .then(async (runtime) => {
          const dependencies = await Promise.all(runtime.dependencies.map(dependencyFor));
          if (disposed) return;
          const serializedDependencies = escapeInline(JSON.stringify(dependencies), "script");
          const serializedRuntime = escapeInline(JSON.stringify({
            assets: runtime.assets,
            javascript: runtime.javascript,
          }), "script");
          const html = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src agentk-editor:; script-src 'unsafe-inline' agentk-editor: blob:; style-src 'unsafe-inline' agentk-editor:; font-src data: blob:; img-src agentk-file: data: blob: https: http:; media-src blob:; frame-src 'self' blob:; worker-src blob:;">
${dependencies.map((dependency) => `<link rel="stylesheet" href="${escapeAttribute(dependency.cssUrl)}">`).join("\n")}
<style>${escapeInline(runtime.css, "style")}</style></head>
<body><div id="agent-k-editor-root"></div>
<script>
const reportRuntimeError = (value) => parent.postMessage({
    apiVersion: 1,
    channel: "agent-k-editor",
    type: "runtime-error",
    value: value instanceof Error ? value.message : String(value),
  }, "*");
addEventListener("error", (event) => reportRuntimeError(event.error ?? event.message));
addEventListener("unhandledrejection", (event) => reportRuntimeError(event.reason));
</script>
<script>
void (async () => {
  const dependencyRuntimes = ${serializedDependencies};
  const runtime = ${serializedRuntime};
  const urls = [];
  const prepare = (bundle) => {
    let source = bundle.javascript;
    for (const [name, assetSource] of Object.entries(bundle.assets)) {
      const url = URL.createObjectURL(new Blob([assetSource], { type: "text/javascript" }));
      urls.push(url);
      source = source.replaceAll("/assets/" + name, url);
      source = source.replaceAll("assets/" + name, url);
    }
    return source;
  };
  const executeUrl = (url) => new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", () => reject(new Error("Editor runtime script could not be loaded")), { once: true });
    document.body.append(script);
  });
  const execute = (source) => {
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    urls.push(url);
    return executeUrl(url);
  };
  for (const dependency of dependencyRuntimes) {
    await executeUrl(dependency.javascriptUrl);
  }
  await execute(prepare(runtime));
  addEventListener("beforeunload", () => urls.forEach((url) => URL.revokeObjectURL(url)));
})().catch((cause) => reportRuntimeError(cause));
</script></body></html>`;
          htmlUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));
          setFrameUrl(htmlUrl);
        })
        .catch((cause: unknown) => {
          if (disposed) return;
          const message = cause instanceof Error ? cause.message : String(cause);
          setLoadError(message);
          onError(message);
        });
      return () => {
        disposed = true;
        if (htmlUrl) URL.revokeObjectURL(htmlUrl);
      };
    }, [plugin.id, plugin.scope, root]);

    useEffect(() => {
      if (!frameUrl || ready || loadError) return;
      const timeout = window.setTimeout(() => {
        const error = locale === "en-US"
          ? `The Editor plugin '${plugin.name}' did not become ready`
          : `编辑器插件“${plugin.name}”未能完成初始化`;
        setLoadError(error);
        onError(error);
      }, 20_000);
      return () => window.clearTimeout(timeout);
    }, [frameUrl, loadError, locale, onError, plugin.name, ready]);

    useEffect(() => {
      const receive = (event: MessageEvent<PluginMessage>) => {
        if (event.source !== frameRef.current?.contentWindow) return;
        const message = event.data;
        if (
          !message ||
          message.channel !== EDITOR_CHANNEL ||
          message.apiVersion !== EDITOR_API_VERSION
        ) return;
        if (message.type === "booted") {
          initialize();
          return;
        }
        if (message.type === "load-error") {
          const error = locale === "en-US"
            ? "The Editor plugin could not be executed"
            : "编辑器插件无法执行";
          setLoadError(error);
          onError(error);
          return;
        }
        if (message.type === "runtime-error") {
          const detail = typeof message.value === "string" ? message.value : "Unknown runtime error";
          const error = locale === "en-US"
            ? `The Editor plugin failed: ${detail}`
            : `编辑器插件运行失败：${detail}`;
          setLoadError(error);
          onError(error);
          return;
        }
        if (message.nonce !== nonceRef.current) return;
        switch (message.type) {
          case "content": {
            if (typeof message.requestId !== "string" || typeof message.value !== "string") return;
            const resolve = pendingReads.current.get(message.requestId);
            pendingReads.current.delete(message.requestId);
            resolve?.(message.value);
            break;
          }
          case "content-change":
            if (typeof message.value === "string") onContentChange(message.value);
            break;
          case "dirty":
            if (typeof message.value === "boolean") onDirtyChange(message.value);
            break;
          case "error":
            if (typeof message.value === "string") onError(message.value);
            break;
          case "ready":
            setReady(true);
            break;
          case "reference-line": {
            const target = message.value as { column?: unknown; line?: unknown };
            if (typeof target?.line === "number")
              onReferenceLine(target.line, typeof target.column === "number" ? target.column : 1);
            break;
          }
          case "request-save":
            if (typeof message.value === "string") onSaveRequest(message.value);
            break;
          default:
            break;
        }
      };
      window.addEventListener("message", receive);
      return () => window.removeEventListener("message", receive);
    }, [absolutePath, binary, byteSize, codec, content, language, locale, mimeType, onContentChange, onDirtyChange, onError, onReferenceLine, onSaveRequest, path, plugin.mediaKind, readOnly, theme, wordWrap]);

    useEffect(() => {
      if (
        !ready ||
        loadError ||
        initializedDocumentRef.current === documentIdentity
      ) return;
      initialize();
    }, [absolutePath, binary, byteSize, codec, content, documentIdentity, language, loadError, locale, mimeType, path, plugin.mediaKind, readOnly, ready, theme, wordWrap]);

    useEffect(() => {
      const action = (event: Event) => {
        const detail = (event as CustomEvent<Record<string, unknown>>).detail;
        if (!detail || typeof detail.action !== "string") return;
        if (typeof detail.pluginId === "string" && detail.pluginId !== plugin.id) return;
        if (typeof detail.path === "string" && detail.path !== path) return;
        send("action", { id: detail.action, parameters: detail });
      };
      window.addEventListener("agent-k-file-format-action", action);
      return () => window.removeEventListener("agent-k-file-format-action", action);
    }, [path, plugin.id]);

    useEffect(() => {
      const layout = (event: Event) => {
        const suspended = (event as CustomEvent<boolean>).detail;
        if (typeof suspended === "boolean") send("set-layout-suspended", suspended);
      };
      window.addEventListener("agent-k-editor-layout-suspended", layout);
      return () => window.removeEventListener("agent-k-editor-layout-suspended", layout);
    }, []);

    useEffect(() => {
      if (ready) send("set-theme", theme);
    }, [ready, theme]);
    useEffect(() => {
      if (ready) send("set-word-wrap", wordWrap);
    }, [ready, wordWrap]);
    useEffect(() => {
      if (!ready) return;
      for (const action of actions)
        send("action", { id: action.id, parameters: action.parameters ?? {} });
    }, [ready, serializedActions]);

    useImperativeHandle(forwardedRef, () => ({
      executeAction(action, parameters = {}) {
        send("action", { id: action, parameters });
      },
      focus() {
        send("focus");
      },
      markSaved(savedContent) {
        send("mark-saved", savedContent);
      },
      navigate(line, column = 1) {
        send("navigate", { column, line });
      },
      readContent() {
        const requestId = crypto.randomUUID();
        return new Promise<string>((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            pendingReads.current.delete(requestId);
            reject(new Error("Editor plugin did not return its content"));
          }, 5_000);
          pendingReads.current.set(requestId, (value) => {
            window.clearTimeout(timeout);
            resolve(value);
          });
          send("read-content", undefined, requestId);
        });
      },
      setContent(nextContent) {
        send("set-content", nextContent);
      },
    }), []);

    return (
      <div className="plugin-editor-stage">
        {frameUrl ? (
          <iframe
            className="plugin-editor-frame"
            ref={frameRef}
            sandbox="allow-scripts"
            src={frameUrl}
            title={`${plugin.name}: ${path}`}
          />
        ) : null}
        {!ready && !loadError ? (
          <div className="plugin-editor-loading" role="status">
            <span className="html-preview-loader" />
            <span>{locale === "en-US" ? "Loading editor…" : "正在加载编辑器…"}</span>
          </div>
        ) : null}
        {loadError ? <div className="plugin-editor-error">{loadError}</div> : null}
      </div>
    );
  },
);
