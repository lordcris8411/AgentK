mod agent;

use agent::rpc::{pi_process_command, RpcBridge};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

struct DesktopState {
    rpcs: Mutex<HashMap<String, Arc<RpcBridge>>>,
    active_rpc: Mutex<Option<String>>,
    minimum_workers: AtomicUsize,
    starting_workers: AtomicUsize,
    pool_cwd: Mutex<Option<String>>,
    hidden_sessions: Mutex<HashSet<String>>,
    file_indexes: Arc<Mutex<HashMap<String, (Instant, Arc<Vec<String>>)>>>,
    preview_server: Mutex<Option<PreviewServer>>,
}

struct PreviewServer {
    port: u16,
    token: String,
    config: Arc<Mutex<PreviewConfig>>,
}

struct PreviewConfig {
    root: PathBuf,
    overrides: HashMap<PathBuf, Vec<u8>>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ClientSettings {
    version: u8,
    theme: String,
    locale: String,
    permission_mode: String,
    browser_id: String,
    worker_pool_size: u8,
    left_panel_width: u16,
    right_panel_width: u16,
    left_panel_hidden: bool,
    right_panel_hidden: bool,
    window_width: u16,
    window_height: u16,
    window_maximized: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    pi_version: String,
    operating_system: String,
    architecture: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BrowserOption {
    id: String,
    name: String,
}

#[derive(Clone)]
struct DetectedBrowser {
    id: String,
    name: String,
    executable: PathBuf,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LocalServiceInfo {
    kind: String,
    display_name: String,
}

#[tauri::command]
async fn get_runtime_info() -> RuntimeInfo {
    tauri::async_runtime::spawn_blocking(|| {
        let pi_version = pi_process_command(&pi_executable())
            .arg("--version")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .filter(|version| !version.is_empty())
            .unwrap_or_else(|| "unknown".into());
        RuntimeInfo {
            pi_version,
            operating_system: std::env::consts::OS.into(),
            architecture: std::env::consts::ARCH.into(),
        }
    })
    .await
    .unwrap_or_else(|_| RuntimeInfo {
        pi_version: "unknown".into(),
        operating_system: std::env::consts::OS.into(),
        architecture: std::env::consts::ARCH.into(),
    })
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PartialClientSettings {
    version: Option<u8>,
    theme: Option<String>,
    locale: Option<String>,
    permission_mode: Option<String>,
    browser_id: Option<String>,
    worker_pool_size: Option<u8>,
    left_panel_width: Option<u16>,
    right_panel_width: Option<u16>,
    left_panel_hidden: Option<bool>,
    right_panel_hidden: Option<bool>,
    window_width: Option<u16>,
    window_height: Option<u16>,
    window_maximized: Option<bool>,
}

impl Default for ClientSettings {
    fn default() -> Self {
        Self {
            version: 3,
            theme: "light".into(),
            locale: "zh-CN".into(),
            permission_mode: "ask".into(),
            browser_id: "default".into(),
            worker_pool_size: 4,
            left_panel_width: 304,
            right_panel_width: 420,
            left_panel_hidden: false,
            right_panel_hidden: false,
            window_width: 1600,
            window_height: 920,
            window_maximized: false,
        }
    }
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProviderDraft {
    id: String,
    name: String,
    base_url: String,
    api: String,
    #[allow(dead_code)]
    api_key: String,
    models: Vec<String>,
    local: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProviderCatalogItem {
    id: String,
    name: String,
    base_url: Option<String>,
    api: Option<String>,
    source: String,
    configured: bool,
    auth_methods: Vec<String>,
    models: Vec<ProviderModel>,
}

#[derive(Serialize, Clone)]
struct ProviderModel {
    id: String,
    name: Option<String>,
}

fn parse_client_settings(text: &str) -> ClientSettings {
    let partial = serde_json::from_str::<PartialClientSettings>(text).unwrap_or_default();
    let mut settings = ClientSettings::default();
    if matches!(partial.theme.as_deref(), Some("light" | "dark" | "system")) {
        settings.theme = partial.theme.unwrap_or(settings.theme);
    }
    if matches!(partial.locale.as_deref(), Some("zh-CN" | "en-US")) {
        settings.locale = partial.locale.unwrap_or(settings.locale);
    }
    if matches!(partial.permission_mode.as_deref(), Some("ask" | "full")) {
        settings.permission_mode = partial.permission_mode.unwrap_or(settings.permission_mode);
    }
    if let Some(browser_id) = partial.browser_id.filter(|value| {
        !value.is_empty()
            && value.len() <= 64
            && value.chars().all(|character| {
                character.is_ascii_alphanumeric() || character == '-' || character == '_'
            })
    }) {
        settings.browser_id = browser_id;
    }
    if let Some(worker_pool_size) = partial
        .worker_pool_size
        .filter(|value| (2..=4).contains(value))
    {
        settings.worker_pool_size = worker_pool_size;
    }
    if let Some(left_panel_width) = partial
        .left_panel_width
        .filter(|value| (240..=2400).contains(value))
    {
        settings.left_panel_width = left_panel_width;
    }
    if let Some(right_panel_width) = partial
        .right_panel_width
        .filter(|value| (420..=3200).contains(value))
    {
        settings.right_panel_width = right_panel_width;
    }
    settings.left_panel_hidden = partial
        .left_panel_hidden
        .unwrap_or(settings.left_panel_hidden);
    settings.right_panel_hidden = partial
        .right_panel_hidden
        .unwrap_or(settings.right_panel_hidden);
    if let Some(window_width) = partial
        .window_width
        .filter(|value| (1452..=16384).contains(value))
    {
        settings.window_width = window_width;
    }
    if let Some(window_height) = partial
        .window_height
        .filter(|value| (640..=16384).contains(value))
    {
        settings.window_height = window_height;
    }
    settings.window_maximized = partial
        .window_maximized
        .unwrap_or(settings.window_maximized);
    settings.version = partial
        .version
        .unwrap_or(settings.version)
        .max(settings.version);
    settings
}

fn validate_client_settings(settings: &ClientSettings) -> bool {
    matches!(settings.theme.as_str(), "light" | "dark" | "system")
        && matches!(settings.locale.as_str(), "zh-CN" | "en-US")
        && matches!(settings.permission_mode.as_str(), "ask" | "full")
        && !settings.browser_id.is_empty()
        && settings.browser_id.len() <= 64
        && settings.browser_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
        && (2..=4).contains(&settings.worker_pool_size)
        && (240..=2400).contains(&settings.left_panel_width)
        && (420..=3200).contains(&settings.right_panel_width)
        && (1452..=16384).contains(&settings.window_width)
        && (640..=16384).contains(&settings.window_height)
}

#[cfg(target_os = "windows")]
fn detected_browsers() -> Vec<DetectedBrowser> {
    let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from);
    let program_files_x86 = std::env::var_os("ProgramFiles(x86)").map(PathBuf::from);
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let mut candidates: Vec<(&str, &str, Vec<PathBuf>)> = vec![
        (
            "edge",
            "Microsoft Edge",
            [
                program_files_x86
                    .as_ref()
                    .map(|root| root.join("Microsoft/Edge/Application/msedge.exe")),
                program_files
                    .as_ref()
                    .map(|root| root.join("Microsoft/Edge/Application/msedge.exe")),
            ]
            .into_iter()
            .flatten()
            .collect(),
        ),
        (
            "chrome",
            "Google Chrome",
            [
                program_files
                    .as_ref()
                    .map(|root| root.join("Google/Chrome/Application/chrome.exe")),
                program_files_x86
                    .as_ref()
                    .map(|root| root.join("Google/Chrome/Application/chrome.exe")),
                local_app_data
                    .as_ref()
                    .map(|root| root.join("Google/Chrome/Application/chrome.exe")),
            ]
            .into_iter()
            .flatten()
            .collect(),
        ),
        (
            "firefox",
            "Mozilla Firefox",
            [
                program_files
                    .as_ref()
                    .map(|root| root.join("Mozilla Firefox/firefox.exe")),
                program_files_x86
                    .as_ref()
                    .map(|root| root.join("Mozilla Firefox/firefox.exe")),
            ]
            .into_iter()
            .flatten()
            .collect(),
        ),
        (
            "brave",
            "Brave",
            [
                program_files
                    .as_ref()
                    .map(|root| root.join("BraveSoftware/Brave-Browser/Application/brave.exe")),
                program_files_x86
                    .as_ref()
                    .map(|root| root.join("BraveSoftware/Brave-Browser/Application/brave.exe")),
                local_app_data
                    .as_ref()
                    .map(|root| root.join("BraveSoftware/Brave-Browser/Application/brave.exe")),
            ]
            .into_iter()
            .flatten()
            .collect(),
        ),
        (
            "vivaldi",
            "Vivaldi",
            [
                local_app_data
                    .as_ref()
                    .map(|root| root.join("Vivaldi/Application/vivaldi.exe")),
                program_files
                    .as_ref()
                    .map(|root| root.join("Vivaldi/Application/vivaldi.exe")),
            ]
            .into_iter()
            .flatten()
            .collect(),
        ),
        (
            "opera",
            "Opera",
            [local_app_data
                .as_ref()
                .map(|root| root.join("Programs/Opera/opera.exe"))]
            .into_iter()
            .flatten()
            .collect(),
        ),
    ];
    candidates
        .drain(..)
        .filter_map(|(id, name, paths)| {
            paths
                .into_iter()
                .find(|path| path.is_file())
                .map(|executable| DetectedBrowser {
                    id: id.into(),
                    name: name.into(),
                    executable,
                })
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn detected_browsers() -> Vec<DetectedBrowser> {
    [
        (
            "safari",
            "Safari",
            "/Applications/Safari.app/Contents/MacOS/Safari",
        ),
        (
            "chrome",
            "Google Chrome",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ),
        (
            "firefox",
            "Mozilla Firefox",
            "/Applications/Firefox.app/Contents/MacOS/firefox",
        ),
        (
            "brave",
            "Brave",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ),
    ]
    .into_iter()
    .filter_map(|(id, name, path)| {
        let executable = PathBuf::from(path);
        executable.is_file().then(|| DetectedBrowser {
            id: id.into(),
            name: name.into(),
            executable,
        })
    })
    .collect()
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn detected_browsers() -> Vec<DetectedBrowser> {
    [
        ("chrome", "Google Chrome", "google-chrome"),
        ("chromium", "Chromium", "chromium"),
        ("firefox", "Mozilla Firefox", "firefox"),
        ("brave", "Brave", "brave-browser"),
    ]
    .into_iter()
    .filter_map(|(id, name, command)| {
        let output = std::process::Command::new("which")
            .arg(command)
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let executable = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
        Some(DetectedBrowser {
            id: id.into(),
            name: name.into(),
            executable,
        })
    })
    .collect()
}

#[tauri::command]
async fn list_browsers() -> Vec<BrowserOption> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut browsers = vec![BrowserOption {
            id: "default".into(),
            name: "System default".into(),
        }];
        browsers.extend(
            detected_browsers()
                .into_iter()
                .map(|browser| BrowserOption {
                    id: browser.id,
                    name: browser.name,
                }),
        );
        browsers
    })
    .await
    .unwrap_or_else(|_| {
        vec![BrowserOption {
            id: "default".into(),
            name: "System default".into(),
        }]
    })
}

#[tauri::command]
fn open_external_url(app: AppHandle, url: String, browser_id: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|error| error.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only HTTP(S) links can be opened".into());
    }
    if browser_id == "default" {
        return app
            .opener()
            .open_url(url, None::<String>)
            .map_err(|error| error.to_string());
    }
    let browser = detected_browsers()
        .into_iter()
        .find(|browser| browser.id == browser_id)
        .ok_or_else(|| "Selected browser is not installed".to_string())?;
    std::process::Command::new(browser.executable)
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn client_settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("client-settings.json"))
}

fn permission_state_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("permission-state.json"))
}

#[tauri::command]
fn set_session_permission(app: AppHandle, session_id: String, allowed: bool) -> Result<(), String> {
    let path = permission_state_file(&app)?;
    let mut grants = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<BTreeSet<String>>(&text).ok())
        .unwrap_or_default();
    if allowed {
        grants.insert(session_id);
    } else {
        grants.remove(&session_id);
    }
    let bytes = serde_json::to_vec(&grants).map_err(|error| error.to_string())?;
    atomic_write(&path, &bytes)
}

fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_client_settings(app: AppHandle) -> ClientSettings {
    client_settings_file(&app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|text| parse_client_settings(&text))
        .unwrap_or_default()
}

#[tauri::command]
fn save_client_settings(
    app: AppHandle,
    settings: ClientSettings,
) -> Result<ClientSettings, String> {
    if !validate_client_settings(&settings) {
        return Err("Invalid client settings".into());
    }
    let bytes = serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?;
    atomic_write(&client_settings_file(&app)?, &bytes)?;
    Ok(settings)
}

fn pi_agent_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or("Home directory unavailable")?;
    let directory = PathBuf::from(home).join(".pi").join("agent");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

async fn detect_local_service_impl(base_url: &str) -> Result<LocalServiceInfo, String> {
    let mut origin = reqwest::Url::parse(base_url).map_err(|error| error.to_string())?;
    if !matches!(origin.scheme(), "http" | "https") {
        return Err("Only HTTP(S) model services are supported".into());
    }
    origin.set_path("/");
    origin.set_query(None);
    origin.set_fragment(None);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|error| error.to_string())?;

