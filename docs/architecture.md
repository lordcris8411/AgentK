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
- `src/lib/desktop.ts`: process-free renderer port backed by the preload bridge.
- `electron/preload.cjs`: the only API exposed to the renderer.
- `electron/agent`: Pi process management, LF-delimited JSONL framing, request correlation and event forwarding.
- `electron/files.ts`: workspace-scoped file operations, session discovery and preview server.
- `electron/settings.ts` / `electron/resources.ts`: settings, providers, credentials, Skills and Extensions.
- `skills`: bundled Skills copied to stable application data and loaded through Pi's public `--skill` option.

## Pi independence

Pi is not part of this repository. The desktop launcher resolves `AGENT_K_PI_EXECUTABLE` and otherwise invokes `pi` from
`PATH`. The child is treated as an external service implementing Pi's public JSONL RPC protocol. `.reference/pi/` is ignored
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
