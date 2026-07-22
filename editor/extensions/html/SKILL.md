---
name: agent-k-html-editor
description: Work with HTML currently open in Agent K, including source and sandboxed preview. Use when Agent K supplies an active HTML-editor context.
---

# Agent K HTML Editor

For a request to preview an HTML file in Agent K, use `agent_k_file_editor` with
`action: "open"`, the workspace file path, and `preview: true`. This opens the
file in Agent K's right-side sandboxed preview; do not launch the default browser
or an external browser for that request. Agent K may also add an
`<agent_k_file_format>` block containing the active HTML path. To save the
currently visible preview as an image, use `agent_k_file_editor` with
`action: "capture-preview"`; Agent K saves a PNG in the project's `screenshot`
directory and returns its path. Use Pi's normal read, edit, and write tools for
source changes. Agent K owns the sandboxed preview and refresh controls.
