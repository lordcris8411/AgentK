import { existsSync, readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  net,
  nativeTheme,
  protocol,
  session,
  shell,
  type OpenDialogOptions,
  type Rectangle,
} from "electron";
import { DesktopBackend } from "./backend.js";
import { editorPluginDependencyFilePath } from "./file-formats.js";
import { loadClientSettings } from "./settings.js";
import { resolveTheme, type ThemeDefinition } from "./themes.js";
import type { ClientSettings, JsonObject } from "./types.js";
import { asObject, errorMessage } from "./utils.js";
import {
  resizedWindowBounds,
  usesManualWindowResize,
  type ResizeDirection,
} from "./window-resize.js";

if (
  process.platform === "linux" &&
  (process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland" || process.env.WAYLAND_DISPLAY)
) {
  // Chromium's wp_color_manager_v1 integration currently retries unsupported
  // image-description transfers whenever a BrowserWindow surface changes.
  // Opening/resizing the project console therefore floods stderr on affected
  // compositors. Keep native Wayland and GPU acceleration, but use Chromium's
  // normal sRGB path until that optional protocol interoperates reliably.
  const feature = "WaylandWpColorManagerV1";
  const disabledFeatures = app.commandLine
    .getSwitchValue("disable-features")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!disabledFeatures.includes(feature)) {
    app.commandLine.appendSwitch(
      "disable-features",
      [...disabledFeatures, feature].join(","),
    );
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "agentk-file",
    privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true },
  },
  {
    scheme: "agentk-editor",
    privileges: {
      codeCache: true,
      corsEnabled: true,
      secure: true,
      standard: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

const e2eDataPath = process.env.AGENT_K_E2E === "1" && process.env.AGENT_K_E2E_USER_DATA && isAbsolute(process.env.AGENT_K_E2E_USER_DATA)
  ? resolve(process.env.AGENT_K_E2E_USER_DATA) : undefined;
const legacyDataPath = e2eDataPath ?? (process.platform === "linux"
    ? join(
        process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? app.getPath("home"), ".local", "share"),
        "com.lordcris8411.agentk",
      )
    : join(app.getPath("appData"), "com.lordcris8411.agentk"));
mkdirSync(legacyDataPath, { recursive: true });
app.setPath("userData", legacyDataPath);

let mainWindow: BrowserWindow | undefined;
let splashWindow: BrowserWindow | undefined;
let debugWindow: BrowserWindow | undefined;
let mainWindowReady = false;
let startupFinished = false;
type DebugToolKind = "disassembly" | "memory" | "registers";
const debugToolWindows = new Map<DebugToolKind, BrowserWindow>();
const floatingEditorWindows = new Map<string, BrowserWindow>();
let debugToolWindowBoundsState: Partial<Record<DebugToolKind, Rectangle>> | undefined;
let debugToolWindowBoundsTimer: ReturnType<typeof setTimeout> | undefined;
let debugRoot: string | undefined;
let debugWindowBackground = "#1f1f1f";
const previousDebugStates = new Map<string, string | undefined>();
let backend: DesktopBackend | undefined;
let backendReady: Promise<void> | undefined;
let quitting = false;
let shutdownComplete = false;
let shutdownStarted = false;
const ASSISTANT_STREAM_FRAME_MS = 16;
const pendingAssistantEvents = new Map<string, {
  event: JsonObject;
  timer: NodeJS.Timeout;
}>();

function sendRendererEvent(event: JsonObject): void {
  if (quitting) return;
  for (const window of [mainWindow, debugWindow, ...debugToolWindows.values()])
    if (window && !window.webContents.isDestroyed()) window.webContents.send("agent-k:pi-event", event);
}

function sendProjectConsoleEvent(event: JsonObject): void {
  if (quitting || !mainWindow || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send("agent-k:project-console-event", event);
}

function flushAssistantEvent(key: string): void {
  const pending = pendingAssistantEvents.get(key);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingAssistantEvents.delete(key);
  sendRendererEvent(pending.event);
}

function bringDebugWindowToFront(): void {
  const window = debugWindow;
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  if (process.platform === "linux") window.setVisibleOnAllWorkspaces(true);
  // Reasserting the flag creates a fresh compositor stacking request. Merely
  // setting true again is ignored by some Wayland compositors.
  window.setAlwaysOnTop(false);
  window.setAlwaysOnTop(true, "floating");
  window.show();
  try {
    if (mainWindow && !mainWindow.isDestroyed()) window.moveAbove(mainWindow.getMediaSourceId());
  } catch { /* Some Wayland compositors do not expose a movable media source. */ }
  window.moveTop();
  window.focus();
  if (process.platform === "linux") setTimeout(() => {
    if (!window.isDestroyed()) window.setVisibleOnAllWorkspaces(false);
  }, 250);
}

function emitBackendEvent(event: JsonObject): void {
  if (event.type === "debug_session" && typeof event.packId === "string") {
    const packId = event.packId;
    const snapshot = asObject(event.snapshot);
    const state = typeof snapshot.state === "string" ? snapshot.state : undefined;
    const stopReason = typeof snapshot.stopReason === "string" ? snapshot.stopReason : "";
    const stopReasonKind = typeof snapshot.stopReasonKind === "string" ? snapshot.stopReasonKind : "";
    const sessionKey = `${packId}:${typeof event.sessionId === "string" ? event.sessionId : "default"}`;
    const breakpointHit = state === "stopped" && previousDebugStates.get(sessionKey) !== "stopped" && (stopReasonKind === "breakpoint" || /breakpoint/i.test(stopReason));
    previousDebugStates.set(sessionKey, state);
    if (breakpointHit) {
      if (debugWindow && !debugWindow.isDestroyed()) debugWindow.webContents.send("agent-k:debug-provider-hit", packId);
      bringDebugWindowToFront();
    }
  }
  const runtimeKey = typeof event.runtimeId === "string"
    ? event.runtimeId
    : "__default__";
  const message = asObject(event.message);
  if (event.type === "message_update" && message.role === "assistant") {
    const existing = pendingAssistantEvents.get(runtimeKey);
    if (existing) {
      existing.event = event;
      return;
    }
    pendingAssistantEvents.set(runtimeKey, {
      event,
      timer: setTimeout(
        () => flushAssistantEvent(runtimeKey),
        ASSISTANT_STREAM_FRAME_MS,
      ),
    });
    return;
  }
  // Preserve event ordering at phase boundaries: the latest assistant payload
  // reaches the renderer before message_end, tool execution, or settle events.
  flushAssistantEvent(runtimeKey);
  sendRendererEvent(event);
}

type PreviewConsoleEntry = {
  column?: number;
  frameUrl?: string;
  level: "debug" | "error" | "info" | "log" | "warning";
  line?: number;
  text: string;
  timestamp: number;
};
const previewConsoleEntries: PreviewConsoleEntry[] = [];
const previewConsoleFrames = new Map<string, string>();
const previewConsoleContexts = new Map<number, string>();
const PREVIEW_CONSOLE_LIMIT = 500;

type ResizeState = {
  bounds: Rectangle;
  direction: ResizeDirection;
  startX: number;
  startY: number;
};
let resizeState: ResizeState | undefined;
let splashState: {
  current: number;
  message: string;
  theme: string;
  total: number;
} | undefined;
let splashTheme: ThemeDefinition | undefined;

function projectPath(...parts: string[]): string {
  return join(app.getAppPath(), ...parts);
}

function bundledPiNodeExecutable(): string {
  if (!app.isPackaged || process.platform !== "darwin") return process.execPath;
  const executable = basename(process.execPath);
  return join(
    process.resourcesPath,
    "..",
    "Frameworks",
    `${executable} Helper.app`,
    "Contents",
    "MacOS",
    `${executable} Helper`,
  );
}

function firstPartyEditorExtensionsPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "editor", "extensions")
    : projectPath("editor", "extensions");
}

