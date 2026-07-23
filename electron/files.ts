import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  lstat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { shell } from "electron";
import type { FileEntry, JsonObject, ProjectSummary, SessionSummary } from "./types.js";
import {
  asArray,
  asObject,
  asString,
  atomicWrite,
  homeDirectory,
  isPathInside,
  piAgentDirectory,
  randomId,
  readJson,
} from "./utils.js";

const MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function canonicalRoot(root: string): Promise<string> {
  const path = await realpath(root);
  if (!(await stat(path)).isDirectory()) throw new Error("Project root is not a directory");
  return path;
}

async function workspacePath(rootInput: string, requested: string): Promise<string> {
  const root = await canonicalRoot(rootInput);
  const candidate = isAbsolute(requested) ? requested : join(root, requested);
  const parent = await realpath(dirname(candidate));
  const normalized = join(parent, basename(candidate));
  if (!isPathInside(root, normalized))
    throw new Error("Path is outside the active project");
  return normalized;
}

async function buildTree(root: string, target: string, depth: number): Promise<FileEntry> {
  const metadata = await stat(target);
  const name = basename(target) || "workspace";
  const displayPath = relative(root, target);
  if (!metadata.isDirectory())
    return { path: displayPath, name, isDir: false, loaded: true, children: [] };
  if (depth === 0)
    return { path: displayPath, name, isDir: true, loaded: false, children: [] };
  const entries = await readdir(target, { withFileTypes: true });
  const children = await Promise.all(
    entries
      .filter((entry) => !entry.isDirectory() || entry.name !== "node_modules")
      .map((entry) => buildTree(root, join(target, entry.name), depth - 1)),
  );
  children.sort(
    (left, right) =>
      Number(right.isDir) - Number(left.isDir) || left.name.localeCompare(right.name),
  );
  return { path: displayPath, name, isDir: true, loaded: true, children };
}

function userFacingSessionText(text: string): string {
  const prefix = "Analyze the codebase and create a detailed plan for: ";
  const marker = "\n\nWrite the plan to: ";
  const normalized = text.replaceAll("\r\n", "\n");
  if (normalized.startsWith(prefix)) {
    const request = normalized.slice(prefix.length);
    const index = request.indexOf(marker);
    if (index >= 0) return `Plan：${request.slice(0, index).trim()}`;
  }
  return normalized;
}

function messageText(value: JsonObject): string | undefined {
  const content = value.content;
  const text =
    typeof content === "string"
      ? content
      : asArray(content)
          .map(asObject)
          .filter((block) => block.type === "text")
          .map((block) => asString(block.text) ?? "")
          .join(" ");
  const normalized = userFacingSessionText(text).trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  return `${[...normalized].slice(0, 42).join("")}${[...normalized].length > 42 ? "…" : ""}`;
}

async function sessionSummary(path: string): Promise<SessionSummary | undefined> {
  try {
    const text = await readFile(path, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    const header = asObject(JSON.parse(lines[0] ?? "{}"));
    if (header.type !== "session") return undefined;
    const id = asString(header.id);
    const cwd = asString(header.cwd);
    if (!id || !cwd) return undefined;
    let name: string | undefined;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const entry = asObject(JSON.parse(lines[index] ?? "{}"));
      if (entry.type === "session_info" && typeof entry.name === "string") {
        name = entry.name;
        break;
      }
    }
    if (!name) {
      for (const line of lines) {
        const entry = asObject(JSON.parse(line));
        const message = asObject(entry.message);
        if (entry.type === "message" && message.role === "user") {
          name = messageText(message);
          if (name) break;
        }
      }
    }
    const metadata = await stat(path);
    return {
      id,
      path,
      cwd,
      ...(name ? { name } : {}),
      updatedAt: Math.floor(metadata.mtimeMs / 1000),
      preview: "",
    };
  } catch {
    return undefined;
  }
}

type PreviewState = {
  server: Server;
  port: number;
  token: string;
  root: string;
  overrides: Map<string, Buffer>;
};

