---
name: create-agent-k-language-pack
description: Create, update, repair, port, test, or package a complete hot-pluggable Agent K Language Pack that owns a language family's Editor contribution, Skills, LSP/DAP worker, isolated toolchains, and build/run/test/debug actions. Use for adding programming-language support; do not use for ordinary Skills or non-language file Editors.
---

# Create Agent K Language Pack

Build one atomic package for the whole language family. The deliverable is functional only when its worker, Editor contribution, embedded Skill, toolchain policy, lifecycle actions, tests, and built artifact agree.

## Workflow

1. Read [manifest-api.md](references/manifest-api.md), [editor-lsp-dap.md](references/editor-lsp-dap.md), and [testing.md](references/testing.md). If any runtime, compiler, package manager, LSP, or DAP tool is involved, also read [toolchains.md](references/toolchains.md).
2. Work in an isolated source copy. Run `node scripts/scaffold.mjs --output <directory> --id <reverse-dns-id> --display-name <name> --languages <comma-list> --extensions <comma-list> --markers <comma-list>` for a new package.
3. Implement real worker methods. Never return fabricated LSP/DAP responses or ship an empty manifest. Keep all generated output and caches below the worker cache root.
4. Run `node scripts/validate.mjs <pack-directory>`, then `node scripts/build.mjs <pack-directory>`, then `node scripts/local-test.mjs <pack-directory>`.
5. Add focused public tests plus failure cases for traversal, lifecycle, cancellation, isolation, and tool versions. Run the repository checks when developing in Agent K's source tree.
6. Run `node scripts/package.mjs <pack-directory> <artifact-directory>`. Treat the produced directory and `SHA256SUMS.json` as the immutable artifact.
7. Run `node scripts/install-preview.mjs <artifact-directory>` and present the permissions, downloads, processes, and write locations. Do not install until the user explicitly confirms.

## Non-negotiable rules

- Use one `agent-k.language-pack.json`, one version, one enable state, one installation root, and one cache root.
- Expose Pi only through `capability: "language"`, a packId, and manifest-declared standard actions.
- Accept workspace-relative paths at the Agent boundary; canonicalize and contain-check every path before worker use.
- Prefer a compatible system tool resolved to an absolute path, but execute it with a sanitized environment and private HOME/cache/build/index roots. Use a pinned verified private fallback only after confirmation.
- Install and upgrade through staging, cold-start tests, permission review, atomic activation, and rollback. Never write an unverified worker into application data.
- Package Skills start and stop with the package. Do not create a separate language Skill toggle.
- Local success permits a confirmed local install. Only the same artifact passing Windows x64 and Linux x64 may claim dual-platform certification.

## Completion evidence

Report the manifest validation, worker cold start/shutdown, action contract tests, source-tree pollution check, artifact hashes, platform tested, and any unsupported debug modes. A declaration in prose is not evidence.
