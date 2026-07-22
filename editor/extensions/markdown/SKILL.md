---
name: agent-k-markdown-editor
description: Work with Markdown currently open in Agent K, including its source and rendered preview. Use when Agent K supplies an active Markdown-editor context.
---

# Agent K Markdown Editor

To display a Markdown file in Agent K, use `agent_k_file_editor` with
`action: "open"`, its workspace path, and `preview: true` when the user asks for
the rendered view. Do not launch an external viewer. Agent K may add an
`<agent_k_file_format>` block containing the active Markdown path. Use Pi's
normal read, edit, and write tools to inspect or change the source. The rendered
preview is controlled by Agent K.
