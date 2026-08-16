# k-app format and API

A directory is a k-app when its direct children include `config.k` and either
`app.html` or `app.htm` (case-insensitive). `app.html` wins when both exist.
An optional `icon.png`, `icon.svg`, or `icon.webp` supplies its file-tree icon.

`config.k` is UTF-8 JSON:

```json
{
  "schemaVersion": 1,
  "name": "Project tools",
  "author": "Example author",
  "functionality": "Inspect project files and ask Pi for help.",
  "version": "0.1.0",
  "reserved": {},
  "settings": {}
}
```

- `schemaVersion` must be `1`.
- `name`, `author`, and `functionality` must be non-empty strings.
- `version` must be a three-part semantic version, optionally with prerelease or build metadata.
- `reserved` is for future host-defined values. Preserve unknown keys.
- `settings` contains user-controlled, non-secret JSON values. Preserve unknown keys.

The sandboxed page receives this asynchronous API:

```js
await AgentK.files.list(".");
await AgentK.files.read("data/settings.json");
await AgentK.files.write("output/result.txt", "done");
await AgentK.pi.send("Please review output/result.txt");
const task = await AgentK.processes.start("node", ["scripts/task.mjs"], { cwd: "." });
const completion = await AgentK.processes.wait(task.id);
const output = await AgentK.processes.output(task.id);
await AgentK.processes.stop(task.id);
await AgentK.processes.open("taskmgr.exe");
const theme = await AgentK.theme.get();
const unsubscribe = AgentK.theme.onChange((nextTheme) => applyTheme(nextTheme));
```

Every file path is relative to the k-app directory. Absolute paths and `..`
segments are rejected. File methods operate on UTF-8 text. `pi.send` queues a
visible message in the current conversation. Handle rejected promises and show
errors in the app UI.

Theme API:

- `theme.get()` returns the complete normalized current theme definition. It
  contains `id`, `name`, `base`, `colors`, `components`, optional `fonts`,
  `monaco`, optional `monacoSyntax`, and `terminal`, matching the active Agent K
  theme file. When Agent K follows the operating system, it returns the resolved
  built-in light or dark theme rather than the literal `system` setting.
- `theme.onChange(listener)` calls `listener(theme)` after the active theme
  changes and returns an unsubscribe function. Call `theme.get()` once during
  startup, then subscribe for later changes. Theme definitions are data only;
  copy the colors you use into CSS custom properties instead of modifying them.

Process API:

- `processes.start(command, args = [], { cwd = "." })` starts without a shell.
- `processes.list()` and `processes.status(id)` return app-owned process state.
- `processes.wait(id)` resolves when the process ends and reports `successful`,
  `exitCode`, and `signal`. A later exit cannot reject the completed start call.
- `processes.output(id, { stdoutCursor, stderrCursor })` returns bounded output
  after the supplied cursors and the next cursors.
- `processes.stop(id)` stops an app-owned process.
- `processes.open(target)` uses the operating-system shell to open or activate a
  GUI/single-instance app. It is not tracked and cannot provide output or stop.

The working directory must exist inside the k-app directory. Pass every command
argument separately; never concatenate untrusted input into a shell command.
On Windows, open Explorer and Task Manager with `processes.open`; the managed
start API rejects them so Agent K cannot accidentally terminate the system shell.
Use the same open API for Chrome and other GUI applications that hand off to an
existing instance; use managed start only for processes whose PID represents
the task lifecycle that the k-app intends to observe and stop.

The page does not receive Node.js, Electron, a shell, or unrestricted filesystem
access. It may use relative scripts, styles, images, and media served by Agent
K's preview server and may manage only processes created through its host API.