    if let Ok(response) = client.get(origin.clone()).send().await {
        if let Ok(body) = response.text().await {
            if body.to_ascii_lowercase().contains("ollama is running") {
                return Ok(LocalServiceInfo {
                    kind: "ollama".into(),
                    display_name: "Ollama".into(),
                });
            }
        }
    }

    if let Ok(version_url) = origin.join("version") {
        if let Ok(response) = client.get(version_url).send().await {
            if response.status().is_success() {
                if let Ok(body) = response.json::<Value>().await {
                    if body.get("version").and_then(Value::as_str).is_some() {
                        return Ok(LocalServiceInfo {
                            kind: "vllm".into(),
                            display_name: "vLLM".into(),
                        });
                    }
                }
            }
        }
    }

    if origin.port() == Some(1234) {
        return Ok(LocalServiceInfo {
            kind: "lm-studio".into(),
            display_name: "LM Studio".into(),
        });
    }
    Ok(LocalServiceInfo {
        kind: "openai-compatible".into(),
        display_name: "OpenAI-compatible".into(),
    })
}

#[tauri::command]
async fn detect_local_service(base_url: String) -> Result<LocalServiceInfo, String> {
    detect_local_service_impl(&base_url).await
}

async fn migrate_misclassified_vllm() -> Result<bool, String> {
    let agent_dir = pi_agent_dir()?;
    let models_path = agent_dir.join("models.json");
    let Some(mut root) = fs::read_to_string(&models_path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    else {
        return Ok(false);
    };
    let providers = root
        .get_mut("providers")
        .and_then(Value::as_object_mut)
        .ok_or("models.json providers must be an object")?;
    if providers.contains_key("vllm") {
        return Ok(false);
    }
    let candidate_url = providers.get("ollama").and_then(|provider| {
        let name = provider.get("name").and_then(Value::as_str).unwrap_or("");
        let base_url = provider
            .get("baseUrl")
            .and_then(Value::as_str)
            .unwrap_or("");
        let is_legacy_candidate = reqwest::Url::parse(base_url)
            .ok()
            .is_some_and(|url| url.port() == Some(8000));
        (is_legacy_candidate && (name.is_empty() || name.eq_ignore_ascii_case("ollama")))
            .then(|| base_url.to_owned())
    });
    let is_vllm = if let Some(base_url) = candidate_url {
        detect_local_service_impl(&base_url)
            .await
            .is_ok_and(|service| service.kind == "vllm")
    } else {
        false
    };
    if !is_vllm {
        return Ok(false);
    }
    let mut provider = providers
        .remove("ollama")
        .ok_or("Ollama provider disappeared")?;
    provider["name"] = Value::String("vLLM".into());
    providers.insert("vllm".into(), provider);
    atomic_write(
        &models_path,
        &serde_json::to_vec_pretty(&root).map_err(|error| error.to_string())?,
    )?;

    let settings_path = agent_dir.join("settings.json");
    if let Some(mut settings) = fs::read_to_string(&settings_path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    {
        if settings.get("defaultProvider").and_then(Value::as_str) == Some("ollama") {
            settings["defaultProvider"] = Value::String("vllm".into());
            atomic_write(
                &settings_path,
                &serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?,
            )?;
        }
    }
    Ok(true)
}

#[tauri::command]
fn save_model_provider(provider: ProviderDraft) -> Result<(), String> {
    let id = provider.id.trim();
    if id.is_empty()
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Provider ID may contain only letters, numbers, - and _".into());
    }
    if provider.base_url.parse::<reqwest::Url>().is_err() {
        return Err("Base URL is invalid".into());
    }
    if provider.models.is_empty() || provider.models.iter().any(|model| model.trim().is_empty()) {
        return Err("At least one model ID is required".into());
    }
    let path = pi_agent_dir()?.join("models.json");
    let mut root = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_else(|| serde_json::json!({"providers": {}}));
    merge_model_provider(&mut root, &provider)?;
    let bytes = serde_json::to_vec_pretty(&root).map_err(|error| error.to_string())?;
    atomic_write(&path, &bytes)
}

fn merge_model_provider(root: &mut Value, provider: &ProviderDraft) -> Result<(), String> {
    let id = provider.id.trim();
    let providers = root
        .as_object_mut()
        .ok_or("models.json root must be an object")?
        .entry("providers")
        .or_insert_with(|| serde_json::json!({}));
    let providers = providers
        .as_object_mut()
        .ok_or("models.json providers must be an object")?;
    let models = provider
        .models
        .iter()
        .map(|id| serde_json::json!({"id": id.trim(), "name": id.trim()}))
        .collect::<Vec<_>>();
    let mut value = serde_json::json!({
        "name": if provider.name.trim().is_empty() { id } else { provider.name.trim() },
        "baseUrl": provider.base_url.trim(),
        "api": provider.api,
        "models": models,
    });
    if provider.local {
        value["apiKey"] = Value::String(
            if provider.id == "ollama" {
                "ollama"
            } else {
                "local"
            }
            .into(),
        );
    }
    providers.insert(id.to_string(), value);
    Ok(())
}

#[tauri::command]
fn delete_model_provider(provider_id: String) -> Result<(), String> {
    let path = pi_agent_dir()?.join("models.json");
    let mut root = fs::read_to_string(&path)
        .map_err(|error| error.to_string())
        .and_then(|text| serde_json::from_str::<Value>(&text).map_err(|error| error.to_string()))?;
    root.get_mut("providers")
        .and_then(Value::as_object_mut)
        .ok_or("models.json providers must be an object")?
        .remove(&provider_id);
    let bytes = serde_json::to_vec_pretty(&root).map_err(|error| error.to_string())?;
    atomic_write(&path, &bytes)
}

fn valid_provider_id(provider_id: &str) -> bool {
    !provider_id.is_empty()
        && provider_id.len() <= 80
        && provider_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn read_json_object(path: &Path) -> serde_json::Map<String, Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn load_json_object(path: &Path) -> Result<serde_json::Map<String, Value>, String> {
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str::<Value>(&text)
        .map_err(|error| format!("Invalid JSON in {}: {error}", path.display()))?
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{} must contain a JSON object", path.display()))
}

fn atomic_write_private(path: &Path, content: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_provider_api_key(provider_id: String, api_key: String) -> Result<(), String> {
    let provider_id = provider_id.trim();
    if !valid_provider_id(provider_id) {
        return Err("Invalid provider ID".into());
    }
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("API key cannot be empty".into());
    }
    let path = pi_agent_dir()?.join("auth.json");
    let mut auth = load_json_object(&path)?;
    auth.insert(
        provider_id.to_string(),
        serde_json::json!({"type": "api_key", "key": api_key}),
    );
    atomic_write_private(
        &path,
        &serde_json::to_vec_pretty(&auth).map_err(|error| error.to_string())?,
    )
}

#[tauri::command]
fn logout_provider(provider_id: String) -> Result<(), String> {
    let provider_id = provider_id.trim();
    if !valid_provider_id(provider_id) {
        return Err("Invalid provider ID".into());
    }
    let path = pi_agent_dir()?.join("auth.json");
    let mut auth = load_json_object(&path)?;
    auth.remove(provider_id);
    atomic_write_private(
        &path,
        &serde_json::to_vec_pretty(&auth).map_err(|error| error.to_string())?,
    )
}

fn builtin_provider_catalog() -> Vec<(&'static str, &'static str, bool, bool)> {
    vec![
        ("amazon-bedrock", "Amazon Bedrock", true, false),
        ("ant-ling", "Ant Ling", true, false),
        ("anthropic", "Anthropic", true, true),
        ("azure-openai-responses", "Azure OpenAI", true, false),
        ("cerebras", "Cerebras", true, false),
        (
            "cloudflare-ai-gateway",
            "Cloudflare AI Gateway",
            true,
            false,
        ),
        (
            "cloudflare-workers-ai",
            "Cloudflare Workers AI",
            true,
            false,
        ),
        ("deepseek", "DeepSeek", true, false),
        ("fireworks", "Fireworks", true, false),
        ("github-copilot", "GitHub Copilot", true, true),
        ("google", "Google Gemini", true, false),
        ("google-vertex", "Google Vertex AI", true, false),
        ("groq", "Groq", true, false),
        ("huggingface", "Hugging Face", true, false),
        ("kimi-coding", "Kimi For Coding", true, false),
        ("minimax", "MiniMax", true, false),
        ("minimax-cn", "MiniMax China", true, false),
        ("mistral", "Mistral", true, false),
        ("moonshotai", "Moonshot AI", true, false),
        ("moonshotai-cn", "Moonshot AI China", true, false),
        ("nvidia", "NVIDIA NIM", true, false),
        ("openai", "OpenAI", true, false),
        ("openai-codex", "OpenAI Codex", false, true),
        ("opencode", "OpenCode Zen", true, false),
        ("opencode-go", "OpenCode Go", true, false),
        ("openrouter", "OpenRouter", true, false),
        ("qwen-token-plan", "Qwen Token Plan", true, false),
        ("qwen-token-plan-cn", "Qwen Token Plan China", true, false),
        ("radius", "Radius", true, true),
        ("together", "Together AI", true, false),
        ("vercel-ai-gateway", "Vercel AI Gateway", true, false),
        ("xai", "xAI", true, true),
        ("xiaomi", "Xiaomi MiMo", true, false),
        (
            "xiaomi-token-plan-cn",
            "Xiaomi Token Plan China",
            true,
            false,
        ),
        (
            "xiaomi-token-plan-ams",
            "Xiaomi Token Plan Amsterdam",
            true,
            false,
        ),
        (
            "xiaomi-token-plan-sgp",
            "Xiaomi Token Plan Singapore",
            true,
            false,
        ),
        ("zai", "Z.AI", true, false),
        ("zai-coding-cn", "Z.AI Coding China", true, false),
    ]
}

#[tauri::command]
fn get_provider_catalog(
    state: State<DesktopState>,
    runtime_id: Option<String>,
) -> Result<Vec<ProviderCatalogItem>, String> {
    let available = rpc(
        &state,
        runtime_id.as_deref(),
        serde_json::json!({"type": "get_available_models"}),
    )?;
    let mut models_by_provider = HashMap::<String, Vec<ProviderModel>>::new();
    for model in available
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let (Some(provider), Some(id)) = (
            model.get("provider").and_then(Value::as_str),
            model.get("id").and_then(Value::as_str),
        ) else {
            continue;
        };
        models_by_provider
            .entry(provider.to_string())
            .or_default()
            .push(ProviderModel {
                id: id.to_string(),
                name: model
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
    }

    let agent_dir = pi_agent_dir()?;
    let auth = read_json_object(&agent_dir.join("auth.json"));
    let models_root = read_json_object(&agent_dir.join("models.json"));
    let custom = models_root
        .get("providers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let custom_ids = custom.keys().cloned().collect::<HashSet<_>>();
    let mut catalog = builtin_provider_catalog()
        .into_iter()
        .map(|(id, name, api_key, oauth)| ProviderCatalogItem {
            id: id.into(),
            name: name.into(),
            base_url: None,
            api: None,
            source: if custom_ids.contains(id) {
                "custom"
            } else {
                "builtin"
            }
            .into(),
            configured: auth.contains_key(id) || models_by_provider.contains_key(id),
            auth_methods: [api_key.then_some("api_key"), oauth.then_some("oauth")]
                .into_iter()
                .flatten()
                .map(str::to_string)
                .collect(),
            models: models_by_provider.remove(id).unwrap_or_default(),
        })
        .collect::<Vec<_>>();

    for (id, value) in custom {
        let configured = auth.contains_key(&id)
            || value
                .get("apiKey")
                .and_then(Value::as_str)
                .is_some_and(|key| !key.is_empty())
            || models_by_provider.contains_key(&id);
        let configured_models = value
            .get("models")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|model| {
                let id = model.get("id").and_then(Value::as_str)?;
                Some(ProviderModel {
                    id: id.to_string(),
                    name: model
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
            })
            .collect::<Vec<_>>();
        if let Some(item) = catalog.iter_mut().find(|item| item.id == id) {
            item.name = value
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&item.name)
                .to_string();
            item.base_url = value
                .get("baseUrl")
                .and_then(Value::as_str)
                .map(str::to_string);
            item.api = value.get("api").and_then(Value::as_str).map(str::to_string);
            item.source = "custom".into();
            item.configured = configured;
            if !configured_models.is_empty() {
                item.models = configured_models;
            }
        } else {
            catalog.push(ProviderCatalogItem {
                id: id.clone(),
                name: value
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string(),
                base_url: value
                    .get("baseUrl")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                api: value.get("api").and_then(Value::as_str).map(str::to_string),
                source: "custom".into(),
                configured,
                auth_methods: vec!["api_key".into()],
                models: if configured_models.is_empty() {
                    models_by_provider.remove(&id).unwrap_or_default()
                } else {
                    configured_models
                },
            });
        }
    }
    for (id, models) in models_by_provider {
        catalog.push(ProviderCatalogItem {
            name: id.clone(),
            id,
            base_url: None,
            api: None,
            source: "extension".into(),
            configured: true,
            auth_methods: Vec::new(),
            models,
        });
    }
    catalog.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(catalog)
}

#[tauri::command]
async fn discover_local_models(base_url: String, ollama: bool) -> Result<Vec<String>, String> {
    let base = reqwest::Url::parse(&base_url).map_err(|error| error.to_string())?;
    if !matches!(base.scheme(), "http" | "https") {
        return Err("Only HTTP(S) model services are supported".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| error.to_string())?;
    let ollama = ollama
        || detect_local_service_impl(&base_url)
            .await
            .is_ok_and(|service| service.kind == "ollama");
    let models_url = if base.path().trim_end_matches('/').ends_with("/v1") {
        base.join("models").map_err(|error| error.to_string())?
    } else {
        base.join("v1/models").map_err(|error| error.to_string())?
    };
    if let Ok(response) = client.get(models_url).send().await {
        if let Ok(response) = response.error_for_status() {
            if let Ok(body) = response.json::<Value>().await {
                let mut models = body
                    .get("data")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|item| item.get("id").and_then(Value::as_str).map(str::to_string))
                    .collect::<Vec<_>>();
                models.sort();
                models.dedup();
                if !models.is_empty() {
                    return Ok(models);
                }
            }
        }
    }
    if ollama {
        let tags_url = base.join("/api/tags").map_err(|error| error.to_string())?;
        let body = client
            .get(tags_url)
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?
            .json::<Value>()
            .await
            .map_err(|error| error.to_string())?;
        let mut models = body
            .get("models")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| item.get("name").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        models.sort();
        models.dedup();
        return Ok(models);
    }
    Err("The service did not return an OpenAI-compatible model list".into())
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionSummary {
    id: String,
    path: String,
    cwd: String,
    name: Option<String>,
    updated_at: u64,
    preview: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProjectSummary {
    cwd: String,
    name: String,
    is_home: bool,
    sessions: Vec<SessionSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    path: String,
    name: String,
    is_dir: bool,
    loaded: bool,
    children: Vec<FileEntry>,
}

fn app_data_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("hidden-sessions.json"))
}

fn known_projects_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("known-projects.json"))
}

fn load_known_projects(app: &AppHandle) -> BTreeSet<String> {
    known_projects_file(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_known_projects(app: &AppHandle, projects: &BTreeSet<String>) -> Result<(), String> {
    let data = serde_json::to_string(projects).map_err(|error| error.to_string())?;
    fs::write(known_projects_file(app)?, data).map_err(|error| error.to_string())
}

#[tauri::command]
fn add_workspace(app: AppHandle, cwd: String) -> Result<String, String> {
    let selected = PathBuf::from(&cwd)
        .canonicalize()
        .map_err(|error| format!("无法打开所选工作区：{error}"))?;
    if !selected.is_dir() {
        return Err("所选路径不是文件夹".into());
    }

    let mut projects = load_known_projects(&app);
    // Reuse the spelling already stored for an existing workspace. This avoids
    // duplicate entries caused by Windows slash/case/extended-path variants.
    if let Some(existing) = projects.iter().find(|existing| {
        PathBuf::from(existing)
            .canonicalize()
            .is_ok_and(|path| path == selected)
    }) {
        return Ok(existing.clone());
    }

    let display = selected.display().to_string();
    #[cfg(windows)]
    let display = display
        .strip_prefix(r"\\?\")
        .unwrap_or(&display)
        .to_string();
    projects.insert(display.clone());
    save_known_projects(&app, &projects)?;
    Ok(display)
}

fn load_hidden(app: &AppHandle) -> HashSet<String> {
    app_data_file(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_hidden(app: &AppHandle, hidden: &HashSet<String>) -> Result<(), String> {
    let data = serde_json::to_string(hidden).map_err(|error| error.to_string())?;
    fs::write(app_data_file(app)?, data).map_err(|error| error.to_string())
}

fn session_root() -> Result<PathBuf, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or("Home directory unavailable")?;
    Ok(PathBuf::from(home)
        .join(".pi")
        .join("agent")
        .join("sessions"))
}

fn user_facing_session_text(text: String) -> String {
    const PLAN_PREFIX: &str = "Analyze the codebase and create a detailed plan for: ";
    const PLAN_PATH_MARKER: &str = "\n\nWrite the plan to: ";
    let normalized = text.replace("\r\n", "\n");
    if let Some(request) = normalized.strip_prefix(PLAN_PREFIX) {
        if let Some(marker) = request.find(PLAN_PATH_MARKER) {
            return format!("/plan {}", request[..marker].trim());
        }
    }
    normalized
}

fn message_text(value: &Value) -> Option<String> {
    let content = value.get("content")?;
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    };
    let text = user_facing_session_text(text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if text.is_empty() {
        return None;
    }
    let mut title = text.chars().take(42).collect::<String>();
    if text.chars().count() > 42 {
        title.push('…');
    }
    Some(title)
}

fn session_summary(path: &Path) -> Option<SessionSummary> {
    let first_line = fs::read_to_string(path).ok()?.lines().next()?.to_string();
    let header: Value = serde_json::from_str(&first_line).ok()?;
    if header.get("type")?.as_str()? != "session" {
        return None;
    }
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    let id = header.get("id")?.as_str()?.to_string();
    let cwd = header.get("cwd")?.as_str()?.to_string();
    let text = fs::read_to_string(path).ok()?;
    let explicit_name = text
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("session_info"))
        .and_then(|entry| {
            entry
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    // Pi sessions do not always persist a session_info record. In that case,
    // use the first user request as the readable session title instead of a UUID.
    let name = explicit_name.or_else(|| {
        text.lines().find_map(|line| {
            let entry = serde_json::from_str::<Value>(line).ok()?;
            (entry.get("type").and_then(Value::as_str) == Some("message")
                && entry.get("message")?.get("role").and_then(Value::as_str) == Some("user"))
            .then(|| message_text(entry.get("message")?))
            .flatten()
        })
    });
    Some(SessionSummary {
        id,
        path: path.display().to_string(),
        cwd,
        name,
        updated_at: modified,
        preview: String::new(),
    })
}

fn workspace_path(root: &Path, requested: &str) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let candidate = PathBuf::from(requested);
    let target = if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    };
    let parent = target
        .parent()
        .ok_or("Path has no parent")?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let normalized = parent.join(target.file_name().ok_or("Path has no filename")?);
    if !normalized.starts_with(&root) {
        return Err("Path is outside the active project".into());
    }
    Ok(normalized)
}

fn build_tree(root: &Path, path: &Path, depth: u8) -> Result<FileEntry, String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("workspace")
        .to_string();
    if !path.is_dir() {
        return Ok(FileEntry {
            path: path
                .strip_prefix(root)
                .unwrap_or(path)
                .display()
                .to_string(),
            name,
            is_dir: false,
            loaded: true,
            children: vec![],
        });
    }
    if depth == 0 {
        return Ok(FileEntry {
            path: path
                .strip_prefix(root)
                .unwrap_or(path)
                .display()
                .to_string(),
            name,
            is_dir: true,
            loaded: false,
            children: vec![],
        });
    }
    let mut children = fs::read_dir(path)
        .map_err(|error| error.to_string())?
        .flatten()
        // Keep dependencies out of the tree, but expose dotfiles and dot-directories.
        // Directories are loaded lazily, so showing hidden folders does not recursively
        // scan their contents during the initial project-tree request.
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            !entry.path().is_dir() || name != "node_modules"
        })
        .filter_map(|entry| build_tree(root, &entry.path(), depth - 1).ok())
        .collect::<Vec<_>>();
    children.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then(left.name.cmp(&right.name))
    });
    Ok(FileEntry {
        path: path
            .strip_prefix(root)
            .unwrap_or(path)
            .display()
            .to_string(),
        name,
        is_dir: true,
        loaded: true,
        children,
    })
}

