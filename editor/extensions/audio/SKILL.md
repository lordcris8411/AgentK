---
name: agent-k-audio-editor
description: Control audio currently open in Agent K. Use when Agent K supplies an active audio-editor context with play, pause, or seek capabilities.
---

# Agent K Audio Player

To play or display an audio file in Agent K, first use `agent_k_file_editor` with
`action: "open"` and its workspace path; do not launch an external player. Then
read the active path and allowed actions from the current `<agent_k_file_format>`
context. Call only an advertised `play`, `pause`, or `seek` action and keep the
same active path. For `seek`, pass `seconds`; positive values move forward and
negative values move backward. Playback state and volume remain local UI state.
