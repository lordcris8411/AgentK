---
name: cpp-project-tools
description: Use Agent K's managed C/C++ project services for CMake lifecycle, clangd semantics, isolated build/run/test actions, and basic CodeLLDB session control.
---

# Agent K C++ project tools

Call `agent_k` with `capability: "language"`, `packId: "agent-k.cpp"`, an exact
action ID below, and action-specific values inside `arguments`. Never shorten an
ID: use `language.symbols`, not `symbols`, and `language.hover`, not `hover` or
`semantic.hover`.

Pass `workspace` and `file` as paths relative to the current Agent K workspace.
Semantic positions are zero-based `{ line: number, character: number }` objects.
Call `project.status` before semantic, build, run, test, or debug operations.
Opening a C/C++ file does not load its CMake workspace.

## Exact action IDs

- Lifecycle: `project.list`, `project.load`, `project.status`,
  `project.restart`, `project.unload`.
- Semantics: `language.diagnostics`, `language.definition`,
  `language.references`, `language.hover`, `language.symbols`,
  `language.completion`, `language.rename`, `language.format`.
- Project execution: `build`, `run`, `test`.
- Basic debugging: `debug.configurations`, `debug.start`, `debug.attach`,
  `debug.stop`.

Definition, references, hover, and completion require `workspace`, `file`, and
`position`. Rename also requires `newName`. Formatting requires `workspace` and
`file`. `language.symbols` accepts optional `file` for document symbols or
optional `query` for workspace symbols. `run` requires the built `program` path
and accepts optional string `args`; build, run, and test accept an optional
`configuration`.

Use `debug.configurations` before `debug.start`. Attach requires `processId`;
stop requires the returned `sessionId`. Breakpoints, stepping, variables,
registers, memory, disassembly, and other advanced debugger controls are exposed
through Agent K's trusted Debug UI, not through undeclared `agent_k` actions.

When a project reports `indexing`, semantic results can be partial. Do not treat
an empty result as authoritative until `project.status` reports `ready`. Keep
useful projects loaded instead of repeatedly unloading and reloading them.

Agent K keeps managed CMake, Ninja, clangd, compiler, CodeLLDB, build, and index
artifacts in application-owned cache directories. Use normal file tools for
source edits and do not invoke private language tooling directly.
