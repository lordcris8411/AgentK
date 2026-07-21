use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

const AGENT_K_PERMISSION_EXTENSION: &str = include_str!("../../../agent-k-permissions.ts");

pub(crate) fn pi_process_command(executable: &Path) -> Command {
    #[cfg(target_os = "windows")]
    {
        let extension = executable.extension().and_then(|value| value.to_str());
        if extension.is_none() || matches!(extension, Some("cmd" | "bat")) {
            let mut command = Command::new("cmd.exe");
            command.args(["/D", "/S", "/C"]).arg(executable);
            return command;
        }
    }
    Command::new(executable)
}

fn pi_agent_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .map(|home| home.join(".pi").join("agent"))
}

fn npm_dependency_names(value: &Value) -> Vec<String> {
    let mut names = value
        .get("dependencies")
        .and_then(Value::as_object)
        .map(|dependencies| dependencies.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    names.sort();
    names
}

/// Packages installed through Pi live in a small npm project under
/// `~/.pi/agent/npm`. Agent K supplies its permission extension through the
/// CLI, so also pass every installed top-level package explicitly. This keeps
/// packages usable even when an older/manual npm installation has not yet
/// added the newer `packages` array to Pi's settings.json.
fn installed_pi_package_paths() -> Vec<PathBuf> {
    let Some(agent_dir) = pi_agent_dir() else {
        return Vec::new();
    };
    let npm_dir = agent_dir.join("npm");
    let package_json = npm_dir.join("package.json");
    let Some(manifest) = fs::read_to_string(package_json)
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
    else {
        return Vec::new();
    };
    npm_dependency_names(&manifest)
        .into_iter()
        .map(|name| npm_dir.join("node_modules").join(name))
        .filter(|path| path.exists())
        .collect()
}

pub struct RpcBridge {
    runtime_id: String,
    session_file: Arc<Mutex<Option<String>>>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>,
    sequence: Mutex<u64>,
    child: Mutex<Child>,
    closed: Arc<AtomicBool>,
    agent_running: Arc<AtomicBool>,
    in_flight: Arc<AtomicUsize>,
    pending_ui: Arc<Mutex<std::collections::HashSet<String>>>,
    reserved: AtomicBool,
    retire_on_idle: AtomicBool,
    last_used: Mutex<Instant>,
    workspace_cwd: Mutex<PathBuf>,
}

struct InFlightGuard(Arc<AtomicUsize>);

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl RpcBridge {
    pub fn start(
        app: AppHandle,
        executable: &Path,
        cwd: &Path,
        runtime_id: String,
    ) -> Result<Self, String> {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        fs::create_dir_all(&app_data).map_err(|error| error.to_string())?;
        let extension = app_data.join("agent-k-permissions.ts");
        let extension_needs_write = fs::read_to_string(&extension)
            .map(|contents| contents != AGENT_K_PERMISSION_EXTENSION)
            .unwrap_or(true);
        if extension_needs_write {
            fs::write(&extension, AGENT_K_PERMISSION_EXTENSION).map_err(|error| {
                format!("failed to install Agent K permission extension: {error}")
            })?;
        }
        let mut command = pi_process_command(executable);
        command
            .args(["--mode", "rpc"])
            .arg("--extension")
            .arg(extension);
        for package_path in installed_pi_package_paths() {
            command.arg("--extension").arg(package_path);
        }
        let mut child = command
            .env(
                "AGENT_K_SETTINGS_PATH",
                app_data.join("client-settings.json"),
            )
            .env(
                "AGENT_K_PERMISSION_STATE_PATH",
                app_data.join("permission-state.json"),
            )
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                format!(
                    "Unable to start Pi RPC from '{}': {error}. Install Pi or set AGENT_K_PI_EXECUTABLE",
                    executable.display()
                )
            })?;
        let stdin = child.stdin.take().ok_or("Pi RPC stdin is unavailable")?;
        let stdout = child.stdout.take().ok_or("Pi RPC stdout is unavailable")?;
        let stderr = child.stderr.take().ok_or("Pi RPC stderr is unavailable")?;
        let pending = Arc::new(Mutex::new(HashMap::<String, mpsc::Sender<Value>>::new()));
        let reader_pending = pending.clone();
        let closed = Arc::new(AtomicBool::new(false));
        let reader_closed = closed.clone();
        let reader_runtime_id = runtime_id.clone();
        let session_file = Arc::new(Mutex::new(None));
        let reader_session_file = session_file.clone();
        let agent_running = Arc::new(AtomicBool::new(false));
        let reader_agent_running = agent_running.clone();
        let pending_ui = Arc::new(Mutex::new(std::collections::HashSet::<String>::new()));
        let reader_pending_ui = pending_ui.clone();
        let event_cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(mut value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let reported_session = value
                    .get("sessionFile")
                    .and_then(Value::as_str)
                    .or_else(|| {
                        value
                            .get("data")
                            .and_then(|data| data.get("sessionFile"))
                            .and_then(Value::as_str)
                    })
                    .map(str::to_string);
                if let Some(path) = reported_session {
                    if let Ok(mut current) = reader_session_file.lock() {
                        *current = Some(path);
                    }
                }
                if let Some(id) = value.get("id").and_then(Value::as_str) {
                    if let Some(sender) = reader_pending
                        .lock()
                        .ok()
                        .and_then(|mut items| items.remove(id))
                    {
                        let _ = sender.send(value);
                        continue;
                    }
                }
                match value.get("type").and_then(Value::as_str) {
                    Some("agent_start") => reader_agent_running.store(true, Ordering::SeqCst),
                    Some("agent_settled") => reader_agent_running.store(false, Ordering::SeqCst),
                    Some("extension_ui_request") => {
                        if matches!(
                            value.get("method").and_then(Value::as_str),
                            Some("select" | "confirm" | "input" | "editor")
                        ) {
                            if let Some(id) = value.get("id").and_then(Value::as_str) {
                                if let Ok(mut requests) = reader_pending_ui.lock() {
                                    requests.insert(id.to_string());
                                }
                            }
                        }
                    }
                    _ => {}
                }
                enrich_file_tool_start(&mut value, &event_cwd);
                if let Some(event) = value.as_object_mut() {
                    event.insert("runtimeId".into(), Value::String(reader_runtime_id.clone()));
                }
                let _ = app.emit("pi-rpc-event", value);
            }
            // `stop()` marks a bridge closed before terminating its child.
            // That is an intentional hand-off (for example when deleting the
            // active session and preparing a fresh draft), not a connection
            // failure. Only report EOF when the bridge was still considered
            // live; otherwise an obsolete reader can poison the new session's
            // UI with a false "connection closed" error.
            let was_already_closed = reader_closed.swap(true, Ordering::SeqCst);
            if !was_already_closed {
                let _ = app.emit(
                    "pi-rpc-event",
                    json!({"type": "bridge_closed", "runtimeId": reader_runtime_id}),
                );
            }
        });
        // Extensions may write diagnostics to stderr. Always drain it so a full
        // OS pipe cannot stall the child process and, in turn, RPC responses.
        std::thread::spawn(move || for _ in BufReader::new(stderr).lines() {});
        Ok(Self {
            runtime_id,
            session_file,
            stdin: Mutex::new(Some(stdin)),
            pending,
            sequence: Mutex::new(0),
            child: Mutex::new(child),
            closed,
            agent_running,
            in_flight: Arc::new(AtomicUsize::new(0)),
            pending_ui,
            reserved: AtomicBool::new(false),
            retire_on_idle: AtomicBool::new(false),
            last_used: Mutex::new(Instant::now()),
            workspace_cwd: Mutex::new(cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf())),
        })
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    pub fn runtime_id(&self) -> &str {
        &self.runtime_id
    }

    pub fn session_file(&self) -> Option<String> {
        self.session_file.lock().ok().and_then(|path| path.clone())
    }

    pub fn set_session_file(&self, path: Option<String>) {
        if let Ok(mut current) = self.session_file.lock() {
            *current = path;
        }
        self.touch();
    }

    pub fn workspace_matches(&self, cwd: &Path) -> bool {
        let wanted = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
        self.workspace_cwd
            .lock()
            .map(|current| *current == wanted)
            .unwrap_or(false)
    }

    pub fn workspace_cwd(&self) -> Result<PathBuf, String> {
        self.workspace_cwd
            .lock()
            .map(|cwd| cwd.clone())
            .map_err(|_| "RPC workspace lock failed".into())
    }

    pub fn set_workspace_cwd(&self, cwd: &Path) {
        if let Ok(mut current) = self.workspace_cwd.lock() {
            *current = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
        }
        self.touch();
    }

    pub fn is_available(&self) -> bool {
        !self.is_closed()
            && !self.reserved.load(Ordering::SeqCst)
            && !self.agent_running.load(Ordering::SeqCst)
            && self.in_flight.load(Ordering::SeqCst) == 0
            && self
                .pending_ui
                .lock()
                .map(|requests| requests.is_empty())
                .unwrap_or(false)
    }

    pub fn try_reserve(&self) -> bool {
        self.is_available()
            && self
                .reserved
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
    }

    pub fn release_reservation(&self) {
        self.reserved.store(false, Ordering::SeqCst);
        self.touch();
    }

    pub fn mark_retire_on_idle(&self, retire: bool) {
        self.retire_on_idle.store(retire, Ordering::SeqCst);
    }

    pub fn should_retire(&self) -> bool {
        self.retire_on_idle.load(Ordering::SeqCst)
    }

    pub fn idle_for(&self) -> Duration {
        self.last_used
            .lock()
            .map(|last_used| last_used.elapsed())
            .unwrap_or_default()
    }

    pub fn touch(&self) {
        if let Ok(mut last_used) = self.last_used.lock() {
            *last_used = Instant::now();
        }
    }

    pub fn stop(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Ok(mut stdin) = self.stdin.lock() {
            stdin.take();
        }
        if let Ok(mut child) = self.child.lock() {
            #[cfg(target_os = "windows")]
            {
                // PowerShell launches tsx.cmd, which in turn launches Node.
                // Child::kill() only terminates the PowerShell parent and
                // leaves the actual Pi RPC process orphaned. taskkill /T keeps
                // pool shrink/reaping aligned with real memory usage.
                let _ = Command::new("taskkill.exe")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            #[cfg(not(target_os = "windows"))]
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    pub fn request(&self, mut command: Value) -> Result<Value, String> {
        if self.is_closed() {
            return Err("Pi RPC connection is closed; reconnect and try again".into());
        }
        // Pi acknowledges `prompt` as soon as prompt preflight succeeds, while
        // `agent_start` is emitted slightly later. Without occupying the
        // worker here, a quick UI session switch can reserve this bridge in
        // that gap and `switch_session` will abort the turn that just started.
        // Keep it unavailable synchronously until the authoritative
        // `agent_settled` event arrives.
        let starts_agent = command_starts_agent(&command);
        if starts_agent {
            self.agent_running.store(true, Ordering::SeqCst);
        }
        self.touch();
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        let _in_flight = InFlightGuard(self.in_flight.clone());
        let id = {
            let mut sequence = self
                .sequence
                .lock()
                .map_err(|_| "RPC sequence lock failed")?;
            *sequence += 1;
            format!("desktop-{}", *sequence)
        };
        command["id"] = Value::String(id.clone());
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| "RPC pending lock failed")?
            .insert(id.clone(), sender);
        let encoded = format!(
            "{}\n",
            serde_json::to_string(&command).map_err(|error| error.to_string())?
        );
        let write_result = self
            .stdin
            .lock()
            .map_err(|_| "RPC stdin lock failed")?
            .as_mut()
            .ok_or("Pi RPC connection is closed; reconnect and try again")?
            .write_all(encoded.as_bytes());
        if let Err(error) = write_result {
            self.pending.lock().ok().map(|mut items| items.remove(&id));
            if starts_agent {
                self.agent_running.store(false, Ordering::SeqCst);
            }
            if error.kind() == std::io::ErrorKind::BrokenPipe {
                self.closed.store(true, Ordering::SeqCst);
                return Err(
                    "Pi RPC connection closed while sending the request; reconnect and try again"
                        .into(),
                );
            }
            return Err(format!("Unable to send Pi RPC request: {error}"));
        }
        let timeout = match command.get("type").and_then(Value::as_str) {
            Some("switch_session") => 90,
            _ => 30,
        };
        let response = receiver
            .recv_timeout(std::time::Duration::from_secs(timeout))
            .map_err(|error| {
                self.pending.lock().ok().map(|mut items| items.remove(&id));
                format!("Pi RPC request timed out: {error}")
            });
        // A rejected preflight never produces an agent lifecycle, so release
        // the optimistic busy latch. On timeout we deliberately remain busy:
        // the prompt may have reached Pi and reusing this worker would be more
        // destructive than temporarily keeping it out of the idle pool.
        if starts_agent
            && matches!(
                &response,
                Ok(value) if value.get("success").and_then(Value::as_bool) == Some(false)
            )
        {
            self.agent_running.store(false, Ordering::SeqCst);
        }
        response
    }

    pub fn send_notification(&self, command: &Value) -> Result<(), String> {
        if self.is_closed() {
            return Err("Pi RPC connection is closed; reconnect and try again".into());
        }
        self.touch();
        if command.get("type").and_then(Value::as_str) == Some("extension_ui_response") {
            if let Some(id) = command.get("id").and_then(Value::as_str) {
                if let Ok(mut requests) = self.pending_ui.lock() {
                    requests.remove(id);
                }
            }
        }
        let encoded = format!(
            "{}\n",
            serde_json::to_string(command).map_err(|error| error.to_string())?
        );
        self.stdin
            .lock()
            .map_err(|_| "RPC stdin lock failed")?
            .as_mut()
            .ok_or("Pi RPC connection is closed; reconnect and try again")?
            .write_all(encoded.as_bytes())
            .map_err(|error| format!("Unable to send Pi RPC notification: {error}"))
    }
}

fn command_starts_agent(command: &Value) -> bool {
    command.get("type").and_then(Value::as_str) == Some("prompt")
}

#[cfg(test)]
mod tests {
    use super::{command_starts_agent, npm_dependency_names};
    use serde_json::json;

    #[test]
    fn prompt_occupies_worker_before_agent_start_event() {
        assert!(command_starts_agent(&json!({ "type": "prompt" })));
        assert!(!command_starts_agent(&json!({ "type": "switch_session" })));
        assert!(!command_starts_agent(&json!({ "type": "get_messages" })));
    }

    #[test]
    fn installed_pi_packages_are_loaded_in_stable_order() {
        assert_eq!(
            npm_dependency_names(&json!({
                "dependencies": {
                    "pi-research": "^1.5.1",
                    "@agent-k/k-plan": "file:./k-plan"
                }
            })),
            vec!["@agent-k/k-plan", "pi-research"]
        );
    }
}

impl Drop for RpcBridge {
    fn drop(&mut self) {
        self.stop();
    }
}

fn enrich_file_tool_start(value: &mut Value, cwd: &Path) {
    if value.get("type").and_then(Value::as_str) != Some("tool_execution_start") {
        return;
    }
    let tool = value
        .get("toolName")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if tool != "write" && tool != "edit" {
        return;
    }
    let Some(raw_path) = value
        .get("args")
        .and_then(|args| args.get("path"))
        .and_then(Value::as_str)
    else {
        return;
    };
    let supplied = PathBuf::from(raw_path);
    let target = if supplied.is_absolute() {
        supplied
    } else {
        cwd.join(supplied)
    };
    let resolved = target.canonicalize().unwrap_or(target);
    if !resolved.starts_with(cwd) {
        return;
    }
    let old_content = fs::read_to_string(&resolved).ok();
    if let Some(args) = value.get_mut("args").and_then(Value::as_object_mut) {
        args.insert("fileExisted".into(), Value::Bool(old_content.is_some()));
        if let Some(content) = old_content {
            args.insert("oldContent".into(), Value::String(content));
        }
    }
}
