# AgentK Development Rules

## Scope

- This repository maintains only the AgentK Visual Client.
- Pi is an external runtime accessed through its public RPC protocol.
- Never edit, vendor, or commit Pi source. `.reference/pi/` is ignored reference material only.
- Keep protocol-specific behavior inside `src-tauri/src/agent/` and keep the React renderer process-free.

## Commands

- Install dependencies with `npm ci --ignore-scripts`.
- After TypeScript changes, run `npm run check`.
- After Rust changes, run `npm run check:desktop`.
- Run focused tests for changed functionality; `npm test` covers the bundled K Plan extension.
- Do not run lifecycle scripts from new dependencies without reviewing them.

## Code quality

- TypeScript stays strict; do not add `any` without a concrete reason.
- Keep imports at module scope.
- External dependencies use exact versions.
- Do not remove user-facing functionality without explicit approval.

## Git

- Do not commit unless the user asks.
- Stage explicit paths only.
- Preserve unrelated user changes.
