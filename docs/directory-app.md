# Directory previews and k-apps

Selecting a directory in Agent K opens the first matching direct child, in this
order: a k-app's `app.html`/`app.htm`, `index.html`, `index.htm`, then
`README.md`. An `app.html`/`app.htm` without `config.k` is not previewed.
`icon.png`, `icon.svg`, or `icon.webp` replaces the directory icon in the file
tree, using that same order.

A directory containing both `app.html`/`app.htm` and `config.k` is a **k-app**.
Its app page runs sandboxed, without the website-preview toolbar, and can use
the asynchronous `window.AgentK` API:

```js
const files = await AgentK.files.list(".");
const settings = await AgentK.files.read("settings.json");
await AgentK.files.write("result.txt", "done");
await AgentK.pi.send("Please inspect the result produced by this directory app.");
const task = await AgentK.processes.start("node", ["scripts/task.mjs"]);
const completion = await AgentK.processes.wait(task.id);
const output = await AgentK.processes.output(task.id);
await AgentK.processes.stop(task.id);
await AgentK.processes.open("taskmgr.exe");
const theme = await AgentK.theme.get();
const unsubscribe = AgentK.theme.onChange((nextTheme) => applyTheme(nextTheme));
```

File paths are relative to the selected directory. Absolute paths and `..`
segments are rejected. `files.read` and `files.write` handle UTF-8 text;
ordinary relative image, stylesheet, script, and media URLs are served by the
workspace preview server. `pi.send` queues a visible message in the active
Agent K conversation and resolves after the message is accepted.

`theme.get()` returns the complete normalized definition of the currently
resolved Agent K theme, including UI colors, component colors, fonts, Monaco
colors, and terminal colors. `theme.onChange(listener)` reports later theme
changes and returns an unsubscribe function. A k-app should read once at startup
and subscribe so it follows both explicit theme changes and system light/dark
changes without reloading.

`processes.start(command, args, { cwd })` starts a shell-free child process;
`cwd` must stay inside the k-app. `processes.list()`, `status(id)`,
`wait(id)`, `output(id, cursors)`, and `stop(id)` manage only processes owned
by that k-app. `wait` resolves once with `successful`, `exitCode`, and `signal`;
a process ending after a successful start is an exit result, not a second
rejection of the already-resolved `start()` promise.
Output is bounded and read incrementally using the returned stdout/stderr cursors.
All managed processes are stopped when Agent K exits.

Use `processes.open(target)` for GUI, shell-integrated, and single-instance
applications. On Windows it uses ShellExecute semantics and is intentionally
unmanaged: it has no PID/output/stop handle and Agent K will not terminate it.
This includes Chrome and other browsers, whose newly created launcher process
may immediately hand work to an existing browser instance and exit normally.
`explorer.exe`, `explore.exe`, and `taskmgr.exe` are rejected by
`processes.start()` to prevent Windows shell abort/restart behavior.

`config.k` is UTF-8 JSON containing `schemaVersion`, `name`, `author`,
`functionality`, `version`, `reserved`, and `settings`. A k-app may also be a
language project; the language pack and k-app contributions remain independent.

An `app.html` or `app.htm` without `config.k` is ignored as a directory preview.
`index.html` and `index.htm` remain website previews without the Agent K API;
`README.md` uses the normal Markdown preview.