fn rpc_bridge(state: &DesktopState, runtime_id: Option<&str>) -> Result<Arc<RpcBridge>, String> {
    let runtime_id = match runtime_id {
        Some(runtime_id) => runtime_id.to_string(),
        None => state
            .active_rpc
            .lock()
            .map_err(|_| "Active RPC lock failed")?
            .clone()
            .ok_or("Pi RPC is not connected")?,
    };
    state
        .rpcs
        .lock()
        .map_err(|_| "RPC state lock failed")?
        .get(&runtime_id)
        .filter(|bridge| !bridge.is_closed())
        .cloned()
        .ok_or_else(|| format!("Pi runtime is not connected: {runtime_id}"))
}

fn request_rpc(bridge: &RpcBridge, command: Value) -> Result<Value, String> {
    let response = bridge.request(command)?;
    if response.get("success").and_then(Value::as_bool) == Some(false) {
        return Err(response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Pi RPC error")
            .to_string());
    }
    Ok(response.get("data").cloned().unwrap_or(Value::Null))
}

fn rpc(state: &DesktopState, runtime_id: Option<&str>, command: Value) -> Result<Value, String> {
    let bridge = rpc_bridge(state, runtime_id)?;
    request_rpc(bridge.as_ref(), command)
}

#[tauri::command]
fn list_projects(
    app: AppHandle,
    state: State<DesktopState>,
) -> Result<Vec<ProjectSummary>, String> {
    let hidden = state
        .hidden_sessions
        .lock()
        .map_err(|_| "Hidden session lock failed")?
        .clone();
    let mut sessions = vec![];
    let mut known_projects = load_known_projects(&app);
    if let Ok(project_dirs) = fs::read_dir(session_root()?) {
        for project_dir in project_dirs.flatten() {
            if let Ok(files) = fs::read_dir(project_dir.path()) {
                for file in files.flatten() {
                    if file
                        .path()
                        .extension()
                        .and_then(|extension| extension.to_str())
                        == Some("jsonl")
                    {
                        if let Some(session) = session_summary(&file.path()) {
                            known_projects.insert(session.cwd.clone());
                            if !hidden.contains(&session.path) {
                                sessions.push(session);
                            }
                        }
                    }
                }
            }
        }
    }
    // A workspace belongs to the client even when all of its sessions are
    // hidden. Persisting discovered roots prevents the sidebar from removing
    // the workspace after its final session is deleted.
    save_known_projects(&app, &known_projects)?;
    let mut projects = std::collections::BTreeMap::<String, Vec<SessionSummary>>::new();
    for cwd in known_projects {
        projects.entry(cwd).or_default();
    }
    for session in sessions {
        projects
            .entry(session.cwd.clone())
            .or_default()
            .push(session);
    }
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .and_then(|path| path.canonicalize().ok());
    Ok(projects
        .into_iter()
        .map(|(cwd, mut sessions)| {
            sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
            let name = Path::new(&cwd)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(&cwd)
                .to_string();
            let is_home = home
                .as_ref()
                .is_some_and(|home| PathBuf::from(&cwd).canonicalize().ok().as_ref() == Some(home));
            ProjectSummary {
                cwd,
                name,
                is_home,
                sessions,
            }
        })
        .collect())
}

