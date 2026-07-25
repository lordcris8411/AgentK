# Native Language Server plugin protocol

Native language support is split into three processes:

```text
Editor iframe -> Electron language-server host -> plugin worker -> LSP server
```

The Electron host only starts a worker, gives it a private cache directory, and
routes request/response/event messages. A worker owns all language-specific
behaviour such as project detection, toolchain preparation, build databases,
LSP process arguments, document ownership and diagnostics.

## Trusted package manifest

Install a native plugin below the application's `language-server-plugins`
directory. Native workers have Node and process privileges, so Agent K never
loads these packages directly from an opened project.

```text
language-server-plugins/
  example-lsp/
    agent-k.language-server.json
    worker.js
```

`agent-k.language-server.json` uses API version 1:

```json
{
  "apiVersion": 1,
  "id": "example-lsp",
  "languages": ["example"],
  "projectMarkers": ["example.config"],
  "worker": "worker.js",
  "debugServer": {
    "protocol": "dap",
    "adapters": [{ "command": "example-debug", "platforms": ["win32"] }]
  }
}
```

The worker path must be a `.js` file inside its own package. Duplicate IDs,
unsupported API versions, malformed manifests and path traversal are rejected.
Every plugin receives `cache/language-servers/<id>` as its cache root.

## Worker transport

Workers receive IPC requests of the form `{ type: "request", id, method,
args }` and answer with `{ type: "response", id, result }` or `{ type:
"response", id, error }`. They may publish `{ type: "event", event }` for
progress, status and diagnostics.

The built-in `cpp-clangd` worker is the reference implementation. Its
`debugServer` declaration reserves the Debug Adapter Protocol path for WinDbg
on Windows and LLDB/GDB on Linux/macOS; no debug adapter is launched yet.
