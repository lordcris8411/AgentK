# Contributing to Agent K

Agent K is an independent Electron desktop client for Pi. Changes must stay within Pi's public RPC and Extension boundaries
and must never require a patched or vendored Pi source tree. The React renderer is process-free; local files, PTYs, Pi
children, native language workers, credentials, and other privileged operations belong in the Electron main process.

```bash
npm ci --ignore-scripts
npm run prepare:native
npm run build:editors
npm run build:language-servers
npm run check
npm test
```

Keep pull requests focused and document any minimum Pi version or optional RPC capability they require.
Editor packages must remain independent: keep implementation and CSS inside each package, declare exact-version shared
dependencies in `editor.json`, and do not add a common Editor UI base class or imports between plugins.

Native language extensions are trusted code. Keep language-specific project detection, toolchain management, LSP/DAP
behavior, and diagnostics inside the package worker under `language-servers/`; the generic host and React UI must route only
manifest-declared commands and opaque worker RPC. Do not load native workers from an opened project.

Use exact dependency versions, preserve strict TypeScript, stage explicit paths, and update the relevant documents when a
public command, manifest field, installation path, or security boundary changes. See the [architecture](docs/architecture.md),
[Editor SDK](docs/file-format-sdk.md), and [native language-extension protocol](docs/language-server-plugin.md).
