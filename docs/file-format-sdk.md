# Agent K 可编程 Editor SDK（v1）

Editor 插件是一个独立的、可执行的浏览器微应用。插件编写者决定使用 Monaco、CodeMirror、Canvas、媒体组件或自己的 DOM，拥有插件 frame 内的全部 HTML 和 CSS；Agent K 不再替插件绘制编辑器。

一个完整插件包如下：

```text
my-editor/
├── editor.json          # 只用于安全发现，不包含界面逻辑
├── editor.ts            # 真正执行的 TypeScript 入口
├── editor.css           # 插件自己的样式（可选）
├── dist/
│   ├── editor.iife.js   # 可离线运行的浏览器 bundle
│   ├── editor.css
│   └── assets/          # Worker 等构建资源（可选）
└── SKILL.md             # 提供给 Pi 的配套 Skill
```

第一方示例位于 [`editor/extensions/text/`](../editor/extensions/text/)：它自己选择 Monaco、创建 model、定义浅色/深色主题、设置滚动和换行行为，并实现保存快捷键、跳转与“添加本行到对话”。这些逻辑不在 Agent K 的 `InspectorPanel` 中。

第一方 Markdown、HTML、图片、音频、视频和 PDF 也全部具有自己的 `editor.ts`、`editor.css` 与独立 runtime。插件之间禁止直接导入代码、CSS 或资源，不存在公共编辑器基类、公共 UI 组件或公共样式。宿主只提供无界面的版本化通信协议 `editor/sdk/index.ts`，以及由插件显式声明、带精确版本号的第三方依赖缓存；是否使用 Monaco 完全由插件决定。Agent K 宿主没有对应格式的备用渲染分支；任一第一方包校验或构建失败都会阻止桌面后端完成启动。

## Manifest

`editor.json` 仅让 Agent K 在不执行未知代码的前提下完成匹配、设置展示和资源限制。可编程插件使用 `editor: "plugin"`：

