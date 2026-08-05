---
name: agent-k-text-editor
description: Work with the file currently open in Agent K's text editor. Use when Agent K supplies an active text-editor context.
---

# Agent K Text Editor

Use the `agent_k` bridge with `capability: "file-editor"`. Put `action` at the
top level and all action-specific values in `arguments`. To show, open, or display
a text or source file in Agent K's editor, call it with `action: "open"` and
`arguments: { "path": "<workspace path>" }`; do not
substitute Pi's `read` tool and do not launch an external editor. Agent K may add
an `<agent_k_file_format>` block containing the active file path. Use Pi's normal
read, edit, and write tools only for file contents or modifications after opening
when needed. Apart from the built-in `open` action, use the `agent_k` file-editor
capability only with a supplied supported action.

When the user asks to run or preview a web project with an npm `dev` script in
Agent K, call `agent_k` with `capability: "file-editor"`,
`action: "run-web-project"`, and the project directory as `arguments.path`.
Agent K validates the project, starts its dev server in
the project terminal, and opens the preview in the right-side panel. Do not run
the dev command yourself or open a browser. Use `get-preview-console` to inspect
recent browser console entries and `capture-preview` to save the visible preview.

Language diagnostics, completion, navigation, references, and project search are
Agent K UI services. Continue to use Pi's ordinary file tools for source changes;
do not attempt to call the Editor's internal language bridge as a Pi tool.