/// Reads the complete local history while Pi is starting or switching.
/// File IO and JSON parsing stay off the async IPC executor so a large session
/// cannot freeze unrelated renderer commands.
#[tauri::command]
async fn session_messages(path: String) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || read_session_messages(path))
        .await
        .map_err(|error| format!("Session history worker failed: {error}"))?
}

fn read_session_messages(path: String) -> Result<Vec<Value>, String> {
    let root = session_root()?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !path.starts_with(&root)
        || path.extension().and_then(|extension| extension.to_str()) != Some("jsonl")
    {
        return Err("Session path is outside Pi's session directory".into());
    }
    let messages = fs::read_to_string(path)
        .map_err(|error| error.to_string())?
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("message"))
        .filter_map(|entry| entry.get("message").cloned())
        .collect::<Vec<_>>();
    Ok(messages)
}

#[tauri::command]
fn hide_session(
    app: AppHandle,
    state: State<DesktopState>,
    path: String,
    hidden: bool,
) -> Result<(), String> {
    // Register the workspace before hiding its final visible session. This
    // also covers a hide action made before the next project-list refresh.
    if hidden {
        if let Some(session) = session_summary(Path::new(&path)) {
            let mut projects = load_known_projects(&app);
            if projects.insert(session.cwd) {
                save_known_projects(&app, &projects)?;
            }
        }
    }
    let mut values = state
        .hidden_sessions
        .lock()
        .map_err(|_| "Hidden session lock failed")?;
    if hidden {
        values.insert(path);
    } else {
        values.remove(&path);
    }
    save_hidden(&app, &values)
}

/// Rename a session that is not currently loaded by Pi.
///
/// Pi represents names as append-only `session_info` entries. Keeping the
/// same format means the renamed session remains fully compatible with the
/// CLI and will be picked up by SessionManager the next time it is opened.
#[tauri::command]
fn rename_session(path: String, name: String, timestamp: String) -> Result<(), String> {
    let name = name.replace(['\r', '\n'], " ").trim().to_string();
    if name.is_empty() {
        return Err("Session name cannot be empty".into());
    }
    let root = session_root()?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !path.starts_with(&root)
        || path.extension().and_then(|extension| extension.to_str()) != Some("jsonl")
    {
        return Err("Session path is outside Pi's session directory".into());
    }
    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let parent_id = text
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line).ok())
        .and_then(|entry| entry.get("id").and_then(Value::as_str).map(str::to_string));
    let entry = serde_json::json!({
        "type": "session_info",
        "id": format!("{:08x}", rand::random::<u32>()),
        "parentId": parent_id,
        "timestamp": timestamp,
        "name": name,
    });
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    writeln!(file, "{entry}").map_err(|error| error.to_string())
}

