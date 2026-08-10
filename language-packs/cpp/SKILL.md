---
name: cpp-project-tools
description: Use Agent K's managed C/C++ project services for semantic clangd queries and native CodeLLDB debugging. Use for CMake workspace symbols, diagnostics, definitions, references, launch or attach debugging, breakpoints, stepping, variables, registers, memory, disassembly, console output, and core or minidump analysis through the Agent K Skill bridge.
---

# Agent K C++ project tools

A **C++ workspace** is a folder that Agent K can recognize as a CMake project
because it contains `CMakeLists.txt`. Its `workspace` argument is the folder
name, not a path. It must uniquely identify the current Agent K workspace or a
nested folder below it.

Use the `agent_k` bridge with `capability: "language"` and `packId: "agent-k.cpp"` for semantic
C/C++ questions. Put `action` at the top level and all action-specific values in
`arguments`. At the start of a C++ language-service workflow, call `status` with
`arguments: { "workspace": "<workspace name>" }`. All
semantic actions require the named workspace to be loaded with clangd in either
`indexing` or `ready` state. Never imply that merely opening a C/C++ file loaded
its workspace.

A newly loaded workspace may temporarily report `indexing`. The editor can
already use clangd and this Skill may issue semantic actions, but each response
will report `status`, `indexReady`, and `partial`. When `partial` is `true`, tell
the user that indexing is still in progress, treat all results as provisional,
and never interpret an empty result as "not found" or claim that a result set is
complete. Repeat the query after a later `status` reports `ready` when a complete
answer matters. Do not unload or reload the workspace just to wait for indexing.

## Tool priority

When the workspace is loaded and clangd is usable, use this Skill **before**
shell commands or textual search for any question whose answer depends on C++
meaning:

- which declaration or definition an identifier resolves to;
- references to a symbol, including overloaded or scoped names;
- implementations, types, inheritance, or call relationships;
- diagnostics, hover/type information, and indexed symbols.

Do not substitute `grep`, `rg`, `findstr`, compiler-output scraping, or a custom
Clang invocation for those semantic operations. Text search cannot reliably
distinguish comments, strings, shadowed variables, overloads, macros, or
identically named symbols in different scopes.

Use shell commands directly for compilation, tests, execution, Git operations,
and explicitly textual or regular-expression searches such as `TODO` scanning.
Normal Pi read/edit/write tools remain the correct choice for inspecting or
changing file contents. If clangd returns no semantic result, report that fact
first; use a shell/text search only as a clearly identified supplementary
investigation, never present it as an equivalent semantic result.

Available actions:

- `status`: report whether the named C++ workspace is loaded, whether its index
  is ready, and whether semantic results are currently partial.
- `references`: find all indexed references to an exact `symbol`.
- `definition`: find definitions of a variable, function, enum, type, method,
  macro, or other exact `symbol`.
- `declaration`: find declarations of an exact `symbol`.
- `type-declaration`: find declarations of an exact class, struct, enum,
  interface, or type parameter.
- `implementation` and `hover`: query implementations or type/documentation
  information for an exact `symbol`.
- `symbols`: search indexed workspace symbols with `query`.
- `document-symbols` and `diagnostics`: inspect a workspace-relative `file`.
- `incoming-calls`, `outgoing-calls`, `supertypes`, and `subtypes`: query clangd
  call and type hierarchies for an exact `symbol`.
- `load` and `unload`: explicitly change the named C++ workspace lifecycle.

Use the optional workspace-relative `file` argument to disambiguate duplicate
symbol names. Results are structured and use one-based line and character
numbers where Agent K presents source locations.

Keep useful C++ workspaces loaded. Do not unload and reload between queries, do
not load preemptively for unrelated questions, and do not retry lifecycle
actions when `status` already reports the desired state. Loading may configure
CMake, prepare a private compilation database, start clangd, and build its
background index, so frequent lifecycle cycling wastes substantial time and
resources.

Agent K keeps its pinned CMake, Ninja, and clangd binaries, generated CMake tree,
compilation database, and index in application-owned cache directories. Use
Pi's normal file tools for source edits and the Agent K project terminal for an
explicit build; this skill provides language intelligence and lifecycle control,
not file mutation or compilation.

