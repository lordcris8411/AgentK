# Architecture

## Boundary

The WebView never talks to Pi or the local file system directly. The Tauri backend owns a single local Pi RPC child process per workspace session and exposes a narrow command/event API to the frontend.

```text
React UI <-> Tauri command/event bridge <-> pi --mode rpc <-> provider/tools/session
```

This keeps provider credentials, shell execution, and the Pi JSONL protocol outside the browser security boundary.

## Modules

- `features/conversation`: timeline, streaming messages, tool cards, composer.
- `features/sessions`: session list, active task selection, branching UI.
- `components/layout`: application shell and navigation primitives.
- `lib/agent-client.ts`: frontend port. It starts as a mock and will be backed by Tauri events.
- `src-tauri/src/agent`: process management, strict LF JSONL framing, request correlation, and event forwarding.

## Delivery sequence

1. Establish the Codex-inspired shell and mock conversation state.
2. Spawn Pi in RPC mode and surface state plus streamed events.
3. Add session switching/tree navigation and tool activity rendering.
4. Add settings, provider/auth guidance, and platform packaging.