```json
{
  "apiVersion": 1,
  "id": "example.hex-editor",
  "name": "Hex Editor",
  "match": {
    "extensions": ["bin", "rom"],
    "fileNames": ["firmware.bin"],
    "absolutePaths": ["/opt/device/firmware.bin", "C:\\device\\firmware.bin"],
    "mimeTypes": ["application/octet-stream", "application/x-firmware"]
  },
  "editor": "plugin",
  "editable": true,
  "runtime": {
    "entry": "dist/editor.iife.js",
    "style": "dist/editor.css",
    "assets": "dist/assets",
    "dependencies": ["monaco-editor@0.55.1"]
  }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `apiVersion` | 可编程插件必填 | 当前必须为 `1`。 |
| `id` | 是 | 2–81 个字符的稳定标识；仅允许字母、数字、`.`、`_`、`-`。 |
| `name` | 是 | 设置、错误信息和诊断中使用的名称。 |
| `match.extensions` | 至少一项匹配规则 | 不带点的扩展名；匹配时忽略大小写。 |
| `match.fileNames` | 至少一项匹配规则 | 精确 basename，区分大小写。不得包含目录分隔符。 |
| `match.absolutePaths` | 至少一项匹配规则 | 精确绝对路径；支持 POSIX、Windows 盘符和 UNC 路径。Windows 路径匹配不区分大小写。 |
| `match.mimeTypes` | 至少一项匹配规则 | MIME type，可使用精确值或主类型通配符，如 `image/*`。 |
| `editor` | 是 | 唯一合法值是 `plugin`。其他值会使整个包校验失败。 |
| `runtime.entry` | `editor: plugin` 必填 | 相对包目录的 IIFE JavaScript bundle，必须以 `.js` 结尾。 |
| `runtime.style` | 否 | 相对包目录的构建后 CSS。 |
| `runtime.assets` | 否 | 单层构建资源目录，主要用于 Monaco Worker。 |
| `runtime.dependencies` | 否 | Agent K 提供的精确版本共享依赖 ID。相同依赖通过只读内部 URL 复用 Chromium 资源缓存和 V8 代码缓存，插件无需各自携带副本。当前内置 `monaco-editor@0.55.1`。 |
| `editable` | 否 | 表明该格式可以写回。实际写入仍必须通过宿主保存协议。 |
| `languageId` | 否 | 传入插件 `initial.language` 的编辑器无关语言 ID，例如 `json`、`html`、`markdown`。插件可将其用于 Monaco、CodeMirror、自定义解析器或其他实现。省略时，Agent K 会根据当前文件扩展名动态选择语言；覆盖多种语言的通用文本插件通常应省略。 |
| `mimeType` | 否 | 覆盖传给插件的媒体 MIME type；未设置时由文件名推断。 |
| `mediaKind` | 否 | 二进制预览类别：`image`、`audio`、`video` 或 `pdf`。设置后宿主以 `initial.binary` 提供文件数据。 |
| `capabilities` | 否 | 暴露给 Pi 的编辑器能力描述。每项包含 `id`、`label`、`description`，可选 `parameters` 把参数名映射为 `string`、`number` 或 `boolean`。 |
| `contextActions` | 否 | 附加到文件树菜单末尾的动作；每项包含 `id`、`label`，`when` 可为 `file`、`directory` 或 `both`。 |

路径必须留在插件目录内；Agent K 会解析真实路径并拒绝 `..`、绝对路径和逃逸插件目录的符号链接。JavaScript、CSS 与资源目录也有独立大小上限。

四种 `match` 数组之间是 OR 关系，至少有一个数组包含规则。同一文件匹配多个插件时，优先级固定为：绝对路径 > 精确文件名 > 扩展名 > 精确 MIME > 通配 MIME；同等级保持发现顺序。`absolutePaths` 只负责选择插件，不会向插件授予文件系统权限。

## 代码入口

插件调用 SDK 的 `defineEditor` 注册工厂。下面的导入路径表示插件包内复制的协议适配器；构建者也可以将仓库中的 `editor/sdk/index.ts` 通过其他本地路径纳入 bundle。下面是一个不依赖框架的最小编辑器；React、Vue、Monaco 等依赖可以由插件自行打包：

```ts
import { defineEditor } from "./agent-k-editor-sdk";
import "./editor.css";

defineEditor((host, initial) => {
  const textarea = document.createElement("textarea");
  textarea.value = initial.content;
  textarea.readOnly = initial.readOnly;
  host.root.append(textarea);

  let saved = initial.content;
  textarea.addEventListener("input", () => {
    host.reportDirty(textarea.value !== saved);
  });
  textarea.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "s") {
      event.preventDefault();
      host.requestSave(textarea.value);
    }
  });

  return {
    focus: () => textarea.focus(),
    getContent: () => textarea.value,
    markSaved(content) {
      saved = content;
      host.reportDirty(textarea.value !== saved);
    },
    setContent(content) {
      saved = content;
      textarea.value = content;
      host.reportDirty(false);
    },
    setTheme(theme) {
      document.documentElement.dataset.theme = theme;
    },
    setWordWrap(enabled) {
      textarea.wrap = enabled ? "soft" : "off";
    },
  };
});
```

当前 SDK 源码随安装包放在 `editor/sdk/index.ts`。它只是消息协议适配器，不是编辑器基类，也不提供 DOM、CSS 或界面行为。第一方插件直接引用它；第三方插件构建时可将这个小型 SDK 模块纳入自己的 bundle。发布给 Agent K 的产物必须已编译，不会在用户机器上执行 npm lifecycle 或现场编译 TypeScript。

## 宿主协议

`defineEditor` 封装了版本化 `postMessage` 协议。初始化数据包含：

- 文件相对路径、绝对路径、文件名、MIME type、文本内容和编辑器无关的语言 ID；
- 二进制插件所需的 `binary`、`byteSize`、`codec` 与 `mediaKind`；
- `light` / `dark` 主题与 `zh-CN` / `en-US` locale；
- 只读状态与自动换行设置。

插件实例必须实现 `getContent` 和 `setContent`，还可实现 `markSaved`、`focus`、`navigate`、`executeAction`、`setLayoutSuspended`、`setTheme`、`setWordWrap` 和 `dispose`。`executeAction` 接收宿主或 Pi 发来的已声明动作；`setLayoutSuspended` 让重型编辑器在侧栏拖动期间暂停布局，并在结束后执行一次权威布局。插件可通过 host 的 `updateContent`、`reportDirty`、`requestSave`、`reportError` 和 `referenceLine` 同步内容、报告状态、请求保存或把某一行加入对话。文件写入始终由 Agent K 后端完成，插件不会得到真实文件系统 API。

`initial.language` 的来源是 manifest 的 `languageId`；未声明时由宿主根据当前文件扩展名推断。使用 Monaco 的插件通常把它传给 `monaco.editor.createModel`，其他插件可以将它用于自己的语法模式、解析器或高亮系统，也可以忽略。Agent K 不会把这个字段解释为依赖，也不会据此加载某个编辑器库版本；依赖版本只能通过 `runtime.dependencies` 声明。旧字段 `monacoLanguage` 不会被兼容或降级处理，包含它的 manifest 将直接校验失败。

## 文件树上下文菜单

插件可在 `editor.json` 的 `runtime.menu` 指向一个单独构建的 IIFE bundle，并在源码中调用 `defineContextMenu`。宿主仅向该沙箱传入所选项的 `absolutePath`、工作区相对 `path`、`isDirectory`、目录直属子项名称 `directoryEntries`，以及受限读取的 `packageJson` 和 `viteConfig` 标记。插件返回 `{ id, label }[]` 即可追加菜单项；不需要的项目返回空数组。菜单代码没有 Node、Electron 或直接文件系统权限。

`directoryEntries` 对文件恒为空数组，对文件夹则仅包含直属子项的名称，不会递归扫描。第一方文本插件据此识别包含 `CMakeLists.txt` 的项目目录并提供“编译项目”。实际执行前 Electron 后端仍会重新校验项目路径和 `CMakeLists.txt`，随后把安全转义的配置、编译命令写入下方项目 PTY；命令和输出都保留在用户可继续操作的真实控制台中。

## 构建约定

第一方插件通过 `npm run build:editors` 构建。每个插件仍独立输出自己的 `dist/editor.iife.js` 和 `dist/editor.css`；构建目标是纯浏览器生产环境，不可在运行时代码中依赖 Node.js 的 `process`、`Buffer` 或模块加载器。选择 Monaco 的插件在 manifest 中声明精确版本依赖，构建时不再把 Monaco 重复写入插件 bundle；共享依赖的 JavaScript 与 CSS 通过只读内部协议加载，让 Chromium 跨 iframe 复用资源缓存和 V8 编译缓存。各语言 Worker 仅在对应语言服务实际启动时按需获取，普通文本、Python 或 C/C++ 文件不会携带 7 MB 的 TypeScript Worker。未声明共享依赖的插件不受影响，仍可选择 CodeMirror、Canvas、原生 DOM 或自行离线打包任意库。第三方入口必须是能在普通浏览器中直接执行的 IIFE bundle。

运行时最多保留 40 个最近使用的文件编辑器 iframe，并按工作区、插件 ID 和文件路径执行 LRU 淘汰。切换回缓存中的文件会直接恢复其 iframe 和编辑器实例；切换会话或工作区不会主动清空缓存。第 41 个文件编辑器进入缓存时才会销毁最久未使用的 iframe。插件 bundle 与带精确版本号的第三方依赖另行全局缓存，不会随文件 iframe 的淘汰而重复读取。

运行完整检查：

```bash
npm run check:editors
npm run build:editors
npm run check
```

## 安全边界

- 每个可编程 Editor 在 `<iframe sandbox="allow-scripts">` 中运行，没有 `allow-same-origin`。
- frame 没有 preload、Node.js、Electron IPC、Cookie、宿主 DOM 或直接文件系统权限。
- frame CSP 默认拒绝普通网络、导航和对象嵌入，只允许内联样式、插件脚本 Blob、Worker Blob、内嵌字体/图片以及 Agent K 的只读依赖协议。
- 消息同时校验 frame window、API 版本和每个实例的随机 nonce。
- Agent K 只接受已启用且已发现插件的 runtime 请求，并再次验证所有构建资源的真实路径。

这是一条代码级互通边界：插件可以完全控制自己的界面和行为，但需要桌面权限时必须使用 Agent K 明确提供的版本化 API。

## Pi Skill 与开关

`SKILL.md` 是必需的标准 Pi Skill，也是 Agent K 在 Pi 生态目录中发现 Editor 包的锚点。Editor 开启时 Skill 可以独立开关；Editor 关闭时 Skill 必须关闭；开启 Skill 会同时开启 Editor。Agent K 在设置窗口关闭后一次性刷新 worker pool，并通过 Pi 的公开 `--skill <插件目录>` 参数加载启用的 Skill。

当当前文件匹配且 Editor Skill 已启用时，Agent K 会把格式、路径和 manifest 声明的能力加入下一条用户消息的 Pi 上下文。`agent_k_file_editor` 始终提供内置 `open` 动作，可按工作区路径在右侧打开文件；HTML 和 Markdown 可额外传入 `preview: true` 显示预览。Pi 还可调用当前插件在 manifest 中声明的能力。

## 不兼容旧注释格式

旧版在 `editor.ts` 的 `/* agent-k-file-format ... */` 注释中嵌入 JSON 的格式不会被扫描、解析或降级加载。插件必须迁移为独立 `editor.json`；可编程 UI 必须同时提供已构建 runtime。这样 `editor.ts` 的含义始终只有一个：真正的插件源代码。