/** Native language workers are extension packages too. The desktop host sees
 * only this package root; manifests select and describe every worker. */
function firstPartyLanguagePacksPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "language-packs")
    : projectPath("language-packs");
}

function resolvedAppearanceTheme(
  theme: ClientSettings["theme"],
): "light" | "soft-light" | "dark" {
  if (theme === "system") return nativeTheme.shouldUseDarkColors ? "dark" : "light";
  return theme === "light" || theme === "soft-light" || theme === "dark" ? theme : "light";
}

function initialThemePayload(
  fallback: "light" | "soft-light" | "dark",
  theme?: ThemeDefinition,
): string {
  return JSON.stringify({
    base: theme?.base ?? fallback,
    colors: theme?.colors ?? {},
    components: theme?.components ?? {},
    fonts: theme?.fonts,
  });
}

function createWindows(theme: ClientSettings["theme"], resolvedTheme?: ThemeDefinition): void {
  const preload = projectPath("electron", "preload.cjs");
  const appearance = resolvedAppearanceTheme(theme);
  const initialTheme = initialThemePayload(appearance, resolvedTheme);
  debugWindowBackground = resolvedTheme?.colors["surface-app"] ?? (appearance === "dark" ? "#1f1f1f" : appearance === "soft-light" ? "#dedad4" : "#f4f2ee");
  mainWindow = new BrowserWindow({
    title: "Agent K",
    width: 1600,
    height: 920,
    minWidth: 1372,
    minHeight: 640,
    frame: false,
    show: false,
    backgroundColor: resolvedTheme?.colors["surface-app"] ?? (appearance === "dark" ? "#1f1f1f" : appearance === "soft-light" ? "#dedad4" : "#f4f2ee"),
    icon: projectPath("assets", "icons", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      devTools: !app.isPackaged,
      nodeIntegration: false,
      preload,
      sandbox: true,
      spellcheck: true,
      webSecurity: true,
    },
  });
  mainWindow.once("ready-to-show", () => {
    mainWindowReady = true;
    revealMainWindow();
  });
  splashWindow = new BrowserWindow({
    title: "Agent K",
    width: 388,
    height: 162,
    resizable: false,
    center: true,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devUrl = process.env.AGENT_K_DEV_URL;
  if (devUrl) {
    const mainUrl = new URL(devUrl);
    mainUrl.searchParams.set("initial-theme", initialTheme);
    const splashUrl = new URL("/splashscreen.html", devUrl);
    splashUrl.searchParams.set("initial-theme", initialTheme);
    void mainWindow.loadURL(mainUrl.toString());
    void splashWindow.loadURL(splashUrl.toString());
  } else {
    void mainWindow.loadFile(projectPath("dist", "index.html"), { query: { "initial-theme": initialTheme } });
    void splashWindow.loadFile(projectPath("dist", "splashscreen.html"), { query: { "initial-theme": initialTheme } });
  }
  splashWindow.once("ready-to-show", () => splashWindow?.show());
  splashWindow.webContents.on("did-finish-load", applySplashState);

  const floatingEditorFrame = /^agent-k-floating-editor-[0-9a-f-]{36}$/i;
  mainWindow.webContents.setWindowOpenHandler(({ frameName, url }) => {
    if (url === "about:blank" && floatingEditorFrame.test(frameName)) {
      return {
        action: "allow",
        outlivesOpener: false,
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          backgroundColor: debugWindowBackground,
          frame: false,
          icon: projectPath("assets", "icons", "icon.png"),
          minHeight: 360,
          minWidth: 560,
          title: "Agent K · Editor",
        },
      };
    }
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("did-create-window", (child, details) => {
    if (!floatingEditorFrame.test(details.frameName)) return;
    const id = details.frameName.slice("agent-k-floating-editor-".length).toLowerCase();
    floatingEditorWindows.set(id, child);
    if (mainWindow && !mainWindow.isDestroyed()) child.setParentWindow(mainWindow);
    child.once("closed", () => {
      if (floatingEditorWindows.get(id) === child) floatingEditorWindows.delete(id);
    });
    child.setMenuBarVisibility(false);
    child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    child.webContents.on("will-navigate", (event, url) => {
      if (url !== "about:blank") event.preventDefault();
    });
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const current = mainWindow?.webContents.getURL();
    if (current && current !== "about:blank" && url !== current) event.preventDefault();
  });
  if (!app.isPackaged) {
    mainWindow.webContents.on("console-message", (details) => {
      if (details.level === "error")
        console.error(`[Renderer] ${details.message} (${details.sourceId}:${details.lineNumber})`);
    });
  }
  mainWindow.on("resize", notifyWindowState);
  mainWindow.on("maximize", notifyWindowState);
  mainWindow.on("unmaximize", notifyWindowState);
  mainWindow.on("closed", () => {
    mainWindow = undefined;
    if (!quitting) app.quit();
  });
  // Electron's debugger API and Playwright both attach to the renderer through
  // the DevTools protocol; keep the production console bridge out of E2E runs.
  // Attaching while the BrowserWindow is still replacing its initial
  // about:blank renderer can race Electron's sandbox bootstrap on Windows.
  // Wait for the application document so startupData belongs to a committed
  // renderer before enabling the preview-console domains.
  if (process.env.AGENT_K_E2E !== "1") {
    mainWindow.webContents.once("did-finish-load", () => {
      const window = mainWindow;
      if (window && !window.isDestroyed()) enablePreviewConsole(window);
    });
  }
}

function loadDebugWindow(root: string, contextFile?: string): void {
  if (!debugWindow) return;
  const initialTheme = initialThemePayload(splashTheme?.base ?? "light", splashTheme);
  const devUrl = process.env.AGENT_K_DEV_URL;
  if (devUrl) {
    const url = new URL(devUrl);
    url.searchParams.set("initial-theme", initialTheme);
    url.searchParams.set("window", "debug");
    url.searchParams.set("root", root);
    if (contextFile) url.searchParams.set("context-file", contextFile);
    void debugWindow.loadURL(url.toString());
  } else {
    void debugWindow.loadFile(projectPath("dist", "index.html"), { query: { "initial-theme": initialTheme, root, ...(contextFile ? { "context-file": contextFile } : {}), window: "debug" } });
  }
}

function debugToolStatePath(): string {
  return join(app.getPath("userData"), "debug-tool-windows.json");
}

function debugToolBounds(kind: DebugToolKind): Rectangle | undefined {
  if (debugToolWindowBoundsState) return debugToolWindowBoundsState[kind];
  try {
    const source = JSON.parse(readFileSync(debugToolStatePath(), "utf8")) as Record<string, unknown>;
    debugToolWindowBoundsState = {};
    for (const candidate of ["memory", "registers", "disassembly"] as DebugToolKind[]) {
      const value = asObject(source[candidate]);
      const width = Number(value.width);
      const height = Number(value.height);
      const x = Number(value.x);
      const y = Number(value.y);
      if ([width, height, x, y].every(Number.isFinite) && width >= 420 && height >= 280)
        debugToolWindowBoundsState[candidate] = { width, height, x, y };
    }
  } catch { debugToolWindowBoundsState = {}; }
  return debugToolWindowBoundsState[kind];
}

function saveDebugToolBounds(kind: DebugToolKind, window: BrowserWindow): void {
  if (window.isDestroyed() || window.isMinimized() || window.isMaximized()) return;
  debugToolWindowBoundsState ??= {};
  debugToolWindowBoundsState[kind] = window.getBounds();
  if (debugToolWindowBoundsTimer) clearTimeout(debugToolWindowBoundsTimer);
  debugToolWindowBoundsTimer = setTimeout(() => {
    debugToolWindowBoundsTimer = undefined;
    void writeFile(debugToolStatePath(), JSON.stringify(debugToolWindowBoundsState), "utf8").catch(() => undefined);
  }, 150);
}

function openDebugToolWindow(kind: DebugToolKind, target: string | undefined, packId: string, sessionId?: string): void {
  const owner = debugWindow;
  if (!owner || owner.isDestroyed() || !debugRoot) throw new Error("The Debug window is unavailable");
  const existing = debugToolWindows.get(kind);
  if (existing && !existing.isDestroyed()) {
    existing.webContents.send("agent-k:debug-tool-provider", packId);
    existing.webContents.send("agent-k:debug-tool-session", sessionId);
    if (target) existing.webContents.send("agent-k:debug-tool-target", target);
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.moveTop();
    existing.focus();
    return;
  }
  const labels: Record<DebugToolKind, string> = { disassembly: "Disassembly", memory: "Memory", registers: "Registers" };
  const bounds = debugToolBounds(kind);
  const window = new BrowserWindow({
    ...(bounds ?? { width: 820, height: 560 }),
    parent: owner,
    title: `Agent K — ${labels[kind]}`,
    minWidth: 420,
    minHeight: 280,
    show: false,
    backgroundColor: debugWindowBackground,
    icon: projectPath("assets", "icons", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      devTools: !app.isPackaged,
      nodeIntegration: false,
      preload: projectPath("electron", "preload.cjs"),
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
    },
  });
  debugToolWindows.set(kind, window);
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const current = window.webContents.getURL();
    if (current && current !== "about:blank" && url !== current) event.preventDefault();
  });
  window.once("ready-to-show", () => { window.show(); window.focus(); });
  window.on("resize", () => saveDebugToolBounds(kind, window));
  window.on("move", () => saveDebugToolBounds(kind, window));
  window.on("closed", () => debugToolWindows.delete(kind));
  const initialTheme = initialThemePayload(splashTheme?.base ?? "light", splashTheme);
  const query = { "initial-theme": initialTheme, "language-pack": packId, root: debugRoot, ...(sessionId ? { "session-id": sessionId } : {}), ...(target ? { target } : {}), tool: kind, window: "debug-tool" };
  const devUrl = process.env.AGENT_K_DEV_URL;
  if (devUrl) {
    const url = new URL(devUrl);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    void window.loadURL(url.toString());
  } else void window.loadFile(projectPath("dist", "index.html"), { query });
}

function openDebugWindow(root: string, contextFile?: string): void {
  const owner = mainWindow;
  if (!owner || owner.isDestroyed()) throw new Error("The main window is unavailable");
  debugRoot = root;
  if (debugWindow && !debugWindow.isDestroyed()) {
    debugWindow.webContents.send("agent-k:debug-root", root);
    debugWindow.webContents.send("agent-k:debug-context", { root, ...(contextFile ? { contextFile } : {}) });
    if (debugWindow.isMinimized()) debugWindow.restore();
    debugWindow.setAlwaysOnTop(true);
    debugWindow.show();
    debugWindow.moveTop();
    debugWindow.focus();
    return;
  }
  debugWindow = new BrowserWindow({
    alwaysOnTop: true,
    parent: owner,
    title: "Agent K — Debug",
    width: 1040,
    height: 720,
    minWidth: 680,
    minHeight: 420,
    show: false,
    backgroundColor: debugWindowBackground,
    icon: projectPath("assets", "icons", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      devTools: !app.isPackaged,
      nodeIntegration: false,
      preload: projectPath("electron", "preload.cjs"),
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
    },
  });
  debugWindow.setMenuBarVisibility(false);
  debugWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  debugWindow.webContents.on("will-navigate", (event, url) => {
    const current = debugWindow?.webContents.getURL();
    if (current && current !== "about:blank" && url !== current) event.preventDefault();
  });
  debugWindow.once("ready-to-show", () => {
    debugWindow?.setAlwaysOnTop(true);
    debugWindow?.show();
    debugWindow?.moveTop();
    debugWindow?.focus();
  });
  debugWindow.on("closed", () => {
    for (const window of debugToolWindows.values()) if (!window.isDestroyed()) window.close();
    debugToolWindows.clear();
    debugWindow = undefined;
  });
  loadDebugWindow(root, contextFile);
}

function pushPreviewConsole(entry: PreviewConsoleEntry): void {
  previewConsoleEntries.push(entry);
  if (previewConsoleEntries.length > PREVIEW_CONSOLE_LIMIT)
    previewConsoleEntries.splice(0, previewConsoleEntries.length - PREVIEW_CONSOLE_LIMIT);
}

function remoteValue(value: unknown): string {
  if (!value || typeof value !== "object") return String(value ?? "");
  const remote = value as { description?: unknown; unserializableValue?: unknown; value?: unknown };
  if (typeof remote.value === "string") return remote.value;
  if (remote.value !== undefined) {
    try { return JSON.stringify(remote.value); } catch { /* use description below */ }
  }
  if (typeof remote.unserializableValue === "string") return remote.unserializableValue;
  return typeof remote.description === "string" ? remote.description : "";
}

function enablePreviewConsole(window: BrowserWindow): void {
  const debuggerApi = window.webContents.debugger;
  try {
    debuggerApi.attach("1.3");
  } catch (cause) {
    console.warn(`Preview console capture is unavailable: ${errorMessage(cause)}`);
    return;
  }
  debuggerApi.on("message", (_event, method, raw) => {
    const payload = asObject(raw);
    if (method === "Page.frameNavigated") {
      const frame = asObject(payload.frame);
      if (typeof frame.id === "string" && typeof frame.url === "string")
        previewConsoleFrames.set(frame.id, frame.url);
      return;
    }
    if (method === "Page.frameDetached") {
      if (typeof payload.frameId === "string") previewConsoleFrames.delete(payload.frameId);
      return;
    }
    if (method === "Runtime.executionContextCreated") {
      const context = asObject(payload.context);
      const auxiliary = asObject(context.auxData);
      if (typeof context.id === "number" && typeof auxiliary.frameId === "string")
        previewConsoleContexts.set(context.id, auxiliary.frameId);
      return;
    }
    if (method === "Runtime.executionContextDestroyed") {
      if (typeof payload.executionContextId === "number")
        previewConsoleContexts.delete(payload.executionContextId);
      return;
    }
    if (method === "Runtime.consoleAPICalled") {
      const frameUrl = previewConsoleFrames.get(previewConsoleContexts.get(Number(payload.executionContextId)) ?? "");
      const type = typeof payload.type === "string" ? payload.type : "log";
      pushPreviewConsole({
        frameUrl,
        level: (["debug", "error", "info", "log", "warning"] as string[]).includes(type)
          ? type as PreviewConsoleEntry["level"]
          : "log",
        text: (Array.isArray(payload.args) ? payload.args : []).map(remoteValue).join(" "),
        timestamp: typeof payload.timestamp === "number" ? Math.round(payload.timestamp) : Date.now(),
      });
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      const details = asObject(payload.exceptionDetails);
      const frameUrl = previewConsoleFrames.get(previewConsoleContexts.get(Number(details.executionContextId)) ?? "");
      pushPreviewConsole({
        column: typeof details.columnNumber === "number" ? details.columnNumber : undefined,
        frameUrl,
        level: "error",
        line: typeof details.lineNumber === "number" ? details.lineNumber : undefined,
        text: remoteValue(details.exception) || String(details.text ?? "Uncaught exception"),
        timestamp: Date.now(),
      });
    }
  });
  const rememberFrameTree = (value: unknown) => {
    const visit = (tree: unknown) => {
      const record = asObject(tree);
      const frame = asObject(record.frame);
      if (typeof frame.id === "string" && typeof frame.url === "string")
        previewConsoleFrames.set(frame.id, frame.url);
      for (const child of Array.isArray(record.childFrames) ? record.childFrames : []) visit(child);
    };
    visit(asObject(value).frameTree);
  };
  void Promise.all([
    debuggerApi.sendCommand("Page.enable"),
    debuggerApi.sendCommand("Runtime.enable"),
    debuggerApi.sendCommand("Log.enable"),
  ]).then(() => debuggerApi.sendCommand("Page.getFrameTree"))
    .then(rememberFrameTree)
    .catch((cause) => console.warn(`Preview console capture setup failed: ${errorMessage(cause)}`));
}

function previewConsoleFor(url: string, limit: number): PreviewConsoleEntry[] {
  let origin: string;
  try { origin = new URL(url).origin; } catch { throw new Error("Invalid preview URL"); }
  return previewConsoleEntries
    .filter((entry) => {
      try { return entry.frameUrl ? new URL(entry.frameUrl).origin === origin : false; } catch { return false; }
    })
    .slice(-Math.max(1, Math.min(limit, 200)));
}

function notifyWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("agent-k:window-resized", {
    maximized: mainWindow.isMaximized(),
    width: mainWindow.getContentBounds().width,
    height: mainWindow.getContentBounds().height,
  });
}

