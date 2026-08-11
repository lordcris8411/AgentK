# AgentK Development Rules

## Scope

- This repository maintains only the AgentK Visual Client.
- Pi is an external runtime accessed through its public RPC protocol.
- Never edit, vendor, or commit Pi source. `.reference/pi/` is ignored reference material only.
- Keep protocol-specific behavior inside `electron/agent/` and keep the React renderer process-free.
- Keep privileged language tooling inside trusted packages under `language-packs/`; Editor packages remain sandboxed browser code under `editor/extensions/`.

## Commands

- Install dependencies with `npm ci --ignore-scripts`.
- After TypeScript changes, run `npm run check`.
- After Electron main-process changes, run `npm run check:desktop`.
- After Editor changes, run `npm run check:editors` and `npm run build:editors`.
- After native language-extension changes, run `npm run check:language-packs` and `npm run build:language-packs`.
- Run focused tests for changed functionality; `npm test` covers K Plan, resource discovery, Editor manifests, language extensions, conversation content, and project ordering.
- Do not run lifecycle scripts from new dependencies without reviewing them.

## Code quality

- TypeScript stays strict; do not add `any` without a concrete reason.
- Keep imports at module scope.
- External dependencies use exact versions.
- Do not remove user-facing functionality without explicit approval.

## Git

- Never create a Git branch unless the user explicitly authorizes it.
- Do not commit unless the user asks.
- Stage explicit paths only.
- Preserve unrelated user changes.
