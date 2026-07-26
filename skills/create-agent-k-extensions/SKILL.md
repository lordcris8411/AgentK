---
name: create-agent-k-extensions
description: Create or update first-party Agent K Editor extensions, native language-server extensions, and their related Pi Skills. Use when asked to add a file editor, package an Editor plugin, add a language service or debug-service declaration, create an extension-provided Skill, or validate any of these extension packages in this repository.
---

# Agent K extension authoring

Read `references/protocols.md` before changing an extension package.

## Choose the extension boundary

- Create an **Editor extension** for file rendering, editing UI, preview, and file-format actions.
- Create a **language extension** for project ownership, toolchains, LSP/DAP workers, semantic operations and language Skills.
- Create a **Skill** when Pi needs instructions for using or creating an extension.

Do not put language-specific project logic into generic host or panel code.

## Editor extension

1. Create `editor/extensions/<name>/` with `editor.json`, `editor.ts`, `SKILL.md`, and optional CSS.
2. Declare API version 1, stable ID, semantic `version`, clear `description`, match rules and built runtime paths.
3. Use `editor/sdk/index.ts`; never import another editor package.
4. Build with `npm run build:editors`.

## Language extension

1. Declare ID, display name, languages, project markers and worker; add editor contribution, commands, debug-server and Skill only when needed.
2. Keep toolchains, project lifecycle, LSP/DAP and diagnostics inside the worker. Use generic host RPC/events only.
3. Declare an editor contribution when semantic behavior attaches to a text editor; do not clone an editor just for LSP.
4. Provide a language Skill only for real available behavior.

## Verify

Run the relevant manifest test, then:

```powershell
npm run check
npm run build:desktop
npm run build:web
git diff --check
```

## Package for sharing

After a Skill is validated, package its directory for another Agent K instance
or a community upload:

```powershell
python skills/create-agent-k-extensions/scripts/package_skill.py <skill-directory>
```

The command creates `<skill-name>.agentk-skill.zip` beside the directory. Do
not package `node_modules`, build output, VCS files, environment files or
secrets. Inspect the printed file list before sharing.
