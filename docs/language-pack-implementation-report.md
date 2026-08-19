# Agent K Language Pack 重构本地验证报告

日期：2026-08-10
工作区：Windows 源码工作区；未创建 Git commit。

## 结论

统一、可热插拔的 Language Pack 功能实现及本地双平台回归通过。C/C++、C#、TypeScript/JavaScript 均通过同一 manifest、registry、`capability: "language"`、包内 Skill、文本 Editor、隔离工具链、LSP、build/test/run 和通用 DAP 接入；C++ 不再拥有宿主硬编码 capability 或 language ID 分支。

三个首批包均完成 Windows x64 与 Ubuntu 24.04 x64 的真实语义、构建和调试链路。原生 Debug UI 同一测试在 Windows Electron 和 Ubuntu Electron + Xvfb 均通过。安装 preview、冷启动契约、原子升级、失败回滚、启停、卸载及 Skill 暴露由 registry 测试覆盖。

唯一环境限制是本机 WSL 无法直连 nodejs.org/GitHub/npm；Linux 冷链路因此复用已按官方摘要校验的归档缓存。功能、解压、执行、LSP、编译和 DAP 均真实运行，不是模拟响应。

## 已实现能力

- `agent-k.language-pack.json` v1 严格校验平台、语言 ID、扩展名、项目标记、Editor、嵌入 Skill、action schema、权限、固定工具版本、HTTPS URL 和哈希。
- 通用 `LanguagePackRegistry`、worker supervisor、LSP/DAP router、工具链管理和统一 Agent IPC。
- 用户包版本目录、staging 校验、短时安装确认 token、冷启动探测、原子 active 切换与失败回滚。
- 启用、禁用、升级和卸载同步刷新 Editor contribution、Pi Skill 与 action；不要求重启 Agent K。
- workspace 仅接受当前工作区内相对路径；构建、索引、依赖和临时输出进入私有 cache。
- 系统工具兼容时优先使用解析后的绝对路径；不兼容时使用固定版本私有 fallback 和清理后的子进程环境。
- 下载具备确认、进度、取消、缓存复用、SHA-256/SHA-512、staging、原子切换，以及 HTTP/连接/流中断重试。
- `agent-k.cpp`：clangd、CMake、Ninja、编译器、CodeLLDB、Skill、Editor、build/test/run/debug。
- `agent-k.csharp`：.NET SDK 10.0.302、csharp-ls 0.26.0、netcoredbg 3.2.0-1092、Skill、Editor、build/test/run/debug。
- `agent-k.typescript-javascript`：Node 24.18.1、typescript-language-server 5.3.0、TypeScript 6.0.3、js-debug 1.117.0、Skill、Editor、build/test/run/debug。
- `create-agent-k-language-pack` 作者 Skill：scaffold、validate、build、local-test、package、install-preview 和单层 references。

## 本轮发现并修复的问题

- Windows 系统工具探测直接启动 `npm.cmd` 会触发 `spawn EINVAL`，并导致 Desktop backend 整体启动失败。现对 `.cmd/.bat` 使用 Windows shell，且单个探测失败只回退私有工具链。
- 主窗口、Debug 窗口和 Debug 工具窗口的导航保护会误拦截首次 `about:blank` 导航；现仅放行首次应用页加载，后续外部导航仍被禁止。
- 通用 worker 环境清理误删 E2E 调试适配器变量；现只在 `AGENT_K_E2E=1` 时传递测试变量，生产隔离不变。
- C#/TS/C++ worker shutdown 曾在缓存清理时残留 LSP、编译服务器或 DAP 进程；现执行协议关闭、等待退出、分级 kill，并禁用 .NET build server/shared compilation。
- C++ 混合系统/私有工具路径、Windows PATH 大小写重复、Linux tar 辅助程序、TS6 build 参数和 JS DAP Node 路径均已修正。
- C++、C#、TS/JS 下载现在都覆盖响应体中途断线重试，而非只重试初始 HTTP 请求。
- Debug E2E 不再把仓库根误识别成待配置 CMake 项目，改用隔离的无项目标记工作区夹具。
- Agent 评测源码副本过去只复制 `HEAD`，会漏掉当前未提交的 Language Pack 实现；现可显式覆盖当前 working tree diff 与未跟踪源码，同时排除评测输出目录。
- Settings 启动阶段存在竞态：布局设置可能先于原生设置加载并覆盖默认模型、推理等级和 `permissionMode`，导致并行工具调用停在权限选择。现复用同一个原生设置加载 promise，任何局部更新都会先完成 hydration 再合并持久化。
- 作者 Skill 规范与 validator 补齐了 `trace`、合法 action 命名、必需 Editor contribution、所有 fallback 平台归档摘要，以及可恢复的异步下载确认握手；生成包的 replay 改为读取实际 manifest 版本。
- 作者会话超时后不再只依赖单个 UI 事件；评测会用 Pi `get_state` 确认真实 idle 状态，并保留 timeout/session trace 证据。报告同时移除了已经被通用 `capability: "language"` 解决的旧产品缺口。
- Windows 开发启动时，Preview Console 曾在主窗口仍替换初始 `about:blank` renderer 时附加 DevTools debugger，触发 Electron sandbox `startupData=null`。现等待应用文档首次 `did-finish-load` 后再附加，并以真实用户数据启动复验。
- 默认 Pi 选择曾优先采用 PATH 中的 `pi.cmd`，触发 Node 24 `DEP0190` 且可能偏离固定 Pi 版本。现只有显式环境变量/设置能覆盖内置 Pi；系统 `.cmd/.bat` 工具版本探测也改为显式、已引用的 `cmd.exe` 调用，不再使用 `shell: true`。

