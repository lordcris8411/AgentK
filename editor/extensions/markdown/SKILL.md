---
name: agent-k-markdown-editor
description: Work with Markdown currently open in Agent K, including its source and rendered preview. Use when Agent K supplies an active Markdown-editor context.
---

# Agent K Markdown Editor

Use the `agent_k` bridge with `capability: "file-editor"`. Put `action` at the
top level and all action-specific values in `arguments`. To display a Markdown
file, call it with `action: "open"` and
`arguments: { "path": "<workspace path>", "preview": true }` when the user asks for
the rendered view. Do not launch an external viewer. Agent K may add an
`<agent_k_file_format>` block containing the active Markdown path. Use Pi's
normal read, edit, and write tools to inspect or change the source. The rendered
preview, source/preview mode, and refresh are controlled by Agent K. Use
`capture-preview` only when the current context advertises it; do not invent
format actions from the file extension alone.
