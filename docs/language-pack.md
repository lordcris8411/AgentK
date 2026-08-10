# Agent K Language Pack protocol

Language Pack is the only programming-language extension unit. A package atomically owns its text or sandbox Editor contribution, Pi Skills, LSP/DAP worker, toolchain policy, and project/build/run/test/debug actions. It has one manifest, version, installation directory, active receipt, enable state, and cache root. Ordinary Skills and non-language Editors remain independent.

Bundled packs live in `language-packs/`. User packages are installed as `language-packs/<id>/<version>/` below application data with `<id>/active.json` selecting the active version. Old `language-server-plugins` content is ignored.

## Manifest

The root file is `agent-k.language-pack.json` with `apiVersion: 1` and `kind: "language-pack"`. Required declarations are:

- identity: `id`, semantic `version`, `displayName`, `platforms`;
- routing: `languages`, `fileExtensions`, `projectMarkers`;
- runtime: a contained JavaScript `worker`, non-empty `actions`, and parameter JSON Schemas;
- integrated contributions: one or more embedded `skills` and optional `editorContribution`, `projectMenu`, commands, and `debugServer`;
- execution policy: explicit `permissions` and versioned `toolchains` with compatible system ranges and/or pinned fallback URL plus SHA-256/SHA-512.

Validation rejects missing Skills, duplicate language IDs or actions, escaping workers, unsupported install platforms, unversioned tools, toolchains absent from external-tool permissions, and malformed schemas.

## Generic host contract

The Electron host contains no language IDs. `LanguagePackRegistry` discovers active manifests, supervises workers, routes Editor LSP notifications/requests by language ID, routes DAP through the common debug session model, and exposes one Pi bridge:

```json
{
  "capability": "language",
  "packId": "agent-k.cpp",
  "action": "language.references",
  "arguments": {
    "workspace": "project",
    "file": "src/main.cpp",
    "position": { "line": 10, "character": 8 }
  }
}
```

Pi may submit only a workspace-relative path. The backend resolves it against the active task workspace, rejects traversal or absolute paths, validates the declared action schema, and only then invokes the manifest method. Standard namespaces are `project.*`, `language.*`, `build/run/test`, and `debug.*`. Build-like results use `code`, `stdout`, `stderr`, `artifacts`, `durationMs`, and `cancelled`.

Workers receive their private cache root plus compatible system tools resolved to canonical absolute paths. Child environments are allowlisted. Packs keep HOME, dependency caches, build output, indexes, logs, and temporary files private. Pinned fallback downloads require confirmation and use progress, cancellation, digest verification, staging, activation, and rollback.

## Installation and hot lifecycle

Preview validates the artifact and returns a short-lived approval token with its permissions. Install refuses calls without that approved preview. The host copies to staging, validates again, cold-starts the worker, calls `list`, shuts it down, then switches the version receipt. Existing workers are stopped first; initialization failure restores the prior receipt and registry.

Enable and disable stop or expose the whole worker/Editor/Skill/action set together. Pi runtimes are hot-replaced with their session file preserved so embedded Skills change without restarting Agent K. Active tasks must finish before an install, uninstall, or capability change. Debug sessions end during shutdown and are not migrated.

## First-party packs

- `agent-k.cpp`: C/C++, clangd, CMake/Ninja/LLVM, build/test/run, and CodeLLDB DAP.
- `agent-k.csharp`: C#, csharp-ls, compatible system or private .NET 10.0.302, isolated build/test/run.
- `agent-k.typescript-javascript`: TS/TSX/JS/JSX, typescript-language-server 5.3.0, TypeScript 6.0.3, private Node 24.18.1, build/test/run, formatting and organize imports.

All three use the same registry, Editor routing, worker supervisor, action validator, cache convention, confirmation flow, and `capability: "language"`. C++ has no host-side capability or language branch.

## Authoring and certification

Use `skills/create-agent-k-language-pack`. Its scripts scaffold, validate, build, cold-test, package with hashes, and print an install preview. A local pass allows a confirmed local install. Dual-platform certification requires the identical Windows-generated artifact to pass Windows x64 and Ubuntu x64 install, cold start, actions, supported debugging, and uninstall tests.