function applySplashState(): void {
  if (!splashState || !splashWindow || splashWindow.isDestroyed()) return;
  const { current, message, theme, total } = splashState;
  const resolvedTheme = splashTheme?.base ?? resolvedAppearanceTheme(theme);
  if (!splashWindow || splashWindow.isDestroyed()) return;
  const percent = total > 0 ? (Math.min(current, total) / total) * 100 : 0;
  void splashWindow.webContents.executeJavaScript(
    `document.documentElement.dataset.theme=${JSON.stringify(resolvedTheme)};` +
      `for(const [key,value] of Object.entries(${JSON.stringify(splashTheme?.colors ?? {})}))document.documentElement.style.setProperty('--'+key,String(value));` +
      `document.getElementById('status').textContent=${JSON.stringify(message)};` +
      `document.getElementById('progress').style.width=${JSON.stringify(`${percent.toFixed(2)}%`)};`,
  ).catch(() => undefined);
}

function updateSplash(message: string, current: number, total: number, theme: string): void {
  splashState = { current, message, theme, total };
  applySplashState();
}

function revealMainWindow(): void {
  if (!startupFinished || !mainWindowReady || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
  splashWindow?.close();
  splashWindow = undefined;
}

function finishSplash(): void {
  startupFinished = true;
  revealMainWindow();
}

function registerIpc(): void {
  ipcMain.on("agent-k:project-console-input", (event, id: unknown, data: unknown) => {
    if (
      !mainWindow ||
      event.sender !== mainWindow.webContents ||
      typeof id !== "string" ||
      typeof data !== "string"
    ) return;
    try {
      backend?.writeProjectConsole(id, data);
    } catch (cause) {
      sendProjectConsoleEvent({
        error: errorMessage(cause),
        id,
        type: "project_console_input_error",
      });
    }
  });
  ipcMain.handle("agent-k:invoke", async (_event, command: unknown, args: unknown) => {
    if (typeof command !== "string") throw new Error("Desktop command must be a string");
    if (!backend || !backendReady) throw new Error("Desktop backend is unavailable");
    await backendReady;
    return backend.invoke(command, args);
  });
  ipcMain.handle("agent-k:app-version", () => app.getVersion());
  ipcMain.handle("agent-k:clipboard-write", (_event, value: unknown) => {
    if (typeof value !== "string") throw new Error("Clipboard text must be a string");
    clipboard.writeText(value);
  });
  ipcMain.handle("agent-k:dialog-open", async (event, rawOptions: unknown) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const source = asObject(rawOptions);
    const properties: OpenDialogOptions["properties"] = ["openFile"];
    if (source.directory === true) properties.splice(0, 1, "openDirectory");
    if (source.multiple === true) properties.push("multiSelections");
    const filters = Array.isArray(source.filters)
      ? source.filters.flatMap((raw) => {
          const filter = asObject(raw);
          return typeof filter.name === "string" &&
            Array.isArray(filter.extensions) &&
            filter.extensions.every((value) => typeof value === "string")
            ? [{ name: filter.name, extensions: filter.extensions as string[] }]
            : [];
        })
      : undefined;
    const options: OpenDialogOptions = {
      properties,
      ...(typeof source.title === "string" ? { title: source.title } : {}),
      ...(filters ? { filters } : {}),
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length) return null;
    return source.multiple === true ? result.filePaths : result.filePaths[0];
  });
  ipcMain.handle("agent-k:window", async (event, action: unknown, payload: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || typeof action !== "string") return;
    const data = asObject(payload);
    switch (action) {
      case "open-debug": {
        if (event.sender !== mainWindow?.webContents) throw new Error("Only the main window can open Debug");
        const root = typeof data.root === "string" && isAbsolute(data.root) ? resolve(data.root) : undefined;
        if (!root) throw new Error("An absolute workspace root is required");
        const candidate = typeof data.contextFile === "string" && isAbsolute(data.contextFile) ? resolve(data.contextFile) : undefined;
        const nested = candidate ? relative(root, candidate) : "";
        const contextFile = candidate && nested !== ".." && !isAbsolute(nested) && !nested.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ? candidate : undefined;
        openDebugWindow(root, contextFile);
        break;
      }
      case "set-debug-root": {
        if (event.sender !== mainWindow?.webContents) return;
        const root = typeof data.root === "string" && isAbsolute(data.root) ? resolve(data.root) : undefined;
        debugRoot = root;
        if (root && debugWindow && !debugWindow.webContents.isDestroyed()) debugWindow.webContents.send("agent-k:debug-root", root);
        if (root) for (const tool of debugToolWindows.values()) if (!tool.webContents.isDestroyed()) tool.webContents.send("agent-k:debug-root", root);
        break;
      }
      case "open-debug-tool": {
        if (event.sender !== debugWindow?.webContents) throw new Error("Only the Debug window can open Debug tools");
        const kind = data.kind;
        if (kind !== "memory" && kind !== "registers" && kind !== "disassembly") throw new Error("Unknown Debug tool window");
        const target = typeof data.target === "string" && data.target.length <= 4_096 ? data.target : undefined;
        const packId = typeof data.packId === "string" && /^[a-z0-9][a-z0-9.-]*$/i.test(data.packId) ? data.packId : undefined;
        if (!packId) throw new Error("A valid Debug provider is required");
        const sessionId = typeof data.sessionId === "string" && data.sessionId.length <= 128 ? data.sessionId : undefined;
        openDebugToolWindow(kind, target, packId, sessionId);
        break;
      }
      case "open-editor-location": {
        const debugSender = event.sender === debugWindow?.webContents || [...debugToolWindows.values()].some((tool) => event.sender === tool.webContents);
        if (!debugSender || !mainWindow || mainWindow.webContents.isDestroyed()) return;
        const path = typeof data.path === "string" && isAbsolute(data.path) ? resolve(data.path) : undefined;
        if (!path) throw new Error("An absolute source path is required");
        const workspacePath = debugRoot ? relative(debugRoot, path) : "..";
        if (isAbsolute(workspacePath) || workspacePath === ".." || workspacePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
          throw new Error("The source location is outside the Debug workspace");
        mainWindow.webContents.send("agent-k:open-editor-location", { path, line: number(data.line), column: number(data.column ?? 1) });
        if (data.focus !== false) {
          mainWindow.show();
          mainWindow.focus();
        }
        break;
      }
      case "set-size":
        window.setContentSize(number(data.width), number(data.height));
        break;
      case "is-maximized":
        return window.isMaximized();
      case "maximize":
        window.maximize();
        break;
      case "unmaximize":
        window.unmaximize();
        break;
      case "minimize":
        window.minimize();
        break;
      case "close":
        window.close();
        break;
      case "floating-editor-window": {
        if (event.sender !== mainWindow?.webContents) throw new Error("Only the main window can control floating Editors");
        const id = typeof data.id === "string" ? data.id.toLowerCase() : "";
        const target = /^[0-9a-f-]{36}$/i.test(id) ? floatingEditorWindows.get(id) : undefined;
        if (!target || target.isDestroyed()) throw new Error("Floating Editor window is unavailable");
        switch (data.action) {
          case "is-maximized": return target.isMaximized();
          case "maximize": target.maximize(); break;
          case "unmaximize": target.unmaximize(); break;
          case "minimize": target.minimize(); break;
          case "close": target.close(); break;
          default: throw new Error("Unknown floating Editor window action");
        }
        break;
      }
      case "open-devtools":
        window.webContents.openDevTools({ mode: "detach" });
        break;
      case "resize-mode":
        return usesManualWindowResize(
          process.platform,
          process.env,
          app.commandLine.getSwitchValue("ozone-platform"),
          app.commandLine.getSwitchValue("ozone-platform-hint"),
        ) ? "manual" : "native";
      case "capture-preview": {
        const x = Math.max(0, number(data.x));
        const y = Math.max(0, number(data.y));
        const width = number(data.width);
        const height = number(data.height);
        if (width < 1 || height < 1) throw new Error("Preview has no visible area to capture");
        const outputPath = typeof data.outputPath === "string" ? data.outputPath : "";
        if (!outputPath || !isAbsolute(outputPath) || !outputPath.toLowerCase().endsWith(".png"))
          throw new Error("A PNG output path is required");
        const floatingEditorId = typeof data.floatingEditorId === "string"
          ? data.floatingEditorId.toLowerCase()
          : undefined;
        const captureWindow = floatingEditorId && event.sender === mainWindow?.webContents
          ? floatingEditorWindows.get(floatingEditorId)
          : window;
        if (!captureWindow || captureWindow.isDestroyed()) throw new Error("Preview window is unavailable");
        const image = await captureWindow.webContents.capturePage({ height, width, x, y });
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, image.toPNG());
        return outputPath;
      }
      case "get-preview-console": {
        const url = typeof data.url === "string" ? data.url : "";
        const limit = typeof data.limit === "number" && Number.isFinite(data.limit)
          ? Math.round(data.limit)
          : 80;
        return previewConsoleFor(url, limit);
      }
      case "style-preview-scrollbars": {
        if (event.sender !== mainWindow?.webContents) throw new Error("Only the main window can style previews");
        const floatingEditorId = typeof data.floatingEditorId === "string"
          ? data.floatingEditorId.toLowerCase()
          : undefined;
        const previewWindow = floatingEditorId
          ? floatingEditorWindows.get(floatingEditorId)
          : mainWindow;
        if (!previewWindow || previewWindow.isDestroyed()) throw new Error("Preview window is unavailable");
        const previewUrl = typeof data.url === "string" ? data.url : "";
        const css = typeof data.css === "string" ? data.css : "";
        if (!css || css.length > 12_000) throw new Error("Invalid preview scrollbar CSS");
        let origin: string;
        try {
          const parsed = new URL(previewUrl);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Unsupported preview URL");
          origin = parsed.origin;
        } catch {
          throw new Error("Invalid preview URL");
        }
        const script = `(() => { const id = "agent-k-preview-scrollbars"; let style = document.getElementById(id); if (!style) { style = document.createElement("style"); style.id = id; (document.head || document.documentElement).append(style); } style.textContent = ${JSON.stringify(css)}; })()`;
        const previewMainFrame = previewWindow.webContents.mainFrame;
        const targets = previewMainFrame.framesInSubtree.filter((frame) => {
          if (frame === previewMainFrame || frame.detached) return false;
          try { return new URL(frame.url).origin === origin; } catch { return false; }
        });
        const results = await Promise.allSettled(targets.map((frame) => frame.executeJavaScript(script)));
        return results.filter((result) => result.status === "fulfilled").length;
      }
      case "resize-begin": {
        if (!usesManualWindowResize(
          process.platform,
          process.env,
          app.commandLine.getSwitchValue("ozone-platform"),
          app.commandLine.getSwitchValue("ozone-platform-hint"),
        )) return;
        const direction = String(data.direction) as ResizeDirection;
        if (![
          "East", "North", "NorthEast", "NorthWest", "South",
          "SouthEast", "SouthWest", "West",
        ].includes(direction)) throw new Error("Invalid resize direction");
        resizeState = {
          bounds: window.getBounds(),
          direction,
          startX: number(data.screenX),
          startY: number(data.screenY),
        };
        break;
      }
      case "resize-update":
        updateWindowResize(window, number(data.screenX), number(data.screenY));
        break;
      case "resize-end":
        resizeState = undefined;
        break;
      default:
        throw new Error(`Unknown window action: ${action}`);
    }
  });
}

