# Agent K theme element map

Read this map before choosing colors. Theme fields are semantic tokens, not a
paint-by-coordinate format: one token can affect several controls with the same
role. When the user points to a visual location, start with the region map and
then use the detailed tables.

## Screen regions

```text
┌──────────────────┬──────────────────────────────┬──────────────────────────┐
│ Left sidebar     │ Conversation workspace       │ Inspector / editor       │
│ surface-panel    │ surface-app                  │ surface-panel            │
│                  │                              │                          │
│ primary-action   │ user cards / composer:       │ tabs, cards, popovers:   │
│ active-item      │ surface-raised               │ surface-raised           │
│ inactive-item-*  │ assistant text: text-primary │ active-item              │
├──────────────────┴──────────────────────────────┴──────────────────────────┤
│ Project terminal: terminal.background + terminal.foreground + ANSI colors │
└────────────────────────────────────────────────────────────────────────────┘
```

Common translations:

- "main/background behind the conversation" → `surface-app`.
- "left project/session column" or "right file tree/editor shell" → `surface-panel`.
- "message card", "composer", "dialog card", or "floating menu" → usually `surface-raised`.
- "selected session/file/tab" → `components.active-item` and `components.active-item-foreground`.
- "Add workspace/New task/primary confirmation" → `components.primary-action` and its foreground.
- "send arrow" and focus emphasis → `accent`; the send-arrow foreground contrasts against it.
- "terminal background" → `terminal.background`, never a surface token.
- "Monaco code editor background" → `monaco.editor.background`, not `surface-app`.
- "input box inside a dialog" → `components.input`; the main chat composer is a raised surface instead.

## Metadata

| Key | Meaning |
| --- | --- |
| `id` | Stable lowercase kebab-case identifier and JSON filename. |
| `name` | Human-readable name shown in theme settings. |
| `base` | `light`, `soft-light`, or `dark`; selects the closest structural/contrast behavior before overrides. |

## Application colors

| Key | Visible locations and role |
| --- | --- |
| `surface-app` | Lowest application canvas, especially the center conversation background and bare window areas. |
| `surface-panel` | Left sidebar, right inspector shell, settings panels, terminal/editor chrome, and other persistent secondary regions. |
| `surface-raised` | User-message cards, composer surface, dialogs, popovers, menus, cards, and controls raised above a panel. |
| `surface-hover` | Generic hover fill when no component-specific hover is provided. |
| `surface-active` | Generic pressed/active fill and fallback for selected elements or chat code/table surfaces. |
| `border-color` | Normal separators and subtle outlines between panels, cards, rows, and controls. |
| `border-strong` | Focused inputs, prominent card/control outlines, resize boundaries, and stronger dividers. |
| `text-primary` | Main message text, headings, filenames, and high-emphasis labels. |
| `text-secondary` | Supporting labels, secondary icons, metadata, and less prominent controls. |
| `text-muted` | Timestamps, placeholders, disabled/help text, counters, and quiet metadata. |
| `accent` | Send button, focus rings, links/emphasis, progress highlights, and other brand emphasis. It is not the general text color. |
| `selection-background` | Selected text and generic selection fills. |
| `selection-foreground` | Text/icons displayed on `selection-background`. |
| `scrollbar-thumb` | Scrollbar thumb at rest across the app and Editor integrations. |
| `scrollbar-thumb-hover` | Scrollbar thumb while hovered. |
| `danger` | Delete/destructive actions, errors, stop controls, and failure indicators. |
| `info` | Informational notices and status accents. |
| `success` | Ready/connected/success indicators. |
| `warning` | Warnings, caution states, and warning emphasis. |
| `modal-overlay` | Translucent backdrop behind modal dialogs; use an alpha channel. |
| `icon-primary` | Recolors the original black layer of the Agent K illustration/logo. |
| `icon-secondary` | Recolors the original white layer of the Agent K illustration/logo; normally harmonizes with nearby surfaces. |

