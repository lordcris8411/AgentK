---
name: agent-k-video-editor
description: Control video currently open in Agent K. Use when Agent K supplies an active video-editor context with play, pause, or seek capabilities.
---

# Agent K Video Player

Use the `agent_k` bridge with `capability: "file-editor"`. Put `action` at the
top level and all action-specific values in `arguments`. To play or display a
video file, first call it with `action: "open"` and
`arguments: { "path": "<workspace path>" }`; do not launch an external player. Then
read the active path and allowed actions from the current `<agent_k_file_format>`
context. Call only an advertised `play`, `pause`, or `seek` action. Put the same
active `path` in `arguments`; for `seek`, also pass `seconds`, where positive
values move forward and negative values move backward. Playback state and volume
remain local UI state.
