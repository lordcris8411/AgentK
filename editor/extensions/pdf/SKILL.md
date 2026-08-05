---
name: agent-k-pdf-editor
description: Work with the PDF currently displayed in Agent K's PDF preview. Use when Agent K supplies an active PDF-editor context.
---

# Agent K PDF Preview

Use the `agent_k` bridge with `capability: "file-editor"`. To display a PDF,
call it with `action: "open"` and `arguments: { "path": "<workspace path>" }`;
do not launch the system PDF viewer. Agent K may add an
`<agent_k_file_format>` block containing the active PDF path. Use available PDF
or file tools to inspect its contents. Page navigation and zoom remain local UI
operations. Do not infer callable actions from this Skill; use only capabilities
explicitly advertised in the active file-format context.
