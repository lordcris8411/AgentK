---
name: agent-k-image-editor
description: Understand the image currently displayed in Agent K's image preview. Use when Agent K supplies an active image-editor context.
---

# Agent K Image Preview

To display an image in Agent K, use `agent_k_file_editor` with `action: "open"`
and its workspace path; do not open an external image viewer. Agent K may add an
`<agent_k_file_format>` block containing the active image path. Use available
image-reading or file tools when inspection is needed. Zooming and panning remain
local UI operations. Do not invent image-editing actions: call another
`agent_k_file_editor` action only when the current context explicitly advertises it.
