---
name: create-agent-k-extensions
description: Create or update first-party Agent K Editor extensions, trusted native language extensions, and related Pi Skills. Use when asked to add a file editor, package an Editor plugin, add an LSP or DAP declaration, create an extension-provided Skill, or validate these extension packages in this repository.
---

# Agent K extension authoring

Read `references/protocols.md` before changing an extension package.

## Choose the extension boundary

- Create an **Editor extension** for file rendering, editing UI, preview, and file-format actions.
- Create a **native language extension** for project ownership, trusted toolchains, LSP/DAP workers, semantic operations and language documentation/Skills.
- Create a **Skill** when Pi needs instructions for using or creating an extension.

Do not put language-specific project logic into generic host or panel code.

## Editor extension

1. Create `editor/extensions/<name>/` with `editor.json`, `editor.ts`, `SKILL.md`, optional `editor.css`, and optional `menu.ts`.
2. Declare API version 1, stable ID, semantic `version`, clear `description`, match rules, built runtime paths, and exact-version shared dependencies.
3. Use `editor/sdk/index.ts`; never import another editor package.
4. Use `runtime.menu` plus `defineContextMenu` for file-tree actions; `contextActions` is not a manifest field.
5. Build with `npm run build:editors` and ship the generated `dist` runtime.

## Language extension

1. Create `language-servers/<name>/` with `agent-k.language-server.json`, `worker.ts`, and built `dist/worker.js`.
2. Declare ID, display name, languages, project markers and worker; add project menus, Editor contribution, commands, debug-server and Skill metadata only when needed.
3. Keep toolchains, project lifecycle, LSP/DAP and diagnostics inside the worker. Use generic host RPC/events only.
4. Declare an Editor contribution when semantic behavior attaches to an existing Editor; do not clone an Editor just for LSP.
5. Never load a native worker from an opened workspace. User-installed packages belong in Agent K's application-data registry.
6. Provide language Skill metadata only for behavior the worker and UI actually expose.

## Verify

Run the relevant manifest test, then:

```powershell
npm run check
npm run build:desktop
npm run build:web
npm run build:language-servers
git diff --check
```

## Package for sharing

After a Skill is validated, package its directory for another Agent K instance
or a community upload:

```powershell
python skills/create-agent-k-extensions/scripts/package_skill.py <skill-directory>
```

The command creates `<skill-name>.agentk-skill.zip` beside the directory. It is
for Skill packages, not trusted native language workers. Do not package
`node_modules`, generated build output, VCS files, environment files or secrets.
Inspect the printed file list before sharing.
