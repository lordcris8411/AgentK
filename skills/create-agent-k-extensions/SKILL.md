---
name: create-agent-k-extensions
description: Create or update first-party Agent K non-language Editor extensions and their related Pi Skills. Use when asked to add a file-format editor, package an Editor plugin, create an Editor-provided Skill, or validate these Editor packages in this repository.
---

# Agent K extension authoring

Read `references/protocols.md` before changing an extension package.

For a standalone Pi Skill use `create-pi-skill`. For programming-language support, LSP, DAP, compilers, or runtimes use `create-agent-k-language-pack` instead.

## Choose the extension boundary

- Create an **Editor extension** for file rendering, editing UI, preview, and file-format actions.
- Create a **Skill** when Pi needs instructions for using or creating an extension.

Do not put language-specific project logic into generic host or panel code.

## Editor extension

1. Define the public format and action contract first: match rules, input grammar, capability ID, deterministic transformation, and a copyable before/after example. Follow user-supplied IDs and data semantics exactly.
2. Create `editor/extensions/<name>/` with `editor.json`, `editor.ts`, `SKILL.md`, optional `editor.css`, and optional `menu.ts`.
3. Declare API version 1, stable ID, semantic `version`, clear `description`, match rules, built runtime paths, and exact-version shared dependencies.
4. Use `editor/sdk/index.ts`; never import another editor package.
5. Implement load, focus, edit/content synchronization, dirty state, save, base-theme updates, complete-theme updates, and every declared capability. An action must call `host.updateContent` and `host.reportDirty` when it changes content.
6. Document the matching formats and exact `agent_k` capability/action contract in `SKILL.md`. Do not declare actions the runtime does not implement.
7. Use `runtime.menu` plus `defineContextMenu` for file-tree actions; `contextActions` is not a manifest field.
8. Test source behavior with data different from the public example. Build with `npm run build:editors` and ship the generated `dist` runtime.

Do not consider an Editor complete after manifest validation or compilation alone. Exercise the built package through Agent K's production discovery path: install or copy it to a supported Skill root, wait for the workspace to be ready, open a matching sample file, observe the plugin frame, edit and save, execute each declared action and compare the full resulting content, switch both base and complete themes, and verify the saved disk content. Test the same built package on Windows and Linux.

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

The command creates `<skill-name>.agentk-skill.zip` beside the directory. It is
for Skill packages, not trusted native language workers. Do not package
`node_modules`, generated build output, VCS files, environment files or secrets.
Inspect the printed file list before sharing.
