# Architecture

## Process boundaries

Agent K is an Electron visual client. The sandboxed Chromium renderer never talks directly to Pi, the local filesystem, a
PTY, or a native language server. A context-isolated preload exposes a small typed API, and the Electron main process owns all
privileged desktop operations.

```text
React renderer
  ├─ preload IPC ─> Electron main ─> Pi RPC worker pool ─> pi --mode rpc
  ├─ preload IPC ─> Electron main ─> files / previews / native project PTY
  ├─ postMessage ─> sandboxed Editor iframe
  └─ Editor bridge ─> Electron main ─> native language worker ─> LSP server
```

The renderer has no Node.js integration. `electron/preload.cjs` is the only renderer-facing desktop bridge, and its values are
structured-cloneable commands and events rather than process objects. IPC handlers validate arguments; workspace file
operations resolve real paths and reject access outside the active project.

## Main modules

- `src/features/conversation/`: timeline, streaming text/reasoning/tool events, approvals, composer, slash commands, context
  usage, automatic compaction status, forks, and same-session tree navigation.
- `src/features/sessions/`: workspaces and sessions, pinning, activity ordering, rename/delete/duplicate actions, and runtime
  attachment state.
- `src/components/layout/`: resizable application shell, project file tree, advanced content search, Editor tabs, previews, and
  the native project terminal.
- `src/features/file-formats/`: process-free Editor selection and the sandboxed frame bridge.
- `src/lib/desktop.ts`: typed renderer port backed by the preload bridge.
- `electron/main.ts` / `electron/preload.cjs`: Electron lifecycle, windows, protocols, IPC, and the only renderer bridge.
- `electron/backend.ts`: privileged command dispatcher joining settings, files, Pi workers, resources, and language workers.
- `electron/agent/`: external Pi process management, LF-delimited JSONL framing, request correlation, event forwarding, and
  the reusable worker pool.
- `electron/files.ts`: workspace-scoped files, directory operations, search, preview servers, and native PTYs.
- `electron/file-formats.ts`: Editor discovery, strict manifest validation, installation, runtime loading, and dependency-path
  validation.
- `electron/language-server-host.ts` / `electron/language-server-registry.ts`: trusted native package discovery, lazy worker
  processes, and plugin-neutral request/event routing.
- `electron/settings.ts` / `electron/resources.ts`: persisted client settings, providers, credentials, Skills, Extensions, and
  their enablement rules.
- `editor/`: typed Editor message SDK, independent first-party Editor packages, and exact-version shared browser dependencies.
- `language-servers/`: trusted native language packages. The bundled `cpp-clangd` package owns CMake detection, its managed
  toolchain, compilation databases, clangd lifecycle, diagnostics, and LSP transport.
- `extensions/` and `skills/`: bundled Pi Extensions and Skills loaded through Pi's public package/CLI interfaces.

## Pi independence and worker pool

Pi source is not part of this repository. Release builds package an unmodified Pi distribution as a child-process runtime;
development builds can use that prepared runtime or another compatible installation. The launcher resolves Pi in this order:

1. `AGENT_K_PI_EXECUTABLE`
2. the executable configured in Agent Settings
3. `pi` on `PATH`
4. the packaged runtime

Every choice is treated as a separate service implementing Pi's public JSONL RPC protocol. `.reference/pi/` is ignored and
excluded from build inputs. New features must not depend on a patched Pi source tree.

The pool keeps a configurable minimum of two to four Pi children. It remembers runtime/session/workspace affinity, reuses an
available matching worker, starts another when all workers are busy, and retires excess idle workers. Resource changes are
queued in Settings and applied as one pool refresh only after active tasks and extension dialogs finish; replacement workers
restore their sessions before the old set is discarded.

Compatibility behavior that is not represented by one RPC request remains in the Electron main process:

- local image paths are validated and converted to standard RPC `images` payloads;
- `session_changed` is synthesized after public session commands by reading public `get_state`;
- provider cards combine `get_available_models` with non-secret metadata from Pi configuration;
- simple API keys use Pi's `auth.json` schema and Unix credential files use mode `0600`;
- OAuth and structured authentication run through the official interactive Pi CLI;
- Editor state is appended to the outbound user message only when its matching Editor Skill is enabled. The visible message
  remains clean, while the exact outbound payload is available under “Raw information / 原始信息”.

Pi remains authoritative for models, credentials, provider behavior, session trees, and conversation data.

## Programmable Editor boundary

File Editors are independent browser micro-applications discovered through a required `SKILL.md` and strict `editor.json`.
Each compiled runtime executes in a unique-origin `<iframe sandbox="allow-scripts">` without Node.js, preload, Electron IPC,
host DOM, cookies, or direct filesystem access. Plugins own their DOM, CSS, framework, and editing engine; there is no shared
Editor UI base class and packages do not import one another.

The renderer communicates with a plugin only through the versioned `editor/sdk/index.ts` message protocol. Messages are
checked against the frame window, API version, and per-instance nonce. Content, selection, dirty state, saves, theme, word
wrap, file navigation, line references, plugin actions, and optional language requests all cross this bridge. Privileged reads
and writes remain in Electron, and runtime JavaScript, CSS, assets, dependencies, and real paths are validated before use.

Exact-version browser dependencies such as `monaco-editor@0.55.1` are served through the read-only `agentk-editor:` protocol,
allowing Chromium to reuse resource and V8 code caches across isolated frames. The renderer retains up to 40 recently used
file frames across tab, session, and workspace switches and evicts the least recently used instance only after that bound is
crossed.

See [File-format SDK](file-format-sdk.md).

## Native language-extension boundary

Native language extensions are trusted packages, not Editor frames. Agent K discovers bundled packages and installed packages
under the application-data `language-server-plugins/` directory; it never executes a worker from an opened project. The
generic host lazily forks the package's built JavaScript worker with a private cache root and routes opaque requests, responses,
and events.

The worker owns language-specific behavior: project markers, managed language tools, build databases, LSP/DAP processes,
diagnostics, and project lifecycle. The bundled C++ worker downloads pinned CMake, Ninja, and standalone clangd archives on
Windows/Linux x64, verifies SHA-256 checksums, stores them in application cache, and uses a compiler available in the project
environment to generate CMake metadata outside the project. clangd starts only for explicitly loaded projects. The Editor bridge forwards
optional semantic requests by language without importing C++ logic into the host or text Editor.

The bundled C++ Language Skill is loaded into Pi through its public Skill interface. Its tool request crosses Pi's Extension UI
channel back into Electron, then reaches the same trusted `cpp-clangd` worker that owns the UI's loaded-project state. Pi never
launches a second clangd instance, and queries cannot implicitly load a workspace.

See [Native language-extension protocol](language-server-plugin.md).

## Credentials and security

API keys cross the isolated IPC boundary and are never retained in browser storage or sent as chat content. Agent K and every
external Pi, Extension, Skill, terminal command, and native language worker still execute with the current user's operating-
system permissions. UI approval is a workflow guard, not an OS sandbox; use a container or virtual machine for untrusted code.