function updateWindowResize(window: BrowserWindow, screenX: number, screenY: number): void {
  if (!resizeState || window.isMaximized()) return;
  const dx = screenX - resizeState.startX;
  const dy = screenY - resizeState.startY;
  const start = resizeState.bounds;
  const minimumSize = window.getMinimumSize();
  const minimumWidth = minimumSize[0] ?? 1372;
  const minimumHeight = minimumSize[1] ?? 640;
  const next = resizedWindowBounds(
    start,
    resizeState.direction,
    dx,
    dy,
    minimumWidth,
    minimumHeight,
  );
  window.setBounds(next, false);
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("Expected a number");
  return Math.round(value);
}

async function start(): Promise<void> {
  await app.whenReady();
  const appDataPath = app.getPath("userData");
  const startupSettings = await loadClientSettings(appDataPath);
  const bundledThemesSource = app.isPackaged ? join(process.resourcesPath, "themes") : projectPath("themes");
  splashTheme = await resolveTheme(appDataPath, bundledThemesSource, startupSettings.theme, nativeTheme.shouldUseDarkColors);
  splashState = {
    current: 0,
    message: startupSettings.locale === "en-US" ? "Starting Agent K…" : "正在启动 Agent K…",
    theme: startupSettings.theme,
    total: 1,
  };
  const cachePath = startupSettings.cacheDirectory || join(appDataPath, "cache");
  protocol.handle("agentk-file", (request) => {
    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    if (!path || !isAbsolute(path)) return new Response("Bad path", { status: 400 });
    return net.fetch(pathToFileURL(path).toString());
  });
  protocol.handle("agentk-editor", async (request) => {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const kind = parts[1];
      if (
        url.hostname !== "dependency" ||
        !["asset", "entry", "style"].includes(kind ?? "") ||
        (kind === "asset" ? parts.length !== 3 : parts.length !== 2)
      )
        return new Response("Bad Editor asset", { status: 400 });
      const path = await editorPluginDependencyFilePath(
        firstPartyEditorExtensionsPath(),
        parts[0] ?? "",
        kind as "asset" | "entry" | "style",
        parts[2],
      );
      const response = await net.fetch(pathToFileURL(path).toString());
      const headers = new Headers(response.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set(
        "Cache-Control",
        app.isPackaged ? "public, max-age=31536000, immutable" : "no-store",
      );
      headers.set(
        "Content-Type",
        kind === "style"
          ? "text/css; charset=utf-8"
          : "text/javascript; charset=utf-8",
      );
      return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
      });
    } catch (cause) {
      return new Response(errorMessage(cause), { status: 404 });
    }
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            "default-src 'self'; connect-src 'self' http://127.0.0.1:*; img-src 'self' agentk-file: data: blob:; media-src 'self' agentk-file: blob:; frame-src 'self' blob: http://127.0.0.1:*; font-src 'self' data:; worker-src 'self' blob:; object-src 'self' blob:; style-src 'self' 'unsafe-inline'",
          ],
        },
      });
    });
  }
  createWindows(startupSettings.theme, splashTheme);
  registerIpc();
  backend = new DesktopBackend({
    appDataPath,
    bundledExtensionsSource: app.isPackaged
      ? join(process.resourcesPath, "extensions")
      : projectPath("extensions"),
    firstPartyEditorExtensionsSource: firstPartyEditorExtensionsPath(),
    firstPartyLanguagePacksSource: firstPartyLanguagePacksPath(),
    bundledSkillsSource: app.isPackaged
      ? join(process.resourcesPath, "skills")
      : projectPath("skills"),
    bundledThemesSource,
    bundledPiCli: app.isPackaged
      ? join(process.resourcesPath, "pi-runtime", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")
      : projectPath("node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
    bundledPiNode: bundledPiNodeExecutable(),
    cachePath,
    localModelRoot: startupSettings.localModelDirectory || undefined,
    permissionExtensionSource: projectPath("agent-k-permissions.ts"),
    emit: emitBackendEvent,
    emitProjectConsole: sendProjectConsoleEvent,
    updateSplash,
    finishSplash,
    openPath: (path) => shell.openPath(path),
  });
  backendReady = backend.initialize();
  try {
    await backendReady;
  } catch (cause) {
    dialog.showErrorBox("Agent K", `Desktop backend failed to start: ${errorMessage(cause)}`);
    finishSplash();
  }
}

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on("before-quit", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    quitting = true;
    for (const pending of pendingAssistantEvents.values())
      clearTimeout(pending.timer);
    pendingAssistantEvents.clear();
    void (backend?.shutdown() ?? Promise.resolve()).finally(() => {
      shutdownComplete = true;
      app.quit();
    });
  });
  app.on("window-all-closed", () => app.quit());
  void start();
}