## Native debugging

Use the `agent_k` bridge with `capability: "language"` and `packId: "agent-k.cpp"` instead of shelling
out to GDB, LLDB, WinDbg, or a DAP adapter. Put `action` at the top level and all
debugger values in `arguments`. Agent K owns the adapter, validates workspace/session boundaries,
and keeps managed debugger files outside the source tree. The `workspace`
argument is the same unique CMake folder name used by the language tool.

Start every debug workflow with `status`. Reuse the returned `sessionId` on all
session-specific calls. If multiple sessions exist, never guess which one the
user means. Ask or use the session label and status to select it explicitly.

Typical live workflow:

1. Call `configurations` and choose the requested CMake executable `targetId`,
   or call `processes` when the user explicitly wants to attach.
2. Set source breakpoints with `set-breakpoints` when needed. Its `lines` value
   is the complete line list for that file; use `line` plus condition fields to
   configure one breakpoint.
3. Call `start` with `mode: launch` and the target, or `mode: attach` and a PID.
4. Call `status`. When stopped, inspect `stack`, `locals`, `registers`, or
   `evaluate`; use `variables` to expand a returned `variablesReference`.
5. Use `continue`, `pause`, `next`, `step-in`, `step-out`, and `select-frame`
   deliberately. Re-read state after an execution-control action.
6. Call `stop` to terminate the target and remove the session. Call `detach`
   when the target must keep running. For an attached process, prefer detach
   unless the user explicitly asks to terminate it.

For dump analysis, call `start` with `mode: dump`, `dumpPath`, and the matching
`program` when LLDB requires it. Dump sessions are read-only: inspect state,
memory, registers, stack, expressions, and disassembly, then use `stop` only to
close the analysis session. Never attempt continue, stepping, variable changes,
or memory writes on a dump.

Use `read-memory` and `disassemble` only with a memory reference or instruction
pointer returned by the debugger when possible. Use `write-memory`,
`set-variable`, or instruction breakpoints only in a stopped live session and
only when the user explicitly requests that mutation. Preserve exact byte order
and report partial writes or adapter errors without pretending the change
succeeded. Treat addresses and instruction breakpoints as session-local because
ASLR can invalidate them after restart.

`output` is bounded; request only the recent lines needed for diagnosis. Source
breakpoints are project configuration and persist in Agent K. Instruction
breakpoints are session-only. Debug sessions themselves are not persisted and
are removed when the target terminates, is stopped, or is detached.

## Native debugger arguments

Every debugger call requires `arguments.workspace`. Session-specific calls use
`arguments.sessionId`. Supply only values needed by the selected action:

- `mode`: `launch`, `attach`, or `dump` for `start`.
- `targetId`, `buildConfiguration`, `program`, `args`, `workingDirectory`,
  `stopOnEntry`, and `sessionName`: launch configuration.
- `processId`: positive process ID for attach.
- `dumpPath`, `program`, `symbolPaths`, and `sourceMap`: dump analysis and symbol
  resolution.
- `refresh` and optional `file`: configuration discovery.
- `file`, `line`, `lines`, `enabled`, `condition`, `hitCondition`, and
  `logMessage`: source breakpoints. `lines` is the complete list for the file.
- `functionBreakpoints`: complete list of objects containing `name` and optional
  `condition` or `hitCondition`.
- `exceptionFilters`: complete supported exception-filter ID list.
- `threadId` and `frameId`: frame selection and inspection.
- `variablesReference`: expand variables or select a variable container.
- `expression`, `context`, `name`, and `value`: evaluation and explicit variable
  mutation; `context` is `watch` or `repl`.
- `memoryReference`, `offset`, `count`, and `bytes`: memory reads or explicit
  writes. `bytes` contains integer byte values from 0 through 255.
- `memoryReference`, `instructionOffset`, and `instructionCount`: disassembly.
- `addresses`: complete session-local instruction-breakpoint address list.
- `count`: bounded recent-line count for `output`.
