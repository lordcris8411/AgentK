---
name: agent-k-text-editor
description: Work with the file currently open in Agent K's text editor. Use when Agent K supplies an active text-editor context.
---

# Agent K Text Editor

Agent K may add an `<agent_k_file_format>` block containing the active file path. Use Pi's normal read, edit, and write tools for file contents. Treat the visible editor as context only; do not call `agent_k_file_editor` unless the supplied context explicitly lists a supported action.
