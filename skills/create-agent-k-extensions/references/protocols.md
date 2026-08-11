# Agent K extension protocols

Read the canonical docs before authoring packages:

- `docs/file-format-sdk.md` for Editor manifests, independent CSS/DOM, sandbox bridge, context menus, shared dependencies, and runtime assets.

Editor packages require `editor.json`, `SKILL.md`, source, and a built browser runtime. Use API v1, a stable ID, name,
description, semantic version, at least one match rule, and only relative runtime paths. `runtime.menu` points to a separate
`defineContextMenu` bundle; there is no `contextActions` field or common Editor base class.