## 验证结果

### Windows x64

- `npm run check`：通过。
- `npm test`：220 项，210 通过，10 个显式条件跳过，0 失败。
- `npm run test:debug:e2e`：构建通过；Electron Debug UI 1/1 通过（最终用时 4.7 秒）。
- C++ 真实冷链路：1/1，通过；私有工具解压、clangd hover、CMake build、CodeLLDB DAP、卸载及源码树零污染（约 40.4 秒）。
- C# 真实冷链路：1/1，通过；私有 .NET/csharp-ls、hover、build、netcoredbg DAP、卸载及零污染（约 367 秒）。
- TS/JS 真实冷链路：1/1，通过；私有 Node/TypeScript LSP、hover、TS build、js-debug DAP、卸载及零污染（约 65 秒）。
- registry：5/5，通过；包含 1.0 → 1.1 热升级、禁用/启用、坏 1.2 冷启动拒绝、回滚后旧 action 继续可用。

### Ubuntu 24.04 x64（WSL2）

- 私有 Node 24.18.1；未安装或依赖系统 Node。
- `npm run check`：通过。
- 离线模式 `npm test`：220 项，213 通过，7 个条件跳过，0 失败。额外跳过项是需再次联网下载 Node 官方归档的 smoke 和仅适用于 Windows `.cmd` 的 probe；同一 Node 归档已完成哈希校验和真实冷链路。
- Ubuntu Electron 43.1.1 官方 Linux x64 归档 SHA-256 校验通过；`xvfb-run` Debug UI 1/1 通过（6.3 秒）。
- C++ 真实链路：1/1，通过；系统 g++ 13.3.0 与私有 CMake/Ninja/clangd/CodeLLDB 混合隔离运行（约 2.7 秒）。
- C# 私有 fallback 链路：1/1，通过；真实 LSP/build/CoreCLR DAP（约 12.5 秒）。
- TS/JS 私有 fallback 链路：1/1，通过；真实 LSP/build/JavaScript DAP（约 10.5 秒）。

### 作者 Skill

- Codex Skill quick validation：通过。
- Windows：scaffold → build → validate → worker cold local-test → package，全流程通过。
- Linux：对同一模板执行相同全流程，通过。
- 两个全新 Agent 作者会话使用 `openai-codex/gpt-5.6-sol`、中等推理、Pi 0.83.0；总计 3,289,769 tokens、1,241.2 秒。
- C#：Agent 从作者 Skill 创建独立的 `agent-k.eval-csharp`，Windows 静态/隐藏校验和冷启动 replay 通过；同一 artifact 复制到 Linux 后，静态/隐藏校验和冷启动 replay 通过。
- TS/JS：Agent 从作者 Skill 创建独立的 `agent-k.eval-typescript-javascript`，Windows 静态/隐藏校验、真实 `LanguagePackRegistry` 解析和冷启动 replay 通过；同一 artifact 在 Linux 完成相同 replay。
- 汇总：`language-development` 2/2 PASS；产品缺口为 None，失败或未完成样本为 None。Linux 未重新调用模型生成，只验证 Windows 生成的同一 artifact。
- 完整证据保存在 `.agent-k-language-pack-author-final-report/`：包含 `results.json`、汇总、artifact、prompt/response、session trace、工具调用与平台 replay 结果。

## 已校验关键摘要

- Node 24.18.1 Linux x64：`d6c664df3f3f61458e8c277585571328522d705166723a7c7823a9253a4d15a0`
- C# SDK Linux x64 SHA-512：`10069bec8783596484a610332f090d562802a41b9b40e3327a5a5688b572e10c296ae300f940d40461f23c157ed1b0843c2f8e6b3f20d8d8d9d83432d8143bac`
- csharp-ls 0.26.0：`2b03987aef07bb708bfe56a7bfb370364c7c8203e69aa677a37594bbe21a15b0`
- netcoredbg Linux x64：`080eb3b2d2152465f599d3b33d1ee6e747794e11cc0a3773ec689f5e5f2c5afa`
- js-debug 1.117.0：`ad8d04ede9d4b75cc290fd5438a65047a06f786d04f604b6112485b36f090772`
- clangd 22.1.6 Linux x64：`a9c77443af2e447ed467e84771848d3a6ac1c56f84bcfcde717e66318de77cfa`
- CodeLLDB 1.12.2 Linux x64：`b85b45a8570051d535b0927c6c9da11c39f3a056c73559064647faf7f37f637d`
- Electron 43.1.1 Linux x64：`c1f479c52747caf1510e17500e1c8a556d0e40802837bd48c5647a84688a3880`

## 最终判定

- 统一协议、通用 capability、无 C++ 宿主特化：通过。
- C++、C#、TS/JS 三包 Windows/Linux 真实链路：3/3 通过。
- 热插拔生命周期与失败回滚：通过。
- 双平台构建、自动化回归和原生 Debug UI：通过。
- 作者 Skill 的确定性开发工具链：双平台通过。
- `gpt-5.6-sol` 中等推理的两个全新自主作者样本：2/2 通过；C# 与 TS/JS 均由 Agent 独立创建，并以同一 artifact 完成 Windows/Linux 冷启动验证。
