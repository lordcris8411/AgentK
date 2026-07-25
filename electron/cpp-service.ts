import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

export type CppProjectStatus = "preparing" | "configuring" | "starting" | "indexing" | "ready" | "failed" | "stopped";
export type CppProject = { root: string; name: string; status: CppProjectStatus; error?: string; cmake: boolean; compileCommands: boolean };
export type CppLspTrace = { elapsedMs?: number; error?: string; file?: string; method: string; phase: "rejected" | "request" | "response" | "sent" | "timeout" | "write-error"; timestamp: number; version?: number };
type PendingRequest = { file?: string; method: string; reject(reason: Error): void; resolve(value: unknown): void; startedAt: number; timeout: ReturnType<typeof setTimeout>; version?: number };
type Entry = CppProject & { child?: ChildProcessWithoutNullStreams; nextId: number; pending: Map<number, PendingRequest>; stderrTail: string; writeQueue: Promise<void> };

/** Session-only clangd registry. Tool locations are deliberately private to app data. */
export class CppService {
  private readonly projects = new Map<string, Entry>();
  private provisioning?: Promise<string>;
  private provisionAbort?: AbortController;
  private activeCommand?: ReturnType<typeof spawn>;
  private cancellationRequested = false;
  private readonly traces: CppLspTrace[] = [];
  constructor(private readonly cachePath: string, private readonly emit: (event: Record<string, unknown>) => void) {}
  private publish(entry: Entry) { this.emit({ type: "cpp_project", project: this.public(entry) }); }
  private public(entry: Entry): CppProject { const { root, name, status, error, cmake, compileCommands } = entry; return { root, name, status, ...(error ? { error } : {}), cmake, compileCommands }; }
  list(): CppProject[] { return [...this.projects.values()].map((entry) => this.public(entry)); }
  trace(): CppLspTrace[] { return [...this.traces]; }
  private record(trace: CppLspTrace) { this.traces.push(trace); if (this.traces.length > 200) this.traces.splice(0, this.traces.length - 200); }
  private traceMetadata(params: unknown): Pick<CppLspTrace, "file" | "version"> {
    const value = params as { textDocument?: { uri?: unknown; version?: unknown } } | undefined;
    const uri = value?.textDocument?.uri; const version = value?.textDocument?.version;
    let file: string | undefined; if (typeof uri === "string") try { file = fileURLToPath(uri); } catch { /* URI is optional diagnostic metadata. */ }
    return { ...(file ? { file } : {}), ...(typeof version === "number" ? { version } : {}) };
  }
  projectFor(file: string): CppProject | undefined {
    const normalized = resolve(file).replaceAll("\\", "/").toLowerCase();
    return this.list().filter((p) => normalized === p.root.replaceAll("\\", "/").toLowerCase() || normalized.startsWith(`${p.root.replaceAll("\\", "/").toLowerCase()}/`)).sort((a, b) => b.root.length - a.root.length)[0];
  }
  async load(rootInput: string): Promise<CppProject> {
    const root = await realpath(rootInput); this.cancellationRequested = false; const existing = this.projects.get(root); if (existing) return this.public(existing);
    const cmake = existsSync(join(root, "CMakeLists.txt"));
    const entry: Entry = { root, name: basename(root), status: "preparing", cmake, compileCommands: false, nextId: 1, pending: new Map(), stderrTail: "", writeQueue: Promise.resolve() };
    this.projects.set(root, entry); this.publish(entry);
    try {
      const bin = await this.managedBin();
      let commandsDir = root;
      if (cmake) { entry.status = "configuring"; this.publish(entry); commandsDir = await this.configure(root, bin); entry.compileCommands = true; }
      await this.start(entry, join(bin, process.platform === "win32" ? "clangd.exe" : "clangd"), commandsDir, bin);
      return this.public(entry);
    } catch (cause) { await rm(`${join(this.cachePath, "cpp-toolchain", process.platform, process.arch)}.partial`, { recursive: true, force: true }); if (this.cancellationRequested) { this.projects.delete(root); this.emit({ type: "cpp_project_removed", root }); return { ...this.public(entry), status: "stopped" }; } entry.status = "failed"; entry.error = cause instanceof Error ? cause.message : String(cause); this.publish(entry); return this.public(entry); }
  }
  async unload(root: string) { const entry = this.projects.get(await realpath(root)); if (!entry) return; this.stop(entry); this.projects.delete(entry.root); this.emit({ type: "cpp_project_removed", root: entry.root }); }
  async restart(root: string) { await this.unload(root); return this.load(root); }
  shutdown() { for (const entry of this.projects.values()) this.stop(entry); this.projects.clear(); }
  cancel(): void { this.cancellationRequested = true; this.provisionAbort?.abort(); this.activeCommand?.kill(); }
  async lsp(file: string, method: string, params: unknown): Promise<unknown> {
    const canonical = resolve(file); const project = this.projectFor(canonical);
    // Opening an ordinary C++ file must remain useful without first loading a
    // project. Treat its optional language-service calls as unavailable rather
    // than surfacing an IPC exception in Electron's console.
    if (!project) { this.record({ method, phase: "rejected", timestamp: Date.now(), ...this.traceMetadata(params), error: "file is outside loaded C++ projects" }); return undefined; }
    const entry = this.projects.get(project.root); if (!entry?.child || entry.status !== "ready") { this.record({ method, phase: "rejected", timestamp: Date.now(), ...this.traceMetadata(params), error: `clangd status is ${entry?.status ?? "unavailable"}` }); return undefined; }
    await entry.writeQueue;
    try { return await this.request(entry, method, params); }
    catch (cause) {
      // clangd versions differ in support for optional pull diagnostics and
      // semantic-token requests. It also cancels an in-flight query when a
      // didChange arrives first. Both are normal optional-service outcomes,
      // not Electron IPC errors.
      if (!(cause instanceof Error) || !/(method not found|request cancelled because the document was modified|clangd request timed out)/i.test(cause.message)) throw cause;
      if (method === "textDocument/completion") return { items: [] };
      if (method === "textDocument/definition") return [];
      if (method === "textDocument/diagnostic") return { items: [] };
      if (method === "textDocument/semanticTokens/full") return { data: [] };
      if (method === "textDocument/hover") return null;
      return undefined;
    }
  }
  async notify(file: string, method: string, params: unknown): Promise<void> {
    const canonical = resolve(file); const project = this.projectFor(canonical); const entry = project ? this.projects.get(project.root) : undefined;
    if (!entry) { this.record({ method, phase: "rejected", timestamp: Date.now(), ...this.traceMetadata(params), error: "file is outside loaded C++ projects" }); return; }
    await this.enqueueNotification(entry, method, params);
  }
  private enqueueNotification(entry: Entry, method: string, params: unknown): Promise<void> {
    const metadata = this.traceMetadata(params);
    const write = entry.writeQueue.catch(() => undefined).then(() => new Promise<void>((resolveWrite) => {
      if (!entry.child || entry.status !== "ready" || entry.child.killed || entry.child.stdin.destroyed || !entry.child.stdin.writable) { this.record({ method, phase: "rejected", timestamp: Date.now(), ...metadata, error: "clangd stdin is unavailable" }); resolveWrite(); return; }
      const payload = JSON.stringify({ jsonrpc: "2.0", method, params }); entry.child.stdin.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`, (cause) => { this.record({ method, phase: cause ? "write-error" : "sent", timestamp: Date.now(), ...metadata, ...(cause ? { error: String(cause) } : {}) }); resolveWrite(); });
    }));
    entry.writeQueue = write;
    return write;
  }
  private stop(entry: Entry) {
    entry.status = "stopped";
    for (const pending of entry.pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error("clangd stopped")); }
    entry.pending.clear();
    entry.child?.stdin.destroy();
    if (entry.child && !entry.child.killed) entry.child.kill();
  }
  private async managedBin(): Promise<string> {
    const bin = join(this.cachePath, "cpp-toolchain", process.platform, process.arch, "bin");
    const executable = process.platform === "win32" ? ".exe" : "";
    if (["clangd", "clang", "clang++", "cmake", "ninja"].every((name) => existsSync(join(bin, `${name}${executable}`)))) { this.emit({ type: "cpp_progress", stage: "preparing", detail: "Reusing cached C++ toolchain" }); return bin; }
    this.provisionAbort ??= new AbortController(); this.provisioning ??= this.provision(bin, this.provisionAbort.signal).finally(() => { this.provisioning = undefined; this.provisionAbort = undefined; });
    return this.provisioning;
  }
  private async provision(bin: string, signal: AbortSignal): Promise<string> {
    if (!((process.platform === "win32" || process.platform === "linux") && process.arch === "x64")) throw new Error("Automatic C++ toolchain installation supports Windows/Linux x64 only");
    const root = join(this.cachePath, "cpp-toolchain", process.platform, process.arch); const staging = `${root}.partial`; const archiveCache = join(this.cachePath, "cpp-toolchain-downloads", process.platform, process.arch);
    await rm(staging, { recursive: true, force: true }); await Promise.all([mkdir(staging, { recursive: true }), mkdir(archiveCache, { recursive: true })]);
    const platform = process.platform === "win32" ? "windows" : "linux";
    const cmake = process.platform === "win32" ? "cmake-3.31.6-windows-x86_64.zip" : "cmake-3.31.6-linux-x86_64.tar.gz";
    const ninja = process.platform === "win32" ? "ninja-win.zip" : "ninja-linux.zip";
    const llvm = process.platform === "win32" ? "clang+llvm-22.1.6-x86_64-pc-windows-msvc.tar.xz" : "LLVM-22.1.6-Linux-X64.tar.xz";
    this.emit({ type: "cpp_progress", stage: "preparing", detail: `Preparing managed ${platform} toolchain` });
    await this.downloadRelease("Kitware", "CMake", "v3.31.6", cmake, staging, archiveCache, "cmake", process.platform === "win32" ? "d163cd3ab4959b0a53fa8988f2ddbd2e6c501658201e6a154386bad9dbe4f836" : "5a1133ff103c71eb5120e2cc3de922733e7d8a26a98ae716397e8676adb367bf", signal);
    await this.downloadRelease("ninja-build", "ninja", "v1.12.1", ninja, staging, archiveCache, "ninja", process.platform === "win32" ? "f550fec705b6d6ff58f2db3c374c2277a37691678d6aba463adcbb129108467a" : "6f98805688d19672bd699fbbfa2c2cf0fc054ac3df1f0e6a47664d963d530255", signal);
    await this.downloadRelease("llvm", "llvm-project", "llvmorg-22.1.6", llvm, staging, archiveCache, "llvm", process.platform === "win32" ? "657343edf361ca463bd642e39c74b251c6338b96cdbd55ff277555298b027696" : "c5ac8ef89ca39d30cb32e9b83772f995dd891c685ebc188d593c943a64d5f8b5", signal);
    // Archives retain top-level directories. Preserve CMake's share tree and LLVM's lib tree next to
    // the private bin directory: both tools resolve resources relative to their executable.
    const executable = process.platform === "win32" ? ".exe" : ""; const candidates = ["clangd", "clang", "clang++", "cmake", "ninja"];
    await mkdir(join(staging, "bin"), { recursive: true });
    const cmakeSource = await this.findExecutable(staging, `cmake${executable}`);
    const clangSource = await this.findExecutable(staging, `clang${executable}`);
    if (!cmakeSource || !clangSource) throw new Error("Provisioned toolchain is incomplete");
    const cmakeRoot = dirname(dirname(cmakeSource)); const llvmRoot = dirname(dirname(clangSource));
    if (existsSync(join(cmakeRoot, "share"))) await rename(join(cmakeRoot, "share"), join(staging, "share"));
    if (existsSync(join(llvmRoot, "lib"))) await rename(join(llvmRoot, "lib"), join(staging, "lib"));
    await this.moveDirectoryEntries(dirname(cmakeSource), join(staging, "bin"));
    await this.moveDirectoryEntries(dirname(clangSource), join(staging, "bin"));
    for (const name of candidates) { const found = await this.findExecutable(staging, `${name}${executable}`); if (!found) throw new Error(`Provisioned ${name} is missing`); const target = join(staging, "bin", `${name}${executable}`); if (found !== target) await rename(found, target); }
    await rm(root, { recursive: true, force: true }); await rename(staging, root); this.emit({ type: "cpp_progress", stage: "ready", detail: "Managed C++ toolchain is ready" }); return bin;
  }
  private async findExecutable(directory: string, name: string): Promise<string | undefined> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) { const full = join(directory, entry.name); if (entry.isFile() && entry.name === name) return full; if (entry.isDirectory()) { const found = await this.findExecutable(full, name); if (found) return found; } } return undefined;
  }
  private async moveDirectoryEntries(source: string, destination: string): Promise<void> {
    for (const entry of await readdir(source)) { const from = join(source, entry); const to = join(destination, entry); if (from !== to && !existsSync(to)) await rename(from, to); }
  }
  private async archiveMatches(path: string, expectedSha256: string): Promise<boolean> { if (!existsSync(path)) return false; try { const hash = createHash("sha256"); const { createReadStream } = await import("node:fs"); await pipeline(createReadStream(path), hash); return hash.digest("hex") === expectedSha256; } catch { return false; } }
  private async downloadRelease(owner: string, repo: string, tag: string, assetName: string, directory: string, archiveCache: string, tool: string, expectedSha256: string, signal: AbortSignal): Promise<void> {
    const archive = join(directory, assetName); const cachedArchive = join(archiveCache, assetName);
    if (await this.archiveMatches(cachedArchive, expectedSha256)) { const size = (await stat(cachedArchive)).size; this.emit({ type: "cpp_progress", stage: "downloading", tool, bytes: size, total: size, rate: 0, detail: `${assetName} (reused cache)` }); await copyFile(cachedArchive, archive); this.emit({ type: "cpp_progress", stage: "extracting", tool, detail: assetName }); await this.extract(archive, directory); await rm(archive, { force: true }); return; }
    await rm(cachedArchive, { force: true }); const api = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Agent-K" }, signal }); if (!api.ok) throw new Error(`Unable to locate ${tool} release (${api.status})`);
    const release = await api.json() as { assets?: Array<{ name: string; browser_download_url: string }> }; const asset = release.assets?.find((item) => item.name === assetName); if (!asset) throw new Error(`Release asset is unavailable for ${tool}`); const response = await fetch(asset.browser_download_url, { headers: { "User-Agent": "Agent-K" }, signal }); if (!response.ok || !response.body) throw new Error(`Unable to download ${tool} (${response.status})`);
    const total = Number(response.headers.get("content-length") ?? 0); let received = 0; const started = Date.now(); const reader = response.body.getReader(); const emit = this.emit;
    const cancellation = new Error("C++ project load cancelled");
    const stream = new Readable({ read() { void reader.read().then((next) => { if (next.done) this.push(null); else { received += next.value.byteLength; const seconds = Math.max(0.001, (Date.now() - started) / 1000); emit({ type: "cpp_progress", stage: "downloading", tool, bytes: received, total, rate: Math.round(received / seconds), detail: assetName }); this.push(Buffer.from(next.value)); } }).catch((cause) => this.destroy(cause)); } });
    const abortDownload = () => { void reader.cancel().catch(() => undefined); stream.destroy(cancellation); };
    if (signal.aborted) abortDownload(); else signal.addEventListener("abort", abortDownload, { once: true });
    try { await pipeline(stream, createWriteStream(archive)); } finally { signal.removeEventListener("abort", abortDownload); }
    if (!await this.archiveMatches(archive, expectedSha256)) throw new Error(`Checksum verification failed for ${tool}`); const cachedPartial = `${cachedArchive}.partial`; await rm(cachedPartial, { force: true }); await copyFile(archive, cachedPartial); await rename(cachedPartial, cachedArchive);
    this.emit({ type: "cpp_progress", stage: "extracting", tool, detail: assetName }); await this.extract(archive, directory); await rm(archive, { force: true });
  }
  private async extract(archive: string, directory: string): Promise<void> { await this.run(process.platform === "win32" ? "tar.exe" : "tar", ["-xf", archive, "-C", directory], directory, ""); }
  private async configure(root: string, bin: string): Promise<string> {
    const key = createHash("sha256").update(root).digest("hex"); const build = join(this.cachePath, "cpp-build", key);
    await mkdir(build, { recursive: true }); const cmake = join(bin, process.platform === "win32" ? "cmake.exe" : "cmake");
    if (!existsSync(cmake)) throw new Error("Managed CMake is unavailable");
    await this.run(cmake, ["-S", root, "-B", build, "-G", "Ninja", "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON", `-DCMAKE_C_COMPILER=${join(bin, process.platform === "win32" ? "clang.exe" : "clang")}`, `-DCMAKE_CXX_COMPILER=${join(bin, process.platform === "win32" ? "clang++.exe" : "clang++")}`], root, bin);
    const commands = join(build, "compile_commands.json");
    if (!existsSync(commands)) throw new Error("CMake did not generate compile_commands.json");
    // CMake writes -include-pch flags into its compilation database. This
    // feature configures without building, so a newly configured project has
    // no PCH yet. Retain an existing PCH by reference (never copy it); remove
    // only missing PCH inputs while keeping CMake's wrapper header (-include).
    await this.stripMissingPrecompiledHeaders(commands);
    return build;
  }
  private async stripMissingPrecompiledHeaders(commandsPath: string): Promise<void> {
    type Command = { arguments?: unknown; command?: unknown };
    let commands: Command[];
    try { const value = JSON.parse(await readFile(commandsPath, "utf8")) as unknown; if (!Array.isArray(value)) return; commands = value as Command[]; } catch { return; }
    let changed = false;
    for (const entry of commands) {
      if (typeof entry.command === "string") {
        const sanitized = entry.command.replace(/-Xclang\s+-include-pch\s+-Xclang\s+("[^"]+"|\S+)\s*/g, (match, rawPath: string) => {
          const pch = rawPath.startsWith('"') ? rawPath.slice(1, -1) : rawPath;
          return existsSync(pch) ? match : "";
        });
        changed ||= sanitized !== entry.command; entry.command = sanitized;
      }
      if (!Array.isArray(entry.arguments)) continue;
      const argumentsList = entry.arguments.filter((item): item is string => typeof item === "string"); const sanitized: string[] = [];
      for (let index = 0; index < argumentsList.length; index += 1) {
        const pch = argumentsList[index + 3];
        if (argumentsList[index] === "-Xclang" && argumentsList[index + 1] === "-include-pch" && argumentsList[index + 2] === "-Xclang" && typeof pch === "string" && !existsSync(pch)) { index += 3; changed = true; continue; }
        const argument = argumentsList[index]; if (argument !== undefined) sanitized.push(argument);
      }
      entry.arguments = sanitized;
    }
    if (changed) await writeFile(commandsPath, `${JSON.stringify(commands, undefined, 2)}\n`, "utf8");
  }
  private run(command: string, args: string[], cwd: string, bin: string) { return new Promise<void>((resolveRun, reject) => { const child = spawn(command, args, { cwd, windowsHide: true, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` } }); this.activeCommand = child; let log = ""; child.stdout.on("data", b => { log += b; this.emit({ type: "cpp_progress", stage: "cmake", detail: String(b) }); }); child.stderr.on("data", b => { log += b; this.emit({ type: "cpp_progress", stage: "cmake", detail: String(b) }); }); child.once("error", reject); child.once("close", code => { if (this.activeCommand === child) this.activeCommand = undefined; code === 0 ? resolveRun() : reject(new Error(log || `CMake exited with ${code}`)); }); }); }
  private async start(entry: Entry, clangd: string, commandsDir: string, bin: string) {
    if (!existsSync(clangd)) throw new Error("Managed clangd is unavailable");
    entry.status = "starting"; this.publish(entry);
    // Keep background indexing, but make interactive completion/diagnostics
    // win on large projects. PCHs stay on disk rather than inflating the
    // long-lived language-service process.
    const child = spawn(clangd, ["--background-index", "--background-index-priority=background", "--pch-storage=disk", "-j", "2", `--compile-commands-dir=${commandsDir}`], { cwd: entry.root, windowsHide: true, stdio: "pipe", env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` } });
    entry.child = child; entry.status = "indexing"; this.publish(entry);
    let buffer = Buffer.alloc(0);
    const fail = (cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      entry.status = "failed"; entry.error = error.message; this.publish(entry);
      for (const pending of entry.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
      entry.pending.clear(); child.kill();
    };
    child.stdin.on("error", (cause) => { if (entry.status !== "stopped") fail(cause); });
    child.stderr.on("data", (data: Buffer) => {
      // clangd's stderr is diagnostic-only. Keep a bounded tail so a request
      // timeout can be investigated without altering its scheduling or I/O.
      entry.stderrTail = `${entry.stderrTail}${data.toString("utf8")}`.slice(-8_192);
    });
    child.stdout.on("data", (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      for (;;) {
        const headerEnd = buffer.indexOf("\r\n\r\n"); if (headerEnd < 0) break;
        const header = buffer.subarray(0, headerEnd).toString("ascii"); const length = /Content-Length: (\d+)/i.exec(header)?.[1];
        if (!length) { buffer = buffer.subarray(headerEnd + 4); continue; }
        const bodyStart = headerEnd + 4; const bodyEnd = bodyStart + Number(length); if (buffer.length < bodyEnd) break;
        const payload = buffer.subarray(bodyStart, bodyEnd).toString("utf8"); buffer = buffer.subarray(bodyEnd);
        try {
          const message = JSON.parse(payload) as { id?: number; method?: unknown; params?: { diagnostics?: unknown; uri?: unknown }; result?: unknown; error?: { message?: string } };
          if (message.method === "textDocument/publishDiagnostics" && typeof message.params?.uri === "string" && Array.isArray(message.params.diagnostics)) {
            try { this.emit({ type: "cpp_diagnostics", file: fileURLToPath(message.params.uri), diagnostics: message.params.diagnostics }); } catch { /* Ignore malformed server URIs. */ }
            continue;
          }
          if (typeof message.id !== "number") continue;
          const pending = entry.pending.get(message.id); if (!pending) continue;
          entry.pending.delete(message.id); clearTimeout(pending.timeout); this.record({ method: pending.method, phase: "response", timestamp: Date.now(), ...(pending.file ? { file: pending.file } : {}), ...(pending.version === undefined ? {} : { version: pending.version }), elapsedMs: Date.now() - pending.startedAt, ...(message.error ? { error: message.error.message ?? "clangd error" } : {}) }); message.error ? pending.reject(new Error(message.error.message ?? "clangd error")) : pending.resolve(message.result);
        } catch (cause) { fail(new Error(`Invalid clangd response: ${cause instanceof Error ? cause.message : String(cause)}`)); return; }
      }
    });
    child.once("error", fail);
    child.once("close", () => { if (entry.status !== "stopped" && entry.status !== "failed") { entry.status = "stopped"; this.publish(entry); } });
    await this.request(entry, "initialize", { processId: process.pid, rootUri: `file://${entry.root.replaceAll("\\", "/")}`, capabilities: { textDocument: { publishDiagnostics: { relatedInformation: true }, semanticTokens: { formats: ["relative"], multilineTokenSupport: false, overlappingTokenSupport: false, requests: { full: true }, tokenModifiers: ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"], tokenTypes: ["namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator"] } } } });
    const initialized = JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }); child.stdin.write(`Content-Length: ${Buffer.byteLength(initialized)}\r\n\r\n${initialized}`);
    entry.status = "ready"; this.publish(entry);
    // The progress dialog must track the authoritative service lifecycle, not
    // merely the load RPC's return. This also covers a renderer IPC response
    // arriving after CMake/clangd have already completed successfully.
    this.emit({ type: "cpp_progress", stage: "ready", detail: "C++ language service is ready" });
  }
  request(entry: Entry, method: string, params: unknown): Promise<unknown> {
    if (!entry.child || entry.child.killed || entry.child.stdin.destroyed || !entry.child.stdin.writable) return Promise.reject(new Error("clangd is not running"));
    const id = entry.nextId++; const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolveRequest, reject) => {
      const metadata = this.traceMetadata(params); const startedAt = Date.now();
      const rejectPending = (error: Error) => {
        const pending = entry.pending.get(id); if (!pending) return;
        entry.pending.delete(id); clearTimeout(pending.timeout); this.record({ method, phase: /timed out/i.test(error.message) ? "timeout" : "write-error", timestamp: Date.now(), ...metadata, elapsedMs: Date.now() - startedAt, error: error.message }); pending.reject(error);
      };
      const timeout = setTimeout(() => {
        const stderr = entry.stderrTail.trim();
        rejectPending(new Error(`clangd request timed out (${method})${stderr ? `\nclangd stderr tail:\n${stderr}` : ""}`));
      }, method === "initialize" ? 15_000 : 5_000);
      entry.pending.set(id, { resolve: resolveRequest, reject, timeout, method, startedAt, ...metadata }); this.record({ method, phase: "request", timestamp: startedAt, ...metadata });
      entry.child!.stdin.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`, (cause) => {
        if (cause) rejectPending(cause instanceof Error ? cause : new Error(String(cause)));
      });
    });
  }
}

// This module is the built-in cpp-clangd language-plugin worker when launched
// by LanguageServerHost. Keeping the protocol here makes the C++ lifecycle
// independent of Electron's backend: the backend only forks this process and
// forwards opaque method calls/events.
type WorkerRequest = { args?: unknown[]; id: number; method?: unknown; type?: unknown };
type WorkerResponse = { error?: string; id: number; result?: unknown; type: "response" };

if (typeof process.send === "function") {
  let service: CppService | undefined;
  const reply = (response: WorkerResponse) => process.send?.(response);
  process.on("message", (message: WorkerRequest) => {
    if (message.type !== "request" || typeof message.id !== "number" || typeof message.method !== "string") return;
    void (async () => {
      try {
        if (message.method === "initialize") {
          const cachePath = message.args?.[0];
          if (typeof cachePath !== "string") throw new Error("Language worker cache path is required");
          service = new CppService(cachePath, (event) => process.send?.({ event, type: "event" }));
          reply({ id: message.id, result: undefined, type: "response" });
          return;
        }
        if (!service) throw new Error("Language worker is not initialized");
        const args = message.args ?? [];
        let result: unknown;
        switch (message.method) {
          case "load": result = await service.load(String(args[0] ?? "")); break;
          case "list": result = service.list(); break;
          case "trace": result = service.trace(); break;
          case "unload": result = await service.unload(String(args[0] ?? "")); break;
          case "restart": result = await service.restart(String(args[0] ?? "")); break;
          case "cancel": service.cancel(); break;
          case "lsp": result = await service.lsp(String(args[0] ?? ""), String(args[1] ?? ""), args[2]); break;
          case "notify": result = await service.notify(String(args[0] ?? ""), String(args[1] ?? ""), args[2]); break;
          case "shutdown": service.shutdown(); break;
          default: throw new Error(`Unknown language worker method: ${message.method}`);
        }
        reply({ id: message.id, result, type: "response" });
      } catch (cause) {
        reply({ error: cause instanceof Error ? cause.message : String(cause), id: message.id, type: "response" });
      }
    })();
  });
}
