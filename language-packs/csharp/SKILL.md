---
name: csharp-project-tools
description: Use Agent K's private C# project lifecycle, semantic csharp-ls support, and isolated dotnet builds for solution or project folders.
---

# Agent K C# project tools

Call `agent_k` with `capability: "language"`, `packId: "agent-k.csharp"`, and
one exact action ID: `project.list`, `project.load`, `project.status`,
`project.restart`, `project.unload`, `language.diagnostics`,
`language.definition`, `language.references`, `language.hover`,
`language.symbols`, `language.completion`, `language.rename`, `language.format`,
`build`, `run`, `test`, `debug.configurations`, `debug.start`, `debug.attach`, or
`debug.stop`. Never use shortened aliases such as `symbols`, `hover`, or
`semantic.hover`. Put values in `arguments`, call `project.status` first, and
pass `workspace`, `file`, and `project` as workspace-relative paths. Semantic
positions are zero-based `{ line: number, character: number }` objects.

A C# workspace is a directory with a `.sln` or `.csproj` direct child. Use Agent
K's C# project manager to load it once, inspect status, restart, unload, cancel
preparation, view the bounded protocol trace, or run **Build**.

Treat only `status: ready` as success. In particular, a resolved load or status
result containing `status: failed` is a failed lifecycle operation and its
`error` must be reported.

Once ready, use the corresponding `language.*` action for:

- diagnostics
- definition and references
- hover
- document and workspace symbols
- completion
- rename
- document and range formatting

The extension provisions .NET SDK 10.0.302 and csharp-ls 0.26.0 only below the
Agent K language cache after an explicit download confirmation. Its Build action
uses that same private SDK and returns the captured private build result. Do not
invoke a global `dotnet` or `csharp-ls`, and do not create `bin`, `obj`, NuGet,
index, log, or temporary output in the source workspace.
