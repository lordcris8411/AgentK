---
name: agent-k-pdf-editor
description: Work with the PDF currently displayed in Agent K's PDF preview. Use when Agent K supplies an active PDF-editor context.
---

# Agent K PDF Preview

To display a PDF in Agent K, use `agent_k_file_editor` with `action: "open"`
and its workspace path; do not launch the system PDF viewer. Agent K may add an
`<agent_k_file_format>` block containing the active PDF path. Use available PDF
or file tools to inspect its contents. Page navigation and zoom remain local UI
operations unless the context advertises an explicit action.
