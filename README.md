<div align="center">
  <img src="assets/icons/icon.png" width="112" height="112" alt="Agent K logo">

  # Agent K

  **A visual workspace where the [Pi coding agent](https://github.com/earendil-works/pi) can understand and use purpose-built Editors.**

  Bring conversations, projects, files, tools, models, and Pi extensions together on Windows, macOS, and Linux.

  [Product overview](#part-i-product-overview) · [Product tour](#product-tour) · [Technical guide](#part-ii-technical-guide) · [中文](#第一部分产品介绍)

  [![CI](https://github.com/lordcris8411/AgentK/actions/workflows/ci.yml/badge.svg)](https://github.com/lordcris8411/AgentK/actions/workflows/ci.yml)
  [![Electron 43](https://img.shields.io/badge/Electron-43-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
  [![React 19](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)](https://react.dev/)
  [![Windows](https://img.shields.io/badge/Windows-supported-0078D4?logo=windows)](#platform-support)
  [![macOS](https://img.shields.io/badge/macOS-supported-000000?logo=apple)](#platform-support)
  [![Linux](https://img.shields.io/badge/Linux-supported-FCC624?logo=linux&logoColor=black)](#platform-support)
  [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
</div>

## Part I: Product overview

### Pi, with a complete desktop workspace

Agent K is a desktop client for Pi. It keeps Pi's models, providers, conversations, commands, Skills, and Extensions, then adds
the pieces that are useful during project work: a file tree, terminal, editors, previews, and a clear view of what the agent is
doing.

The extension system is available from the app itself. You can ask Pi to build an Editor or a language-service package, review
the generated files, and install it when you are satisfied with the result.

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

### Editors that share context with Pi

Agent K does not force every file into a text box. An Editor can provide the interface that suits the format—a rendered document,
media player, image canvas, or live web preview. Its optional Editor Skill tells Pi which file is open, how the format works, and
which actions the Editor allows.

The boundary is explicit: the Editor lists its available actions, and Pi can only request those actions. This gives Pi useful
visual context without handing it unrestricted access to the desktop.

### What is included

- Multiple workspaces and conversations, with pinned projects and remembered layouts.
- Live reasoning, tool activity, permission requests, file changes, elapsed time, and context usage.
- Editors for code, Markdown, HTML, images, audio, video, and PDF files.
- A native project terminal whose output can be copied or sent back to the conversation.
- Visual management for providers, models, Skills, Extensions, Editors, and language services.
- Managed local llama.cpp models, including Metal acceleration on macOS.
- Automatic context cleanup, configurable caches, and complete application/Editor/terminal themes.

Local OpenAI-compatible providers accept either a service root or `/v1` URL. Agent K discovers their models and context windows,
and keeps custom provider names consistent in the model picker and conversation history.

### Extending Agent K

The bundled `create-agent-k-extensions` Skill can help Pi create two kinds of package:

- An **Editor Extension** supplies a file-specific interface and, optionally, an Editor Skill with format guidance and safe actions.
- A **Language Service Extension** supplies project detection, diagnostics, navigation, project actions, and other semantic services.

For example, you can ask for an Editor for `.scene` files, or language support for a project identified by `acme.project`. Pi
creates the package and runs its checks; you review the files before installing it. Generated code is never installed silently,
and trusted language-service workers always require explicit review.

The bundled packages currently cover:

| Category | Built-in experience |
| --- | --- |
| Code and text | Multi-tab editing, search, undo, save, navigation, and optional language assistance |
| Markdown | Source editing and rendered document preview |
| HTML and web projects | Source editing, project launch, isolated preview, screenshot capture, and preview-error inspection |
| Images | Fit, pan, and smooth zoom |
| Audio and video | Playback, seeking, and media information |
| PDF | In-app document reading |

Editors and their Skills have separate controls. You can keep an Editor enabled without sharing its specialized guidance with Pi;
disabling an Editor also disables the corresponding Skill. Injected context remains available under **Raw information**.

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
- macOS on Apple Silicon or Intel
- Modern Linux x64 desktops using X11 or Wayland
- Light, HDR-friendly soft light, dark, system, and importable custom themes on all desktop platforms

Managed local llama.cpp models are available on Windows x64, Linux x64, and Apple Silicon or Intel Mac. On macOS,
Agent K uses the pinned official llama.cpp runtime with Metal acceleration and CPU fallback.

Release builds include a compatible, unmodified Pi distribution, so a separate global Pi installation is not required.

### Product roadmap

- More built-in Skills and Extensions, plus in-app discovery across compatible Skill catalogs.
- A broader catalog for community-created Editor and Language Service Extensions.
- Integrated debugging workflows for C/C++, Python, and JavaScript/TypeScript.
- Signed and notarized macOS release packages.

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
semantic component colors, the two-color Agent K logo palette, Monaco UI and syntax colors, the complete ANSI terminal palette,
and separate UI/code font stacks.
Theme changes propagate live to the React interface, cached Editor frames, Monaco instances, the review view, and the project
terminal; imported themes are previewed before selection and can be removed independently.

Custom theme files can be imported from **Settings → Appearance and language** or created with Pi through the bundled
`create-agent-k-theme` Skill. Agent K stores them in the isolated `%USERPROFILE%\\.pi\\agent\\k_themes` directory on Windows
and `~/.pi/agent/k_themes` on macOS/Linux, watches that directory, and applies valid external updates without requiring a
rebuild. The bundled [Retro Terminal theme](themes/retro-terminal.json) is a complete theme definition.

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
| `agent-k-file-editor` Skill | Open workspace files in Agent K, preview Markdown or web projects, capture previews, and inspect preview-console output |
| K's Plan Extension | Strict file-backed task planning and review through `/plan` |

Skill Hub accepts `skills add` commands, skills.sh URLs, GitHub repository URLs, and direct GitHub Skill-directory URLs. Preview
is bounded to 80 files / 2 MiB, displays the exact `SKILL.md` and file list, and verifies a content hash before installation. It
does not execute npm lifecycle scripts.

### Credentials and security

- Provider catalogs come from Pi's public `get_available_models` RPC.
- API keys cross an isolated Electron IPC boundary and are written to Pi's `auth.json`; they are never stored in browser storage.
- OAuth and structured authentication use the official Pi interactive terminal.
- Credential paths are `~/.pi/agent/auth.json` on macOS/Linux and `%USERPROFILE%\.pi\agent\auth.json` on Windows.
- The renderer is Chromium-sandboxed, but Pi and approved tools run with the current user's OS permissions. Execution approval is
  not an operating-system sandbox; use a container or VM for untrusted code.

See [Security policy](SECURITY.md).

### Requirements and source startup

| Component | Requirement |
| --- | --- |
| Node.js | 22.19 or newer |
| Pi | Bundled in release builds; optional external Pi 0.83.0 or compatible |
| Windows | Windows 10/11 x64 |
| macOS | Apple Silicon or Intel Mac with command line build tools for source startup |
| Linux | Modern x64 desktop with X11 or Wayland |

macOS:

~~~bash
git clone https://github.com/lordcris8411/AgentK.git
cd AgentK
./script/run-macos.sh
~~~

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

Building `node-pty` from source on macOS or Linux requires Python 3, `make`, and a C++ compiler. Release packages contain the
prepared native module.

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
| `npm run dist:mac` | Build macOS DMG and ZIP packages |
| `npm run dist:linux` | Build the Linux AppImage |
| `npm run dist:windows` | Build the Windows portable package |

Platform checks are also available through `./script/test-macos.sh`, `./script/test-linux.sh`, and `script\test-windows.bat`.

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
├── script/                 # macOS/Windows/Linux run, test, and build scripts
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

Agent K 是 Pi 的桌面客户端。它保留 Pi 的模型、Provider、会话、命令、Skills 和 Extensions，同时加入项目开发常用的
文件树、终端、编辑器和预览，并集中展示 Agent 当前的工作状态。

扩展也可以直接在应用里完成：让 Pi 编写 Editor 或语言服务包，检查生成的文件，确认无误后再安装。

### 产品界面

<p align="center">
  <img src="screenshots/cpp-workspace.png" width="100%" alt="Agent K 对话、C++ 工程、代码 Editor 和终端工作区">
  <br>
  <sub>对话、C++ 语义导航、项目文件、代码 Editor 与原生终端位于同一个工作区。</sub>
</p>

模型与 Provider、项目操作、完整主题、Editor 管理器和 Skill Hub 的更多界面见前面的
[Product tour](#product-tour)。

### 与 Pi 共享上下文的 Editor

Agent K 不会把所有文件都塞进文本框。Editor 可以根据格式提供合适的界面，例如渲染后的文档、媒体播放器、图片画布或 Web
预览。可选的 Editor Skill 会告诉 Pi 当前打开了什么文件、格式如何工作，以及 Editor 允许哪些操作。

动作边界是明确的：Editor 列出可用动作，Pi 只能请求这些动作。这样既能提供有用的可视化上下文，也不会把整个桌面权限交给 Pi。

### 当前功能

- 管理多个工作区和会话，支持固定项目并记住界面布局。
- 查看思考过程、工具活动、权限请求、文件变更、耗时和上下文用量。
- 打开代码、Markdown、HTML、图片、音频、视频和 PDF。
- 使用原生项目终端，并复制输出或发送回对话。
- 可视化管理 Provider、模型、Skills、Extensions、Editors 和语言服务。
- 管理本地 llama.cpp 模型，包括 macOS Metal 加速。
- 自动整理上下文、自定义缓存位置，以及统一应用、Editor 和终端的完整主题。

本地 OpenAI 兼容 Provider 可以填写服务根地址或 `/v1` 地址。Agent K 会发现模型及其上下文窗口，并让自定义 Provider 名称在
模型选择器和会话历史中保持一致。

### 扩展 Agent K

内置的 `create-agent-k-extensions` Skill 可以协助 Pi 创建两类包：

- **Editor Extension** 提供面向特定文件的界面，并可附带包含格式说明和安全动作的 Editor Skill。
- **Language Service Extension** 提供项目识别、诊断、跳转、项目操作及其他语义服务。

例如，你可以要求创建 `.scene` 文件的 Editor，或为通过 `acme.project` 识别的项目增加语言支持。Pi 会创建包并执行检查；安装前
由你审阅文件。生成的代码不会被静默安装，受信任的语言服务 worker 始终需要明确审阅。

当前内置包包括：

| 类型 | 内置体验 |
| --- | --- |
| 代码和文本 | 多标签编辑、搜索、撤销、保存、跳转和可选语言辅助 |
| Markdown | 源码编辑与渲染后的文档预览 |
| HTML 和 Web 项目 | 源码编辑、项目启动、隔离预览、预览截图和错误查看 |
| 图片 | 自适应、拖动和平滑缩放 |
| 音频和视频 | 播放、定位和媒体信息 |
| PDF | 应用内文档阅读 |

Editor 与其 Skill 有独立开关。你可以保留 Editor，但不向 Pi 提供该格式的专用说明；关闭 Editor 时，对应 Skill 也会关闭。
注入的上下文可以在“原始信息”中检查。

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
- Apple Silicon 或 Intel Mac
- 使用 X11 或 Wayland 的现代 Linux x64 桌面
- 所有桌面平台都支持浅色、适合 HDR 显示器的柔和亮色、深色、跟随系统及可导入的自定义主题

托管本地 llama.cpp 模型支持 Windows x64、Linux x64，以及 Apple Silicon 或 Intel Mac。macOS 使用固定版本的
llama.cpp 官方运行时，支持 Metal 加速和 CPU 回退。

正式安装包包含兼容且未经修改的 Pi 发行物，不要求用户另外全局安装 Pi。

### 产品路线图

- 提供更多内置 Skills 和 Extensions，并在应用内浏览兼容的 Skill 目录。
- 建立更丰富的社区 Editor Extension 与 Language Service Extension 目录。
- 集成 C/C++、Python、JavaScript/TypeScript 调试流程。
- 提供已签名并完成 notarization 的 macOS 发行包。

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

Agent K 主题是经过校验的 JSON 包，而不只是一个浅色/深色开关。它可以定义应用表面和语义组件配色、Agent K 图标的双色配色、Monaco 界面与语法颜色、
完整 ANSI 终端调色板，以及独立的 UI/代码字体栈。切换主题时，React 界面、已缓存的 Editor frame、Monaco 实例、审阅界面和项目
终端都会即时更新；导入的主题可以先预览，再独立选择或删除。

用户可以从**设置 → 外观与语言**导入主题文件，也可以通过内置 `create-agent-k-theme` Skill 让 Pi 创建主题。Agent K 在 Windows 将自定义主题
隔离存放在 `%USERPROFILE%\\.pi\\agent\\k_themes`，在 macOS/Linux 存放在 `~/.pi/agent/k_themes`；它会监控该目录，并在有效文件
发生变化时直接应用，无需重新构建。完整定义可参考[内置 Retro Terminal 主题](themes/retro-terminal.json)提供完整的主题定义。

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
| `agent-k-file-editor` Skill | 在 Agent K 中打开工作区文件、预览 Markdown 或 Web 项目、截取预览图，并读取预览控制台输出 |
| K's Plan Extension | 通过 `/plan` 使用严格、文件化的任务规划与审阅流程 |

Skill Hub 接受 `skills add` 命令、skills.sh URL、GitHub 仓库 URL 和直接的 GitHub Skill 目录 URL。预览限制为 80 个文件 / 2 MiB，
会展示完整 `SKILL.md` 和文件列表，并在安装前校验内容哈希；安装过程不执行 npm lifecycle script。

### 凭据与安全

- Provider 目录来自 Pi 公开的 `get_available_models` RPC。
- API Key 通过隔离的 Electron IPC 写入 Pi 的 `auth.json`，不会进入浏览器存储。
- OAuth 与结构化认证使用 Pi 官方交互终端。
- macOS/Linux 凭据路径为 `~/.pi/agent/auth.json`；Windows 为 `%USERPROFILE%\.pi\agent\auth.json`。
- 渲染层使用 Chromium sandbox，但 Pi 和经过确认的工具仍以当前用户的系统权限运行。执行确认不等于操作系统沙箱；处理不受信任
  代码时应使用容器或虚拟机。

详见[安全策略](SECURITY.md)。

### 环境要求与源码启动

| 组件 | 要求 |
| --- | --- |
| Node.js | 22.19 或更新版本 |
| Pi | 正式发行包内置；也可使用外部 Pi 0.83.0 或兼容版本 |
| Windows | Windows 10/11 x64 |
| macOS | Apple Silicon 或 Intel Mac，源码启动需要命令行构建工具 |
| Linux | 支持 X11 或 Wayland 的现代 x64 桌面 |

macOS：

~~~bash
git clone https://github.com/lordcris8411/AgentK.git
cd AgentK
./script/run-macos.sh
~~~

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

macOS 或 Linux 源码环境构建 `node-pty` 需要 Python 3、`make` 和 C++ 编译器；正式发行包已包含准备好的原生模块。

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
| `npm run dist:mac` | 生成 macOS DMG 和 ZIP 包 |
| `npm run dist:linux` | 生成 Linux AppImage |
| `npm run dist:windows` | 生成 Windows portable 包 |

还可以使用 `./script/test-macos.sh`、`./script/test-linux.sh` 和 `script\test-windows.bat` 运行平台检查。

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
├── script/                 # macOS/Windows/Linux 运行、测试与构建脚本
└── docs/                   # 协议与架构文档
~~~

### 参与贡献与许可证

欢迎提交 Issue 和 Pull Request。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。核心边界包括：

- 不 vendor、修改或提交 Pi 源码；
- Pi 协议行为集中在 `electron/agent/`；
- React 渲染层不直接管理进程；
- 未经明确许可，不移除面向用户的现有功能。

[MIT](LICENSE) © 2026 Agent K contributors
