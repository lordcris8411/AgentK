---
name: agent-k-video-editor
description: Control video currently open in Agent K. Use when Agent K supplies an active video-editor context with play, pause, or seek capabilities.
---

# Agent K Video Player

To play or display a video in Agent K, first use `agent_k_file_editor` with
`action: "open"` and its workspace path; do not launch an external player. Then
read the active path and allowed actions from `<agent_k_file_format>`, and use
the advertised `play`, `pause`, or `seek` action. For `seek`, pass `seconds`;
positive values move forward and negative values move backward.
