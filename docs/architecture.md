# Architecture

## Boundary

The WebView never talks to Pi or the local file system directly. The Tauri backend owns a bounded pool of local Pi RPC child processes and exposes a narrow command/event API to the frontend.

```text
React UI <-> Tauri command/event bridge <-> pi --mode rpc <-> provider/tools/session
```

This keeps credential persistence, shell execution, and the Pi JSONL protocol outside the browser security boundary. API
keys entered in the UI cross only the typed Tauri IPC command and are never retained in browser storage or sent through Pi RPC.

## Modules

- `features/conversation`: timeline, streaming messages, tool cards, composer.
- `features/sessions`: session list, active task selection, branching UI.
- `components/layout`: application shell and navigation primitives.
- `lib/desktop.ts`: frontend port backed by Tauri commands and events.
- `src-tauri/src/agent`: process management, strict LF JSONL framing, request correlation, and event forwarding.

## Repository layout

Pi is not part of this repository. The desktop launcher resolves `AGENT_K_PI_EXECUTABLE` and otherwise invokes `pi` from `PATH`.
The child process is treated as an external service implementing Pi's public JSONL RPC protocol.

The root npm workspace owns the desktop app and bundled AgentK extensions. Rust dependencies remain locked by
`src-tauri/Cargo.lock`. A local `.reference/pi/` clone is excluded from version control and every build input.

## Compatibility

Core prompting, sessions, models, commands, and extension UI use the upstream RPC contract. New features must not be
implemented by patching Pi source in this repository.

Features that Pi does not expose through public RPC live in the Tauri adapter:

- local image paths are validated and converted to standard RPC `images` payloads;
- `session_changed` is synthesized after public session commands by reading public `get_state`;
- provider cards combine public `get_available_models` results with non-secret metadata from Pi's documented config files;
- simple API keys use Pi's documented `auth.json` schema and Unix files are written with mode `0600`;
- OAuth and structured multi-field authentication run in the official interactive Pi CLI, in a native terminal on Linux
  or Windows;
- provider refresh replaces idle Pi child processes in place, preserving runtime IDs and selected sessions.

The compatibility catalog contains display names and supported authentication choices only. Pi remains authoritative for
models, credentials, provider behavior, and session data.
