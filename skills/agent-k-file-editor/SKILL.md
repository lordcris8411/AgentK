---
name: agent-k-file-editor
description: Open, display, or preview workspace files and web projects inside Agent K's editor, capture the visible preview, or inspect its browser console. Use when the user asks Agent K to show a file, open a rendered preview, run a web project, capture its preview, or read preview console output.
---

# Agent K file editor

Use the `agent_k` bridge with `capability: "file-editor"`. Put the selected
`action` at the top level and put every action-specific value in `arguments`.
Do not launch an external editor, browser, image viewer, media player, or PDF
viewer when the user asks to use Agent K.

Available host actions:

- `open`: open a workspace file. Pass `arguments.path`; add
  `arguments.preview: true` for a rendered HTML or Markdown preview.
- `run-web-project`: start an npm project that has a `dev` script and open its
  preview. Pass the project directory as `arguments.path`. Do not start the dev
  server separately.
- `capture-preview`: capture the currently visible HTML or web-project preview
  to a PNG under the workspace `screenshot` directory. It has no required
  arguments.
- `get-preview-console`: return recent browser console entries from the current
  web-project preview. Optionally pass `arguments.limit` from 1 through 200.

An active `<agent_k_file_format>` context may advertise additional actions such
as `play`, `pause`, or `seek`. Call only actions explicitly listed there. Keep
the active file path in `arguments.path`; for `seek`, also pass
`arguments.seconds`. Do not infer private Editor actions from a file extension.

Use Pi's normal `read`, `edit`, and `write` tools for file contents and source
changes. Calling `read` does not satisfy an explicit request to open or display
the file in Agent K.
