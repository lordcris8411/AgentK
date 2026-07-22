---
name: agent-k-text-editor
description: Work with the file currently open in Agent K's text editor. Use when Agent K supplies an active text-editor context.
---

# Agent K Text Editor

To show a text or source file in Agent K's editor, use `agent_k_file_editor` with
`action: "open"` and its workspace path; do not launch an external editor. Agent
K may add an `<agent_k_file_format>` block containing the active file path. Use
Pi's normal read, edit, and write tools for file contents. Apart from the built-in
`open` action, call `agent_k_file_editor` only with a supplied supported action.

When the user asks to run or preview a web project with an npm `dev` script in Agent K, call
`agent_k_file_editor` with `action: "run-web-project"` and the project directory
path. Agent K validates the project, starts its dev server, and opens the preview
in the right-side panel. Do not run the dev command yourself or open a browser.
