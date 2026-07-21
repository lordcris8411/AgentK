<div align="center">
  <img src="assets/icons/agent-k.svg" width="112" height="112" alt="Agent K logo">

  # Agent K

  **A fast desktop workspace for the [Pi coding agent](https://github.com/earendil-works/pi).**

  在 Windows 与 Linux 上，通过可视化界面管理 Pi 会话、项目文件、工具调用和模型配置。

  [![CI](https://github.com/lordcris8411/AgentK/actions/workflows/ci.yml/badge.svg)](https://github.com/lordcris8411/AgentK/actions/workflows/ci.yml)
  [![Electron 43](https://img.shields.io/badge/Electron-43-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
  [![React 19](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)](https://react.dev/)
  [![Windows](https://img.shields.io/badge/Windows-supported-0078D4?logo=windows)](#系统要求)
  [![Linux](https://img.shields.io/badge/Linux-supported-FCC624?logo=linux&logoColor=black)](#系统要求)
  [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
</div>

## 功能

- **完整对话体验**：流式响应、思考过程、工具调用、执行确认、分支和会话历史。
- **项目工作区**：文件树、Monaco 编辑器、Markdown/媒体预览和变更审阅。
- **模型与 Provider**：读取 Pi 模型目录，支持 API Key、OAuth 和本地模型服务。
- **资源管理**：查看并启停用户或项目级 Skills 与 Extensions。
- **桌面体验**：自绘标题栏、可调整侧栏、布局记忆、系统主题和中英文界面。
- **同一渲染基座**：Windows 与 Linux 均使用 Electron 内置 Chromium，避免系统 WebView 的实现差异。
- **安全边界清晰**：React 渲染进程不拥有 Node 权限，也不直接启动进程或访问文件系统。

## 架构

```text
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
```

Agent K **不包含、不修改也不提交 Pi 源码**。Pi 是独立安装的外部运行时，双方只通过公开 RPC
协议协作。`.reference/pi/` 只用于本地查阅上游实现，已排除在版本管理和构建输入之外。

桌面后端使用 TypeScript 编写，Pi 协议适配集中在 `electron/agent/`。渲染进程通过
`electron/preload.cjs` 暴露的窄接口访问桌面能力，并保持 `contextIsolation` 与 Chromium sandbox。
更多设计细节见 [架构文档](docs/architecture.md)。

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
| `/session` | 获取当前会话统计 |
| `/reload` | 重新加载 Pi 配置、Skills 与 Extensions |

## 内置 Skills

Agent K 随应用发布以下自有 Skills，并通过 Pi 的公开 `--skill` 参数加载：

| Skill | 用途 | 运行依赖 |
| --- | --- | --- |
| `weather` | 使用 Open-Meteo 查询实时天气、逐小时天气和七日预报 | `bash`、`curl`、`jq` |
| `gdb-debug` | GDB 启动、崩溃回溯、线程和 core dump 分析工作流 | `bash`、`gdb`、`nm` |

首次启动时，内置 Skills 会复制到稳定的应用数据目录，因此外部 Pi 进程不需要读取 Electron
归档。它们会和用户及项目 Skills 一起显示在 `/skills` 管理器中，可以独立启用或停用；设置窗口
关闭后，Agent K 会一次性刷新空闲 worker pool。用户自己的 `~/.pi/agent/skills` 不会被覆盖。

内置脚本当前面向 POSIX shell 环境。在 Windows 上可通过 Git Bash、MSYS2 或 WSL 使用；
Skill 本身仍能被查看和管理。

## 快速开始

### 1. 安装 Pi

```bash
npm install --global @earendil-works/pi-coding-agent
pi --version
```

Agent K 当前面向 Pi `0.80.10` 或兼容版本。也可以指定其他 Pi 可执行文件：

```bash
export AGENT_K_PI_EXECUTABLE=/absolute/path/to/pi
```

Windows PowerShell：

```powershell
$env:AGENT_K_PI_EXECUTABLE = "C:\path\to\pi.cmd"
```

### 2. 启动 Agent K

```bash
git clone https://github.com/lordcris8411/AgentK.git
cd AgentK
./script/run-linux.sh
```

Windows Command Prompt 或 PowerShell：

```bat
git clone https://github.com/lordcris8411/AgentK.git
cd AgentK
script\run-windows.bat
```

脚本会安装锁定的 npm 依赖、按已审查的官方脚本下载 Electron 运行时，然后启动 Vite 与 Electron。
不再需要 Rust、Cargo、WebKitGTK 开发包或 WebView2。

## 系统要求

| 组件 | 要求 |
| --- | --- |
| Node.js | 22.19 或更新版本 |
| Pi | 0.80.10 或兼容版本 |
| Windows | Windows 10/11 x64 |
| Linux | 现代 x64 桌面发行版，支持 X11 或 Wayland |

Electron 自带 Chromium。精简 Linux 安装若缺少运行库，可安装：

```bash
# Debian / Ubuntu
sudo apt install libgtk-3-0 libnss3 libasound2t64 libgbm1

# Fedora / Nobara
sudo dnf install gtk3 nss alsa-lib mesa-libgbm
```

## 开发与构建

安装依赖时默认不执行第三方生命周期脚本；Electron 的官方下载脚本需单独运行：

```bash
npm ci --ignore-scripts
node node_modules/electron/install.js
```

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

完整平台测试：

```bash
./script/test-linux.sh
```

```bat
script\test-windows.bat
```

日常开发不要求在 Linux 上交叉构建 Windows 安装包。

## 仓库结构

```text
AgentK/
├── electron/               # Electron main、Pi RPC pool、文件与设置服务
│   └── agent/              # Pi 外部进程与 JSONL RPC 适配
├── src/                    # React renderer（无 Node 权限）
├── extensions/k-plan/      # 随客户端发布的 K Plan 扩展
├── skills/                 # 随客户端发布的内置 Pi Skills
├── assets/icons/           # 桌面和安装包图标
├── script/                 # Windows/Linux 运行与测试脚本
└── docs/architecture.md    # 详细架构边界
```

## Provider 与凭据

- 模型目录来自 Pi 的公开 `get_available_models` RPC。
- API Key 通过隔离的 Electron IPC 写入 Pi 的 `auth.json`，不会进入浏览器存储。
- OAuth 或结构化认证使用官方 Pi 交互终端完成。
- Linux 凭据路径为 `~/.pi/agent/auth.json`；Windows 为
  `%USERPROFILE%\.pi\agent\auth.json`。

## 安全说明

Agent K 会以当前用户权限启动外部 Pi 进程。界面的执行确认不是操作系统级沙箱；处理不受信任的
代码时，请使用容器或虚拟机。漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 参与贡献

欢迎提交 Issue 和 Pull Request。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

- 不 vendor、修改或提交 Pi 源码。
- Pi 协议行为集中在 `electron/agent/`。
- React 渲染层不直接管理外部进程。
- 新功能不得以移除现有用户体验为代价。

## License

[MIT](LICENSE) © 2026 AgentK contributors
