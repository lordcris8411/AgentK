# Agent K 文件格式 SDK（v1）

文件格式插件放在任一 Pi skill 目录内，并且必须同时包含：

```text
my-format/
├── SKILL.md
└── editor.ts
```

`SKILL.md` 是 Pi 的正常 skill：它说明格式的用途、何时使用，以及可调用的 `agent_k_file_editor` 能力。

`editor.ts` 目前是受限的声明式编辑器描述。Agent K 不会执行第三方 TypeScript；这样插件无法改写文件树、替换内置右键菜单或取得桌面进程权限。将 JSON 放在以下注释中：

```ts
/* agent-k-file-format
{
  "id": "example.audio-notes",
  "name": "Audio notes",
  "match": { "extensions": ["note-audio"], "fileNames": ["recording"] },
  "editor": "media",
  "mediaKind": "audio",
  "mimeType": "audio/mpeg",
  "capabilities": [
    { "id": "play", "label": "播放", "description": "播放当前文件" },
    { "id": "pause", "label": "暂停", "description": "暂停当前文件" },
    { "id": "seek", "label": "跳转", "description": "按秒数移动播放位置" }
  ],
  "contextActions": [
    { "id": "show-metadata", "label": "显示元数据", "when": "file" }
  ]
}
*/
```

支持的 `editor` 是 `text`、`markdown`、`html`、`media` 和 `unsupported`。`media` 必须同时指定 `mediaKind`（`image`、`audio`、`video` 或 `pdf`）。匹配先按项目插件、用户插件、内置插件的顺序处理。

`contextActions` 只会附加在 Agent K 既有菜单项之后，不能删除、排序、替换或拦截任何内置项目。能力会随当前打开的文件作为上下文提供给 Pi；Pi 使用 `agent_k_file_editor` 调用能力。当前内置音频和视频插件已实现 `play`、`pause` 与 `seek`。

## 字段参考

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 2–81 个字符的稳定标识；仅允许字母、数字、`.`、`_`、`-`。项目插件可覆盖同 ID 的用户插件。 |
| `name` | 是 | 设置或诊断中使用的显示名称。 |
| `match.extensions` | 至少一项匹配规则 | 不带点的小写扩展名列表，例如 `"mp3"`。 |
| `match.fileNames` | 至少一项匹配规则 | 精确文件名列表；匹配时不区分大小写，例如 `"Dockerfile"`。 |
| `editor` | 是 | `text`、`markdown`、`html`、`media` 或 `unsupported`。 |
| `editable` | 否 | 仅 `true` 时允许宿主文本编辑器写回文件。 |
| `monacoLanguage` | 否 | 文本编辑器使用的 Monaco 语言 ID。 |
| `mediaKind` | `editor: "media"` 时必填 | `image`、`audio`、`video` 或 `pdf`。 |
| `mimeType` | 否 | 自定义扩展名的媒体 MIME 类型；例如 `audio/mpeg`。 |
| `capabilities` | 否 | Pi 可调用的能力。每项包含 `id`、`label`、`description`；内置媒体编辑器支持 `play`、`pause`、`seek`。 |
| `contextActions` | 否 | 仅追加到现有右键菜单末尾的动作；`when` 可为 `file`、`directory`、`both`。 |

## Pi 调用约定

仅当当前右侧文件与插件匹配、且插件声明了能力时，Agent K 才会在下一条用户消息中把能力列表加入 Pi 上下文。Pi 使用 `agent_k_file_editor` 工具：

```text
action: "play" | "pause" | "seek"
path: 当前上下文公布的文件路径（可选，但建议传入）
seconds: seek 时的秒数；正数前进、负数后退
```

宿主会忽略没有活动编辑器的请求、不匹配当前文件路径的请求及未实现的动作。第三方声明的能力目前只作为上下文契约；只有 Agent K 已实现的宿主编辑器动作才可执行。

## 安全与兼容性

- `editor.ts` 最大为 64 KiB，必须包含上述 JSON 注释；其他 TypeScript 内容不会被执行或解析。
- 不允许插件获得 Node.js、Electron IPC、文件系统、进程或网络权限。
- 无法解析的 manifest 会被忽略，不影响 Pi Skill 的正常加载或其他格式插件。
- 格式插件只改变右侧编辑器选择与菜单追加项；不改变现有文件树、保存、重命名、删除、导入或“在外部控制台中打开目录”的行为。