fn pi_executable() -> PathBuf {
    std::env::var_os("AGENT_K_PI_EXECUTABLE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("pi"))
}

#[tauri::command]
fn open_provider_login(provider_id: String) -> Result<(), String> {
    let provider_id = provider_id.trim();
    if !valid_provider_id(provider_id) {
        return Err("Invalid provider ID".into());
    }
    let directory = pi_agent_dir()?;
    let executable = pi_executable();

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        let mut command = pi_process_command(&executable);
        command
            .current_dir(directory)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map(|_| ())
            .map_err(|error| {
                format!(
                    "Unable to open Pi login terminal: {error}. Run /login {provider_id} in Pi manually."
                )
            })
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (directory, executable);
        Err("OAuth terminal launch is not implemented for macOS".into())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let script =
            "printf '\\nAgent K: enter /login %s in Pi to authenticate.\\n\\n' \"$2\"; exec \"$1\"";
        let shell_args = || {
            vec![
                "sh".to_string(),
                "-lc".to_string(),
                script.to_string(),
                "agent-k-login".to_string(),
                executable.display().to_string(),
                provider_id.to_string(),
            ]
        };
        let candidates: Vec<(&str, Vec<String>)> = vec![
            ("xdg-terminal-exec", shell_args()),
            (
                "konsole",
                [
                    vec![
                        "--workdir".into(),
                        directory.display().to_string(),
                        "-e".into(),
                    ],
                    shell_args(),
                ]
                .concat(),
            ),
            (
                "gnome-terminal",
                [
                    vec![
                        format!("--working-directory={}", directory.display()),
                        "--".into(),
                    ],
                    shell_args(),
                ]
                .concat(),
            ),
            (
                "kitty",
                [
                    vec!["--directory".into(), directory.display().to_string()],
                    shell_args(),
                ]
                .concat(),
            ),
            (
                "alacritty",
                [
                    vec![
                        "--working-directory".into(),
                        directory.display().to_string(),
                        "-e".into(),
                    ],
                    shell_args(),
                ]
                .concat(),
            ),
            (
                "wezterm",
                [
                    vec![
                        "start".into(),
                        "--cwd".into(),
                        directory.display().to_string(),
                        "--".into(),
                    ],
                    shell_args(),
                ]
                .concat(),
            ),
            (
                "foot",
                [
                    vec![
                        "--working-directory".into(),
                        directory.display().to_string(),
                    ],
                    shell_args(),
                ]
                .concat(),
            ),
            (
                "x-terminal-emulator",
                [vec!["-e".into()], shell_args()].concat(),
            ),
            ("xterm", [vec!["-e".into()], shell_args()].concat()),
        ];
        for (program, arguments) in candidates {
            match std::process::Command::new(program)
                .args(arguments)
                .current_dir(&directory)
                .spawn()
            {
                Ok(_) => return Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => continue,
            }
        }
        Err(format!(
            "No supported terminal emulator was found. Run Pi and enter /login {provider_id}."
        ))
    }
}

fn reload_pi_runtimes_impl(app: &AppHandle, state: &DesktopState) -> Result<(), String> {
    let workers = state
        .rpcs
        .lock()
        .map_err(|_| "RPC state lock failed")?
        .values()
        .filter(|worker| !worker.is_closed())
        .cloned()
        .collect::<Vec<_>>();
    if workers.iter().any(|worker| !worker.is_available()) {
        return Err(
            "Wait for active Pi tasks and dialogs to finish before reloading providers".into(),
        );
    }
    for old in workers {
        let runtime_id = old.runtime_id().to_string();
        let cwd = old.workspace_cwd()?;
        let session_file = old.session_file();
        let replacement = Arc::new(RpcBridge::start(
            app.clone(),
            &pi_executable(),
            &cwd,
            runtime_id.clone(),
        )?);
        if let Some(path) = session_file.as_deref() {
            if let Err(error) = request_rpc(
                &replacement,
                serde_json::json!({"type": "switch_session", "sessionPath": path}),
            ) {
                replacement.stop();
                return Err(format!(
                    "Unable to restore Pi session after provider reload: {error}"
                ));
            }
            replacement.set_session_file(Some(path.to_string()));
        }
        if let Err(error) = request_rpc(&replacement, serde_json::json!({"type": "get_state"})) {
            replacement.stop();
            return Err(format!("Reloaded Pi runtime did not become ready: {error}"));
        }
        state
            .rpcs
            .lock()
            .map_err(|_| "RPC state lock failed")?
            .insert(runtime_id, replacement);
        old.stop();
    }
    Ok(())
}

#[tauri::command]
async fn reload_pi_runtimes(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopState>();
        reload_pi_runtimes_impl(&app, &state)
    })
    .await
    .map_err(|error| format!("Pi provider reload task failed: {error}"))?
}

fn start_pi_worker(app: &AppHandle, state: &DesktopState, cwd: &Path) -> Result<String, String> {
    state.starting_workers.fetch_add(1, Ordering::SeqCst);
    let result = (|| {
        let runtime_id = format!("runtime-{:016x}", rand::random::<u64>());
        let bridge = Arc::new(RpcBridge::start(
            app.clone(),
            &pi_executable(),
            cwd,
            runtime_id.clone(),
        )?);
        request_rpc(&bridge, serde_json::json!({ "type": "get_state" }))
            .map_err(|error| format!("Pi RPC did not become ready: {error}"))?;
        state
            .rpcs
            .lock()
            .map_err(|_| "RPC state lock failed")?
            .insert(runtime_id.clone(), bridge);
        if let Ok(mut pool_cwd) = state.pool_cwd.lock() {
            *pool_cwd = Some(cwd.display().to_string());
        }
        Ok(runtime_id)
    })();
    state.starting_workers.fetch_sub(1, Ordering::SeqCst);
    result
}

fn set_active_runtime(state: &DesktopState, runtime_id: &str) -> Result<(), String> {
    *state
        .active_rpc
        .lock()
        .map_err(|_| "Active RPC lock failed")? = Some(runtime_id.to_string());
    Ok(())
}

fn worker_pool_size(state: &DesktopState) -> usize {
    state
        .rpcs
        .lock()
        .map(|workers| {
            workers
                .values()
                .filter(|worker| !worker.is_closed())
                .count()
        })
        .unwrap_or_default()
}

fn reap_worker_pool(state: &DesktopState, force: bool) {
    const IDLE_TTL: Duration = Duration::from_secs(5 * 60);
    let minimum = state.minimum_workers.load(Ordering::SeqCst).clamp(2, 4);
    let Ok(mut workers) = state.rpcs.lock() else {
        return;
    };
    let active_runtime = state
        .active_rpc
        .lock()
        .ok()
        .and_then(|active| active.clone());
    workers.retain(|_, worker| !worker.is_closed());
    let excess = workers.len().saturating_sub(minimum);
    if excess == 0 {
        for worker in workers.values() {
            worker.mark_retire_on_idle(false);
        }
        return;
    }
    let mut available = workers
        .iter()
        .filter(|(id, worker)| {
            active_runtime.as_deref() != Some(id.as_str()) && worker.is_available()
        })
        .map(|(id, worker)| (id.clone(), worker.clone()))
        .collect::<Vec<_>>();
    available.sort_by_key(|(_, worker)| std::cmp::Reverse(worker.idle_for()));
    let mut remove = Vec::new();
    for (id, worker) in available {
        if remove.len() >= excess {
            break;
        }
        if force || worker.should_retire() || worker.idle_for() >= IDLE_TTL {
            remove.push(id);
        }
    }
    for id in remove {
        if let Some(worker) = workers.remove(&id) {
            worker.stop();
        }
    }
    let remaining_excess = workers.len().saturating_sub(minimum);
    if force && remaining_excess > 0 {
        let mut busy = workers
            .values()
            .filter(|worker| !worker.is_available())
            .cloned()
            .collect::<Vec<_>>();
        busy.sort_by_key(|worker| std::cmp::Reverse(worker.idle_for()));
        for worker in busy.into_iter().take(remaining_excess) {
            worker.mark_retire_on_idle(true);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerPoolStatus {
    total: usize,
    idle: usize,
    busy: usize,
    minimum: usize,
}

fn pool_status(state: &DesktopState) -> WorkerPoolStatus {
    let workers = state.rpcs.lock().ok();
    let total = workers
        .as_ref()
        .map(|workers| {
            workers
                .values()
                .filter(|worker| !worker.is_closed())
                .count()
        })
        .unwrap_or_default();
    let idle = workers
        .as_ref()
        .map(|workers| {
            workers
                .values()
                .filter(|worker| worker.is_available())
                .count()
        })
        .unwrap_or_default();
    WorkerPoolStatus {
        total,
        idle,
        busy: total.saturating_sub(idle),
        minimum: state.minimum_workers.load(Ordering::SeqCst).clamp(2, 4),
    }
}

#[tauri::command]
async fn spawn_pi_worker(app: AppHandle, cwd: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopState>();
        start_pi_worker(&app, &state, Path::new(&cwd))
    })
    .await
    .map_err(|error| format!("Pi worker task failed: {error}"))?
}

#[tauri::command]
async fn resize_pi_pool(app: AppHandle, size: usize) -> Result<WorkerPoolStatus, String> {
    if !(2..=4).contains(&size) {
        return Err("Pi worker pool size must be between 2 and 4".into());
    }
    {
        let state = app.state::<DesktopState>();
        state.minimum_workers.store(size, Ordering::SeqCst);
        reap_worker_pool(&state, true);
    }
    let missing = {
        let state = app.state::<DesktopState>();
        size.saturating_sub(worker_pool_size(&state))
    };
    if missing > 0 {
        let cwd = {
            let state = app.state::<DesktopState>();
            state
                .pool_cwd
                .lock()
                .ok()
                .and_then(|cwd| cwd.clone())
                .or_else(|| std::env::var("USERPROFILE").ok())
                .or_else(|| std::env::var("HOME").ok())
                .ok_or("Worker pool directory unavailable")?
        };
        let mut tasks = Vec::with_capacity(missing);
        for _ in 0..missing {
            let app = app.clone();
            let cwd = cwd.clone();
            tasks.push(tauri::async_runtime::spawn_blocking(move || {
                let state = app.state::<DesktopState>();
                start_pi_worker(&app, &state, Path::new(&cwd))
            }));
        }
        for task in tasks {
            task.await
                .map_err(|error| format!("Pi worker task failed: {error}"))??;
        }
    }
    let state = app.state::<DesktopState>();
    Ok(pool_status(&state))
}

#[tauri::command]
fn get_worker_pool_status(state: State<DesktopState>) -> WorkerPoolStatus {
    pool_status(&state)
}

fn connect_pi_impl(
    app: &AppHandle,
    state: &DesktopState,
    cwd: String,
    session_path: Option<String>,
    runtime_id: Option<String>,
) -> Result<String, String> {
    if let Some(runtime_id) = runtime_id {
        if let Ok(bridge) = rpc_bridge(&state, Some(&runtime_id)) {
            let still_matches = match session_path.as_deref() {
                Some(path) => bridge.session_file().as_deref() == Some(path),
                None => bridge.workspace_matches(Path::new(&cwd)),
            };
            if still_matches {
                bridge.touch();
                set_active_runtime(&state, &runtime_id)?;
                return Ok(runtime_id);
            }
        }
    }
    if let Some(path) = session_path.as_deref() {
        let existing = state
            .rpcs
            .lock()
            .map_err(|_| "RPC state lock failed")?
            .values()
            .find(|bridge| !bridge.is_closed() && bridge.session_file().as_deref() == Some(path))
            .cloned();
        if let Some(bridge) = existing {
            let runtime_id = bridge.runtime_id().to_string();
            bridge.touch();
            set_active_runtime(&state, &runtime_id)?;
            return Ok(runtime_id);
        }
    }
    let candidate = state
        .rpcs
        .lock()
        .map_err(|_| "RPC state lock failed")?
        .values()
        .filter(|bridge| session_path.is_some() || bridge.workspace_matches(Path::new(&cwd)))
        .find(|bridge| bridge.try_reserve())
        .cloned();
    let (runtime_id, bridge, newly_started) = if let Some(bridge) = candidate {
        (bridge.runtime_id().to_string(), bridge, false)
    } else {
        let runtime_id = start_pi_worker(app, state, Path::new(&cwd))?;
        let bridge = rpc_bridge(&state, Some(&runtime_id))?;
        bridge.try_reserve();
        (runtime_id, bridge, true)
    };
    if let Some(path) = session_path.as_deref() {
        let switch_result = request_rpc(
            &bridge,
            serde_json::json!({ "type": "switch_session", "sessionPath": path }),
        );
        if let Err(error) = switch_result {
            bridge.release_reservation();
            if newly_started {
                state
                    .rpcs
                    .lock()
                    .ok()
                    .and_then(|mut workers| workers.remove(&runtime_id));
                bridge.stop();
            }
            return Err(error);
        }
        bridge.set_session_file(Some(path.to_string()));
        bridge.set_workspace_cwd(Path::new(&cwd));
        if let Err(error) = request_rpc(&bridge, serde_json::json!({ "type": "get_state" })) {
            bridge.release_reservation();
            if newly_started {
                state
                    .rpcs
                    .lock()
                    .ok()
                    .and_then(|mut workers| workers.remove(&runtime_id));
                bridge.stop();
            }
            return Err(error);
        }
    }
    bridge.release_reservation();
    set_active_runtime(&state, &runtime_id)?;
    Ok(runtime_id)
}

#[tauri::command]
async fn connect_pi(
    app: AppHandle,
    cwd: String,
    session_path: Option<String>,
    runtime_id: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopState>();
        connect_pi_impl(&app, &state, cwd, session_path, runtime_id)
    })
    .await
    .map_err(|error| format!("Pi worker allocation failed: {error}"))?
}

