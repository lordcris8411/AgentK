---
name: typescript-javascript-language-service
description: Use Agent K's managed TypeScript/JavaScript language extension for project lifecycle and editor semantic features.
---

# TypeScript/JavaScript language service

Call `agent_k` with `capability: "language"`,
`packId: "agent-k.typescript-javascript"`, and one exact action ID:
`project.list`, `project.load`, `project.status`, `project.restart`,
`project.unload`, `language.diagnostics`, `language.definition`,
`language.references`, `language.hover`, `language.symbols`,
`language.completion`, `language.rename`, `language.format`,
`language.organize-imports`, `build`, `run`, `test`, `debug.configurations`,
`debug.start`, `debug.attach`, or `debug.stop`. Never use shortened aliases such
as `symbols`, `hover`, or `semantic.hover`. Put values in `arguments`, call
`project.status` first, and pass `workspace` and `file` as workspace-relative
paths. Semantic positions are zero-based `{ line: number, character: number }`
objects.

Agent K recognizes a TypeScript/JavaScript project when its directory contains
`tsconfig.json`, `jsconfig.json`, or `package.json`. Load that directory from the
file-tree project menu or **Active TypeScript/JavaScript projects** command.
Loading is explicit: opening a source file alone does not load its project.

The extension routes all four Agent K language modes: TypeScript, TSX,
JavaScript, and JSX. Once the project status is `ready`, use the text editor for:

- diagnostics, completion, hover, and document/workspace symbols;
- definition and references across `.ts`, `.tsx`, `.js`, and `.jsx` files;
- rename and document/range formatting;
- organize imports through the TypeScript source action.

Use restart after changing project configuration if the service does not pick up
the change. Unload projects that are no longer useful. Initial loading may ask
for confirmation before downloading the pinned private toolchain; do not approve
unless the user accepts the described network download. Cancellation preserves
the last completed toolchain.

Agent K runs Node.js 24.18.1, typescript-language-server 5.3.0, and TypeScript
6.0.3 from its worker-provided cache. It does not use global Node/npm/TypeScript,
modify PATH globally, install into the source project, or place generated files
there.
