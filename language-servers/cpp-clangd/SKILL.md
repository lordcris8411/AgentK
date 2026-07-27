---
name: cpp-project-language-service
description: Query Agent K's managed clangd service for an explicitly loaded CMake workspace by using the agent_k_cpp_language_server tool.
---

# Agent K C++ project language service

A **C++ workspace** is a folder that Agent K can recognize as a CMake project
because it contains `CMakeLists.txt`. Its `workspace` argument is the folder
name, not a path. It must uniquely identify the current Agent K workspace or a
nested folder below it.

Use `agent_k_cpp_language_server` for semantic C/C++ questions. At the start of
a C++ language-service workflow, call `status` with the workspace name. All
semantic actions require the named workspace to be loaded and clangd to be
ready. Never imply that merely opening a C/C++ file loaded its workspace.

## Tool priority

When the workspace is loaded and ready, use this Skill **before** shell commands
or textual search for any question whose answer depends on C++ meaning:

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

- `status`: report whether the named C++ workspace is loaded and ready.
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
