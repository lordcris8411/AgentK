---
name: create-agent-k-theme
description: Create and manage validated Agent K custom theme JSON files from a user's visual brief. Use when a user asks Agent K to design, generate, customize, list, set, or remove an Agent K color theme.
---

# Manage Agent K themes

Create one JSON file based on `assets/theme.template.json`. Ask only for a missing theme name or whether the theme should be light or dark when it cannot be inferred.

- Use a lowercase kebab-case `id` that is not `light`, `soft-light`, `dark`, or `system`.
- Keep every required key. Values must be hex colors (`#RRGGBB` or `#RRGGBBAA`); use a hex alpha value for `modal-overlay`.
- Use the optional `monacoSyntax` object when the brief calls for a code-editor palette. Its supported keys are `comment`, `keyword`, `string`, `number`, `type`, `function`, `variable`, `parameter`, `macro`, `namespace`, and `property`. Include only intentional overrides: omitted keys inherit Agent K's readable base syntax palette.
- Use the optional `fonts` object for a theme-specific type system. Set both `ui` (all interface text) and `code` (Monaco, terminal, and code blocks) to installed font-family lists; omitted `fonts` uses Agent K defaults.
- Preserve contrast: `text-primary` must be clearly legible on `surface-panel`, and selection text must be legible on its selection background.
- Set `base` to the closest contrast mode (`light`, `soft-light`, or `dark`).
- Write the result to `%USERPROFILE%\\.pi\\agent\\themes\\<id>.json`. Create the directory if needed. Do not overwrite an existing theme without confirmation.
- After creating a theme, offer to set it as the active theme.

## List and set

- List themes by reading `%USERPROFILE%\\.pi\\agent\\themes` recursively; include the built-ins `light`, `soft-light`, `dark`, and `system` in the result.
- To set a theme, first confirm that its ID exists, then atomically update the `theme` property in Agent K's `client-settings.json` while preserving every other setting. Use `%APPDATA%\\com.lordcris8411.agentk\\client-settings.json` on Windows. The running app notices this change and applies it.
- Do not set an unknown ID. Use `system` to return to the system theme.

## Remove

- Remove only a custom theme after explicit confirmation. Never remove `light`, `soft-light`, `dark`, or `system`.
- If the theme is active, set the theme to `system` before deleting its JSON file.
- Delete the matching `<id>.json` file from `%USERPROFILE%\\.pi\\agent\\themes` (including a matching file in a subdirectory), then report the removed theme name and path.
