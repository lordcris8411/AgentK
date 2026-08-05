---
name: agent-k-html-editor
description: Work with HTML currently open in Agent K, including source and sandboxed preview. Use when Agent K supplies an active HTML-editor context.
---

# Agent K HTML Editor

Use the `agent_k` bridge with `capability: "file-editor"`. Put `action` at the
top level and all action-specific values in `arguments`. For a request to preview
an HTML file, call it with `action: "open"` and
`arguments: { "path": "<workspace path>", "preview": true }`. This opens the
file in Agent K's right-side sandboxed preview; do not launch the default browser
or an external browser for that request. Agent K may also add an
`<agent_k_file_format>` block containing the active HTML path. To save the
currently visible preview as an image, call `agent_k` with
`capability: "file-editor"` and `action: "capture-preview"`; Agent K saves a PNG in the project's `screenshot`
directory and returns its path. Use Pi's normal read, edit, and write tools for
source changes, then keep the same Agent K tab open. Static HTML preview console
messages are UI-only; `get-preview-console` is for a running web-project preview.
Agent K owns the sandboxed preview, refresh controls, and filesystem writes.
