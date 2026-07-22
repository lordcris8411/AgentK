import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
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
import { asObject, errorMessage } from "./utils.js";

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

const legacyDataPath =
  process.platform === "linux"
    ? join(
        process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? app.getPath("home"), ".local", "share"),
        "com.lordcris8411.agentk",
      )
    : join(app.getPath("appData"), "com.lordcris8411.agentk");
mkdirSync(legacyDataPath, { recursive: true });
app.setPath("userData", legacyDataPath);

let mainWindow: BrowserWindow | undefined;
let splashWindow: BrowserWindow | undefined;
let backend: DesktopBackend | undefined;
let backendReady: Promise<void> | undefined;
let quitting = false;

type ResizeDirection =
  | "East" | "North" | "NorthEast" | "NorthWest"
  | "South" | "SouthEast" | "SouthWest" | "West";
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

function projectPath(...parts: string[]): string {
  return join(app.getAppPath(), ...parts);
}

function firstPartyEditorExtensionsPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "editor", "extensions")
    : projectPath("editor", "extensions");
}

function createWindows(): void {
  const preload = projectPath("electron", "preload.cjs");
  mainWindow = new BrowserWindow({
    title: "Agent K",
    width: 1600,
    height: 920,
    minWidth: 1452,
    minHeight: 640,
    frame: false,
    show: false,
    backgroundColor: "#f4f2ee",
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
    void mainWindow.loadURL(devUrl);
    void splashWindow.loadURL(`${devUrl}/splashscreen.html`);
  } else {
    void mainWindow.loadFile(projectPath("dist", "index.html"));
    void splashWindow.loadFile(projectPath("dist", "splashscreen.html"));
  }
  splashWindow.once("ready-to-show", () => splashWindow?.show());
  splashWindow.webContents.on("did-finish-load", applySplashState);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const current = mainWindow?.webContents.getURL();
    if (url !== current) event.preventDefault();
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
  const resolvedTheme = theme === "system"
    ? nativeTheme.shouldUseDarkColors ? "dark" : "light"
    : theme === "dark" ? "dark" : "light";
  if (!splashWindow || splashWindow.isDestroyed()) return;
  const percent = total > 0 ? (Math.min(current, total) / total) * 100 : 0;
  void splashWindow.webContents.executeJavaScript(
    `document.documentElement.dataset.theme=${JSON.stringify(resolvedTheme)};` +
      `document.getElementById('status').textContent=${JSON.stringify(message)};` +
      `document.getElementById('progress').style.width=${JSON.stringify(`${percent.toFixed(2)}%`)};`,
  ).catch(() => undefined);
}

function updateSplash(message: string, current: number, total: number, theme: string): void {
  splashState = { current, message, theme, total };
  applySplashState();
}

function finishSplash(): void {
  mainWindow?.show();
  mainWindow?.focus();
  splashWindow?.close();
  splashWindow = undefined;
}

function registerIpc(): void {
  ipcMain.handle("agent-k:invoke", async (_event, command: unknown, args: unknown) => {
    if (typeof command !== "string") throw new Error("Desktop command must be a string");
    if (!backend || !backendReady) throw new Error("Desktop backend is unavailable");
    await backendReady;
    const result = await backend.invoke(command, args);
    return result;
  });
  ipcMain.handle("agent-k:app-version", () => app.getVersion());
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
  ipcMain.handle("agent-k:window", (event, action: unknown, payload: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || typeof action !== "string") return;
    const data = asObject(payload);
    switch (action) {
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
      case "resize-begin": {
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
  const next = { ...start };
  if (resizeState.direction.includes("East")) next.width = start.width + dx;
  if (resizeState.direction.includes("South")) next.height = start.height + dy;
  if (resizeState.direction.includes("West")) {
    next.x = start.x + dx;
    next.width = start.width - dx;
  }
  if (resizeState.direction.includes("North")) {
    next.y = start.y + dy;
    next.height = start.height - dy;
  }
  const minimumSize = window.getMinimumSize();
  const minimumWidth = minimumSize[0] ?? 1452;
  const minimumHeight = minimumSize[1] ?? 640;
  if (next.width < minimumWidth) {
    if (resizeState.direction.includes("West")) next.x -= minimumWidth - next.width;
    next.width = minimumWidth;
  }
  if (next.height < minimumHeight) {
    if (resizeState.direction.includes("North")) next.y -= minimumHeight - next.height;
    next.height = minimumHeight;
  }
  window.setBounds(next, false);
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("Expected a number");
  return Math.round(value);
}

async function start(): Promise<void> {
  await app.whenReady();
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
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
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
  createWindows();
  registerIpc();
  backend = new DesktopBackend({
    appDataPath: app.getPath("userData"),
    bundledExtensionsSource: app.isPackaged
      ? join(process.resourcesPath, "extensions")
      : projectPath("extensions"),
    firstPartyEditorExtensionsSource: firstPartyEditorExtensionsPath(),
    bundledSkillsSource: app.isPackaged
      ? join(process.resourcesPath, "skills")
      : projectPath("skills"),
    bundledPiCli: app.isPackaged
      ? join(process.resourcesPath, "pi-runtime", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")
      : projectPath("node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
    cachePath: join(app.getPath("userData"), "cache"),
    permissionExtensionSource: projectPath("agent-k-permissions.ts"),
    emit: (event) => mainWindow?.webContents.send("agent-k:pi-event", event),
    updateSplash,
    finishSplash,
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
  app.on("before-quit", () => {
    quitting = true;
    backend?.shutdown();
  });
  app.on("window-all-closed", () => app.quit());
  void start();
}
