---
name: agent-k-eval-record-tools
description: Run deterministic record transformations for Agent K Skill invocation evaluation. Use for JSONL summaries, CSV validation, slug normalization, timestamp conversion, map merging, semantic-version sorting, logical path remapping, term counting, record filtering, and duration totals.
---

# Agent K evaluation record tools

Run `node <skill-dir>/scripts/run.mjs <operation> '<json-input>'` with the operation and JSON supplied by the user. Return the emitted JSON without silently reimplementing the operation.