## Component colors

These override generic surface/text fallbacks for specific interaction roles.

| Key | Visible locations and role |
| --- | --- |
| `primary-action` | Add workspace/New task, primary confirmation buttons, and equivalent high-priority actions. The send button still uses `accent`. |
| `primary-action-foreground` | Text and icons drawn on `primary-action`. |
| `active-item` | Selected session row, selected file-tree row, active editor tab, and selected navigation item. |
| `active-item-foreground` | Label/icon color on `active-item`. |
| `inactive-item-foreground` | Unselected session, file, tab, navigation, and secondary action labels. |
| `input` | Text inputs inside inspector/settings dialogs. It does not define the main chat composer surface. |
| `input-foreground` | Text typed in those dialog inputs. |
| `code-block` | Code/preformatted surfaces in programmable text, Markdown, and HTML Editors; chat code may fall back to `surface-active`. |
| `code-block-foreground` | Text on those Editor code/preformatted surfaces. |
| `hover` | Component-specific hover fill for response actions, dialog buttons, and similar interactive controls. |
| `hover-foreground` | Text/icon color on `hover`. |

## Fonts

| Key | Visible locations and role |
| --- | --- |
| `fonts.ui` | All normal Agent K interface and conversation text. |
| `fonts.code` | Monaco, terminal, code blocks, and other monospaced content. |

## Monaco editor

These affect the code editor only, not the surrounding inspector or terminal.

| Key | Visible locations and role |
| --- | --- |
| `editor.background` | Monaco text-area background. |
| `editorGutter.background` | Monaco line-number, breakpoint, and glyph margin background. |
| `editor.lineHighlightBackground` | Current-line highlight. |
| `editor.selectionBackground` | Focused Monaco selection. |
| `editor.inactiveSelectionBackground` | Monaco selection while the editor is unfocused. |
| `editor.selectionHighlightBackground` | Other occurrences matching the current selection. |

## Monaco syntax

`monacoSyntax` is optional. Its keys color tokens inside Monaco: `comment`,
`keyword`, `string`, `number`, `type`, `function`, `variable`, `parameter`,
`macro`, `namespace`, and `property`. These never recolor ordinary UI labels.

## Terminal

The terminal palette is independent from application surfaces and Monaco.

| Key | Visible locations and role |
| --- | --- |
| `background` | Terminal viewport background. |
| `foreground` | Default terminal text. |
| `cursor` | Terminal cursor color. |
| `cursorAccent` | Glyph color when the block cursor covers a character. |
| `selectionBackground` | Terminal text-selection background. |
| `black` | ANSI black. |
| `red` | ANSI red. |
| `green` | ANSI green. |
| `yellow` | ANSI yellow. |
| `blue` | ANSI blue. |
| `magenta` | ANSI magenta. |
| `cyan` | ANSI cyan. |
| `white` | ANSI white. |
| `brightBlack` | Bright ANSI black, commonly used for dim metadata. |
| `brightRed` | Bright ANSI red. |
| `brightGreen` | Bright ANSI green. |
| `brightYellow` | Bright ANSI yellow. |
| `brightBlue` | Bright ANSI blue. |
| `brightMagenta` | Bright ANSI magenta. |
| `brightCyan` | Bright ANSI cyan. |
| `brightWhite` | Bright ANSI white. |

## Contrast checks

Check the actual pair, not colors in isolation:

- `text-primary` on `surface-panel`, `surface-app`, and `surface-raised`.
- `active-item-foreground` on `active-item`.
- `primary-action-foreground` on `primary-action`.
- `input-foreground` on `input`.
- `code-block-foreground` on `code-block`.
- `hover-foreground` on `hover`.
- `selection-foreground` on `selection-background`.
- `terminal.foreground` on `terminal.background`.

If the user names only "the background" and the intended region cannot be
inferred, ask whether they mean the conversation canvas, a side panel, a raised
card/composer, Monaco, or the terminal instead of changing all five.
