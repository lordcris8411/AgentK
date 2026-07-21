<div align="center">
  <img src="assets/icons/agent-k.svg" width="112" height="112" alt="Agent K logo">

  # Agent K

  **A fast desktop workspace for the [Pi coding agent](https://github.com/earendil-works/pi).**

  Manage Pi sessions, project files, tool calls, and model configuration through one visual workspace on Windows and Linux.

  [English](#features) · [中文](#中文说明)

  [![CI](https://github.com/lordcris8411/AgentK/actions/workflows/ci.yml/badge.svg)](https://github.com/lordcris8411/AgentK/actions/workflows/ci.yml)
  [![Electron 43](https://img.shields.io/badge/Electron-43-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
  [![React 19](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)](https://react.dev/)
  [![Windows](https://img.shields.io/badge/Windows-supported-0078D4?logo=windows)](#requirements)
  [![Linux](https://img.shields.io/badge/Linux-supported-FCC624?logo=linux&logoColor=black)](#requirements)
  [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
</div>

## Features

- **A GUI built for Pi:** a dedicated visual frontend for Pi conversations, sessions, tools, models, and project workflows—not a separate agent runtime.
- **Compatible with the Pi ecosystem:** connects through Pi's public JSONL RPC and preserves its providers, sessions, slash commands, Skills, Extensions, and user/project configuration.
- **Pooled Pi sessions:** prewarms a configurable pool of 2–4 Pi RPC workers, keeps sessions attached to reusable runtimes, expands on demand, and retires excess idle processes automatically.
- **Performance-focused desktop UI:** GPU-accelerated Chromium rendering, bounded 60 Hz resize updates, responsive Monaco layout, deferred React commits, and optimized scrolling keep large conversations and files responsive.
- **Light, dark, and system themes:** a complete semantic color system covers the workspace, dialogs, previews, Markdown, and Monaco editor, with theme-aware selection and highlight colors.
- **Multi-format preview and editing:** edit source code, configuration, Markdown, and other text formats in Monaco; preview Markdown, HTML, images, audio, video, and PDF files directly in the workspace.
- **Skill and Extension managers:** discover, inspect, enable, or disable user, project, package, and bundled resources from the settings UI or with `/skills` and `/extensions`.
- **Complete agent workflow:** streaming responses, reasoning, tool calls, execution approval, change review, forks, and session history.
- **Clear security boundary:** the sandboxed React renderer has no Node.js access and cannot directly launch processes or access local files.

## Architecture

~~~text
┌─────────────────────────┐
│ React / TypeScript UI   │
└────────────┬────────────┘
             │ context-isolated preload IPC
┌────────────▼────────────┐
│ Electron main process   │
│ Pi pool · files · window│
└────────────┬────────────┘
             │ public JSONL RPC
┌────────────▼────────────┐
│ external pi --mode rpc  │
└─────────────────────────┘
~~~

Agent K **does not include, modify, or commit Pi source code**. Pi is installed separately and treated as an external runtime that communicates exclusively through its public RPC protocol. `.reference/pi/` is ignored and used only for local upstream reference.

The desktop backend is written in TypeScript. Pi protocol integration stays under `electron/agent/`, while `electron/preload.cjs` exposes a narrow API to the renderer with context isolation and Chromium sandboxing enabled. See [Architecture](docs/architecture.md) for details.

## Agent K commands

Type `/` to search Pi commands and Agent K commands. Client commands are handled locally and are not sent to the model as prompts.

| Command | Action |
| --- | --- |
| `/settings`, `/skills`, `/extensions` | Open the corresponding settings page |
| `/model [provider/model]` | Open the model picker or switch directly |
| `/compact [instructions]` | Compact the current context |
| `/new` | Start a new Pi session |
| `/fork`, `/tree` | Open session branch navigation |
| `/name <name>` | Rename the current session |
| `/session` | Show current session statistics |
| `/reload` | Reload Pi configuration, Skills, and Extensions |

## Bundled Skills

Agent K ships these project-owned Skills and loads them through Pi's public `--skill` option:

| Skill | Purpose | Runtime requirements |
| --- | --- | --- |
| `weather` | Current weather, hourly conditions, and seven-day forecasts through Open-Meteo | `bash`, `curl`, `jq` |
| `gdb-debug` | GDB launch, crash backtrace, thread, and core-dump workflows | `bash`, `gdb`, `nm` |

At first launch, bundled Skills are copied to a stable application-data directory so the external Pi process never needs to read Electron archives. They appear alongside user and project Skills in the `/skills` manager and can be enabled or disabled independently. Closing Settings applies pending resource changes in one worker-pool refresh. Existing `~/.pi/agent/skills` content is never overwritten.

The bundled scripts target a POSIX shell. On Windows, use Git Bash, MSYS2, or WSL to run them; the Skills can still be inspected and managed without those environments.

## Technical advantages

Agent K optimizes both sides of the desktop boundary instead of treating every UI action as a fresh Pi startup or a full React render.

| Area | Implementation | Benefit |
| --- | --- | --- |
| Pi RPC and session pool | Starts 2–4 workers concurrently during launch, remembers the runtime assigned to each session, reuses matching workspace/session processes, grows when every worker is busy, and reaps excess workers after five idle minutes. | Switching or creating sessions usually avoids process startup latency while background work can continue in other sessions. |
| Safe pool refresh | Skill and Extension changes stay local to Settings until it closes. When every worker is idle, replacements are prepared concurrently, their sessions are restored, and the old pool is swapped only after every replacement succeeds. | One refresh applies all resource changes without partially updated workers or unnecessary sequential restarts. |
| Session and RPC reuse | Session paths are mapped to runtime IDs, selected history is fetched once and passed into the conversation as an initial seed, and the active Pi connection remains authoritative for subsequent commands. | Avoids duplicate connection, history, and state work during navigation. |
| Lightweight caches | The provider/model catalog is reused for 30 seconds, About and browser discovery use shared promises, and stable settings/layout data are restored locally before expensive background work. | Settings pages reopen quickly and repeated system/model queries are reduced. |
| Theme pipeline | Light, dark, and system modes are persisted, system color-scheme changes are observed live, semantic CSS colors cover every major surface, and Monaco receives a matching theme event with dedicated selection colors. The startup splash resolves the saved theme before workers finish warming. | Theme changes remain consistent across native startup, the application shell, previews, dialogs, and editors without a mismatched flash. |
| Input isolation | The content-editable composer paints keystrokes immediately, while ordinary text synchronizes to React only after 350 ms of idle time; slash-command filtering remains immediate. | Typing and IME input do not trigger a full conversation-tree update on every keypress. |
| Monaco layout control | Monaco's automatic layout is disabled. A shared `ResizeObserver` coalesces measurements into animation frames, freezes editor geometry during panel drags, and performs one authoritative layout when dragging ends. | Large documents do not repeatedly relayout while sidebars move. |
| Frame-budgeted interaction | Sidebar pointer reports are capped at 60 Hz; scroll measurements, custom scrollbars, media zoom, and delayed layout commits are coordinated with `requestAnimationFrame`. | Reduces main-thread bursts and visual tearing during resizing, scrolling, and media interaction. |

## Quick start

### 1. Install Pi

~~~bash
npm install --global @earendil-works/pi-coding-agent
pi --version
~~~

Agent K targets Pi `0.80.10` or a compatible version. To use another executable:

~~~bash
export AGENT_K_PI_EXECUTABLE=/absolute/path/to/pi
~~~

Windows PowerShell:

~~~powershell
$env:AGENT_K_PI_EXECUTABLE = "C:\path\to\pi.cmd"
~~~

### 2. Start Agent K

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

The scripts install locked npm dependencies, download the Electron runtime with its reviewed official installer, and launch Vite with Electron. Rust, Cargo, WebKitGTK development packages, and WebView2 are not required.

## Requirements

| Component | Requirement |
| --- | --- |
| Node.js | 22.19 or newer |
| Pi | 0.80.10 or compatible |
| Windows | Windows 10/11 x64 |
| Linux | Modern x64 desktop distribution with X11 or Wayland |

Electron bundles Chromium. Minimal Linux installations may need:

~~~bash
# Debian / Ubuntu
sudo apt install libgtk-3-0 libnss3 libasound2t64 libgbm1

# Fedora / Nobara
sudo dnf install gtk3 nss alsa-lib mesa-libgbm
~~~

## Development and builds

Install dependencies without running third-party lifecycle scripts, then run Electron's reviewed download script explicitly:

~~~bash
npm ci --ignore-scripts
node node_modules/electron/install.js
~~~

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Vite and the complete Electron development environment |
| `npm run dev:web` | Start only the Vite renderer |
| `npm run check` | Type-check React, the Electron backend, and K Plan |
| `npm run check:desktop` | Type-check the Electron main process |
| `npm test` | Run K Plan tests |
| `npm run build` | Build the renderer and Electron main process |
| `npm run dist:linux` | Build a Linux AppImage |
| `npm run dist:windows` | Build a Windows NSIS installer |

Platform test scripts:

~~~bash
./script/test-linux.sh
~~~

~~~bat
script\test-windows.bat
~~~

Normal Linux development does not require cross-building the Windows package.

## Repository layout

~~~text
AgentK/
├── electron/               # Electron main process, Pi RPC pool, files, and settings
│   └── agent/              # External Pi process and JSONL RPC adapter
├── src/                    # React renderer without Node.js privileges
├── extensions/k-plan/      # Bundled K Plan extension
├── skills/                 # Bundled Pi Skills
├── assets/icons/           # Desktop and installer icons
├── script/                 # Windows/Linux run and test scripts
└── docs/architecture.md    # Detailed architecture boundaries
~~~

## Providers and credentials

- The model catalog comes from Pi's public `get_available_models` RPC command.
- API keys cross isolated Electron IPC and are written to Pi's `auth.json`; they are not stored in browser storage.
- OAuth and structured authentication use the official interactive Pi CLI.
- Credential paths are `~/.pi/agent/auth.json` on Linux and `%USERPROFILE%\.pi\agent\auth.json` on Windows.

## Security

Agent K launches external Pi processes with the current user's permissions. UI execution approval is not an operating-system sandbox. Use a container or virtual machine for untrusted code. See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Roadmap

The following items are planned and are not part of the current release:

- [ ] **One-click local AI distribution:** bundle llama.cpp and Pi, support self-contained packaging, download local models from ModelScope or Hugging Face, and run them in place without a separate inference-service setup.
- [ ] **A broader Skill and Extension ecosystem:** ship more built-in Skills and Extensions, and add in-app discovery for Skill Hub and other compatible resource catalogs.
- [ ] **File-format SDK:** provide extension points for implementing parsers, previews, and editors for specialized file formats.
- [ ] **Integrated code debugging:** add debugging workflows for C/C++, Python, and JavaScript/TypeScript, including GDB and MSVC debugger support.
- [ ] **macOS release:** add a supported macOS application, packaging pipeline, and platform integration.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first.

- Do not vendor, modify, or commit Pi source.
- Keep Pi protocol behavior in `electron/agent/`.
- Keep external process management out of the React renderer.
- Do not remove user-facing behavior without explicit approval.

## License

[MIT](LICENSE) © 2026 AgentK contributors

---

# 中文说明

Agent K 是 [Pi coding agent](https://github.com/earendil-works/pi) 的桌面工作区，可在 Windows 和 Linux 上通过可视化界面管理 Pi 会话、项目文件、工具调用和模型配置。

## 功能

- **专为 Pi 打造的 GUI 前端：** 将 Pi 的对话、会话、工具、模型和项目工作流完整呈现在桌面界面中，而不是另造一套 Agent 运行时。
- **兼容 Pi 生态：** 通过 Pi 公开的 JSONL RPC 接入，保留 Provider、会话、斜杠命令、Skills、Extensions 以及用户级和项目级配置。
- **Pi Session 池化：** 预热可配置的 2–4 个 Pi RPC worker，将会话绑定到可复用 runtime，繁忙时按需扩容，并自动回收多余的空闲进程。
- **面向高性能优化：** 使用 GPU 加速的 Chromium 渲染、最高 60 Hz 的尺寸更新、响应式 Monaco 布局、延迟 React 合并和滚动优化，改善长对话与大型文件场景的流畅度。
- **浅色、深色与跟随系统主题：** 完整的语义配色覆盖工作区、对话框、预览、Markdown 和 Monaco 编辑器，并为不同主题分别优化选区与高亮颜色。
- **多种文件格式的预览与编辑：** 使用 Monaco 编辑源代码、配置、Markdown 等文本格式，并在工作区直接预览 Markdown、HTML、图片、音频、视频和 PDF。
- **Skill 和 Extension 管理器：** 在设置界面或通过 `/skills`、`/extensions` 发现、查看、启用或停用用户、项目、Package 和内置资源。
- **完整 Agent 工作流：** 流式响应、思考过程、工具调用、执行确认、变更审阅、分支和会话历史。
- **清晰的安全边界：** React 渲染进程没有 Node.js 权限，不能直接启动进程或访问本地文件。

## 架构

~~~text
┌─────────────────────────┐
│ React / TypeScript UI   │
└────────────┬────────────┘
             │ context-isolated preload IPC
┌────────────▼────────────┐
│ Electron main process   │
│ Pi pool · files · window│
└────────────┬────────────┘
             │ public JSONL RPC
┌────────────▼────────────┐
│ external pi --mode rpc  │
└─────────────────────────┘
~~~

Agent K **不包含、不修改也不提交 Pi 源码**。Pi 是单独安装的外部运行时，双方只通过公开 RPC 协议协作。`.reference/pi/` 仅用于本地查阅上游实现，已排除在版本管理和构建输入之外。

桌面后端使用 TypeScript 编写，Pi 协议适配集中在 `electron/agent/`。渲染进程通过 `electron/preload.cjs` 暴露的窄接口访问桌面能力，并启用 context isolation 和 Chromium sandbox。更多设计细节见[架构文档](docs/architecture.md)。

## Agent K 命令

输入 `/` 可搜索 Pi 动态命令和 Agent K 内置命令。内置命令在客户端处理，不会作为普通提示发送给模型。

| 命令 | 操作 |
| --- | --- |
| `/settings`、`/skills`、`/extensions` | 打开对应设置页面 |
| `/model [provider/model]` | 打开模型选择器或直接切换模型 |
| `/compact [instructions]` | 压缩当前上下文 |
| `/new` | 新建 Pi 会话 |
| `/fork`、`/tree` | 打开会话分支导航 |
| `/name <name>` | 修改当前会话名称 |
| `/session` | 显示当前会话统计 |
| `/reload` | 重新加载 Pi 配置、Skills 与 Extensions |

## 内置 Skills

Agent K 随应用发布以下自有 Skills，并通过 Pi 的公开 `--skill` 参数加载：

| Skill | 用途 | 运行依赖 |
| --- | --- | --- |
| `weather` | 使用 Open-Meteo 查询实时天气、逐小时天气和七日预报 | `bash`、`curl`、`jq` |
| `gdb-debug` | GDB 启动、崩溃回溯、线程和 core dump 分析工作流 | `bash`、`gdb`、`nm` |

首次启动时，内置 Skills 会复制到稳定的应用数据目录，因此外部 Pi 进程不需要读取 Electron 归档。它们会和用户及项目 Skills 一起显示在 `/skills` 管理器中，可以独立启用或停用；设置窗口关闭后，Agent K 会一次性刷新 worker pool。用户自己的 `~/.pi/agent/skills` 不会被覆盖。

内置脚本面向 POSIX shell 环境。在 Windows 上可通过 Git Bash、MSYS2 或 WSL 使用；Skill 本身仍能被查看和管理。

## 技术优势

Agent K 同时优化桌面边界的两侧，避免把每次界面操作都变成一次新的 Pi 启动或整棵 React 对话树重绘。

| 领域 | 实现方式 | 带来的优势 |
| --- | --- | --- |
| Pi RPC 与 Session 池 | 启动时并行预热 2–4 个 worker，记录每个 Session 对应的 runtime，复用匹配的工作区/会话进程；全部繁忙时自动扩容，超额 worker 空闲五分钟后回收。 | 切换或创建会话通常无需等待新进程启动，不同会话的后台任务也可以继续运行。 |
| 安全的池刷新 | Skill 与 Extension 改动先保留在设置界面；全部 worker 空闲后，并行创建替代进程、恢复原会话，并且仅在全部成功后替换旧池。 | 一次刷新应用所有资源改动，避免 worker 配置不一致和逐个重启造成的长时间等待。 |
| Session 与 RPC 复用 | 将 Session 路径映射到 runtime ID；切换时只获取一次历史并作为初始种子交给对话区，后续命令继续使用同一个 Pi 连接。 | 减少导航过程中重复的连接、历史和状态请求。 |
| 轻量缓存 | Provider/模型目录复用 30 秒，关于信息和浏览器探测共享 Promise，并在后台重任务前先从本地恢复稳定的设置与布局。 | 设置页面再次打开更快，减少重复的系统和模型查询。 |
| 主题管线 | 持久化浅色、深色和跟随系统模式，实时监听系统配色变化；主要界面统一使用语义 CSS 色彩，Monaco 通过主题事件同步切换并使用独立选区颜色。启动 Splash 也会在 worker 预热完成前解析已保存的主题。 | 从原生启动、应用外壳、预览、对话框到编辑器始终保持一致，避免主题错配和启动闪烁。 |
| 输入隔离 | `contentEditable` 立即绘制按键输入，普通文本只在停止输入 350 ms 后同步给 React；斜杠命令过滤仍保持即时响应。 | 输入法和连续输入不会在每次按键时触发整个对话区域更新。 |
| Monaco 布局控制 | 关闭 Monaco `automaticLayout`，通过共享 `ResizeObserver` 将测量合并到动画帧；拖动边栏时冻结编辑器几何尺寸，结束后只执行一次权威布局。 | 大型文档不会在侧栏移动过程中反复重排。 |
| 帧预算交互 | 侧栏指针更新限制为最高 60 Hz，滚动测量、自定义滚动条、媒体缩放和延迟布局提交统一通过 `requestAnimationFrame` 调度。 | 减少调整尺寸、滚动和媒体操作时的主线程峰值与画面撕裂。 |

## 快速开始

### 1. 安装 Pi

~~~bash
npm install --global @earendil-works/pi-coding-agent
pi --version
~~~

Agent K 当前面向 Pi `0.80.10` 或兼容版本。也可以指定其他 Pi 可执行文件：

~~~bash
export AGENT_K_PI_EXECUTABLE=/absolute/path/to/pi
~~~

Windows PowerShell：

~~~powershell
$env:AGENT_K_PI_EXECUTABLE = "C:\path\to\pi.cmd"
~~~

### 2. 启动 Agent K

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

启动脚本会安装锁定的 npm 依赖、通过已审查的官方脚本下载 Electron 运行时，然后启动 Vite 与 Electron。不再需要 Rust、Cargo、WebKitGTK 开发包或 WebView2。

## 系统要求

| 组件 | 要求 |
| --- | --- |
| Node.js | 22.19 或更新版本 |
| Pi | 0.80.10 或兼容版本 |
| Windows | Windows 10/11 x64 |
| Linux | 支持 X11 或 Wayland 的现代 x64 桌面发行版 |

Electron 自带 Chromium。精简 Linux 安装若缺少运行库，可安装：

~~~bash
# Debian / Ubuntu
sudo apt install libgtk-3-0 libnss3 libasound2t64 libgbm1

# Fedora / Nobara
sudo dnf install gtk3 nss alsa-lib mesa-libgbm
~~~

## 开发与构建

安装依赖时默认不执行第三方生命周期脚本；Electron 的官方下载脚本需单独运行：

~~~bash
npm ci --ignore-scripts
node node_modules/electron/install.js
~~~

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动 Vite 与完整 Electron 开发环境 |
| `npm run dev:web` | 只启动 Vite 渲染层 |
| `npm run check` | 检查 React、Electron 后端和 K Plan TypeScript |
| `npm run check:desktop` | 检查 Electron 主进程 TypeScript |
| `npm test` | 运行 K Plan 测试 |
| `npm run build` | 构建渲染层与 Electron 主进程 |
| `npm run dist:linux` | 生成 Linux AppImage |
| `npm run dist:windows` | 在 Windows 上生成 NSIS 安装包 |

平台测试脚本：

~~~bash
./script/test-linux.sh
~~~

~~~bat
script\test-windows.bat
~~~

日常 Linux 开发不要求交叉构建 Windows 安装包。

## 仓库结构

~~~text
AgentK/
├── electron/               # Electron 主进程、Pi RPC pool、文件与设置服务
│   └── agent/              # Pi 外部进程与 JSONL RPC 适配
├── src/                    # 无 Node.js 权限的 React 渲染进程
├── extensions/k-plan/      # 随客户端发布的 K Plan 扩展
├── skills/                 # 随客户端发布的 Pi Skills
├── assets/icons/           # 桌面和安装包图标
├── script/                 # Windows/Linux 运行与测试脚本
└── docs/architecture.md    # 详细架构边界
~~~

## Provider 与凭据

- 模型目录来自 Pi 的公开 `get_available_models` RPC。
- API Key 通过隔离的 Electron IPC 写入 Pi 的 `auth.json`，不会进入浏览器存储。
- OAuth 或结构化认证使用官方 Pi 交互终端完成。
- Linux 凭据路径为 `~/.pi/agent/auth.json`；Windows 为 `%USERPROFILE%\.pi\agent\auth.json`。

## 安全说明

Agent K 会以当前用户权限启动外部 Pi 进程。界面的执行确认不是操作系统级沙箱；处理不受信任的代码时，请使用容器或虚拟机。漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## Roadmap

以下内容属于后续规划，尚未包含在当前版本中：

- [ ] **一键式本地 AI 发行包：** 内置 llama.cpp 与 Pi，支持一键式完整打包；可从 ModelScope 或 Hugging Face 下载本地大模型，并在原位置直接运行，无需额外配置推理服务。
- [ ] **更丰富的 Skill 与 Extension 生态：** 内置更多 Skills 和 Extensions，并在应用内浏览 Skill Hub 等兼容的 Skill 站点与资源目录。
- [ ] **文件格式 SDK：** 提供扩展接口，用于为特定文件格式实现解析、预览和编辑功能。
- [ ] **集成代码调试：** 支持 C/C++、Python、JavaScript/TypeScript 的调试工作流，包括 GDB 与 MSVC 调试器。
- [ ] **macOS 版本：** 提供正式支持的 macOS 应用、打包流程和平台集成。

## 参与贡献

欢迎提交 Issue 和 Pull Request。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

- 不 vendor、修改或提交 Pi 源码。
- Pi 协议行为集中在 `electron/agent/`。
- React 渲染层不直接管理外部进程。
- 未经明确许可，不移除面向用户的现有功能。

## 许可证

[MIT](LICENSE) © 2026 AgentK contributors