#[tauri::command]
async fn pi_command(
    app: AppHandle,
    state: State<'_, DesktopState>,
    mut command: Value,
    runtime_id: Option<String>,
) -> Result<Value, String> {
    // A bridge process is reusable, but `switch_session` replaces Pi's
    // AgentSession and therefore its actual working directory. Keep the
    // backend's cwd cache aligned with the selected JSONL header so a later
    // `new_session` cannot accidentally inherit the previous project's cwd.
    normalize_rpc_images(&mut command)?;
    let command_type = command
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let bridge = rpc_bridge(&state, runtime_id.as_deref())?;
    let previous_session_file = bridge.session_file();
    let request_bridge = bridge.clone();
    let response =
        tauri::async_runtime::spawn_blocking(move || request_rpc(&request_bridge, command))
            .await
            .map_err(|error| format!("Pi RPC worker failed: {error}"))??;
    let session_change_cancelled = response.get("cancelled").and_then(Value::as_bool) == Some(true);
    if !session_change_cancelled
        && matches!(
            command_type.as_str(),
            "new_session" | "fork" | "switch_session"
        )
    {
        let state_bridge = bridge.clone();
        let session_state = tauri::async_runtime::spawn_blocking(move || {
            request_rpc(&state_bridge, serde_json::json!({"type": "get_state"}))
        })
        .await
        .map_err(|error| format!("Pi session state task failed: {error}"))??;
        if let Some(session_file) = session_state.get("sessionFile").and_then(Value::as_str) {
            bridge.set_session_file(Some(session_file.to_string()));
            let _ = app.emit(
                "pi-rpc-event",
                serde_json::json!({
                    "type": "session_changed",
                    "runtimeId": bridge.runtime_id(),
                    "previousSessionFile": previous_session_file,
                    "sessionFile": session_file,
                    "sessionId": session_state.get("sessionId").cloned().unwrap_or(Value::Null),
                }),
            );
        }
    }
    Ok(response)
}

fn normalize_rpc_images(command: &mut Value) -> Result<(), String> {
    const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
    let Some(paths) = command
        .as_object_mut()
        .and_then(|object| object.remove("imagePaths"))
        .and_then(|value| value.as_array().cloned())
    else {
        return Ok(());
    };
    if paths.len() > 10 {
        return Err("A Pi request can contain at most 10 images".into());
    }
    let mut images = command
        .get("images")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for value in paths {
        let path = value.as_str().ok_or("Image path must be a string")?;
        let path = PathBuf::from(path);
        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        if !metadata.is_file() || metadata.len() > MAX_IMAGE_BYTES {
            return Err(format!(
                "Image is not a file or exceeds 20 MiB: {}",
                path.display()
            ));
        }
        let mime_type = mime_guess::from_path(&path)
            .first()
            .filter(|mime| mime.type_().as_str() == "image")
            .ok_or_else(|| format!("Unsupported image type: {}", path.display()))?;
        let data = fs::read(&path).map_err(|error| error.to_string())?;
        images.push(serde_json::json!({
            "type": "image",
            "data": BASE64.encode(data),
            "mimeType": mime_type.to_string(),
        }));
    }
    command["images"] = Value::Array(images);
    Ok(())
}

/// Interrupt Pi without waiting for the current turn to settle.
///
/// An abort response is only produced after AgentSession.waitForIdle().  Waiting
/// for that response in the renderer made the stop control look frozen during
/// extension-command hand-offs and long-running tools.  The RPC process still
/// handles the same canonical `abort` command; this command only changes the
/// desktop transport to fire-and-forget.
#[tauri::command]
fn pi_abort(state: State<DesktopState>, runtime_id: Option<String>) -> Result<(), String> {
    let bridge = rpc_bridge(&state, runtime_id.as_deref())?;
    bridge.send_notification(&serde_json::json!({ "type": "abort" }))
}

#[tauri::command]
fn close_pi_runtime(state: State<DesktopState>, runtime_id: String) -> Result<(), String> {
    let bridge = state
        .rpcs
        .lock()
        .map_err(|_| "RPC state lock failed")?
        .remove(&runtime_id);
    if let Some(bridge) = bridge {
        bridge.stop();
    }
    let mut active = state
        .active_rpc
        .lock()
        .map_err(|_| "Active RPC lock failed")?;
    if active.as_deref() == Some(&runtime_id) {
        *active = None;
    }
    Ok(())
}

#[tauri::command]
fn pi_extension_ui_response(
    state: State<DesktopState>,
    response: Value,
    runtime_id: Option<String>,
) -> Result<(), String> {
    if response.get("type").and_then(Value::as_str) != Some("extension_ui_response")
        || response.get("id").and_then(Value::as_str).is_none()
    {
        return Err("Invalid extension UI response".into());
    }
    let bridge = rpc_bridge(&state, runtime_id.as_deref())?;
    bridge.send_notification(&response)
}

/// Prewarm a Pi runtime for a draft session without writing any session data.
#[tauri::command]
async fn prepare_session(app: AppHandle, cwd: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopState>();
        connect_pi_impl(&app, &state, cwd, None, None)
    })
    .await
    .map_err(|error| format!("Pi worker allocation failed: {error}"))?
}

/// A fresh session must be created by a runtime whose cwd is the target
/// workspace. A reusable RPC bridge may currently be attached to another
/// project, in which case Pi's `new_session` would otherwise inherit that
/// old cwd.
#[tauri::command]
fn create_session(state: State<DesktopState>, runtime_id: String) -> Result<Value, String> {
    rpc(
        &state,
        Some(&runtime_id),
        serde_json::json!({ "type": "new_session" }),
    )?;
    rpc(
        &state,
        Some(&runtime_id),
        serde_json::json!({ "type": "get_state" }),
    )
}

