# Agent K extension protocols

Read the canonical docs before authoring packages:

- `docs/file-format-sdk.md` for Editor manifests, sandbox bridge and runtime assets.
- `docs/language-server-plugin.md` for trusted native workers, generic RPC, projects and DAP.

Editor packages require `editor.json`, `SKILL.md`, source and built runtime. Use API v1, ID, name, description and version.

Language project workers use generic events/RPC; supported project methods are `list`, `load`, `unload`, `restart` and `cancel`. Keep managed caches outside opened projects and never let paths escape the package.
