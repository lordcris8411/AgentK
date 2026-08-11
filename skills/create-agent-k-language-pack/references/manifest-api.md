# Manifest and action API

`agent-k.language-pack.json` is API version 1 and `kind` is `language-pack`. Required fields are `id`, semantic `version`, `displayName`, `platforms`, `languages`, `fileExtensions`, `projectMarkers`, `worker`, non-empty `skills`, non-empty `actions`, `permissions`, and `toolchains`.

Each action declares `id`, worker `method`, description, and an object JSON Schema in `parameters`. Action IDs use these namespaces:

- `project.list/load/status/restart/unload`
- `language.diagnostics/definition/references/hover/symbols/completion/rename/format`
- Additional language actions use lowercase kebab segments, for example `language.organize-imports` (never camelCase).
- `build`, `run`, `test`
- `debug.configurations/start/attach/stop/...`

The generic worker method convention receives one object containing the declared arguments plus `action`. Lifecycle and semantic implementations must operate on the same in-memory project registry used by the Editor. Build/run/test return `code`, `stdout`, `stderr`, `artifacts`, `durationMs`, and `cancelled`.

`editorContribution` is required and references the core text Editor or a sandbox Editor shipped in the package. Optional `debugServer` declares DAP adapters and providers. Do not encode a language ID in host source or add a language-specific IPC capability.