#[tauri::command]
fn update_startup_progress(
    app: AppHandle,
    message: String,
    current: usize,
    total: usize,
    theme: Option<String>,
) -> Result<(), String> {
    let Some(splash) = app.get_webview_window("splashscreen") else {
        return Ok(());
    };
    let message = serde_json::to_string(&message).map_err(|error| error.to_string())?;
    let percent = if total == 0 {
        0.0
    } else {
        current.min(total) as f64 / total as f64 * 100.0
    };
    let theme = match theme.as_deref() {
        Some("dark") => "dark",
        _ => "light",
    };
    splash
        .eval(format!(
            "document.documentElement.dataset.theme='{theme}';document.getElementById('status').textContent={message};document.getElementById('progress').style.width='{percent:.2}%';"
        ))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn finish_startup(app: AppHandle) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or("Main window is unavailable")?;
    main.show().map_err(|error| error.to_string())?;
    main.set_focus().map_err(|error| error.to_string())?;
    if let Some(splash) = app.get_webview_window("splashscreen") {
        splash.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn project_tree(root: String) -> Result<FileEntry, String> {
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    build_tree(&root, &root, 1)
}
#[tauri::command]
fn project_context(root: String) -> Result<String, String> {
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("Project root is not a directory".into());
    }
    let mut entries = fs::read_dir(&root)
        .map_err(|error| error.to_string())?
        .flatten()
        .map(|entry| {
            format!(
                "{}{}",
                entry.file_name().to_string_lossy(),
                if entry.path().is_dir() { "/" } else { "" }
            )
        })
        .filter(|name| name != "node_modules/" && name != ".git/")
        .collect::<Vec<_>>();
    entries.sort();
    entries.truncate(36);
    let mut summary = format!(
        "Working directory: {}\nTop-level entries: {}",
        root.display(),
        if entries.is_empty() {
            "(empty)".into()
        } else {
            entries.join(", ")
        }
    );
    let package = root.join("package.json");
    if let Ok(text) = fs::read_to_string(package) {
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            let name = value
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("(unnamed)");
            let description = value
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("");
            let scripts = value
                .get("scripts")
                .and_then(Value::as_object)
                .map(|scripts| {
                    scripts
                        .keys()
                        .take(12)
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            summary.push_str(&format!(
                "\npackage.json: name={name}; description={description}; scripts={scripts}"
            ));
        }
    }
    for name in ["README.md", "readme.md", "README", "AGENTS.md"] {
        if let Ok(text) = fs::read_to_string(root.join(name)) {
            let excerpt = text.chars().take(1400).collect::<String>();
            if !excerpt.trim().is_empty() {
                summary.push_str(&format!("\n{name} excerpt:\n{excerpt}"));
                break;
            }
        }
    }
    Ok(summary)
}
#[tauri::command]
fn directory_tree(root: String, path: String) -> Result<FileEntry, String> {
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let target = if path.is_empty() {
        root.clone()
    } else {
        workspace_path(&root, &path)?
    };
    if !target.is_dir() {
        return Err("Requested path is not a directory".into());
    }
    build_tree(&root, &target, 1)
}
#[tauri::command]
fn read_text_file(root: String, path: String) -> Result<String, String> {
    fs::read_to_string(workspace_path(Path::new(&root), &path)?).map_err(|error| error.to_string())
}
#[tauri::command]
fn read_binary_file(root: String, path: String) -> Result<tauri::ipc::Response, String> {
    let bytes =
        fs::read(workspace_path(Path::new(&root), &path)?).map_err(|error| error.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn save_temp_attachment(app: AppHandle, name: String, data: Vec<u8>) -> Result<String, String> {
    let extension = Path::new(&name)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 10
                && value.chars().all(|ch| ch.is_ascii_alphanumeric())
        })
        .unwrap_or("png")
        .to_ascii_lowercase();
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("attachments");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let target = directory.join(format!("{:032x}.{extension}", rand::random::<u128>()));
    fs::write(&target, data).map_err(|error| error.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

fn preview_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
    head_only: bool,
) -> std::io::Result<()> {
    let headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nCross-Origin-Resource-Policy: cross-origin\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(headers.as_bytes())?;
    if !head_only {
        stream.write_all(body)?;
    }
    Ok(())
}

fn handle_preview_request(
    mut stream: TcpStream,
    token: &str,
    config: &Arc<Mutex<PreviewConfig>>,
) -> Result<(), String> {
    let mut request = [0_u8; 16 * 1024];
    let size = stream
        .read(&mut request)
        .map_err(|error| error.to_string())?;
    let request = String::from_utf8_lossy(&request[..size]);
    let mut parts = request
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace();
    let method = parts.next().unwrap_or_default();
    let raw_path = parts
        .next()
        .unwrap_or_default()
        .split('?')
        .next()
        .unwrap_or_default();
    if method != "GET" && method != "HEAD" {
        return preview_response(
            &mut stream,
            "405 Method Not Allowed",
            "text/plain; charset=utf-8",
            b"Method not allowed",
            false,
        )
        .map_err(|error| error.to_string());
    }
    let prefix = format!("/{token}/");
    let Some(encoded_relative) = raw_path.strip_prefix(&prefix) else {
        return preview_response(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"Not found",
            method == "HEAD",
        )
        .map_err(|error| error.to_string());
    };
    let decoded = percent_encoding::percent_decode_str(encoded_relative)
        .decode_utf8()
        .map_err(|error| error.to_string())?;
    let relative = PathBuf::from(decoded.replace('/', std::path::MAIN_SEPARATOR_STR));
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return preview_response(
            &mut stream,
            "403 Forbidden",
            "text/plain; charset=utf-8",
            b"Forbidden",
            method == "HEAD",
        )
        .map_err(|error| error.to_string());
    }
    let (root, overridden) = {
        let config = config
            .lock()
            .map_err(|_| "Preview configuration lock failed".to_string())?;
        (
            config.root.clone(),
            config.overrides.get(&relative).cloned(),
        )
    };
    let unresolved = root.join(&relative);
    let target = if unresolved.is_dir() {
        unresolved.join("index.html")
    } else {
        unresolved
    };
    let canonical = target.canonicalize().map_err(|_| "Not found".to_string());
    let canonical = match canonical {
        Ok(path) if path.starts_with(&root) => path,
        _ => {
            return preview_response(
                &mut stream,
                "404 Not Found",
                "text/plain; charset=utf-8",
                b"Not found",
                method == "HEAD",
            )
            .map_err(|error| error.to_string())
        }
    };
    let mut body = overridden.unwrap_or_else(|| fs::read(&canonical).unwrap_or_default());
    let mime = mime_guess::from_path(&canonical)
        .first_or_octet_stream()
        .to_string();
    if mime.starts_with("text/html") {
        body.extend_from_slice(
            br#"<script>document.addEventListener('contextmenu',function(event){event.preventDefault();},{capture:true});</script>"#,
        );
    }
    preview_response(&mut stream, "200 OK", &mime, &body, method == "HEAD")
        .map_err(|error| error.to_string())
}

fn create_preview_server(config: Arc<Mutex<PreviewConfig>>) -> Result<(u16, String), String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let token = format!("{:032x}", rand::random::<u128>());
    let thread_token = token.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let config = config.clone();
            let token = thread_token.clone();
            std::thread::spawn(move || {
                let _ = handle_preview_request(stream, &token, &config);
            });
        }
    });
    Ok((port, token))
}

#[tauri::command]
fn start_workspace_preview(
    state: State<'_, DesktopState>,
    root: String,
    path: String,
    content: String,
) -> Result<String, String> {
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let target = workspace_path(&root, &path)?;
    if !target.is_file() {
        return Err("预览目标不是文件".into());
    }
    let relative = target
        .strip_prefix(&root)
        .map_err(|error| error.to_string())?
        .to_path_buf();
    let mut server = state
        .preview_server
        .lock()
        .map_err(|_| "Preview server lock failed".to_string())?;
    if server.is_none() {
        let config = Arc::new(Mutex::new(PreviewConfig {
            root: root.clone(),
            overrides: HashMap::new(),
        }));
        let (port, token) = create_preview_server(config.clone())?;
        *server = Some(PreviewServer {
            port,
            token,
            config,
        });
    }
    let server = server.as_ref().ok_or("Preview server failed to start")?;
    {
        let mut config = server
            .config
            .lock()
            .map_err(|_| "Preview configuration lock failed".to_string())?;
        if config.root != root {
            config.root = root;
            config.overrides.clear();
        }
        config
            .overrides
            .insert(relative.clone(), content.into_bytes());
    }
    let encoded = relative
        .components()
        .map(|part| {
            percent_encoding::utf8_percent_encode(
                &part.as_os_str().to_string_lossy(),
                percent_encoding::NON_ALPHANUMERIC,
            )
            .to_string()
        })
        .collect::<Vec<_>>()
        .join("/");
    Ok(format!(
        "http://127.0.0.1:{}/{}/{}",
        server.port, server.token, encoded
    ))
}
#[tauri::command]
fn write_text_file(root: String, path: String, content: String) -> Result<(), String> {
    let path = workspace_path(Path::new(&root), &path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, content).map_err(|error| error.to_string())
}
#[tauri::command]
fn create_directory(root: String, path: String) -> Result<(), String> {
    fs::create_dir_all(workspace_path(Path::new(&root), &path)?).map_err(|error| error.to_string())
}
#[tauri::command]
fn move_path(root: String, from: String, to: String) -> Result<(), String> {
    fs::rename(
        workspace_path(Path::new(&root), &from)?,
        workspace_path(Path::new(&root), &to)?,
    )
    .map_err(|error| error.to_string())
}
#[tauri::command]
fn copy_path(root: String, from: String, to: String) -> Result<(), String> {
    fs::copy(
        workspace_path(Path::new(&root), &from)?,
        workspace_path(Path::new(&root), &to)?,
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}
fn copy_external_entry(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        return Err(format!("目标已存在：{}", destination.display()));
    }
    let metadata = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err(format!("暂不支持复制符号链接：{}", source.display()));
    }
    if metadata.is_file() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(source, destination)
            .map(|_| ())
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err(format!("不支持的文件类型：{}", source.display()));
    }
    fs::create_dir(destination).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source)
        .map_err(|error| error.to_string())?
        .flatten()
    {
        copy_external_entry(&entry.path(), &destination.join(entry.file_name()))?;
    }
    Ok(())
}
#[tauri::command]
async fn import_external_paths(
    state: State<'_, DesktopState>,
    root: String,
    target_dir: String,
    sources: Vec<String>,
) -> Result<(), String> {
    let indexes = state.file_indexes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(root)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let target = if target_dir.is_empty() {
            root.clone()
        } else {
            workspace_path(&root, &target_dir)?
        };
        if !target.is_dir() {
            return Err("拖放目标不是文件夹".to_string());
        }
        for source in sources {
            let source = PathBuf::from(source)
                .canonicalize()
                .map_err(|error| error.to_string())?;
            let name = source.file_name().ok_or("外部路径没有文件名")?;
            let destination = target.join(name);
            if source.is_dir() && destination.starts_with(&source) {
                return Err("不能将文件夹复制到其自身内部".to_string());
            }
            copy_external_entry(&source, &destination)?;
        }
        if let Ok(mut indexes) = indexes.lock() {
            indexes.remove(&root.display().to_string());
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("External copy task failed: {error}"))?
}
#[tauri::command]
fn trash_path(root: String, path: String) -> Result<(), String> {
    trash::delete(workspace_path(Path::new(&root), &path)?).map_err(|error| error.to_string())
}

#[tauri::command]
fn open_terminal_at(root: String, path: String) -> Result<(), String> {
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let target = if path.is_empty() {
        root.clone()
    } else {
        workspace_path(&root, &path)?
    };
    let directory = if target.is_dir() {
        target
    } else {
        target
            .parent()
            .ok_or_else(|| "文件没有父目录".to_string())?
            .to_path_buf()
    };

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        std::process::Command::new("cmd.exe")
            .arg("/K")
            .current_dir(&directory)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Terminal"])
            .arg(&directory)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // There is no single terminal executable shared by all Linux desktop
        // environments. Prefer the freedesktop launcher, then try the common
        // native terminals. Setting the child process' cwd also works for
        // wrappers that do not expose a working-directory command-line flag.
        let terminal_commands: &[(&str, &[&str])] = &[
            ("xdg-terminal-exec", &[]),
            ("konsole", &["--workdir"]),
            ("gnome-terminal", &["--working-directory"]),
            ("xfce4-terminal", &["--working-directory"]),
            ("mate-terminal", &["--working-directory"]),
            ("kitty", &["--directory"]),
            ("alacritty", &["--working-directory"]),
            ("wezterm", &["start", "--cwd"]),
            ("foot", &[]),
            ("x-terminal-emulator", &[]),
            ("xterm", &[]),
        ];
        let mut failures = Vec::new();

        for (executable, arguments) in terminal_commands {
            let mut command = std::process::Command::new(executable);
            command.args(*arguments).current_dir(&directory);
            if !arguments.is_empty() {
                command.arg(&directory);
            }
            match command.spawn() {
                Ok(_) => return Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => failures.push(format!("{executable}: {error}")),
            }
        }

        let details = if failures.is_empty() {
            String::new()
        } else {
            format!(" ({})", failures.join("; "))
        };
        Err(format!(
            "No supported terminal emulator was found. Install a terminal such as Konsole, GNOME Terminal, or xterm{details}"
        ))
    }
}

