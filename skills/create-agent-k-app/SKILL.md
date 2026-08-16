---
name: create-agent-k-app
description: "Create, update, repair, or validate an Agent K k-app: a directory containing app.html or app.htm plus config.k, with sandboxed AgentK file, Pi conversation, theme, and managed process APIs. Use when the user asks for a k-app, an interactive Agent K directory app, a project dashboard/control panel, or a local app that talks to Pi, follows the active theme, manages tasks, or works with project files."
---

# Create an Agent K k-app

Read `references/k-app.md` before authoring or changing a k-app.

## Workflow

1. Inspect the target directory and preserve its existing language project, build files, and user content. A k-app may also be a C++, C#, TypeScript/JavaScript, or other language project.
2. For a new app, run `node scripts/create-k-app.mjs <target> --name <name> --author <author> --functionality <summary>`. Do not overwrite an existing `app.htm(l)` or `config.k` without explicit user approval.
3. Implement the UI in `app.html` or `app.htm`. Use only relative asset URLs. Use the asynchronous `window.AgentK` API for project files, Pi requests, the current theme, and managed shell-free processes.
4. Keep author, functionality, semantic version, reserved values, and user settings in JSON-formatted `config.k`. Never store credentials or secrets there.
5. Run `node scripts/validate-k-app.mjs <target>`. Fix every validation error.
6. If Agent K is running, select the directory and verify that it opens without the website-preview toolbar, can call Pi, can start/read/stop a managed process, and cannot access paths or process working directories outside the k-app directory.

Do not fake API results, add a second manifest, or grant browser/Electron/Node privileges. The host injects the API only when `config.k` and `app.htm(l)` are direct children of the same selected directory.
