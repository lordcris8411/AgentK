<div align="center">
  <img src="src-tauri/icons/agent-k.svg" width="112" height="112" alt="Agent K logo">

  # Agent K

  **A fast, native desktop workspace for the [Pi coding agent](https://github.com/earendil-works/pi).**

  在 Windows 与 Linux 上，通过可视化界面管理 Pi 会话、项目文件、工具调用和模型配置。

  [![CI](https://github.com/lordcris8411/AgentK/actions/workflows/ci.yml/badge.svg)](https://github.com/lordcris8411/AgentK/actions/workflows/ci.yml)
  [![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://v2.tauri.app/)
  [![React 19](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)](https://react.dev/)
  [![Windows](https://img.shields.io/badge/Windows-supported-0078D4?logo=windows)](#系统要求)
  [![Linux](https://img.shields.io/badge/Linux-supported-FCC624?logo=linux&logoColor=black)](#系统要求)
  [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
</div>

## 为什么选择 Agent K？

Agent K 将 Pi 的 Agent 能力放进一个专注、可调整的桌面工作区，同时保持与 Pi 源码完全解耦。

- **完整对话体验**：流式响应、思考过程、工具调用、执行确认、分支与会话历史。
- **项目工作区**：文件树、Monaco 编辑器、Markdown/媒体预览和变更审阅。
- **模型与 Provider**：读取 Pi 的公开模型目录，支持 API Key、OAuth 和本地模型服务。
- **原生桌面集成**：多窗口尺寸适配、可调整侧栏、布局记忆、系统主题和中英文界面。
- **跨平台**：同一套代码支持 Windows 与 Linux，并针对 WebKitGTK、Wayland 和 NVIDIA 做兼容处理。
- **安全边界清晰**：React 渲染层不直接启动进程、读写凭据或访问任意文件。

## 架构

```text
┌──────────────────────┐
│ React / TypeScript UI│
└──────────┬───────────┘
           │ typed Tauri commands & events
┌──────────▼───────────┐
│ Rust desktop adapter │
│ process · files · IPC│
└──────────┬───────────┘
           │ public JSONL RPC
┌──────────▼───────────┐
│ external pi --mode rpc│
└──────────────────────┘
```

Agent K **不包含、不修改也不提交 Pi 源码**。Pi 是独立安装的外部运行时，双方只通过公开 RPC
协议协作。`.reference/pi/` 仅可用于本地查阅上游实现，并已排除在版本管理和构建输入之外。

更多设计细节见 [架构文档](docs/architecture.md)。

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

### 2. 获取并启动 Agent K

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

启动脚本会检查 Node.js、Rust 和平台依赖，在需要时执行 `npm ci --ignore-scripts`，然后启动
完整的 Tauri 开发模式。

## 系统要求

| 组件 | 要求 |
| --- | --- |
| Node.js | 22.19 或更新版本 |
| Rust | stable toolchain |
| Pi | 0.80.10 或兼容版本 |
| Windows | Windows 10/11，WebView2 |
| Linux | WebKitGTK 4.1 与 Tauri 2 构建依赖 |

<details>
<summary><strong>Debian / Ubuntu 依赖</strong></summary>

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libdbus-1-dev pkg-config \
  libayatana-appindicator3-dev librsvg2-dev
```

</details>

<details>
<summary><strong>Fedora / Nobara 依赖</strong></summary>

```bash
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  dbus-devel pkgconf-pkg-config libappindicator-gtk3-devel \
  librsvg2-devel libxdo-devel
sudo dnf group install "c-development"
```

</details>

尚未安装 Rust 时：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## 开发

安装依赖：

```bash
npm ci --ignore-scripts
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 只启动 Vite/WebView 前端 |
| `npm run tauri -- dev` | 启动完整桌面开发环境 |
| `npm run check` | 检查前端与 K Plan TypeScript |
| `npm run check:desktop` | 检查 Rust/Tauri 后端 |
| `npm test` | 运行 K Plan 测试 |
| `npm run build` | 构建生产前端 |
| `npm run tauri -- build` | 构建当前平台安装包 |

完整的平台测试脚本：

```bash
./script/test-linux.sh
```

```bat
script\test-windows.bat
```

> Windows 与 Linux 均受支持。日常开发不要求在 Linux 上交叉编译 Windows 产物。

## 仓库结构

```text
AgentK/
├── src/                    # React renderer
│   ├── components/layout/  # 窗口、侧栏、编辑器与媒体预览
│   ├── features/           # 会话、对话、设置与扩展 UI
│   └── lib/                # Tauri 前端端口与通用工具
├── src-tauri/
│   └── src/agent/          # Pi 进程与 RPC 适配层
├── extensions/k-plan/      # 随客户端发布的 K Plan 扩展
├── script/                 # Windows/Linux 运行与测试脚本
└── docs/architecture.md    # 详细架构边界
```

## Provider 与凭据

- 模型目录来自 Pi 的公开 `get_available_models` RPC。
- 普通 API Key 通过 Tauri IPC 写入 Pi 的 `auth.json`，不会进入浏览器存储。
- OAuth 或需要账号、项目等多字段的 Provider 使用官方 Pi 交互终端完成登录。
- Linux 凭据路径为 `~/.pi/agent/auth.json`；Windows 为
  `%USERPROFILE%\.pi\agent\auth.json`。

登录终端打开后，在 Pi 中执行界面提示的 `/login <provider>`，完成后回到 Agent K 刷新模型列表。

## Linux 图形兼容

Agent K 默认使用 `AGENT_K_WEBKIT_RENDERER=auto`：

- 正常情况下保留 WebKitGTK DMA-BUF 加速。
- NVIDIA 驱动内核模块与用户态库不匹配时，自动切换兼容渲染器。
- NVIDIA + Wayland 下规避 explicit-sync protocol error，并对 WebKit 的 H.264 绿色帧问题使用
  独立的视频呈现兼容路径；主界面仍保持 GPU 加速。

手动选择渲染器：

```bash
AGENT_K_WEBKIT_RENDERER=accelerated ./script/run-linux.sh
AGENT_K_WEBKIT_RENDERER=compatible ./script/run-linux.sh
```

原生 `WEBKIT_DISABLE_DMABUF_RENDERER` 环境变量的优先级高于 Agent K 自动选择。

## 安全说明

Agent K 会以当前用户权限启动外部 Pi 进程。界面的执行确认不是操作系统级沙箱；处理不受信任的
代码时，请使用容器或虚拟机。漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 参与贡献

欢迎提交 Issue 和 Pull Request。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，并遵守以下边界：

- 不 vendor、修改或提交 Pi 源码。
- Pi 协议相关行为集中在 `src-tauri/src/agent/`。
- React 渲染层不直接管理外部进程。
- 新功能不得以移除现有用户体验为代价。

## License

[MIT](LICENSE) © 2026 AgentK contributors