#[tauri::command]
fn open_in_file_manager(root: String, path: String) -> Result<(), String> {
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let target = if path.is_empty() {
        root.clone()
    } else {
        workspace_path(&root, &path)?
            .canonicalize()
            .map_err(|error| error.to_string())?
    };
    if !target.starts_with(&root) {
        return Err("Path is outside the active project".into());
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = std::process::Command::new("explorer.exe");
        if target.is_file() {
            command.arg("/select,");
        }
        command
            .arg(&target)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("open");
        if target.is_file() {
            command.arg("-R");
        }
        command
            .arg(&target)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let directory = if target.is_dir() {
            target
        } else {
            target
                .parent()
                .ok_or_else(|| "File has no parent directory".to_string())?
                .to_path_buf()
        };
        std::process::Command::new("xdg-open")
            .arg(directory)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

#[tauri::command]
async fn search_files(
    state: State<'_, DesktopState>,
    root: String,
    query: String,
) -> Result<Vec<String>, String> {
    let indexes = state.file_indexes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(root)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let root_key = root.display().to_string();
        let needle = query.to_lowercase();
        let paths = {
            let mut indexes = indexes
                .lock()
                .map_err(|_| "File index lock failed".to_string())?;
            if let Some((created_at, paths)) = indexes.get(&root_key) {
                if created_at.elapsed() < Duration::from_secs(5) {
                    paths.clone()
                } else {
                    indexes.remove(&root_key);
                    let paths = Arc::new(build_file_index(&root));
                    indexes.insert(root_key, (Instant::now(), paths.clone()));
                    paths
                }
            } else {
                let paths = Arc::new(build_file_index(&root));
                indexes.insert(root_key, (Instant::now(), paths.clone()));
                paths
            }
        };
        let mut matches = paths
            .iter()
            .filter(|path| path.to_lowercase().contains(&needle))
            .take(500)
            .cloned()
            .collect::<Vec<_>>();
        matches.sort_by_key(|path| path.to_lowercase());
        Ok(matches)
    })
    .await
    .map_err(|error| format!("File filter task failed: {error}"))?
}

fn build_file_index(root: &Path) -> Vec<String> {
    let mut pending = vec![root.to_path_buf()];
    let mut paths = Vec::new();
    while let Some(directory) = pending.pop() {
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                if entry.file_name() != "node_modules" {
                    pending.push(entry.path());
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let entry_path = entry.path();
            paths.push(
                entry_path
                    .strip_prefix(root)
                    .unwrap_or(&entry_path)
                    .display()
                    .to_string(),
            );
        }
    }
    paths.sort_by_key(|path| path.to_lowercase());
    paths
}

#[cfg(test)]
mod settings_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn mock_service(responses: Vec<(&'static str, &'static str)>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for (expected_path, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0_u8; 1024];
                let size = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..size]);
                assert!(request.starts_with(&format!("GET {expected_path} ")));
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        format!("http://{address}/v1")
    }

    #[test]
    fn migrates_partial_settings_without_losing_defaults() {
        let settings = parse_client_settings(r#"{"theme":"dark"}"#);
        assert_eq!(settings.version, 3);
        assert_eq!(settings.theme, "dark");
        assert_eq!(settings.locale, "zh-CN");
        assert_eq!(settings.permission_mode, "ask");
        assert_eq!(settings.browser_id, "default");
        assert_eq!(settings.worker_pool_size, 4);
        assert_eq!(settings.left_panel_width, 304);
        assert_eq!(settings.right_panel_width, 420);
        assert_eq!(settings.window_width, 1600);
        assert_eq!(settings.window_height, 920);
    }

    #[test]
    fn accepts_system_theme_preference() {
        let settings = parse_client_settings(r#"{"theme":"system"}"#);
        assert_eq!(settings.theme, "system");
        assert!(validate_client_settings(&settings));
    }

    #[test]
    fn rejects_unknown_setting_values() {
        let settings = ClientSettings {
            version: 3,
            theme: "sepia".into(),
            locale: "zh-CN".into(),
            permission_mode: "ask".into(),
            browser_id: "default".into(),
            worker_pool_size: 4,
            left_panel_width: 304,
            right_panel_width: 420,
            left_panel_hidden: false,
            right_panel_hidden: false,
            window_width: 1600,
            window_height: 920,
            window_maximized: false,
        };
        assert!(!validate_client_settings(&settings));
    }

    #[test]
    fn migrates_and_validates_worker_pool_size() {
        let migrated = parse_client_settings(r#"{"workerPoolSize":1}"#);
        assert_eq!(migrated.worker_pool_size, 4);
        let configured = parse_client_settings(r#"{"workerPoolSize":2}"#);
        assert_eq!(configured.worker_pool_size, 2);
        assert!(validate_client_settings(&configured));
    }

    #[test]
    fn provider_merge_preserves_unknown_configuration() {
        let mut root = serde_json::json!({
            "futureSetting": { "enabled": true },
            "providers": {
                "existing": { "baseUrl": "https://example.test", "unknown": 42 }
            }
        });
        let provider = ProviderDraft {
            id: "local-test".into(),
            name: "Local Test".into(),
            base_url: "http://127.0.0.1:1234/v1".into(),
            api: "openai-completions".into(),
            api_key: String::new(),
            models: vec!["model-a".into()],
            local: true,
        };
        merge_model_provider(&mut root, &provider).unwrap();
        assert_eq!(root["futureSetting"]["enabled"], true);
        assert_eq!(root["providers"]["existing"]["unknown"], 42);
        assert_eq!(
            root["providers"]["local-test"]["models"][0]["id"],
            "model-a"
        );
    }

    #[test]
    fn provider_ids_reject_paths_and_shell_syntax() {
        assert!(valid_provider_id("openai-codex"));
        assert!(valid_provider_id("local_provider_2"));
        assert!(!valid_provider_id("../auth"));
        assert!(!valid_provider_id("openai & calc"));
        assert!(!valid_provider_id(""));
    }

    #[test]
    fn compatibility_provider_catalog_has_unique_ids() {
        let providers = builtin_provider_catalog();
        let ids = providers
            .iter()
            .map(|(id, _, _, _)| *id)
            .collect::<HashSet<_>>();
        assert_eq!(ids.len(), providers.len());
        assert!(providers
            .iter()
            .any(|(id, _, api_key, oauth)| *id == "anthropic" && *api_key && *oauth));
        assert!(providers
            .iter()
            .any(|(id, _, api_key, oauth)| *id == "openai-codex" && !*api_key && *oauth));
    }

    #[test]
    fn detects_ollama_from_root_banner() {
        let base_url = mock_service(vec![("/", "Ollama is running")]);
        let service = tauri::async_runtime::block_on(detect_local_service_impl(&base_url)).unwrap();
        assert_eq!(service.kind, "ollama");
        assert_eq!(service.display_name, "Ollama");
    }

    #[test]
    fn detects_vllm_from_version_endpoint_without_ollama_banner() {
        let base_url = mock_service(vec![
            ("/", "not ollama"),
            ("/version", r#"{"version":"0.25.1"}"#),
        ]);
        let service = tauri::async_runtime::block_on(detect_local_service_impl(&base_url)).unwrap();
        assert_eq!(service.kind, "vllm");
        assert_eq!(service.display_name, "vLLM");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(DesktopState {
            rpcs: Mutex::new(HashMap::new()),
            active_rpc: Mutex::new(None),
            minimum_workers: AtomicUsize::new(4),
            starting_workers: AtomicUsize::new(0),
            pool_cwd: Mutex::new(None),
            hidden_sessions: Mutex::new(HashSet::new()),
            file_indexes: Arc::new(Mutex::new(HashMap::new())),
            preview_server: Mutex::new(None),
        })
        .setup(|app| {
            let _ = tauri::async_runtime::block_on(migrate_misclassified_vllm());
            let state = app.state::<DesktopState>();
            *state
                .hidden_sessions
                .lock()
                .map_err(|_| "Hidden session lock failed")? = load_hidden(&app.handle());
            state.minimum_workers.store(
                get_client_settings(app.handle().clone()).worker_pool_size as usize,
                Ordering::SeqCst,
            );
            let reaper_app = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(2));
                let state = reaper_app.state::<DesktopState>();
                reap_worker_pool(&state, false);
                let minimum = state.minimum_workers.load(Ordering::SeqCst).clamp(2, 4);
                let present =
                    worker_pool_size(&state) + state.starting_workers.load(Ordering::SeqCst);
                let missing = minimum.saturating_sub(present);
                let cwd = state.pool_cwd.lock().ok().and_then(|cwd| cwd.clone());
                if let Some(cwd) = cwd {
                    for _ in 0..missing {
                        let _ = start_pi_worker(&reaper_app, &state, Path::new(&cwd));
                    }
                }
            });
            // Session grants intentionally last only for this desktop run.
            let _ = atomic_write(&permission_state_file(&app.handle())?, b"[]");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_runtime_info,
            list_browsers,
            open_external_url,
            get_client_settings,
            save_client_settings,
            set_session_permission,
            save_model_provider,
            delete_model_provider,
            get_provider_catalog,
            save_provider_api_key,
            logout_provider,
            open_provider_login,
            reload_pi_runtimes,
            detect_local_service,
            discover_local_models,
            list_projects,
            add_workspace,
            session_messages,
            hide_session,
            rename_session,
            spawn_pi_worker,
            resize_pi_pool,
            get_worker_pool_status,
            connect_pi,
            prepare_session,
            create_session,
            pi_command,
            pi_abort,
            close_pi_runtime,
            pi_extension_ui_response,
            update_startup_progress,
            finish_startup,
            project_tree,
            project_context,
            directory_tree,
            read_text_file,
            read_binary_file,
            save_temp_attachment,
            start_workspace_preview,
            write_text_file,
            create_directory,
            move_path,
            copy_path,
            import_external_paths,
            trash_path,
            open_terminal_at,
            open_in_file_manager,
            search_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pi Visual Client");
}
