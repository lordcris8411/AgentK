# Architecture

## Boundary

The sandboxed Chromium renderer never talks to Pi or the local file system directly. A context-isolated preload exposes a
small typed API, while the Electron main process owns the bounded pool of external Pi RPC processes and all privileged desktop
operations.

```text
React renderer <-> preload IPC <-> Electron main <-> pi --mode rpc <-> provider/tools/session
```

API keys cross only the IPC boundary and are never retained in browser storage or sent through Pi RPC. IPC handlers validate
arguments and workspace file operations reject paths outside the active project.

## Modules

- `src/features/conversation`: timeline, streaming messages, tool cards, composer.
- `src/features/sessions`: session list, active task selection, branching UI.
- `src/components/layout`: application shell, editor, preview and navigation.
- `src/features/file-formats`: process-free plugin selection and the sandboxed Editor frame bridge.
- `src/lib/desktop.ts`: process-free renderer port backed by the preload bridge.
- `electron/preload.cjs`: the only API exposed to the renderer.
- `electron/agent`: Pi process management, LF-delimited JSONL framing, request correlation and event forwarding.
- `electron/files.ts`: workspace-scoped file operations, session discovery and preview server.
- `electron/file-formats.ts`: Editor package discovery, strict manifest validation, runtime loading and dependency path validation.
- `electron/settings.ts` / `electron/resources.ts`: settings, providers, credentials, Skills and Extensions.
- `editor`: the typed Editor protocol adapter, independent first-party Editor packages and exact-version shared dependencies.
- `skills`: bundled Skills copied to stable application data and loaded through Pi's public `--skill` option.

## Pi independence

Pi source is not part of this repository. Release builds package an unmodified Pi distribution as an external child runtime;
development builds can use the same prepared runtime or another compatible installation. The launcher resolves Pi in this
order: `AGENT_K_PI_EXECUTABLE`, the executable configured in Agent Settings, `pi` from `PATH`, then the packaged runtime. In
every case the child is treated as a separate service implementing Pi's public JSONL RPC protocol. `.reference/pi/` is ignored
and excluded from every build input.

Features not directly represented by one RPC command remain compatibility logic in the Electron main process:

- local image paths are validated and converted to standard RPC `images` payloads;
- `session_changed` is synthesized after public session commands by reading public `get_state`;
- provider cards combine `get_available_models` with non-secret metadata from Pi's config files;
- simple API keys use Pi's `auth.json` schema and Unix credential files use mode `0600`;
- OAuth and structured authentication run through the official interactive Pi CLI;
- resource refresh replaces idle Pi children concurrently while preserving runtime IDs and sessions.

Pi remains authoritative for models, credentials, provider behavior and session data. New features must not depend on a
patched Pi source tree.

## Programmable Editor boundary

File Editors are independent browser micro-applications discovered through `SKILL.md` and a strict `editor.json` manifest.
Each compiled runtime executes in a unique-origin `<iframe sandbox="allow-scripts">` without Node.js, preload, Electron IPC,
host DOM or direct file-system access. Plugins own their DOM, CSS, framework and editing engine; there is no shared Editor UI
base class and packages do not import one another.

The renderer communicates with a plugin only through the versioned `editor/sdk/index.ts` message protocol. Messages are
checked against the frame window, API version and per-instance nonce. Privileged file reads and writes remain in Electron,
and runtime JavaScript, CSS, assets and real paths are validated before use.

Exact-version shared dependencies such as `monaco-editor@0.55.1` are served through the read-only `agentk-editor:` protocol so
Chromium can reuse its resource and V8 code caches across isolated frames. The renderer retains up to 40 recently used file
frames across tab, session and workspace switches and evicts the least recently used instance only when that bound is crossed.
