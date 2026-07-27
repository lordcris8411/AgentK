# Native language-extension protocol (v1)

Native language support is deliberately separate from file-format Editors:

```text
Editor iframe -> typed Editor bridge -> Electron language host -> package worker -> LSP/DAP process
```

An Editor owns presentation and editing. A native language extension owns project detection, toolchains, build databases,
semantic services, diagnostics, and any debugger declaration. The host does not contain language-specific branches and the
text Editor does not import a language package.

## Trust and installation

Language workers have Node.js and child-process privileges. Agent K therefore discovers them only from two trusted roots:

- bundled packages under the installed `language-servers/` directory;
- user-installed packages under the application-data `language-server-plugins/` directory.

Packages inside an opened workspace are never loaded as native workers. “Install language extension” in Settings copies an
already reviewed, already built directory into the application-data root and reloads the registry. Disabling a language
extension terminates its worker. Enabling it does not start a process immediately; workers are forked lazily on the first
request.

A package has this shape:

```text
example-lsp/
├── agent-k.language-server.json
├── worker.ts                 # source, when distributed for development
├── dist/worker.js            # required runtime selected by the manifest
└── SKILL.md                  # optional authoring/documentation companion
```

## Manifest

`agent-k.language-server.json` uses API version 1:

```json
{
  "apiVersion": 1,
  "id": "example-lsp",
  "displayName": "Example language service",
  "languages": ["example"],
  "projectMarkers": ["example.config"],
  "projectMenu": {
    "loadLabel": "Load Example project",
    "unloadLabel": "Unload Example project",
    "actions": [
      { "id": "build", "label": "Build project", "method": "terminalCommand" }
    ]
  },
  "editorContribution": {
    "id": "example-project",
    "name": "Example project",
    "description": "Example semantic project support.",
    "version": "1.0.0",
    "editorPluginId": "agent-k.text"
  },
  "skill": {
    "name": "Example language service",
    "markdown": "---\nname: example-language-service\ndescription: Use the managed Example language service.\n---\n"
  },
  "commands": [
    { "id": "active-example-projects", "title": "Active Example projects", "kind": "project-manager" }
  ],
  "worker": "dist/worker.js",
  "debugServer": {
    "protocol": "dap",
    "adapters": [
      { "command": "example-debug", "platforms": ["win32", "linux"] }
    ]
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `apiVersion` | yes | Must be `1`. |
| `id` | yes | Stable package ID using letters, numbers, `.`, or `-`. Duplicate IDs are rejected. |
| `displayName` | yes | Human-readable name shown in Settings, project status, and errors. |
| `languages` | yes | Editor-independent language IDs routed to this worker, such as `c` and `cpp`. |
| `projectMarkers` | yes | Direct child names used by the generic file tree to recognize a loadable project directory. |
| `projectMenu` | no | Localized load/unload labels and optional project actions. Each action maps an `id` and `label` to an opaque worker `method`. |
| `editorContribution` | no | Describes semantic functionality attached to an existing Editor plugin. `version` must be `x.y.z`; `editorPluginId` identifies the reused file Editor. |
| `skill` | no | Inline Skill metadata/body displayed by the language-extension manager. For a bundled package with `SKILL.md`, the Language Skill switch also controls whether Agent K passes that package to Pi through public `--skill` loading. It does not grant worker privileges. |
| `commands` | no | Slash-command contributions. API v1 supports `kind: "project-manager"`. |
| `worker` | yes | Built `.js` file inside the same package. Absolute paths and traversal are rejected. |
| `debugServer` | no | Declares a future/current DAP boundary and platform-specific adapter commands; declaration alone does not launch a debugger. |

Malformed manifests, unsupported API versions, missing workers, path traversal, duplicate IDs, and malformed optional fields
are rejected. Every worker receives an application-owned `cache/language-servers/<id>` directory during initialization.

## Worker transport

The host starts the worker with Electron's executable in Node mode and communicates over the child-process IPC channel.
Requests use this envelope:

```ts
{ type: "request", id: number, method: string, args: unknown[] }
```

Responses and events use:

```ts
{ type: "response", id: number, result?: unknown, error?: string }
{ type: "event", event: Record<string, unknown> }
```

An already-running worker may also receive the optional one-way workspace
notification below. Workers that do not implement filesystem synchronization
can ignore it without replying:

```ts
{
  type: "workspace-files-changed",
  changes: Array<{ path: string; type: 1 | 2 | 3 }>
}
```

The change types follow LSP `FileChangeType`: `1` created, `2` changed, and `3`
deleted. Events come from the operating-system workspace watcher, so they also
cover files written by Pi tools, shell commands, compilers, and external
applications rather than only edits made inside an Agent K Editor.

The first call is `initialize(cachePath)`. The host adds `languageServerId` to every emitted event and otherwise treats its
contents as opaque. Shutdown resolves outstanding host requests, asks the worker to stop, disconnects IPC, and terminates the
child.

Project-aware workers implement these generic methods:

| Method | Purpose |
| --- | --- |
| `list()` | Return project records containing at least `root`, `name`, and `status`. |
| `load(root)` | Prepare and start semantic support for one project root. |
| `unload(root)` | Stop and forget one project. |
| `restart(root)` | Recreate one loaded project. |
| `cancel()` | Cancel the active preparation/download/configuration operation. |
| `trace()` | Return bounded diagnostic transport history for the project-manager trace UI. |
| manifest action method | Return data expected by the generic action consumer; for example, `terminalCommand(root, relativePath)` returns a command for the project PTY. |
| optional Skill method | A package may expose a high-level structured method used by its Pi-facing Skill; the C++ package uses `skill(request)`. The generic host treats its method name and payload as opaque. |
| `lsp(file, method, params)` | Handle an Editor request routed by language and file. |
| `notify(file, method, params)` | Handle an Editor notification such as `didOpen`, `didChange`, or `didClose`. |
| `shutdown()` | Stop child services and release package state. |

`list` results are augmented with `languageServerId` and `languageServerName` before reaching the UI. Project menus and slash
commands are driven solely by manifest contributions rather than hard-coded language names. A `project-manager` slash command
opens the project list by default and supports `trace`, `restart <root>`, and `unload <root>`.

## Editor integration

An Editor calls `host.languageRequest(method, params)`. The renderer maps notification-style `*/did*` methods to the language
notification route and other methods to request/response RPC, using the current file's `initial.language` to choose a package.
The worker remains responsible for rejecting files outside loaded projects.

Workers may emit `language_server_diagnostics` with an absolute `file` and a diagnostics array. The host routes that event to
the matching cached Editor frame. When a project becomes ready, matching frames receive a `language-server-project-ready`
action so a tab opened before project loading can establish its document state.

## Bundled C++ package

`language-servers/cpp-clangd/` is the reference implementation. It recognizes `CMakeLists.txt` and
`compile_commands.json`, exposes `/active-cpp-projects`, and attaches C/C++ semantics to `agent-k.text`.

On first project load on Windows/Linux x64 it downloads pinned CMake 3.31.6, Ninja 1.12.1, and clangd 22.1.6 release archives,
verifies their SHA-256 hashes, and caches them under the package's private application cache. ZIP archives are extracted
in-process rather than passed to GNU tar. Both platforms use the standalone clangd package and a compiler available in the
project environment. On Windows that may be Visual Studio Build Tools, Clang, or MinGW; the worker initializes an installed
Visual Studio C++ environment through `vswhere` and `VsDevCmd`. The package configures a Ninja build
directory outside the source tree with `CMAKE_EXPORT_COMPILE_COMMANDS=ON`, then starts clangd with
background indexing and disk-backed PCH storage. Project unload/restart and preparation cancellation are available
from the file tree and project manager.

Its Pi-facing `agent_k_cpp_language_server` tool names a CMake workspace rather than passing an arbitrary path. `status`,
`load`, and `unload` provide an idempotent lifecycle; every semantic action rejects a workspace that is not loaded and ready.
Semantic actions include exact-symbol references, definitions, declarations, type declarations, implementations, hover,
workspace/document symbols, diagnostics, call hierarchy, and type hierarchy. The Skill explicitly keeps useful workspaces
loaded instead of repeatedly paying CMake configuration and clangd indexing costs. In a ready workspace these semantic
operations take priority over shell text searches; shell remains the direct path for builds, tests, execution, Git, and
explicitly textual or regular-expression searches.

The text Editor currently integrates document synchronization (including
`didOpen`, versioned `didChange`, `didSave`, and `didClose`), diagnostics,
completion, hover, semantic tokens, definition, declaration, and references for
loaded C++ projects. The worker converts workspace watcher events to
`workspace/didChangeWatchedFiles`; project-owned CMake configuration changes
are coalesced and rebuild the compilation database before clangd restarts.
Generated build/dependency CMake files do not trigger reconfiguration. The
manifest's DAP adapters reserve WinDbg on Windows and LLDB/GDB on Linux/macOS,
but no debug adapter is launched yet.

## Build and verification

First-party packages use `worker.ts` as source and the manifest-selected `dist/worker.js` as runtime:

```bash
npm run build:language-servers
npm run check:language-servers
npm run check:desktop
npm test
```

`build:language-servers` creates a Node 22 worker bundle for every package. `check:language-servers` verifies that each declared
runtime already exists; registry tests cover manifest validation, discovery, and public metadata.