function previewRelativePath(
  request: IncomingMessage,
  url: URL,
  state: PreviewState,
): string | undefined {
  const prefix = `/${state.token}/`;
  if (url.pathname.startsWith(prefix))
    return decodeURIComponent(url.pathname.slice(prefix.length));

  // Root-relative URLs in a preview (for example /assets/logo.png) do not
  // contain the capability token. Accept them only when they were requested
  // by the current tokenized preview page, then resolve them from its workspace.
  const referer = request.headers.referer;
  if (typeof referer !== "string") return undefined;
  try {
    const source = new URL(referer);
    if (
      source.hostname !== "127.0.0.1" ||
      source.port !== String(state.port) ||
      !source.pathname.startsWith(prefix)
    ) return undefined;
    return decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    return undefined;
  }
}

function previewHtml(body: Buffer, token: string): Buffer {
  const prefix = `/${token}/`;
  const rewritten = body.toString("utf8").replace(
    /(\b(?:src|href|poster)\s*=\s*["'])\/(?!\/)/gi,
    `$1${prefix}`,
  );
  return Buffer.from(
    `${rewritten}<script>document.addEventListener('contextmenu',event=>event.preventDefault(),{capture:true})</script>`,
  );
}

export class FileService {
  private readonly appDataPath: string;
  private readonly cachePath: string;
  private hidden = new Set<string>();
  private preview?: PreviewState;
  private indexes = new Map<string, { createdAt: number; paths: string[] }>();

  constructor(appDataPath: string, cachePath: string) {
    this.appDataPath = appDataPath;
    this.cachePath = cachePath;
  }

  async initialize(): Promise<void> {
    this.hidden = new Set(
      await readJson<string[]>(join(this.appDataPath, "hidden-sessions.json"), []),
    );
  }

  async addWorkspace(cwd: string): Promise<string> {
    const selected = await canonicalRoot(cwd);
    const path = join(this.appDataPath, "known-projects.json");
    const projects = new Set(await readJson<string[]>(path, []));
    for (const existing of projects) {
      try {
        if ((await realpath(existing)) === selected) return existing;
      } catch {
        // Preserve missing projects in the user's list.
      }
    }
    projects.add(selected);
    await atomicWrite(path, JSON.stringify([...projects].sort()));
    return selected;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const knownPath = join(this.appDataPath, "known-projects.json");
    const known = new Set(await readJson<string[]>(knownPath, []));
    const sessions: SessionSummary[] = [];
    const root = join(piAgentDirectory(), "sessions");
    try {
      for (const project of await readdir(root, { withFileTypes: true })) {
        if (!project.isDirectory()) continue;
        for (const file of await readdir(join(root, project.name), { withFileTypes: true })) {
          if (!file.isFile() || extname(file.name) !== ".jsonl") continue;
          const summary = await sessionSummary(join(root, project.name, file.name));
          if (!summary) continue;
          known.add(summary.cwd);
          if (!this.hidden.has(summary.path)) sessions.push(summary);
        }
      }
    } catch {
      // Pi may not have created its sessions directory yet.
    }
    await atomicWrite(knownPath, JSON.stringify([...known].sort()));
    const home = await realpath(homeDirectory()).catch(() => resolve(homeDirectory()));
    const projects = await Promise.all([...known].map(async (cwd) => {
      const projectSessions = sessions
        .filter((session) => session.cwd === cwd)
        .sort((left, right) => right.updatedAt - left.updatedAt);
      const directoryUpdatedAt = await stat(cwd)
        .then((metadata) => Math.floor(metadata.mtimeMs / 1000))
        .catch(() => 0);
      return {
        cwd,
        name: basename(cwd) || cwd,
        ...(resolve(cwd) === home ? { isHome: true } : {}),
        updatedAt: projectSessions[0]?.updatedAt ?? directoryUpdatedAt,
        sessions: projectSessions,
      };
    }));
    return projects.sort(
      (left, right) =>
        right.updatedAt - left.updatedAt ||
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
        left.cwd.localeCompare(right.cwd, undefined, { sensitivity: "base" }),
    );
  }

  async sessionMessages(path: string): Promise<JsonObject[]> {
    const root = await realpath(join(piAgentDirectory(), "sessions"));
    const target = await realpath(path);
    if (!isPathInside(root, target) || extname(target) !== ".jsonl")
      throw new Error("Session path is outside Pi's session directory");
    return (await readFile(target, "utf8"))
      .split(/\r?\n/)
      .flatMap((line) => {
        try {
          const entry = asObject(JSON.parse(line));
          return entry.type === "message" ? [asObject(entry.message)] : [];
        } catch {
          return [];
        }
      });
  }

  async hideSession(path: string, hidden: boolean): Promise<void> {
    if (hidden) {
      const summary = await sessionSummary(path);
      if (summary) await this.addWorkspace(summary.cwd);
      this.hidden.add(path);
    } else this.hidden.delete(path);
    await atomicWrite(
      join(this.appDataPath, "hidden-sessions.json"),
      JSON.stringify([...this.hidden]),
    );
  }

  async deleteSession(path: string): Promise<void> {
    const root = await realpath(join(piAgentDirectory(), "sessions"));
    const target = await realpath(path);
    if (!isPathInside(root, target) || extname(target) !== ".jsonl")
      throw new Error("Session path is outside Pi's session directory");
    await shell.trashItem(target);
    this.hidden.delete(path);
    this.hidden.delete(target);
    await atomicWrite(
      join(this.appDataPath, "hidden-sessions.json"),
      JSON.stringify([...this.hidden]),
    );
  }

  async renameSession(path: string, nameInput: string, timestamp: string): Promise<void> {
    const name = nameInput.replace(/[\r\n]/g, " ").trim();
    if (!name) throw new Error("Session name cannot be empty");
    const root = await realpath(join(piAgentDirectory(), "sessions"));
    const target = await realpath(path);
    if (!isPathInside(root, target) || extname(target) !== ".jsonl")
      throw new Error("Session path is outside Pi's session directory");
    const lines = (await readFile(target, "utf8")).split(/\r?\n/).filter(Boolean);
    let parentId: string | undefined;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        parentId = asString(asObject(JSON.parse(lines[index] ?? "{}")).id);
        if (parentId) break;
      } catch {
        // Continue to the previous valid JSONL entry.
      }
    }
    await appendFile(
      target,
      `${JSON.stringify({ type: "session_info", id: randomBytes(4).toString("hex"), parentId, timestamp, name })}\n`,
    );
  }

  async projectTree(rootInput: string): Promise<FileEntry> {
    const root = await canonicalRoot(rootInput);
    return buildTree(root, root, 1);
  }

  async directoryTree(rootInput: string, path: string): Promise<FileEntry> {
    const root = await canonicalRoot(rootInput);
    const target = path ? await workspacePath(root, path) : root;
    if (!(await stat(target)).isDirectory())
      throw new Error("Requested path is not a directory");
    return buildTree(root, target, 1);
  }

  async cmakeProjectDirectory(rootInput: string, path: string): Promise<string> {
    const root = await canonicalRoot(rootInput);
    const requested = path ? await workspacePath(root, path) : root;
    const target = await realpath(requested);
    if (target !== root && !isPathInside(root, target))
      throw new Error("CMake project path is outside the active workspace");
    if (!(await stat(target)).isDirectory())
      throw new Error("CMake project path is not a directory");
    try {
      if (!(await stat(join(target, "CMakeLists.txt"))).isFile())
        throw new Error("CMakeLists.txt is not a file");
    } catch {
      throw new Error("The selected directory is not a CMake project");
    }
    return target;
  }

  async projectContext(rootInput: string): Promise<string> {
    const root = await canonicalRoot(rootInput);
    const entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => !["node_modules", ".git"].includes(entry.name))
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort()
      .slice(0, 36);
    let summary = `Working directory: ${root}\nTop-level entries: ${entries.join(", ") || "(empty)"}`;
    try {
      const manifest = asObject(JSON.parse(await readFile(join(root, "package.json"), "utf8")));
      summary += `\npackage.json: name=${asString(manifest.name) ?? "(unnamed)"}; description=${asString(manifest.description) ?? ""}; scripts=${Object.keys(asObject(manifest.scripts)).slice(0, 12).join(", ")}`;
    } catch {
      // package.json is optional.
    }
    for (const name of ["README.md", "readme.md", "README", "AGENTS.md"]) {
      try {
        const text = await readFile(join(root, name), "utf8");
        if (text.trim()) {
          summary += `\n${name} excerpt:\n${[...text].slice(0, 1400).join("")}`;
          break;
        }
      } catch {
        // Try the next conventional project description.
      }
    }
    return summary;
  }

  async readText(root: string, path: string): Promise<string> {
    return readFile(await workspacePath(root, path), "utf8");
  }

  async readBinary(root: string, path: string): Promise<ArrayBuffer> {
    const bytes = await readFile(await workspacePath(root, path));
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
  }

  async saveTempAttachment(name: string, data: number[]): Promise<string> {
    const rawExtension = extname(name).slice(1);
    const extension = /^[A-Za-z0-9]{1,10}$/.test(rawExtension)
      ? rawExtension.toLowerCase()
      : "png";
    const directory = join(this.cachePath, "attachments");
    await mkdir(directory, { recursive: true });
    const target = join(directory, `${randomBytes(16).toString("hex")}.${extension}`);
    await writeFile(target, Uint8Array.from(data));
    return target;
  }

  async startPreview(rootInput: string, path: string, content: string): Promise<string> {
    const root = await canonicalRoot(rootInput);
    const target = await workspacePath(root, path);
    if (!(await stat(target)).isFile()) throw new Error("预览目标不是文件");
    if (!this.preview) this.preview = await this.createPreviewServer(root);
    if (this.preview.root !== root) {
      this.preview.root = root;
      this.preview.overrides.clear();
    }
    const relativePath = relative(root, target);
    this.preview.overrides.set(relativePath, Buffer.from(content));
    const encoded = relativePath.split(sep).map(encodeURIComponent).join("/");
    return `http://127.0.0.1:${this.preview.port}/${this.preview.token}/${encoded}`;
  }

  async writeText(root: string, path: string, content: string): Promise<void> {
    const target = await workspacePath(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    this.indexes.delete(await canonicalRoot(root));
  }

  async createDirectory(root: string, path: string): Promise<void> {
    await mkdir(await workspacePath(root, path), { recursive: true });
    this.indexes.delete(await canonicalRoot(root));
  }

  async move(root: string, from: string, to: string): Promise<void> {
    await rename(await workspacePath(root, from), await workspacePath(root, to));
    this.indexes.delete(await canonicalRoot(root));
  }

  async copy(root: string, from: string, to: string): Promise<void> {
    await copyFile(await workspacePath(root, from), await workspacePath(root, to));
    this.indexes.delete(await canonicalRoot(root));
  }

  async importPaths(rootInput: string, targetDir: string, sources: string[]): Promise<void> {
    const root = await canonicalRoot(rootInput);
    const target = targetDir ? await workspacePath(root, targetDir) : root;
    if (!(await stat(target)).isDirectory()) throw new Error("拖放目标不是文件夹");
    for (const sourceInput of sources) {
      const source = await realpath(sourceInput);
      const destination = join(target, basename(source));
      if ((await stat(source)).isDirectory() && isPathInside(source, destination))
        throw new Error("不能将文件夹复制到其自身内部");
      await copyExternalEntry(source, destination);
    }
    this.indexes.delete(root);
  }

  async trash(root: string, path: string): Promise<void> {
    await shell.trashItem(await workspacePath(root, path));
    this.indexes.delete(await canonicalRoot(root));
  }

  async openTerminal(rootInput: string, path: string): Promise<void> {
    const root = await canonicalRoot(rootInput);
    const target = path ? await workspacePath(root, path) : root;
    const directory = (await stat(target)).isDirectory() ? target : dirname(target);
    const candidates: Array<[string, string[]]> =
      process.platform === "win32"
        ? [["cmd.exe", ["/K"]]]
        : [
            ["xdg-terminal-exec", []],
            ["konsole", ["--workdir", directory]],
            ["gnome-terminal", [`--working-directory=${directory}`]],
            ["xfce4-terminal", [`--working-directory=${directory}`]],
            ["kitty", ["--directory", directory]],
            ["alacritty", ["--working-directory", directory]],
            ["wezterm", ["start", "--cwd", directory]],
            ["x-terminal-emulator", []],
            ["xterm", []],
          ];
    const available = candidates.find(([command]) => commandExists(command));
    if (!available)
      throw new Error("No supported terminal emulator was found");
    const child = spawn(available[0], available[1], {
      cwd: directory,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
  }

  async openInFileManager(rootInput: string, path: string): Promise<void> {
    const root = await canonicalRoot(rootInput);
    const target = path ? await realpath(await workspacePath(root, path)) : root;
    if (!isPathInside(root, target)) throw new Error("Path is outside the active project");
    if ((await stat(target)).isDirectory()) {
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
    } else shell.showItemInFolder(target);
  }

  async search(rootInput: string, query: string): Promise<string[]> {
    const root = await canonicalRoot(rootInput);
    let index = this.indexes.get(root);
    if (!index || Date.now() - index.createdAt >= 5_000) {
      index = { createdAt: Date.now(), paths: await buildFileIndex(root) };
      this.indexes.set(root, index);
    }
    const needle = query.toLowerCase();
    return index.paths
      .filter((path) => path.toLowerCase().includes(needle))
      .slice(0, 500)
      .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
  }

  fileUrl(path: string): string {
    return `agentk-file://local/?path=${encodeURIComponent(path)}`;
  }

  shutdown(): void {
    this.preview?.server.close();
  }

  private async createPreviewServer(root: string): Promise<PreviewState> {
    const state: PreviewState = {
      server: createServer(),
      port: 0,
      token: randomId(),
      root,
      overrides: new Map(),
    };
    state.server.on("request", async (request, response) => {
      try {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405).end("Method not allowed");
          return;
        }
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const relativePath = previewRelativePath(request, url, state);
        if (relativePath === undefined) {
          response.writeHead(404).end("Not found");
          return;
        }
        if (isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
          response.writeHead(403).end("Forbidden");
          return;
        }
        let target = join(state.root, ...relativePath.split("/"));
        if ((await stat(target)).isDirectory()) target = join(target, "index.html");
        const canonical = await realpath(target);
        if (!isPathInside(state.root, canonical)) throw new Error("Forbidden");
        let body = state.overrides.get(relative(state.root, canonical)) ?? await readFile(canonical);
        const contentType = MIME_TYPES[extname(canonical).toLowerCase()] ?? "application/octet-stream";
        if (contentType.startsWith("text/html")) body = previewHtml(body, state.token);
        response.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
          "Content-Length": body.byteLength,
          "Content-Type": contentType,
          "Cross-Origin-Resource-Policy": "cross-origin",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(request.method === "HEAD" ? undefined : body);
      } catch {
        response.writeHead(404).end("Not found");
      }
    });
    await new Promise<void>((resolveListen, reject) => {
      state.server.once("error", reject);
      state.server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = state.server.address();
    if (!address || typeof address === "string") throw new Error("Preview server failed to start");
    state.port = address.port;
    return state;
  }
}

async function copyExternalEntry(source: string, destination: string): Promise<void> {
  try {
    await lstat(destination);
    throw new Error(`目标已存在：${destination}`);
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("目标已存在")) throw cause;
  }
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink()) throw new Error(`暂不支持复制符号链接：${source}`);
  if (metadata.isFile()) {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    return;
  }
  if (!metadata.isDirectory()) throw new Error(`不支持的文件类型：${source}`);
  await mkdir(destination);
  for (const entry of await readdir(source))
    await copyExternalEntry(join(source, entry), join(destination, entry));
}

async function buildFileIndex(root: string): Promise<string[]> {
  const pending = [root];
  const paths: string[] = [];
  while (pending.length) {
    const directory = pending.pop();
    if (!directory) break;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") pending.push(path);
      } else if (entry.isFile()) paths.push(relative(root, path));
    }
  }
  return paths.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
}

function commandExists(command: string): boolean {
  if (process.platform === "win32") return true;
  const directories = (process.env.PATH ?? "").split(":");
  return directories.some((directory) => {
    try {
      return requireStat(join(directory, command));
    } catch {
      return false;
    }
  });
}

function requireStat(path: string): boolean {
  // Kept synchronous only for a handful of PATH candidates before launching
  // a user-visible terminal.
  return Boolean(process.getBuiltinModule("node:fs")?.existsSync(path));
}
