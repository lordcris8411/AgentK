# Pi Visual Client

一个基于 Tauri 2、React 和 TypeScript 的 Pi Coding Agent 可视化桌面客户端。界面设计以 Codex 的任务侧栏、对话工作区和可折叠工具活动为参考。

## 架构

- `src/`：运行在系统 WebView 中的 React 界面。
- `src-tauri/`：桌面宿主与本地能力边界。
- `src-tauri/src/agent/`：Pi RPC 生命周期和协议桥接层；界面不直接启动或解析 Pi 子进程。
- `src/lib/agent-client.ts`：前端唯一的 agent 通信抽象，现阶段提供 mock 实现。
- `docs/architecture.md`：模块边界和后续实施顺序。

## 前置条件

- Node.js 22 或更新版本。
- Rust stable 工具链（Tauri 构建所需）。
- Windows 需要 Microsoft C++ Build Tools；WebView2 通常随 Windows 11 提供。
- 本地 Pi CLI 或后续通过设置指定的 Pi 源码/可执行文件。

## 开发

```powershell
npm install
npm run tauri dev
```

仅调试界面：

```powershell
npm run dev
```

当前提交仅建立骨架和一个静态工作区；Pi RPC 子进程桥接、会话状态同步与真实交互将在后续阶段实现。

