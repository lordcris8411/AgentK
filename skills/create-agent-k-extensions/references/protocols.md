# Agent K extension protocols

Read the canonical docs before authoring packages:

- `docs/file-format-sdk.md` for Editor manifests, independent CSS/DOM, sandbox bridge, context menus, shared dependencies, and runtime assets.
- `docs/language-server-plugin.md` for trusted native workers, installation roots, generic RPC/events, project menus, Editor contributions, LSP routing, and DAP declarations.

Editor packages require `editor.json`, `SKILL.md`, source, and a built browser runtime. Use API v1, a stable ID, name,
description, semantic version, at least one match rule, and only relative runtime paths. `runtime.menu` points to a separate
`defineContextMenu` bundle; there is no `contextActions` field or common Editor base class.

Language project workers use generic events/RPC; core methods are `initialize`, `list`, `load`, `unload`, `restart`, `cancel`,
`trace`, `lsp`, `notify`, and `shutdown`, plus manifest-declared project action methods. Keep managed caches and generated
build databases outside opened projects, verify downloaded tools, and never let runtime or workspace paths escape their
validated roots. Native workers are trusted application packages and must never be discovered from project directories.
