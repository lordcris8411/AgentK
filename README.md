<div align="center">
  <img src="assets/icons/agent-k.svg" width="112" height="112" alt="Agent K logo">

  # Agent K

  **A visual workspace where the [Pi coding agent](https://github.com/earendil-works/pi) can understand and use purpose-built Editors.**

  Bring conversations, projects, files, tools, models, and Pi extensions together on Windows and Linux.

  [Product overview](#part-i-product-overview) · [Product tour](#product-tour) · [Technical guide](#part-ii-technical-guide) · [中文](#第一部分产品介绍)

  [![CI](https://github.com/lordcris8411/AgentK/actions/workflows/ci.yml/badge.svg)](https://github.com/lordcris8411/AgentK/actions/workflows/ci.yml)
  [![Electron 43](https://img.shields.io/badge/Electron-43-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
  [![React 19](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)](https://react.dev/)
  [![Windows](https://img.shields.io/badge/Windows-supported-0078D4?logo=windows)](#platform-support)
  [![Linux](https://img.shields.io/badge/Linux-supported-FCC624?logo=linux&logoColor=black)](#platform-support)
  [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
</div>

## Part I: Product overview

### Pi, with a complete desktop workspace

Agent K is the graphical desktop frontend for Pi. It does not replace Pi or create a separate agent ecosystem. Your Pi models,
providers, conversations, commands, Skills, Extensions, and project settings remain available, while Agent K gives them a
focused visual workspace.

You can keep the conversation in the center, browse project files on the side, open a terminal when needed, and preview or edit
files without leaving the application. Long-running work remains visible through live reasoning, tool activity, progress, and
change-review cards.

Agent K is also self-extensible: **users can create Editor Extensions and Language Service Extensions from inside Agent K by
working with Pi.** This authoring workflow is available now; it is not only a roadmap direction.

### Product tour

<p align="center">
  <img src="screenshots/cpp-workspace.png" width="100%" alt="Agent K conversation, C++ project, code Editor, and terminal in one workspace">
  <br>
  <sub>Conversation, C++ semantic navigation, project files, a code Editor, and a native terminal stay in one workspace.</sub>
</p>

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="screenshots/project-actions.png" width="100%" alt="Agent K project actions and C++ workspace loading">
      <br><sub><strong>Project actions</strong> — open a folder externally, load its C++ language workspace, or build it in the integrated terminal.</sub>
    </td>
    <td width="50%" valign="top">
      <img src="screenshots/model-providers.png" width="100%" alt="Agent K model and Provider settings">
      <br><sub><strong>Models and Providers</strong> — configure compatible Pi providers, authentication, models, and reasoning levels visually.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="screenshots/themes.png" width="100%" alt="Agent K custom theme carousel">
      <br><sub><strong>Complete themes</strong> — preview built-in or imported themes that coordinate the app, Editors, syntax, terminal, and fonts.</sub>
    </td>
    <td width="50%" valign="top">
      <img src="screenshots/editor-manager.png" width="100%" alt="Agent K Editor and language extension manager">
      <br><sub><strong>Editor management</strong> — inspect package Skills and control Editors, Editor Skills, language services, and Language Skills separately.</sub>
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <img src="screenshots/skill-hub.png" width="100%" alt="Agent K Skill Hub and installed Skill manager">
      <br><sub><strong>Skill Hub</strong> — safely preview Skills from skills.sh or GitHub, then manage installed Pi Skills in the same interface.</sub>
    </td>
  </tr>
</table>

### Core feature: Editors Pi can understand and use

Most AI tools treat a file as plain text or an attachment. Agent K treats a file as the entrance to a purpose-built workspace.
An Editor can decide what the file should look like and how a person should interact with it; its paired Editor Skill teaches Pi
what that workspace means and how it should be used.

~~~text
your file → its purpose-built Editor → format knowledge and safe actions → you and Pi share one workspace
~~~

The design has three parts:

- **The right experience for the file:** a format is not forced into a generic text box. It can have a canvas, timeline, graph,
  form, table, player, live preview, or any other interface that makes sense for the work.
- **The right knowledge for Pi:** the paired Editor Skill explains the format, the active file, the workflow, and the meaning of
  the available controls. You can say “this file,” “the current scene,” or “the visible result” without rebuilding that context
  by hand.
- **A deliberate action boundary:** the Editor declares exactly what Pi may ask it to do. Pi can participate in the same visual
  workflow without guessing hidden operations or receiving unrestricted desktop access.

This is more than an extensible file viewer. It is a way to build AI-native tools in which the visual interface, domain knowledge,
and agent workflow are shipped together.

### What you can do

- **Turn specialized files into shared AI workspaces:** install an Editor with its Editor Skill, then work with Pi through the
  view and controls designed for that domain instead of translating everything into chat messages.
- **Create extensions inside Agent K—available today:** describe the Editor or language support you need in the conversation,
  let Pi author and validate it with Agent K's built-in extension guidance, then review and install it as a separately managed
  package.
- **Work with multiple projects and conversations:** pin active workspaces, switch between recent sessions, create branches, and
  return to previous work without rebuilding your desktop layout.
- **Follow the agent while it works:** see live progress, reasoning, tool calls, permission requests, file changes, elapsed time,
  context usage, and completion status in one conversation view.
- **Work on files together with Pi:** open code, documents, websites, images, audio, video, and PDFs beside the conversation. With
  an Editor Skill enabled, Pi knows which file is active, understands the experience it belongs to, and can use the actions that
  experience makes available.
- **Use a real project terminal:** run normal shell commands, copy terminal content, or send selected output back into the chat.
  On Linux, Agent K keeps your Bash configuration while mapping standard ANSI colors—and Starship when installed—to the
  active theme.
- **Manage the Pi ecosystem visually:** inspect, install, enable, or disable Skills and Extensions without manually editing
  configuration files. File editors and language features have their own controls.
- **Choose models and permissions:** manage providers, switch models, select reasoning levels, and control whether a session may
  run actions.
- **Keep long conversations useful:** optional automatic context cleanup preserves the important recent state before the context
  becomes full.
- **Match your desktop:** choose light, HDR-friendly soft light, dark, system, or an imported custom theme. A complete theme can
  coordinate the application, Monaco syntax, terminal palette, and UI/code fonts. Window size, panel widths, terminal height,
  and panel visibility are remembered for the next launch.
- **Put large caches where they belong:** choose the cache location used by language tools, indexes, and temporary data without
  moving the project or application installation.
- **Stay responsive on larger work:** session reuse, file-editor caching, and interaction optimizations reduce pauses when
  switching conversations, opening files, scrolling, or resizing panels.

### What the Editor Skill model makes possible

The bundled Editors demonstrate the model with code, documents, websites, images, media, and PDFs. The important idea is not
that list—it is that an installed Editor and its paired Skill can turn another format into a new collaborative product experience.

| A purpose-built Editor could provide | You could work with Pi like this |
| --- | --- |
| A spreadsheet with formulas, filters, and charts | “Explain these outliers, correct the formula, and update the chart while I keep the table open.” |
| A 3D scene or game-level viewport | “Focus the broken object, inspect its source definition, fix the material, and reload the scene.” |
| A log, trace, or performance timeline | “Jump to the first failure, group related events, and explain what happened immediately before it.” |
| A diagram or node-based configuration | “Add the missing service, connect it to the queue, validate the relationships, and show me the result.” |
| A binary, firmware, or save-file inspector | “Decode this region, highlight the invalid field, patch it, and recalculate the checksum.” |
| An API request collection | “Open the login request, compare the latest response with the expected schema, and prepare the corrected request.” |
| A media-review timeline | “Go to the reported moment, mark the section that needs work, and keep that segment as our current context.” |
| A proprietary business or scientific format | “Use our organization’s own viewer, rules, and approved actions to review and update this record.” |

These examples describe the possibility of the Editor Skill model, not a claim that every specialized Editor is bundled today.
The model lets each future package define all three parts together: what the user sees, what Pi needs to understand, and what Pi
is allowed to do. Adding a new domain does not require turning Agent K itself into a spreadsheet, 3D tool, diagram editor, or
firmware suite.

### Create the Editor or language support you need

> **Available today:** the extension system is not reserved for Agent K maintainers. A user can ask Pi to create or update an
> Editor Extension or Language Service Extension without leaving Agent K.

Agent K includes the `create-agent-k-extensions` authoring Skill. It gives Pi the current package rules, the separation between
visual file experiences and trusted language services, and the required creation and verification workflow.

| When you need | Ask Pi to create |
| --- | --- |
| A better way to view or manipulate a file | An **Editor Extension** that defines the complete visual experience, file matching, controls, styles, safe actions, and the Editor Skill that teaches Pi how to use it |
| Deeper understanding of a language or project | A **Language Service Extension** that can recognize projects, manage its language tools, provide diagnostics and navigation, contribute project actions, and connect semantic results to an existing Editor |

The two extension types solve different problems. An Editor Extension owns what the user sees and how the file is manipulated;
its paired Editor Skill gives Pi the format-specific knowledge and permitted actions. A Language Service Extension owns
project-level analysis and semantic services. It can enhance an existing Editor and does not need to create another file UI.

For example, you could say:

- “Create an Editor for `.scene` files with a scene tree, property panel, viewport, and actions for focusing or reloading an object.”
- “Create an Editor Skill that teaches Pi our scene rules and only exposes the approved scene operations.”
- “Add language support for our internal configuration language, recognize projects by `acme.project`, and show validation errors in the text Editor.”
- “Connect the new language service to the existing Editor instead of building another code editor.”

The complete authoring loop happens through Agent K:

1. Describe the file experience or language support you want in the conversation.
2. Pi selects the right extension type and reads Agent K's official extension rules.
3. Pi creates the independent package, visual experience or language service, matching rules, companion Skill, and ready-to-use output.
4. Pi runs the required build, tests, and validation.
5. Review the generated files, then install and enable the package from Agent K.

Agent K does not silently trust or install generated code. Editor Extensions run in an isolated environment after validation.
Language Service Extensions have deeper access to local language tools, so they must receive explicit review before installation.
Both remain independent packages that can be inspected, enabled, disabled, installed, or shared without adding
format- or language-specific branches to Agent K itself.

Today, the first-party packages provide these starting points:

| Category | Built-in experience |
| --- | --- |
| Code and text | Multi-tab editing, search, undo, save, navigation, and optional language assistance |
| Markdown | Source editing and rendered document preview |
| HTML and web projects | Source editing, project launch, isolated preview, screenshot capture, and preview-error inspection |
| Images | Fit, pan, and smooth zoom |
| Audio and video | Playback, seeking, and media information |
| PDF | In-app document reading |

Every Editor and Editor Skill can be managed independently. You may keep the visual experience while withholding its specialized
guidance and actions from Pi; disabling an Editor also disables its paired Skill. Context sent to Pi stays hidden from the visible
question and remains inspectable under **Raw information**.

### A typical workflow

1. Add a project folder and open or create a conversation.
2. Ask Pi to inspect, explain, change, build, or test the project.
3. Follow the current activity above the message box and review tool calls as they complete.
4. Open changed files beside the conversation, use preview when available, and review proposed changes.
5. Continue in the same session, create a branch to explore another direction, or switch to another project while work continues.

### Commands available from chat

Type `/` in the message box to search both Pi commands and Agent K actions.

| Command | What it opens or does |
| --- | --- |
| `/settings` | Open Agent K Settings |
| `/skills`, `/extensions`, `/editors` | Open the corresponding manager |
| `/model [provider/model]` | Choose a model or switch directly |
| `/compact [instructions]` | Clean up the current conversation context |
| `/new` | Start a new conversation |
| `/fork`, `/tree` | Explore conversation branches |
| `/name <name>` | Rename the current conversation |
| `/session` | Show session usage and statistics |
| `/reload` | Apply refreshed Pi resources and configuration |

Installed language packages may add their own project actions.

### Platform support

- Windows 10/11 x64
- Modern Linux x64 desktops using X11 or Wayland
- Light, HDR-friendly soft light, dark, system, and importable custom themes on both platforms

Release builds include a compatible, unmodified Pi distribution, so a separate global Pi installation is not required.

### Product roadmap

- One-click local model packages with llama.cpp and downloads from ModelScope or Hugging Face.
- More built-in Skills and Extensions, plus in-app discovery across compatible Skill catalogs.
- A broader catalog for community-created Editor and Language Service Extensions.
- Integrated debugging workflows for C/C++, Python, and JavaScript/TypeScript.
- A supported macOS release.

## Part II: Technical guide

### Architecture and Pi boundary

~~~text
┌──────────────────────────┐
│ React renderer           │
│ sandboxed, process-free  │
└────────────┬─────────────┘
             │ context-isolated preload IPC
┌────────────▼─────────────┐
│ Electron main process    │
│ files · PTY · Pi pool    │
└───────┬───────────┬──────┘
        │           │ trusted worker IPC
        │ public JSONL RPC
┌───────▼──────────┐  ┌────▼────────────────┐
│ external Pi RPC │  │ language worker/LSP │
└──────────────────┘  └─────────────────────┘
~~~

Agent K maintains only the visual client. Pi runs as an external child process in RPC mode and is accessed exclusively through
its public protocol. Agent K never edits, vendors, or commits Pi source; `.reference/pi/` is ignored reference material. A
release may carry an unmodified Pi distribution for one-click startup without changing this process boundary.

Protocol-specific code stays under `electron/agent/`. The React renderer has no Node.js or direct process access; a
context-isolated preload exposes a narrow, typed desktop API. Filesystem, credentials, PTY, process, and native language work
remain in the Electron main process or dedicated trusted workers. See [Architecture](docs/architecture.md).

### Pi runtime selection and session pool

Agent K resolves Pi in this order:

1. `AGENT_K_PI_EXECUTABLE`
2. The executable configured in Agent Settings
3. `pi` on the system `PATH`
4. The bundled Pi runtime

The desktop prewarms a configurable pool of 2–4 Pi RPC processes. A session is mapped to a reusable runtime, matching
workspace/session processes are retained, capacity grows when every worker is occupied, and surplus workers are reaped after
five idle minutes. Switching sessions therefore normally reuses an established RPC connection instead of starting Pi again.

Skill and Extension changes remain pending inside Settings. When Settings closes and every worker is idle, replacement workers
are prepared concurrently, their sessions are restored, and the pool is swapped only after all replacements succeed. This
transactional refresh avoids mixed resource states across workers.

### Performance design

| Area | Implementation |
| --- | --- |
| Conversation input | The editable surface paints keystrokes immediately; ordinary text is committed to React after 350 ms idle, while slash filtering remains immediate. Composer state does not invalidate the conversation tree. |
| Session navigation | Runtime assignment, selected history, and active RPC state are reused instead of reconnecting and refetching on every switch. |
| React rendering | Conversation rows and stable subtrees are memoized; streaming state is scoped so terminal input and unrelated panels do not rerender with every agent event. |
| Panel resizing | Pointer reports are capped at 60 Hz. Editor layout is suspended during a drag and one authoritative layout is requested when the interaction ends. |
| Monaco layout | Code-capable Editor packages own Monaco with `automaticLayout` disabled. The host never reaches into Monaco internals. |
| Dependency cache | Exact Monaco JavaScript/CSS versions use an internal read-only protocol, Chromium resource caching, and V8 code caching. Language workers are loaded only when required. |
| Editor instance cache | Up to 40 recently used Editor frames remain alive across file, session, and workspace switches, with LRU eviction. |
| Scrolling and media | Scroll measurement, custom scrollbars, delayed commits, and media zoom are frame-budgeted with `requestAnimationFrame`. |
| Terminal | The project console uses a native PTY and enables WebGL rendering when available. Terminal input is isolated from conversation streaming. Theme changes replace the xterm palette and font live; the Linux Bash profile retains the user's `.bashrc`, gives an installed Starship an ANSI-only profile, and keeps directory colors on that palette. |
| Lightweight caches | Provider catalogs use a short TTL; About/browser discovery share promises; layout and theme state restore before expensive background initialization. The language-tool, index, and temporary-data cache root is user-selectable. |

### Complete theme system

An Agent K theme is a validated JSON package rather than a single light/dark flag. It can define application surfaces and
semantic component colors, Monaco UI and syntax colors, the complete ANSI terminal palette, and separate UI/code font stacks.
Theme changes propagate live to the React interface, cached Editor frames, Monaco instances, the review view, and the project
terminal; imported themes are previewed before selection and can be removed independently.

Custom theme files can be imported from **Settings → Appearance and language** or created with Pi through the bundled
`create-agent-k-theme` Skill. Agent K watches the user theme directory and applies valid external updates without requiring a
rebuild. See the [Retro Terminal example](examples/theme/retro-terminal.json) for a complete theme definition.

### Programmable file Editor SDK

File Editors are independent browser applications, not subclasses of a shared host editor. A package owns its DOM, CSS,
framework, editing engine, controls, and rendering strategy; packages do not import one another. Selection can match an extension,
an exact filename, an absolute path, or a MIME type.

A package contains:

~~~text
example-editor/
├── editor.json       # discovery, matching, permissions, and runtime metadata
├── editor.ts         # real application source
├── dist/             # prebuilt browser runtime
└── SKILL.md          # required Pi-facing Editor Skill
~~~

Agent K runs the bundle in a unique-origin `<iframe sandbox="allow-scripts">`. The frame has no Node.js, Electron IPC, host DOM,
or direct filesystem access. A nonce-checked, versioned bridge carries content, dirty state, save requests, themes, navigation,
line references, and declared callable capabilities. Runtime bundles and resolved asset paths are validated before execution.

Project packages in `.pi/skills/` or `.agents/skills/` override user packages in `~/.pi/agent/skills/` or `~/.agents/skills/`,
which override first-party packages. The Editor and its Pi-facing Editor Skill have separate switches, with the invariant that a
disabled Editor cannot leave its Skill enabled.

The first-party text package chooses Monaco 0.55.1, while other packages remain free to use another Monaco version, CodeMirror,
Canvas, a framework, or plain DOM. Dependencies are identified and cached independently by exact version.
See [File-format SDK](docs/file-format-sdk.md).

### Native language extensions

Native language packages are trusted worker packages with process access. They own project markers, tool preparation, build
databases, diagnostics, LSP transport, project lifecycle, semantic Editor contributions, and DAP declarations. They are loaded
only from the installation or application-data plugin directory—never from an opened workspace—and start lazily on first use.

The bundled `cpp-clangd` package supports CMake and compilation-database projects. On Windows/Linux x64 it downloads pinned
CMake 3.31.6, Ninja 1.12.1, and standalone clangd 22.1.6 archives, verifies SHA-256 hashes, and keeps them in a private cache.
ZIP files are extracted in-process instead of being passed to platform `tar` implementations.

CMake metadata is generated outside the source tree with a compiler from the project environment. Linux uses the configured
GCC/Clang toolchain. Windows accepts `CC`/`CXX`, Clang, MinGW, or MSVC; when necessary it discovers Visual Studio Build Tools via
`vswhere` and initializes `VsDevCmd`. Missing compiler prerequisites produce an explicit error rather than downloading an
incomplete full LLVM SDK. clangd runs in a separate process with background indexing and disk-backed PCH storage.

The C++ Language Skill lets Pi check a named CMake workspace's load state and query exact-symbol references, definitions,
declarations, implementations, hover information, diagnostics, workspace/document symbols, and call/type hierarchies through
the already-running clangd worker. Queries never implicitly load a project, and lifecycle operations are idempotent so Pi can
keep useful workspaces loaded instead of repeatedly configuring and indexing them. For semantic C++ questions this path takes
priority over shell text search; builds, tests, execution, Git, and explicitly textual searches continue to use the terminal.

See [Native language-extension protocol](docs/language-server-plugin.md).

### Extension authoring from Agent K

The bundled `create-agent-k-extensions` Skill gives Pi the repository's canonical boundary and verification workflow. An Editor
request is routed to an independent `editor.json + editor.ts + SKILL.md + dist` package; a language request is routed to an
`agent-k.language-server.json + worker.ts + dist/worker.js` package. Pi reads the corresponding protocol documentation before
changing the package and keeps format UI separate from trusted project/LSP processes.

Editor packages are built with `npm run build:editors`; language workers use `npm run build:language-servers`. The authoring flow
then runs the relevant manifest tests, strict project checks, and `git diff --check`. Installation never compiles unknown source
or runs npm lifecycle scripts on behalf of a downloaded package: an Editor must already contain its browser runtime, and a
trusted language worker must already be built and explicitly reviewed.

### Pi resources and Skill Hub

Agent K exposes Pi Skills and Extensions through Pi's public launch options; it does not patch the runtime. Bundled resources
include:

| Resource | Purpose |
| --- | --- |
| `weather` Skill | Current, hourly, and seven-day weather through Open-Meteo |
| `gdb-debug` Skill | GDB launch, backtrace, threads, and core-dump workflows |
| `create-agent-k-extensions` Skill | Authoring and validation guidance for Agent K packages |
| `create-agent-k-theme` Skill | Creation and management of complete Agent K theme packages |
| K's Plan Extension | Strict file-backed task planning and review through `/plan` |

Skill Hub accepts `skills add` commands, skills.sh URLs, GitHub repository URLs, and direct GitHub Skill-directory URLs. Preview
is bounded to 80 files / 2 MiB, displays the exact `SKILL.md` and file list, and verifies a content hash before installation. It
does not execute npm lifecycle scripts.

### Credentials and security

- Provider catalogs come from Pi's public `get_available_models` RPC.
- API keys cross an isolated Electron IPC boundary and are written to Pi's `auth.json`; they are never stored in browser storage.
- OAuth and structured authentication use the official Pi interactive terminal.
- Credential paths are `~/.pi/agent/auth.json` on Linux and `%USERPROFILE%\.pi\agent\auth.json` on Windows.
- The renderer is Chromium-sandboxed, but Pi and approved tools run with the current user's OS permissions. Execution approval is
  not an operating-system sandbox; use a container or VM for untrusted code.

See [Security policy](SECURITY.md).

### Requirements and source startup

| Component | Requirement |
| --- | --- |
| Node.js | 22.19 or newer |
| Pi | Bundled in release builds; optional external Pi 0.80.10 or compatible |
| Windows | Windows 10/11 x64 |
| Linux | Modern x64 desktop with X11 or Wayland |

Linux:

~~~bash
git clone https://github.com/lordcris8411/AgentK.git
cd AgentK
./script/run-linux.sh
~~~

Windows Command Prompt or PowerShell:

~~~bat
git clone https://github.com/lordcris8411/AgentK.git
cd AgentK
script\run-windows.bat
~~~

The scripts install locked npm dependencies, prepare the reviewed native PTY module, download the Electron runtime with its
reviewed official installer, and launch the complete development application. Rust, Cargo, WebKitGTK development packages, and
WebView2 are not required.

Minimal Linux installations may need Chromium runtime libraries:

~~~bash
# Debian / Ubuntu
sudo apt install libgtk-3-0 libnss3 libasound2t64 libgbm1

# Fedora / Nobara
sudo dnf install gtk3 nss alsa-lib mesa-libgbm
~~~

### Development and builds

Install dependencies without running unreviewed third-party lifecycle scripts, then prepare the reviewed native components:

~~~bash
npm ci --ignore-scripts
npm run prepare:native
node node_modules/electron/install.js
~~~

Building `node-pty` from source on Linux requires Python 3, `make`, and a C++ compiler. Release packages contain the prepared
native module.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Vite and the complete Electron development environment |
| `npm run dev:web` | Start only the renderer |
| `npm run prepare:native` | Prepare the reviewed `node-pty` native module |
| `npm run check` | Check renderer, Electron, language packages, Editors, and K's Plan |
| `npm run check:desktop` | Type-check the Electron main process |
| `npm run build:editors` | Build all first-party Editor packages and shared dependencies |
| `npm run build:language-servers` | Build trusted first-party native language workers |
| `npm test` | Run the repository test suite |
| `npm run build` | Build language workers, Electron, Editors, and renderer |
| `npm run dist:linux` | Build the Linux AppImage |
| `npm run dist:windows` | Build the Windows NSIS installer |

Platform checks are also available through `./script/test-linux.sh` and `script\test-windows.bat`.

### Repository layout

~~~text
AgentK/
├── electron/               # Electron main process, desktop services, and Pi pool
│   └── agent/              # Pi process and public RPC adapter
├── src/                    # sandboxed React renderer
├── editor/                 # programmable Editor SDK and independent packages
├── language-servers/       # trusted native language packages
├── extensions/k-plan/      # bundled Pi Extension
├── skills/                 # bundled Pi Skills
├── themes/                 # built-in complete theme definitions
├── screenshots/            # product screenshots used by this README
├── script/                 # Windows/Linux run, test, and build scripts
└── docs/                   # protocol and architecture documentation
~~~

### Contributing and license

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before starting. The central boundaries are:

- never vendor, edit, or commit Pi source;
- keep Pi protocol behavior under `electron/agent/`;
- keep the React renderer process-free;
- do not remove user-facing functionality without explicit approval.

[MIT](LICENSE) © 2026 Agent K contributors

---

## 第一部分：产品介绍

### 为 Pi 打造的完整桌面工作区

Agent K 是 Pi 的图形化桌面前端。它不会替代 Pi，也不会创造另一套不兼容的 Agent 生态。你在 Pi 中使用的模型、
Provider、会话、命令、Skills、Extensions 和项目配置都可以继续使用，同时获得一个更完整、更集中的桌面界面。

对话位于界面中央，项目文件、终端和预览编辑器分布在两侧。你无需频繁切换应用，就能看到 Agent 当前正在做什么、
使用了哪些工具、修改了哪些文件，以及任务是否已经完成。

Agent K 还具备自扩展能力：**用户可以直接在 Agent K 中与 Pi 协作，创建 Editor Extension 和 Language Service Extension。**
这是当前已经提供的编写流程，不只是 Roadmap 中的未来方向。

### 产品界面

<p align="center">
  <img src="screenshots/cpp-workspace.png" width="100%" alt="Agent K 对话、C++ 工程、代码 Editor 和终端工作区">
  <br>
  <sub>对话、C++ 语义导航、项目文件、代码 Editor 与原生终端位于同一个工作区。</sub>
</p>

模型与 Provider、项目操作、完整主题、Editor 管理器和 Skill Hub 的更多界面见前面的
[Product tour](#product-tour)。

### 核心特性：Pi 能理解和使用的 Editor

大多数 AI 工具只把文件当作纯文本或附件。Agent K 把文件看成一个专用工作台的入口。Editor 决定这种文件应该以什么形态
呈现、用户应该如何操作；与它配套的 Editor Skill 则让 Pi 理解这个工作台代表什么、应该如何参与。

~~~text
你的文件 → 为它设计的专用 Editor → 格式知识与安全动作 → 你和 Pi 共享同一个工作台
~~~

这套设计由三部分组成：

- **适合这种文件的界面：** 文件不必被塞进通用文本框，它可以拥有画布、时间轴、关系图、表单、表格、播放器、实时预览，
  或任何真正适合这项工作的界面。
- **Pi 所需的领域知识：** 配套 Editor Skill 会说明文件格式、当前对象、工作流程和控件含义。你可以直接说“这个文件”、
  “当前场景”或“现在看到的结果”，无需每次手动重建上下文。
- **明确的动作边界：** Editor 会清楚声明 Pi 可以请求哪些操作。Pi 能参与同一个可视化流程，但不能猜测隐藏动作，也不会因此
  获得不受限制的桌面权限。

因此，它不只是一个可以扩展的文件查看器，而是一种构建 AI 原生工具的方式：可视化界面、领域知识和 Agent 工作流程可以作为
一个整体一起交付。

### 你可以用它做什么

- **把专业文件变成共享 AI 工作台：** 安装 Editor 及其 Editor Skill 后，你可以通过这个领域真正需要的视图和控件与 Pi 协作，
  而不必先把所有内容翻译成聊天文字。
- **现在就能在 Agent K 中创建扩展：** 在对话中描述你需要的 Editor 或语言支持，让 Pi 根据 Agent K 内置扩展规范完成编写和
  校验，审阅结果后再把它作为独立包安装和管理。
- **同时管理多个项目和会话：** 固定常用工作区，按活跃度查看最近会话，创建对话分支，并在切换后保留原来的界面布局。
- **实时跟进 Agent 工作：** 在同一个对话界面查看进度、思考过程、工具调用、执行确认、文件变更、耗时、上下文用量和完成状态。
- **和 Pi 一起处理文件：** 在对话旁打开代码、文档、网站、图片、音频、视频和 PDF。启用 Editor Skill 后，Pi 会知道当前
  正在查看哪个文件、它属于哪种文件体验，以及此刻可以安全使用哪些编辑器动作。
- **使用真正的项目终端：** 运行日常命令、复制终端内容，或把选中的输出直接加入聊天框。在 Linux 上，Agent K 会保留用户
  的 Bash 配置，同时让标准 ANSI 颜色及已安装的 Starship 跟随当前主题。
- **可视化管理 Pi 生态：** 查看、安装、启用或关闭 Skills 和 Extensions，无需手动编辑配置文件；文件编辑器和语言功能也有独立开关。
- **选择模型和权限：** 管理 Provider、切换模型、选择思考级别，并决定某个会话是否允许执行操作。
- **保持长对话可用：** 可选的自动上下文整理会在容量耗尽前保留近期的重要信息。
- **适应你的桌面习惯：** 支持浅色、适合 HDR 显示器的柔和亮色、深色、跟随系统及导入的自定义主题。完整主题可以统一应用
  界面、Monaco 语法、终端调色板和 UI/代码字体，并记住窗口大小、边栏宽度、终端高度及面板开关状态。
- **自行安排大型缓存：** 可以选择语言工具、索引和临时数据的缓存位置，无需移动项目或 Agent K 安装目录。
- **在大型任务中保持流畅：** 会话复用、文件编辑器缓存和交互优化可以减少切换会话、打开文件、滚动及调整面板时的等待。

### Editor Skill 模型带来的可能性

当前内置 Editor 使用代码、文档、网站、图片、媒体和 PDF 展示了这套模型。真正重要的不是这张格式清单，而是任何新安装的
Editor 及其配套 Skill 都可以把另一种文件变成新的协作产品体验。

| 一个专用 Editor 可以提供 | 你可以这样与 Pi 协作 |
| --- | --- |
| 带公式、筛选和图表的电子表格 | “解释这些异常值，修正公式，并在我继续看表格时更新图表。” |
| 3D 场景或游戏关卡视口 | “定位这个损坏对象，检查它的源定义，修复材质，然后重新载入场景。” |
| 日志、Trace 或性能时间轴 | “跳到第一次失败，归类相关事件，并解释在它之前发生了什么。” |
| 关系图或节点式配置 | “补上缺失的服务，把它连接到队列，校验关系，然后显示最终结果。” |
| 二进制、固件或存档检查器 | “解析这个区域，高亮错误字段，完成修补并重新计算校验和。” |
| API 请求集合 | “打开登录请求，对比最近响应和预期结构，然后准备修正后的请求。” |
| 媒体审阅时间轴 | “跳到报告中的时间点，标记需要修改的片段，并让这段内容成为当前上下文。” |
| 企业或科研专有格式 | “使用我们自己的查看器、业务规则和已批准动作来审阅并更新这条记录。” |

这些例子展示的是 Editor Skill 模型的可能性，并不表示所有专用 Editor 现在都已经内置。这个模型允许未来的每个包同时定义三件事：
用户看到什么、Pi 需要理解什么、Pi 被允许做什么。增加一个新领域，不需要先把 Agent K 本身改造成电子表格、3D 工具、关系图
编辑器或固件套件。

### 创建你需要的 Editor 或语言支持

> **当前已经支持：** 扩展系统不是 Agent K 维护者的专属能力。普通用户无需离开 Agent K，就可以让 Pi 创建或更新
> Editor Extension 和 Language Service Extension。

Agent K 内置 `create-agent-k-extensions` 编写 Skill。它会向 Pi 提供最新的包规范、可视化文件体验与受信任语言服务之间的边界，
以及必须执行的创建和校验流程。

| 当你需要 | 可以让 Pi 创建 |
| --- | --- |
| 更合适的文件查看或操作方式 | **Editor Extension**：完整定义可视化体验、文件匹配、控件、样式和安全动作，同时提供教 Pi 使用它的 Editor Skill |
| 更深入的语言或项目理解 | **Language Service Extension**：识别工程、管理语言工具、提供诊断与导航、贡献项目动作，并把语义结果接入现有 Editor |

两类扩展解决的是不同问题。Editor Extension 决定用户看到什么、如何操作文件；配套 Editor Skill 向 Pi 提供格式知识和允许调用的
动作。Language Service Extension 负责工程级分析和语义服务，它可以增强现有 Editor，不需要再创建一套文件界面。

例如，你可以直接说：

- “为 `.scene` 文件创建一个 Editor，包含场景树、属性面板、视口，以及聚焦和重新载入对象的动作。”
- “创建配套 Editor Skill，让 Pi 理解我们的场景规则，并且只暴露经过批准的场景操作。”
- “为内部配置语言增加语言支持，通过 `acme.project` 识别工程，并把校验错误显示在文本 Editor 中。”
- “把新语言服务连接到现有 Editor，不要再做一个代码编辑器。”

完整编写闭环都可以通过 Agent K 完成：

1. 在对话中描述你想要的文件体验或语言支持。
2. Pi 选择合适的扩展类型，并读取 Agent K 的官方扩展规则。
3. Pi 创建独立包、可视化体验或语言服务、匹配规则、配套 Skill 和可直接使用的产物。
4. Pi 运行必要的构建、测试和校验。
5. 用户检查生成文件，然后在 Agent K 中安装并启用该扩展。

Agent K 不会静默信任或安装生成的代码。Editor Extension 通过校验后在隔离环境中运行；Language Service Extension
对本地语言工具拥有更深层访问，因此安装前必须经过明确审阅。两者都保持为独立包，可以检查、启用、关闭、安装或分享，
不需要向 Agent K 本身加入特定格式或语言的分支。

当前第一方包提供以下起点：

| 类型 | 内置体验 |
| --- | --- |
| 代码和文本 | 多标签编辑、搜索、撤销、保存、跳转和可选语言辅助 |
| Markdown | 源码编辑与渲染后的文档预览 |
| HTML 和 Web 项目 | 源码编辑、项目启动、隔离预览、预览截图和错误查看 |
| 图片 | 自适应、拖动和平滑缩放 |
| 音频和视频 | 播放、定位和媒体信息 |
| PDF | 应用内文档阅读 |

每个 Editor 和 Editor Skill 都可以独立管理。你可以保留可视化体验，但不向 Pi 提供该格式的专用说明与动作；关闭 Editor 时，
对应 Skill 也会关闭。发送给 Pi 的上下文不会混入可见问题，并可在“原始信息”中检查。

### 一次典型的使用过程

1. 添加一个项目文件夹，打开已有会话或新建会话。
2. 让 Pi 检查、解释、修改、编译或测试项目。
3. 在输入框上方查看当前工作状态，并在工具调用完成后检查结果。
4. 在对话旁打开变更文件，使用可用的预览功能并审阅修改。
5. 在同一会话继续工作、创建分支探索另一种方案，或切换到其他项目，同时保留正在进行的任务。

### 聊天框中的快捷命令

在输入框中键入 `/`，即可同时搜索 Pi 命令与 Agent K 操作。

| 命令 | 功能 |
| --- | --- |
| `/settings` | 打开 Agent K 设置 |
| `/skills`、`/extensions`、`/editors` | 打开对应管理器 |
| `/model [provider/model]` | 选择模型或直接切换 |
| `/compact [instructions]` | 整理当前对话的上下文 |
| `/new` | 新建会话 |
| `/fork`、`/tree` | 查看对话分支 |
| `/name <name>` | 修改当前会话名称 |
| `/session` | 查看会话用量和统计 |
| `/reload` | 应用更新后的 Pi 资源和配置 |

已安装的语言包还可以增加自己的项目操作。

### 平台支持

- Windows 10/11 x64
- 使用 X11 或 Wayland 的现代 Linux x64 桌面
- 两个平台都支持浅色、适合 HDR 显示器的柔和亮色、深色、跟随系统及可导入的自定义主题

正式安装包包含兼容且未经修改的 Pi 发行物，不要求用户另外全局安装 Pi。

### 产品路线图

- 内置 llama.cpp，并支持从 ModelScope 或 Hugging Face 下载本地模型后直接使用。
- 提供更多内置 Skills 和 Extensions，并在应用内浏览兼容的 Skill 目录。
- 建立更丰富的社区 Editor Extension 与 Language Service Extension 目录。
- 集成 C/C++、Python、JavaScript/TypeScript 调试流程。
- 提供正式支持的 macOS 版本。

## 第二部分：技术说明

### 架构与 Pi 边界

~~~text
┌──────────────────────────┐
│ React renderer           │
│ sandboxed, process-free  │
└────────────┬─────────────┘
             │ context-isolated preload IPC
┌────────────▼─────────────┐
│ Electron main process    │
│ files · PTY · Pi pool    │
└───────┬───────────┬──────┘
        │           │ trusted worker IPC
        │ public JSONL RPC
┌───────▼──────────┐  ┌────▼────────────────┐
│ external Pi RPC │  │ language worker/LSP │
└──────────────────┘  └─────────────────────┘
~~~

Agent K 只维护 Visual Client。Pi 始终以 RPC 模式作为外部子进程运行，双方只通过公开协议交互。Agent K 不修改、vendor
或提交 Pi 源码；`.reference/pi/` 只是被版本管理忽略的本地参考材料。正式发行包可以携带未经修改的 Pi 发行物实现一键启动，
但不会改变双方的进程边界。

所有 Pi 协议相关实现都位于 `electron/agent/`。React 渲染层没有 Node.js 权限，也不能直接管理进程；启用上下文隔离的
preload 只暴露窄化、类型化的桌面接口。文件系统、凭据、PTY、外部进程和原生语言功能位于 Electron 主进程或独立的
受信任 worker 中。详见[架构文档](docs/architecture.md)。

### Pi 运行时选择与 Session Pool

Agent K 按以下顺序选择 Pi：

1. `AGENT_K_PI_EXECUTABLE`
2. Agent 设置中指定的可执行文件
3. 系统 `PATH` 中的 `pi`
4. 随应用提供的 Pi runtime

桌面端会预热可配置的 2–4 个 Pi RPC 进程，将 Session 映射到可复用的 runtime，优先保留匹配工作区和会话的进程；
当全部 worker 都繁忙时自动扩容，超额 worker 空闲五分钟后回收。因此切换 Session 通常会复用已有 RPC 连接，而不是重新启动 Pi。

Skill 和 Extension 的改动先保留在设置界面。设置关闭且所有 worker 空闲后，替代进程会并行创建、恢复原会话，并且只有在
全部成功后才原子替换旧池。这种事务式刷新可以避免多个 worker 处于不同资源版本。

### 性能设计

| 领域 | 实现 |
| --- | --- |
| 对话输入 | 可编辑区域立即绘制按键；普通文本在停止输入 350 ms 后合并到 React，斜杠命令筛选仍保持即时。输入框状态不会使整棵对话树失效。 |
| Session 导航 | 复用 runtime 分配、已选择的历史和活跃 RPC 状态，避免每次切换都重新连接和重复获取数据。 |
| React 渲染 | 对话行与稳定子树使用 memo；流式状态按作用域分离，Agent 事件不会使终端输入或无关面板反复渲染。 |
| 面板缩放 | 指针回报限制为最高 60 Hz；拖动期间暂停 Editor layout，结束时只请求一次权威布局。 |
| Monaco 布局 | 代码类 Editor 自行持有 Monaco 并关闭 `automaticLayout`，宿主不访问 Monaco 内部实现。 |
| 依赖缓存 | 精确版本的 Monaco JavaScript/CSS 通过内部只读协议、Chromium 资源缓存和 V8 编译缓存加载；语言 worker 按需启动。 |
| Editor 实例缓存 | 跨文件、Session 和工作区保留最近 40 个 Editor frame，超出上限后按 LRU 淘汰。 |
| 滚动与媒体 | 滚动测量、自定义滚动条、延迟提交和媒体缩放统一使用 `requestAnimationFrame` 控制帧预算。 |
| 终端 | 项目控制台使用原生 PTY，并在可用时启用 WebGL；终端输入与对话流式输出相互隔离。主题切换会即时更新 xterm 调色板和字体；Linux Bash profile 会保留用户 `.bashrc`，为已安装的 Starship 提供仅使用 ANSI 色的配置，并让目录色使用该调色板。 |
| 轻量缓存 | Provider 目录使用短 TTL，关于信息和浏览器探测共享 Promise；布局和主题在后台初始化前恢复。语言工具、索引和临时数据的缓存根目录可由用户选择。 |

### 完整主题系统

Agent K 主题是经过校验的 JSON 包，而不只是一个浅色/深色开关。它可以定义应用表面和语义组件配色、Monaco 界面与语法颜色、
完整 ANSI 终端调色板，以及独立的 UI/代码字体栈。切换主题时，React 界面、已缓存的 Editor frame、Monaco 实例、审阅界面和项目
终端都会即时更新；导入的主题可以先预览，再独立选择或删除。

用户可以从**设置 → 外观与语言**导入主题文件，也可以通过内置 `create-agent-k-theme` Skill 让 Pi 创建主题。Agent K 会监控用户
主题目录，并在有效文件发生变化时直接应用，无需重新构建。完整定义可参考
[Retro Terminal 示例](examples/theme/retro-terminal.json)。

### 可编程文件 Editor SDK

文件 Editor 是相互独立的浏览器应用，不继承公共宿主编辑器。每个包自行拥有 DOM、CSS、框架、编辑引擎、控件和渲染策略，
包之间不相互导入。匹配条件可以是扩展名、精确文件名、绝对路径或 MIME type。

一个标准包包含：

~~~text
example-editor/
├── editor.json       # 发现、匹配、权限和 runtime 元数据
├── editor.ts         # 真正的应用源码
├── dist/             # 预构建浏览器 runtime
└── SKILL.md          # 必需的 Pi Editor Skill
~~~

Agent K 在独立源的 `<iframe sandbox="allow-scripts">` 中运行 bundle。frame 没有 Node.js、Electron IPC、宿主 DOM 或直接文件系统
权限；带 nonce 校验的版本化桥接负责内容、dirty 状态、保存请求、主题、导航、行引用和已声明的可调用能力。执行前还会校验
runtime bundle 与解析后的真实资源路径。

`.pi/skills/` 或 `.agents/skills/` 中的项目包优先于 `~/.pi/agent/skills/` 或 `~/.agents/skills/` 中的用户包，用户包又优先于
第一方包。Editor 与面向 Pi 的 Editor Skill 使用独立开关，但始终保证 Editor 关闭时对应 Skill 不能保持开启。

第一方文本包选择 Monaco 0.55.1；其他包可以使用另一 Monaco 版本、CodeMirror、Canvas、任意框架或原生 DOM。依赖按照精确版本
分别识别和缓存。详见[文件格式 SDK](docs/file-format-sdk.md)。

### 原生语言扩展

原生语言包是拥有进程权限的受信任 worker。它们独立负责项目标记、工具准备、构建数据库、诊断、LSP transport、项目生命周期、
语义 Editor contribution 和 DAP 声明。包只会从安装目录或应用数据插件目录加载，绝不会直接加载当前工作区中的代码，并且在首次
使用时才延迟启动。

内置 `cpp-clangd` 包支持 CMake 和 compilation database 工程。在 Windows/Linux x64 上，它会下载固定版本的 CMake 3.31.6、
Ninja 1.12.1 和独立 clangd 22.1.6，校验 SHA-256 后存入私有缓存。ZIP 归档在进程内解压，不再交给不同平台的 `tar` 实现。

CMake 元数据在源码树之外生成，并使用项目环境中的编译器。Linux 使用已配置的 GCC/Clang；Windows 支持 `CC`/`CXX`、Clang、
MinGW 或 MSVC，必要时通过 `vswhere` 发现 Visual Studio Build Tools 并初始化 `VsDevCmd`。如果缺少编译器，会返回明确错误，
而不是下载仍不完整的完整 LLVM SDK。clangd 在独立进程中运行，启用后台索引并把 PCH 保存在磁盘。

C++ Language Skill 可让 Pi 检查指定 CMake 工作区的加载状态，并通过已经运行的 clangd worker 查询精确符号的引用、定义、声明、
实现、悬浮信息、诊断、工作区/文档符号以及调用/类型层级。查询不会隐式加载工程；生命周期操作具有幂等性，因此 Pi 可以保持有用
的工作区处于加载状态，而不会反复执行 CMake 配置与 clangd 索引。
对于 C++ 语义问题，该路径优先于 Shell 文本搜索；编译、测试、运行、Git 和明确的文本搜索仍直接使用终端。

详见[原生语言扩展协议](docs/language-server-plugin.md)。

### 在 Agent K 中编写扩展

内置 `create-agent-k-extensions` Skill 会向 Pi 提供仓库的权威边界和校验流程。Editor 需求会落到相互独立的
`editor.json + editor.ts + SKILL.md + dist` 包；语言需求会落到
`agent-k.language-server.json + worker.ts + dist/worker.js` 包。Pi 在修改前读取对应协议文档，并始终把文件格式 UI 与受信任的
工程/LSP 进程分开。

Editor 包通过 `npm run build:editors` 构建，语言 worker 通过 `npm run build:language-servers` 构建；随后运行相关 manifest 测试、
严格项目检查和 `git diff --check`。安装过程不会替下载的包现场编译未知源码或执行 npm lifecycle script：Editor 必须已经包含
浏览器 runtime，受信任语言 worker 也必须提前构建并经过明确审阅。

### Pi 资源与 Skill Hub

Agent K 通过 Pi 公开的启动参数提供 Skills 和 Extensions，不修改 Pi runtime。当前内置资源包括：

| 资源 | 用途 |
| --- | --- |
| `weather` Skill | 通过 Open-Meteo 查询实时、逐小时和七日天气 |
| `gdb-debug` Skill | GDB 启动、回溯、线程和 core dump 工作流 |
| `create-agent-k-extensions` Skill | Agent K 扩展包的编写和校验说明 |
| `create-agent-k-theme` Skill | 创建和管理完整的 Agent K 主题包 |
| K's Plan Extension | 通过 `/plan` 使用严格、文件化的任务规划与审阅流程 |

Skill Hub 接受 `skills add` 命令、skills.sh URL、GitHub 仓库 URL 和直接的 GitHub Skill 目录 URL。预览限制为 80 个文件 / 2 MiB，
会展示完整 `SKILL.md` 和文件列表，并在安装前校验内容哈希；安装过程不执行 npm lifecycle script。

### 凭据与安全

- Provider 目录来自 Pi 公开的 `get_available_models` RPC。
- API Key 通过隔离的 Electron IPC 写入 Pi 的 `auth.json`，不会进入浏览器存储。
- OAuth 与结构化认证使用 Pi 官方交互终端。
- Linux 凭据路径为 `~/.pi/agent/auth.json`；Windows 为 `%USERPROFILE%\.pi\agent\auth.json`。
- 渲染层使用 Chromium sandbox，但 Pi 和经过确认的工具仍以当前用户的系统权限运行。执行确认不等于操作系统沙箱；处理不受信任
  代码时应使用容器或虚拟机。

详见[安全策略](SECURITY.md)。

### 环境要求与源码启动

| 组件 | 要求 |
| --- | --- |
| Node.js | 22.19 或更新版本 |
| Pi | 正式发行包内置；也可使用外部 Pi 0.80.10 或兼容版本 |
| Windows | Windows 10/11 x64 |
| Linux | 支持 X11 或 Wayland 的现代 x64 桌面 |

Linux：

~~~bash
git clone https://github.com/lordcris8411/AgentK.git
cd AgentK
./script/run-linux.sh
~~~

Windows 命令提示符或 PowerShell：

~~~bat
git clone https://github.com/lordcris8411/AgentK.git
cd AgentK
script\run-windows.bat
~~~

脚本会安装锁定的 npm 依赖、准备经过审查的原生 PTY 模块、通过已审查的官方安装器下载 Electron runtime，并启动完整开发应用。
不需要 Rust、Cargo、WebKitGTK 开发包或 WebView2。

精简 Linux 系统可能需要 Chromium 运行库：

~~~bash
# Debian / Ubuntu
sudo apt install libgtk-3-0 libnss3 libasound2t64 libgbm1

# Fedora / Nobara
sudo dnf install gtk3 nss alsa-lib mesa-libgbm
~~~

### 开发与构建

安装依赖时不执行未经审查的第三方 lifecycle script，然后显式准备已审查的原生组件：

~~~bash
npm ci --ignore-scripts
npm run prepare:native
node node_modules/electron/install.js
~~~

Linux 源码环境构建 `node-pty` 需要 Python 3、`make` 和 C++ 编译器；正式发行包已包含准备好的原生模块。

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动 Vite 和完整 Electron 开发环境 |
| `npm run dev:web` | 只启动渲染层 |
| `npm run prepare:native` | 准备已审查的 `node-pty` 原生模块 |
| `npm run check` | 检查渲染层、Electron、语言包、Editors 和 K's Plan |
| `npm run check:desktop` | 检查 Electron 主进程 TypeScript |
| `npm run build:editors` | 构建全部第一方 Editor 包及共享依赖 |
| `npm run build:language-servers` | 构建受信任的第一方原生语言 worker |
| `npm test` | 运行仓库测试套件 |
| `npm run build` | 构建语言 worker、Electron、Editors 和渲染层 |
| `npm run dist:linux` | 生成 Linux AppImage |
| `npm run dist:windows` | 生成 Windows NSIS 安装包 |

还可以使用 `./script/test-linux.sh` 和 `script\test-windows.bat` 运行平台检查。

### 仓库结构

~~~text
AgentK/
├── electron/               # Electron 主进程、桌面服务和 Pi pool
│   └── agent/              # Pi 进程与公开 RPC 适配
├── src/                    # 沙箱化 React 渲染层
├── editor/                 # 可编程 Editor SDK 与独立插件包
├── language-servers/       # 受信任的原生语言包
├── extensions/k-plan/      # 内置 Pi Extension
├── skills/                 # 内置 Pi Skills
├── themes/                 # 内置完整主题定义
├── screenshots/            # README 使用的产品截图
├── script/                 # Windows/Linux 运行、测试与构建脚本
└── docs/                   # 协议与架构文档
~~~

### 参与贡献与许可证

欢迎提交 Issue 和 Pull Request。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。核心边界包括：

- 不 vendor、修改或提交 Pi 源码；
- Pi 协议行为集中在 `electron/agent/`；
- React 渲染层不直接管理进程；
- 未经明确许可，不移除面向用户的现有功能。

[MIT](LICENSE) © 2026 Agent K contributors
