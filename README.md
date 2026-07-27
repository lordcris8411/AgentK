<div align="center">
  <img src="assets/icons/agent-k.svg" width="112" height="112" alt="Agent K logo">

  # Agent K

  **A fast visual workspace for the [Pi coding agent](https://github.com/earendil-works/pi).**

  Bring conversations, projects, files, tools, models, and Pi extensions together on Windows and Linux.

  [Product overview](#part-i-product-overview) · [Technical guide](#part-ii-technical-guide) · [中文](#第一部分产品介绍)

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

### What you can do

- **Work with multiple projects and conversations:** pin active workspaces, switch between recent sessions, create branches, and
  return to previous work without rebuilding your desktop layout.
- **Follow the agent while it works:** see live progress, reasoning, tool calls, permission requests, file changes, elapsed time,
  context usage, and completion status in one conversation view.
- **Browse, search, preview, and edit files:** work with code and text, Markdown, HTML, images, audio, video, and PDF files from the
  project panel. Recent file tabs stay ready when you switch conversations or workspaces.
- **Use a real project terminal:** run normal shell commands, copy terminal content, or send selected output back into the chat.
- **Manage the Pi ecosystem visually:** inspect, install, enable, or disable Skills and Extensions without manually editing
  configuration files. File editors and language features have their own controls.
- **Choose models and permissions:** manage providers, switch models, select reasoning levels, and control whether a session may
  run actions.
- **Keep long conversations useful:** optional automatic context cleanup preserves the important recent state before the context
  becomes full.
- **Match your desktop:** choose light, dark, or system theme. Window size, panel widths, terminal height, and panel visibility are
  remembered for the next launch.
- **Stay responsive on larger work:** session reuse, file-editor caching, and interaction optimizations reduce pauses when
  switching conversations, opening files, scrolling, or resizing panels.

### Supported file experiences

| Category | Available experience |
| --- | --- |
| Code and text | Multi-tab editing, syntax colors, search, undo, save, navigation, and optional language assistance |
| Markdown | Source editing and rendered preview |
| HTML | Source editing, sandboxed preview, preview capture, and preview-console inspection |
| Images | Fit, pan, and smooth zoom |
| Audio and video | In-app playback, seeking, and media information |
| PDF | In-app document preview |

Additional file experiences can be installed independently. Each category can be enabled or disabled from Settings.

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
- Light, dark, and system theme modes on both platforms

Release builds include a compatible, unmodified Pi distribution, so a separate global Pi installation is not required.

### Product roadmap

- One-click local model packages with llama.cpp and downloads from ModelScope or Hugging Face.
- More built-in Skills and Extensions, plus in-app discovery across compatible Skill catalogs.
- More specialized file preview and editing experiences.
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
| Terminal | The project console uses a native PTY and enables WebGL rendering when available. Terminal input is isolated from conversation streaming. |
| Lightweight caches | Provider catalogs use a short TTL; About/browser discovery share promises; layout and theme state restore before expensive background initialization. |

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
└── SKILL.md          # optional Pi-facing format guidance
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

See [Native language-extension protocol](docs/language-server-plugin.md).

### Pi resources and Skill Hub

Agent K exposes Pi Skills and Extensions through Pi's public launch options; it does not patch the runtime. Bundled resources
include:

| Resource | Purpose |
| --- | --- |
| `weather` Skill | Current, hourly, and seven-day weather through Open-Meteo |
| `gdb-debug` Skill | GDB launch, backtrace, threads, and core-dump workflows |
| `create-agent-k-extensions` Skill | Authoring and validation guidance for Agent K packages |
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

### 你可以用它做什么

- **同时管理多个项目和会话：** 固定常用工作区，按活跃度查看最近会话，创建对话分支，并在切换后保留原来的界面布局。
- **实时跟进 Agent 工作：** 在同一个对话界面查看进度、思考过程、工具调用、执行确认、文件变更、耗时、上下文用量和完成状态。
- **浏览、搜索、预览和编辑文件：** 直接处理代码和文本、Markdown、HTML、图片、音频、视频及 PDF；切换会话或工作区后，
  最近打开的文件仍可快速恢复。
- **使用真正的项目终端：** 运行日常命令、复制终端内容，或把选中的输出直接加入聊天框。
- **可视化管理 Pi 生态：** 查看、安装、启用或关闭 Skills 和 Extensions，无需手动编辑配置文件；文件编辑器和语言功能也有独立开关。
- **选择模型和权限：** 管理 Provider、切换模型、选择思考级别，并决定某个会话是否允许执行操作。
- **保持长对话可用：** 可选的自动上下文整理会在容量耗尽前保留近期的重要信息。
- **适应你的桌面习惯：** 支持浅色、深色和跟随系统主题，并记住窗口大小、边栏宽度、终端高度及面板开关状态。
- **在大型任务中保持流畅：** 会话复用、文件编辑器缓存和交互优化可以减少切换会话、打开文件、滚动及调整面板时的等待。

### 支持的文件体验

| 类型 | 当前能力 |
| --- | --- |
| 代码和文本 | 多标签编辑、语法配色、搜索、撤销、保存、跳转，以及可选的语言辅助 |
| Markdown | 源码编辑与渲染预览 |
| HTML | 源码编辑、隔离预览、预览截图和预览控制台查看 |
| 图片 | 自适应、拖动和平滑缩放 |
| 音频和视频 | 应用内播放、定位和媒体信息 |
| PDF | 应用内文档预览 |

还可以独立安装更多文件处理能力，每个文件品类都能在设置中单独启用或关闭。

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
- 两个平台都支持浅色、深色和跟随系统主题

正式安装包包含兼容且未经修改的 Pi 发行物，不要求用户另外全局安装 Pi。

### 产品路线图

- 内置 llama.cpp，并支持从 ModelScope 或 Hugging Face 下载本地模型后直接使用。
- 提供更多内置 Skills 和 Extensions，并在应用内浏览兼容的 Skill 目录。
- 增加更多专用文件预览和编辑体验。
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
| 终端 | 项目控制台使用原生 PTY，并在可用时启用 WebGL；终端输入与对话流式输出相互隔离。 |
| 轻量缓存 | Provider 目录使用短 TTL，关于信息和浏览器探测共享 Promise；布局和主题在后台初始化前恢复。 |

### 可编程文件 Editor SDK

文件 Editor 是相互独立的浏览器应用，不继承公共宿主编辑器。每个包自行拥有 DOM、CSS、框架、编辑引擎、控件和渲染策略，
包之间不相互导入。匹配条件可以是扩展名、精确文件名、绝对路径或 MIME type。

一个标准包包含：

~~~text
example-editor/
├── editor.json       # 发现、匹配、权限和 runtime 元数据
├── editor.ts         # 真正的应用源码
├── dist/             # 预构建浏览器 runtime
└── SKILL.md          # 可选的 Pi 文件格式说明
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

详见[原生语言扩展协议](docs/language-server-plugin.md)。

### Pi 资源与 Skill Hub

Agent K 通过 Pi 公开的启动参数提供 Skills 和 Extensions，不修改 Pi runtime。当前内置资源包括：

| 资源 | 用途 |
| --- | --- |
| `weather` Skill | 通过 Open-Meteo 查询实时、逐小时和七日天气 |
| `gdb-debug` Skill | GDB 启动、回溯、线程和 core dump 工作流 |
| `create-agent-k-extensions` Skill | Agent K 扩展包的编写和校验说明 |
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
