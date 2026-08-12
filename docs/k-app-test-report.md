# k-app API 与创建 Skill 本地测试报告

日期：2026-08-13
平台：Windows x64
项目版本：Agent K 0.1.10

## 结论

k-app 的配置授权、目录识别、JavaScript Bridge、文件访问、Pi 请求、进程管理和创建 Skill 的确定性链路均通过本地测试。全量回归无失败。

本轮测试发现并修复了五项实际问题：

1. 宿主此前只检查 `config.k` 是否存在，没有解析并验证内容；现已在授予 API 和进程权限前验证完整配置。
2. 工作区文件路径此前可能跟随最终文件符号链接离开工作区；现会校验现有目标的真实路径。
3. 进程 `wait()` 可能早于 stdout/stderr 完全关闭；现等待 `close`，保证结束后可读到完整缓冲输出。
4. Skill 脚手架在 Linux 上可能漏掉大小写不同的既有 `APP.HTM`/`CONFIG.K`；现使用跨平台、大小写不敏感的冲突检测。
5. Skill 脚手架的命令行选项此前会接受缺值、未知或重复参数；现全部拒绝。

## API 测试矩阵

| 能力 | 验证内容 | 结果 |
| --- | --- | --- |
| k-app 识别 | 仅 `app.htm(l) + config.k` 获得 k-app 优先级；普通 app 文件不预览 | 通过 |
| `config.k` | JSON、schemaVersion、作者、功能、名称、严格 SemVer、reserved/settings 对象、未知字段保留 | 通过 |
| API 授权 | 无配置、非法配置、非 app 入口均不能获得 Agent K API | 通过 |
| Bridge | API 冻结、请求 ID、方法名、参数、成功响应和错误 Promise | 通过 |
| `files.read` | 相对路径转换、绝对路径与 `..` 拒绝 | 通过 |
| `files.write` | 路径约束及宿主写入链路 | 通过 |
| `files.list` | 相对目录请求与返回结构 | 通过 |
| 文件隔离 | traversal、绝对外部路径和符号链接真实路径检查 | 通过；本机无文件符号链接权限时该子步骤记录诊断 |
| `pi.send` | 精确 Bridge 请求与错误传播 | 通过 |
| `processes.start` | 参数数组、无宿主 shell、cwd、空命令、参数上限 | 通过 |
| 进程隔离 | 进程 ID 仅所属 k-app 可见 | 通过 |
| `list/status/wait` | 运行、正常退出、非零退出、终止和 successful/exitCode/signal | 通过 |
| `output` | stdout、stderr、增量游标、1 MiB 有界缓冲 | 通过 |
| `stop` | 真实长时间 Node 子进程终止并等待关闭 | 通过 |
| `open` | ShellExecute 回调、系统错误传播、相对逃逸拒绝 | 通过（注入替身，未打开真实 GUI） |
| 退出清理 | 管理器 shutdown 终止仍在运行的受管进程 | 通过 |
| k-app UI | k-app 隐藏网站预览菜单条；普通 index 仍保留菜单 | 通过（组件契约测试） |
| 混合语言 | 脚手架保留 package.json、CMakeLists.txt 和既有工程内容 | 通过 |

## Skill 测试矩阵

| 能力 | 验证内容 | 结果 |
| --- | --- | --- |
| Skill 格式 | `skill-creator` quick validation | 通过 |
| 触发描述 | 创建、更新、修复、校验、文件、Pi、进程场景均在 metadata 中 | 通过 |
| Pi 资源发现 | `create-agent-k-app` 作为内置 Skill 被 Agent K 资源注册表发现 | 通过 |
| 脚手架 | 带空格路径、作者、功能、版本、模板和 config.k 输出 | 通过 |
| 覆盖保护 | app.html、app.htm、config.k，包括大小写变体 | 通过 |
| 混合项目保护 | 不修改现有 TS/JS 与 CMake 项目文件 | 通过 |
| 校验器 | 缺失文件、非法 JSON、schema、空作者、非法 SemVer、非法对象 | 通过 |
| CLI 参数 | 缺值、未知参数、重复参数 | 通过 |
| 模板 | 使用异步 AgentK API，无 Node/Electron 直接权限 | 通过 |

## 执行结果

- `npm run check`：通过。
- k-app 最终专项测试：20/20 通过。
- `quick_validate.py skills/create-agent-k-app`：通过。
- `npm test`：266 项；256 通过，10 跳过，0 失败。
- `git diff --check`：通过。

## 未计为通过的场景

- 本轮只在 Windows x64 执行；Linux x64 尚未实际运行同一工作树测试。
- 没有启动真实 Chrome、Explorer 或 Task Manager；`processes.open` 使用 ShellExecute 注入替身验证，以免扰动用户桌面。
- 没有启动完整 Electron UI 做人工点击验收；UI 行为由组件和桥接契约测试覆盖。
- 没有调用真实模型验证一次自然语言请求是否实际展开该 Skill；已验证 Agent K/Pi 资源发现、Skill metadata、确定性脚本和最终产物。
- 进程管理终止直接子进程，不提供 Windows Job Object 或 Unix process-group 级整棵进程树回收保证。

因此，本地可确认的是：k-app API 的宿主契约与安全边界、以及 Skill 的发现和确定性开发链路已经通过；双平台认证和真实模型端到端调用仍需单独执行后才能宣称通过。
