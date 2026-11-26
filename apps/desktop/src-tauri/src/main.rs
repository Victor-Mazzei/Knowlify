#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod share;

use serde::{Deserialize, Serialize};
use std::{
    ffi::OsStr,
    fs,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::Manager;
use url::Url;

/// Keep one rotated copy of the local server log; growth is bounded by the next launch.
const MAX_SERVER_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// The Tauri bundler installs `externalBin` next to the app executable and drops
/// the target-triple suffix, so the installed name is stable on every platform.
#[cfg(windows)]
const SIDECAR_FILE_NAME: &str = "knowlify-node.exe";
#[cfg(not(windows))]
const SIDECAR_FILE_NAME: &str = "knowlify-node";

fn open_server_log(dir: &std::path::Path, max_bytes: u64) -> Result<fs::File, String> {
    let path = dir.join("server.log");
    if fs::metadata(&path)
        .map(|m| m.len() > max_bytes)
        .unwrap_or(false)
    {
        // Best effort: if the rename fails (e.g. the file is locked), keep appending
        // instead of refusing to start the local server.
        let _ = fs::rename(&path, dir.join("server.log.1"));
    }
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())
}

/// Credentials live in small files that older versions created with the process umask.
/// Reapply owner-only permissions when reading or rewriting them.
#[cfg(unix)]
pub(crate) fn ensure_private_file(path: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    if fs::metadata(path)?.mode() & 0o077 != 0 {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(not(unix))]
pub(crate) fn ensure_private_file(_path: &std::path::Path) -> std::io::Result<()> {
    Ok(())
}

#[derive(Default)]
pub(crate) struct Server(Mutex<Option<Child>>);
impl Server {
    /// True while the child process exists and has not exited on its own.
    pub(crate) fn is_running(&self) -> bool {
        match self.0.lock() {
            Ok(mut slot) => match slot.as_mut() {
                Some(child) => matches!(child.try_wait(), Ok(None)),
                None => false,
            },
            Err(_) => false,
        }
    }

    fn stop(&self) {
        if let Ok(mut slot) = self.0.lock() {
            if let Some(mut child) = slot.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Origin of the server the app is connected to. Navigation is limited to the app itself,
/// the dev server (debug builds), and this exact origin.
#[derive(Default)]
struct NavigationGuard(Mutex<Option<Url>>);

impl NavigationGuard {
    fn allow_server(&self, api_base_url: &str) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = Url::parse(api_base_url).ok();
        }
    }

    fn allows(&self, url: &Url) -> bool {
        let base = self.0.lock().ok().and_then(|slot| (*slot).clone());
        is_allowed_navigation(url, base.as_ref())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    api_base_url: String,
    credentials: Credentials,
}
#[derive(Serialize)]
struct Credentials {
    user: String,
    pass: String,
}

#[derive(Serialize, Deserialize)]
struct Saved {
    mode: String,
    url: Option<String>,
    user: Option<String>,
    pass: Option<String>,
}
#[derive(Serialize)]
struct SavedSummary {
    mode: String,
    url: Option<String>,
    user: Option<String>,
}

pub(crate) fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("connection.json"))
}

pub(crate) fn read_saved(app: &tauri::AppHandle) -> Option<Saved> {
    let path = config_path(app).ok()?;
    // Reading is the first touch in a launch; tighten permissions left by older versions.
    let _ = ensure_private_file(&path);
    let raw = fs::read_to_string(path).ok()?;
    let saved: Saved = serde_json::from_str(&raw).ok()?;
    if !matches!(saved.mode.as_str(), "local" | "remote") {
        return None;
    }
    if saved.mode == "local"
        && (saved.url.is_some() || saved.user.is_some() || saved.pass.is_some())
    {
        // Older builds persisted the remote form fields in local mode; scrub them
        // instead of leaving a server password on disk for a connection that never uses it.
        let scrubbed = saved_connection("local", None, None, None);
        let _ = write_saved(app, &scrubbed);
        return Some(scrubbed);
    }
    Some(saved)
}

fn write_saved(app: &tauri::AppHandle, saved: &Saved) -> Result<(), String> {
    use std::io::Write;
    let path = config_path(app)?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let body = serde_json::to_vec(saved).map_err(|e| e.to_string())?;
    options
        .open(&path)
        .and_then(|mut f| f.write_all(&body))
        .map_err(|e| e.to_string())?;
    ensure_private_file(&path).map_err(|e| e.to_string())
}

/// Why the Node runtime that runs the local server could not be resolved.
#[derive(Debug, PartialEq, Eq)]
enum NodeExecutableError {
    OverrideNotAbsolute(PathBuf),
    OverrideMissing(PathBuf),
    OverrideNotFile(PathBuf),
    SidecarMissing(PathBuf),
}

impl std::fmt::Display for NodeExecutableError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OverrideNotAbsolute(path) => write!(
                f,
                "KNOWLIFY_NODE must be an absolute path to the Node executable, got \"{}\".",
                path.display()
            ),
            Self::OverrideMissing(path) => write!(
                f,
                "KNOWLIFY_NODE points to a file that does not exist: \"{}\".",
                path.display()
            ),
            Self::OverrideNotFile(path) => write!(
                f,
                "KNOWLIFY_NODE must point to the Node executable file, not \"{}\".",
                path.display()
            ),
            Self::SidecarMissing(path) => write!(
                f,
                "The bundled Node runtime is missing ({}). Reinstall Knowlify.",
                path.display()
            ),
        }
    }
}

/// Classifies a path for the lookup below: `Some(true)` for a regular file,
/// `Some(false)` for any other existing entry, `None` when it does not exist.
fn regular_file(path: &Path) -> Option<bool> {
    fs::metadata(path).ok().map(|metadata| metadata.is_file())
}

/// Picks the Node binary for the local server. An explicit `KNOWLIFY_NODE`
/// override wins, then the sidecar installed next to the app executable. Only
/// debug builds may fall back to `node` from `PATH`; a release build never
/// searches `PATH` and fails with a clear error when the sidecar is absent.
fn node_executable(
    exe_dir: &Path,
    override_path: Option<&OsStr>,
    allow_path_fallback: bool,
    sidecar_name: &str,
    probe: impl Fn(&Path) -> Option<bool>,
) -> Result<PathBuf, NodeExecutableError> {
    if let Some(value) = override_path {
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err(NodeExecutableError::OverrideNotAbsolute(path));
        }
        match probe(&path) {
            Some(true) => return Ok(path),
            Some(false) => return Err(NodeExecutableError::OverrideNotFile(path)),
            None => return Err(NodeExecutableError::OverrideMissing(path)),
        }
    }
    let sidecar = exe_dir.join(sidecar_name);
    if matches!(probe(&sidecar), Some(true)) {
        return Ok(sidecar);
    }
    if allow_path_fallback {
        return Ok(PathBuf::from("node"));
    }
    Err(NodeExecutableError::SidecarMissing(sidecar))
}

/// Resolves the runtime for the current launch. A blank `KNOWLIFY_NODE` counts
/// as unset; any other value must name an existing absolute file.
pub(crate) fn resolve_node_executable() -> Result<PathBuf, String> {
    let current_exe = std::env::current_exe()
        .map_err(|e| format!("Cannot locate the Knowlify executable: {e}"))?;
    let exe_dir = current_exe
        .parent()
        .ok_or_else(|| "The Knowlify executable has no parent directory.".to_string())?;
    let override_path = std::env::var_os("KNOWLIFY_NODE").filter(|value| !value.is_empty());
    node_executable(
        exe_dir,
        override_path.as_deref(),
        cfg!(debug_assertions),
        SIDECAR_FILE_NAME,
        regular_file,
    )
    .map_err(|error| error.to_string())
}

/// Explains a failed spawn: release builds ship their own runtime, while debug
/// builds may still rely on the system Node.
fn spawn_error(error: &std::io::Error) -> String {
    if cfg!(debug_assertions) {
        format!("Cannot start Node: {error}. Install Node or set KNOWLIFY_NODE.")
    } else {
        format!("Cannot start the bundled Node runtime: {error}. Reinstall Knowlify.")
    }
}

/// Builds the persisted view of a connection. Local mode has no server URL or
/// credentials, so remote values left in the form are never written to disk.
fn saved_connection(
    mode: &str,
    url: Option<String>,
    user: Option<String>,
    pass: Option<String>,
) -> Saved {
    if mode == "remote" {
        Saved {
            mode: mode.to_string(),
            url: url.map(|value| value.trim().to_string()),
            user,
            pass,
        }
    } else {
        Saved {
            mode: mode.to_string(),
            url: None,
            user: None,
            pass: None,
        }
    }
}

/// Remembers the last working connection so the next launch connects on its own.
#[tauri::command]
async fn connect(
    app: tauri::AppHandle,
    mode: String,
    url: Option<String>,
    user: Option<String>,
    pass: Option<String>,
) -> Result<Connection, String> {
    let saved = saved_connection(&mode, url.clone(), user.clone(), pass.clone());
    let connection = establish(app.clone(), mode, url, user, pass).await?;
    write_saved(&app, &saved)?;
    Ok(connection)
}

#[tauri::command]
async fn connect_saved(app: tauri::AppHandle) -> Result<Connection, String> {
    let saved = read_saved(&app).ok_or("No saved connection")?;
    establish(app, saved.mode, saved.url, saved.user, saved.pass).await
}

/// Non-secret view of the saved connection, used to prefill the settings form.
#[tauri::command]
fn saved_summary(app: tauri::AppHandle) -> Option<SavedSummary> {
    read_saved(&app).map(|s| SavedSummary {
        mode: s.mode,
        url: s.url,
        user: s.user,
    })
}

/// One launch of the local server. A fixed port is attempted once (no silent
/// fallback to another port); an ephemeral port keeps the three attempts from
/// earlier versions.
struct LocalServerSpec<'a> {
    bind_lan: bool,
    fixed_port: Option<u16>,
    password: &'a str,
    force_env_password: bool,
    web_dir: &'a Path,
}

fn start_local_server(
    handle: &tauri::AppHandle,
    slot: &mut Option<Child>,
    dir: &Path,
    server_dir: &Path,
    node: &Path,
    spec: &LocalServerSpec<'_>,
) -> Result<Connection, String> {
    let attempts = if spec.fixed_port.is_some() { 1 } else { 3 };
    let mut last_error = String::new();
    for _ in 0..attempts {
        let port = match spec.fixed_port {
            Some(port) => port,
            None => {
                let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
                let port = listener.local_addr().map_err(|e| e.to_string())?.port();
                drop(listener);
                port
            }
        };
        let log = open_server_log(dir, MAX_SERVER_LOG_BYTES)?;
        let env = share::server_env(&share::ServerEnvInput {
            bind_lan: spec.bind_lan,
            force_env_password: spec.force_env_password,
            password: spec.password,
            data_dir: dir,
            web_dir: spec.web_dir,
            port,
        });
        let mut command = Command::new(node);
        command
            .arg(server_dir.join("dist/index.js"))
            .current_dir(server_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
            .stderr(Stdio::from(log));
        env.apply(&mut command);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let child = command.spawn().map_err(|e| spawn_error(&e))?;
        *slot = Some(child);
        // Keep ownership in state even if readiness checks fail or the app exits.
        let base = format!("http://127.0.0.1:{port}");
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_millis(500))
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())?;
        for _ in 0..40 {
            // The child was stored just above; treat an unexpected empty slot as a failed start.
            let Some(child) = slot.as_mut() else {
                break;
            };
            if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                break;
            }
            // `/health` is public, so the readiness probe never sends the password to a
            // process that may have won the port race after we released it.
            if client
                .get(format!("{base}/health"))
                .send()
                .map(|r| r.status().is_success())
                .unwrap_or(false)
            {
                handle.state::<NavigationGuard>().allow_server(&base);
                return Ok(Connection {
                    api_base_url: base,
                    credentials: Credentials {
                        user: "desktop".into(),
                        pass: spec.password.into(),
                    },
                });
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let log_path = dir.join("server.log");
        last_error = match spec.fixed_port {
            Some(port) => format!(
                "Local server did not start on port {port}. Check {} (including Node/SQLite compatibility).",
                log_path.display()
            ),
            None => format!(
                "Local server did not start. Check {} (including Node/SQLite compatibility).",
                log_path.display()
            ),
        };
    }
    Err(last_error)
}

pub(crate) async fn establish(
    app: tauri::AppHandle,
    mode: String,
    url: Option<String>,
    user: Option<String>,
    pass: Option<String>,
) -> Result<Connection, String> {
    // Serialize connection attempts; blocking process startup stays off the UI thread.
    let handle = app.clone();
    let result: Result<Connection, String> = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<Server>();
        let mut slot = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if mode == "remote" {
            let raw = url.unwrap_or_default();
            let api_base_url = validate_remote_url(&raw)?;
            handle
                .state::<NavigationGuard>()
                .allow_server(&api_base_url);
            return Ok(Connection {
                api_base_url,
                credentials: Credentials {
                    user: user.unwrap_or_default(),
                    pass: pass.unwrap_or_default(),
                },
            });
        }
        if mode != "local" {
            return Err("Unknown connection mode".into());
        }
        let dir = app_data_dir(&handle)?;
        let share_config = share::read_share_config(&dir);
        let share_state = handle.state::<share::ShareState>();
        share_state.reset();
        let password = if share_config.enabled {
            share::read_or_create_share_password(&dir)?
        } else {
            share::local_password(&dir)?
        };
        let server_dir: PathBuf = if cfg!(debug_assertions) {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/server")
        } else {
            handle
                .path()
                .resource_dir()
                .map_err(|e| e.to_string())?
                .join("server")
        };
        let web_dir = server_dir.join("web");
        let node = resolve_node_executable()?;

        if share_config.enabled {
            // An occupied fixed port must not silently move to another port: the QR
            // code and bookmarks would break. The app keeps working on loopback and
            // the status tells the UI to offer Retry or another port.
            if !share::is_port_available(share_config.port) {
                share_state.set_error(share::ShareError::port_in_use(share_config.port));
                let connection = start_local_server(
                    &handle,
                    &mut slot,
                    &dir,
                    &server_dir,
                    &node,
                    &LocalServerSpec {
                        bind_lan: false,
                        fixed_port: None,
                        password: &password,
                        force_env_password: true,
                        web_dir: &web_dir,
                    },
                )?;
                share_state.set_running(false);
                return Ok(connection);
            }
            let shared = LocalServerSpec {
                bind_lan: true,
                fixed_port: Some(share_config.port),
                password: &password,
                force_env_password: true,
                web_dir: &web_dir,
            };
            match start_local_server(&handle, &mut slot, &dir, &server_dir, &node, &shared) {
                Ok(connection) => {
                    share_state.set_running(true);
                    if share::lan_ipv4().is_none() {
                        share_state.set_error(share::ShareError::no_network());
                    }
                    return Ok(connection);
                }
                Err(_) => {
                    // The port was free when checked but Node lost the race or failed
                    // to boot: report it and keep the app usable on loopback.
                    share_state.set_error(share::ShareError::start_failed(share_config.port));
                    let fallback = LocalServerSpec {
                        bind_lan: false,
                        fixed_port: None,
                        password: &password,
                        force_env_password: true,
                        web_dir: &web_dir,
                    };
                    let connection = start_local_server(
                        &handle,
                        &mut slot,
                        &dir,
                        &server_dir,
                        &node,
                        &fallback,
                    )?;
                    share_state.set_running(false);
                    return Ok(connection);
                }
            }
        }

        let local = LocalServerSpec {
            bind_lan: false,
            fixed_port: None,
            password: &password,
            force_env_password: false,
            web_dir: &web_dir,
        };
        let connection = start_local_server(&handle, &mut slot, &dir, &server_dir, &node, &local)?;
        share_state.set_running(false);
        Ok(connection)
    })
    .await
    .map_err(|e| e.to_string())?;
    result
}

/// Plain HTTP is only acceptable where the traffic stays local: loopback, RFC1918/ULA
/// addresses, CGNAT/Tailscale (100.64.0.0/10), `localhost`, single-label hostnames, and the
/// usual LAN suffixes. Public hosts must use HTTPS because the desktop sends Basic
/// credentials to them.
pub(crate) fn is_cgnat(ip: std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

fn is_local_http_url(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback() || ip.is_private() || is_cgnat(ip),
        Some(url::Host::Ipv6(ip)) => {
            if ip.is_loopback() {
                return true;
            }
            let octets = ip.octets();
            let mapped = octets[..10].iter().all(|byte| *byte == 0)
                && octets[10] == 0xff
                && octets[11] == 0xff;
            if mapped {
                let ipv4 = std::net::Ipv4Addr::new(octets[12], octets[13], octets[14], octets[15]);
                return ipv4.is_private() || is_cgnat(ipv4);
            }
            // Unique local addresses (fc00::/7), the IPv6 equivalent of RFC1918.
            (octets[0] & 0xfe) == 0xfc
        }
        Some(url::Host::Domain(host)) => {
            let host = host.trim_end_matches('.').to_ascii_lowercase();
            host == "localhost"
                || host.ends_with(".local")
                || host.ends_with(".lan")
                || host.ends_with(".home.arpa")
                || (!host.is_empty() && !host.contains('.'))
        }
        None => false,
    }
}

/// Validates the remote server URL for remote mode: must be HTTP or HTTPS with a valid host,
/// without embedded credentials, query parameters, or fragments. Returns the base URL with trailing slashes stripped.
pub fn validate_remote_url(raw: &str) -> Result<String, String> {
    let parsed =
        Url::parse(raw.trim()).map_err(|_| "Enter a full http:// or https:// server URL")?;
    if !["http", "https"].contains(&parsed.scheme())
        || parsed.host_str().unwrap_or("").is_empty()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Use an HTTP(S) URL without embedded credentials, query, or fragment".into());
    }
    if parsed.scheme() == "http" && !is_local_http_url(&parsed) {
        return Err("Use HTTPS or a local address".into());
    }
    Ok(parsed.as_str().trim_end_matches('/').into())
}

fn is_app_origin(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost") && url.port().is_none(),
        "http" | "https" => url.host_str() == Some("tauri.localhost") && url.port().is_none(),
        _ => false,
    }
}

#[cfg(debug_assertions)]
fn is_dev_origin(url: &Url) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("localhost")
        && url.port_or_known_default() == Some(5174)
}

#[cfg(not(debug_assertions))]
fn is_dev_origin(_url: &Url) -> bool {
    false
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

/// Pure filter for webview navigation: allows the desktop app itself, the Vite dev server
/// (debug builds), the exact origin of the current server, and about:/blob: documents created
/// by one of those origins. External sites, other local ports, file: URLs, and other schemes
/// are blocked.
pub fn is_allowed_navigation(url: &Url, server_base: Option<&Url>) -> bool {
    let is_allowed_origin = |candidate: &Url| {
        is_app_origin(candidate)
            || is_dev_origin(candidate)
            || server_base.is_some_and(|base| same_origin(candidate, base))
    };
    match url.scheme() {
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        // `blob:<origin>/<uuid>`: judge the origin that created the blob.
        "blob" => Url::parse(url.path())
            .map(|inner| is_allowed_origin(&inner))
            .unwrap_or(false),
        _ => is_allowed_origin(url),
    }
}

/// Validates an external URL intended to be opened in the system default browser.
/// Accepts only http and https schemes with a valid host.
/// Rejects non-HTTP schemes (file:, javascript:, data:, etc.), URLs with embedded credentials,
/// and plain HTTP to public hosts (the browser would send traffic unencrypted).
pub fn validate_external_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("URL cannot be empty".into());
    }
    let parsed = Url::parse(trimmed).map_err(|e| format!("Invalid URL: {e}"))?;
    if !["http", "https"].contains(&parsed.scheme()) {
        return Err(format!(
            "Only HTTP and HTTPS URLs are allowed, got scheme '{}'",
            parsed.scheme()
        ));
    }
    if parsed.host_str().unwrap_or("").is_empty() {
        return Err("URL must contain a valid host".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URLs with embedded credentials are not allowed".into());
    }
    if parsed.scheme() == "http" && !is_local_http_url(&parsed) {
        return Err("Use HTTPS or a local address".into());
    }
    Ok(parsed)
}

/// Opens an external HTTP(S) URL in the system's default browser.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let parsed = validate_external_url(&url)?;
    open::that_detached(parsed.as_str())
        .map_err(|e| format!("Failed to open external URL in browser: {e}"))
}

/// Dev builds only: lets bootstrap.js forward webview errors to the terminal running `tauri dev`.
#[tauri::command]
fn js_log(level: String, message: String) {
    if cfg!(debug_assertions) {
        eprintln!("[webview {level}] {message}");
    }
}

fn main() {
    tauri::Builder::default()
        // Native folder picker for local mode; the webview only holds `dialog:allow-open`.
        .plugin(tauri_plugin_dialog::init())
        .manage(Server::default())
        .manage(NavigationGuard::default())
        .manage(share::ShareState::default())
        .invoke_handler(tauri::generate_handler![
            connect,
            connect_saved,
            saved_summary,
            js_log,
            open_external,
            share::share_status,
            share::set_share,
            share::rotate_share_password
        ])
        .setup(|app| {
            let navigation = app.handle().clone();
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Knowlify")
            .inner_size(1120.0, 800.0)
            .initialization_script(format!(
                "window.__KNOWLIFY_LAUNCH__ = {};\n{}",
                serde_json::to_string(&format!("{:?}", std::time::SystemTime::now()))?,
                include_str!("bootstrap.js")
            ))
            .on_navigation(move |url| navigation.state::<NavigationGuard>().allows(url))
            .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Cannot initialize Knowlify")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                app.state::<Server>().stop();
            }
        });
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::ensure_private_file;
    use super::{
        is_allowed_navigation, is_local_http_url, node_executable, open_server_log, regular_file,
        saved_connection, validate_external_url, validate_remote_url, NavigationGuard,
        NodeExecutableError,
    };
    use std::{ffi::OsStr, fs, path::PathBuf};
    use url::Url;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "knowlify-desktop-test-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn test_open_server_log_rotates_past_limit() {
        let dir = temp_dir("log-rotate");
        let log = dir.join("server.log");
        let backup = dir.join("server.log.1");
        fs::write(&log, b"0123456789A").expect("write log");
        fs::write(&backup, b"previous").expect("write backup");
        {
            use std::io::Write;
            let mut file = open_server_log(&dir, 10).expect("open log");
            file.write_all(b"new").expect("append log");
        }
        assert_eq!(fs::read(&log).expect("read log"), b"new");
        assert_eq!(fs::read(&backup).expect("read backup"), b"0123456789A");
        fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    #[test]
    fn test_open_server_log_appends_until_limit() {
        let dir = temp_dir("log-append");
        let log = dir.join("server.log");
        // Exactly at the limit: still append, rotating only when the size is exceeded.
        fs::write(&log, b"0123456789").expect("write log");
        {
            use std::io::Write;
            let mut file = open_server_log(&dir, 10).expect("open log");
            file.write_all(b"x").expect("append log");
        }
        assert_eq!(fs::read(&log).expect("read log"), b"0123456789x");
        assert!(!dir.join("server.log.1").exists());
        fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    #[cfg(unix)]
    #[test]
    fn test_ensure_private_file_tightens_loose_permissions() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let dir = temp_dir("private-file");
        let path = dir.join("connection.json");
        fs::write(&path, b"{}").expect("write file");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("chmod 644");
        ensure_private_file(&path).expect("tighten permissions");
        assert_eq!(fs::metadata(&path).expect("metadata").mode() & 0o777, 0o600);
        fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    fn url(value: &str) -> Url {
        Url::parse(value).expect("test URL must parse")
    }

    #[test]
    fn test_is_allowed_navigation_app_origins() {
        let base = url("http://127.0.0.1:8787");
        assert!(is_allowed_navigation(
            &url("tauri://localhost/index.html"),
            None
        ));
        assert!(is_allowed_navigation(&url("tauri://localhost"), None));
        assert!(is_allowed_navigation(&url("http://tauri.localhost/"), None));
        assert!(is_allowed_navigation(
            &url("https://tauri.localhost/books"),
            None
        ));
        assert!(is_allowed_navigation(
            &url("http://127.0.0.1:8787/api/books"),
            Some(&base)
        ));
        assert!(is_allowed_navigation(
            &url("http://127.0.0.1:8787/"),
            Some(&base)
        ));
    }

    #[test]
    fn test_is_allowed_navigation_rejects_other_local_ports() {
        let base = url("http://127.0.0.1:8787");
        assert!(!is_allowed_navigation(
            &url("http://127.0.0.1:9999/api/books"),
            Some(&base)
        ));
        assert!(!is_allowed_navigation(
            &url("http://localhost:8787/api/books"),
            Some(&base)
        ));
        assert!(!is_allowed_navigation(
            &url("https://127.0.0.1:8787/api/books"),
            Some(&base)
        ));
        assert!(!is_allowed_navigation(
            &url("http://127.0.0.1:8787/api/books"),
            None
        ));
    }

    #[test]
    fn test_is_allowed_navigation_remote_origin_is_exact() {
        let base = url("https://books.example.com");
        assert!(is_allowed_navigation(
            &url("https://books.example.com/reader"),
            Some(&base)
        ));
        assert!(!is_allowed_navigation(
            &url("https://books.example.com:8443/reader"),
            Some(&base)
        ));
        assert!(!is_allowed_navigation(
            &url("http://books.example.com/reader"),
            Some(&base)
        ));
        assert!(!is_allowed_navigation(
            &url("https://other.example.com"),
            Some(&base)
        ));
    }

    #[test]
    fn test_is_allowed_navigation_rejects_lookalike_origins() {
        assert!(!is_allowed_navigation(&url("tauri://evil"), None));
        assert!(!is_allowed_navigation(
            &url("tauri://localhost.evil.com"),
            None
        ));
        assert!(!is_allowed_navigation(
            &url("http://tauri.localhost:8080/"),
            None
        ));
        assert!(!is_allowed_navigation(
            &url("https://tauri.localhost.evil.com/"),
            None
        ));
        assert!(!is_allowed_navigation(
            &url("http://127.0.0.1.evil.com/"),
            None
        ));
    }

    #[test]
    fn test_is_allowed_navigation_about_and_blob_urls() {
        let base = url("http://127.0.0.1:8787");
        assert!(is_allowed_navigation(&url("about:srcdoc"), None));
        assert!(is_allowed_navigation(&url("about:blank"), None));
        assert!(!is_allowed_navigation(&url("about:config"), None));
        assert!(is_allowed_navigation(
            &url("blob:http://127.0.0.1:8787/uuid"),
            Some(&base)
        ));
        assert!(is_allowed_navigation(
            &url("blob:tauri://localhost/uuid"),
            None
        ));
        assert!(is_allowed_navigation(
            &url("blob:https://tauri.localhost/uuid"),
            None
        ));
        assert!(!is_allowed_navigation(
            &url("blob:http://127.0.0.1:9999/uuid"),
            Some(&base)
        ));
        assert!(!is_allowed_navigation(
            &url("blob:http://localhost.evil.com/uuid"),
            None
        ));
        assert!(!is_allowed_navigation(
            &url("blob:https://evil.com/localhost"),
            None
        ));
        assert!(!is_allowed_navigation(&url("blob:not a url"), None));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn test_is_allowed_navigation_dev_server_in_debug() {
        assert!(is_allowed_navigation(&url("http://localhost:5174/"), None));
        assert!(is_allowed_navigation(
            &url("blob:http://localhost:5174/uuid"),
            None
        ));
        assert!(!is_allowed_navigation(&url("http://localhost:5175/"), None));
        assert!(!is_allowed_navigation(&url("http://127.0.0.1:5174/"), None));
    }

    #[test]
    fn test_is_allowed_navigation_blocked_urls() {
        let base = url("http://127.0.0.1:8787");
        assert!(!is_allowed_navigation(
            &url("blob:https://example.com/test-uuid"),
            Some(&base)
        ));
        assert!(!is_allowed_navigation(
            &url("blob:http://external.site/test-uuid"),
            Some(&base)
        ));
        assert!(!is_allowed_navigation(
            &url("https://example.com"),
            Some(&base)
        ));
        assert!(!is_allowed_navigation(
            &url("http://example.com/page"),
            Some(&base)
        ));
        assert!(!is_allowed_navigation(&url("file:///etc/passwd"), None));
        assert!(!is_allowed_navigation(&url("javascript:alert(1)"), None));
        assert!(!is_allowed_navigation(&url("data:text/html,hello"), None));
    }

    #[test]
    fn test_navigation_guard_tracks_current_server() {
        let guard = NavigationGuard::default();
        let server = url("http://127.0.0.1:8787/");
        assert!(!guard.allows(&server));
        guard.allow_server("http://127.0.0.1:8787");
        assert!(guard.allows(&server));
        guard.allow_server("not a url");
        assert!(!guard.allows(&server));
    }

    #[test]
    fn test_is_local_http_url() {
        for allowed in [
            "http://localhost:8787",
            "http://nas:8787",
            "http://nas.local:8787",
            "http://nas.lan:8787",
            "http://nas.home.arpa:8787",
            "http://127.0.0.1:8787",
            "http://127.10.0.2:8787",
            "http://10.1.2.3:8787",
            "http://172.16.0.1:8787",
            "http://192.168.1.20:8787",
            "http://100.64.0.0:8787",
            "http://100.101.101.101:8787",
            "http://100.127.255.255:8787",
            "http://[::1]:8787",
            "http://[fd00::1]:8787",
            "http://[::ffff:192.168.1.20]:8787",
            "http://[::ffff:100.64.0.1]:8787",
        ] {
            assert!(
                is_local_http_url(&url(allowed)),
                "{allowed} should be local"
            );
        }
        for blocked in [
            "http://example.com",
            "http://203.0.113.5",
            "http://100.63.255.255:8787",
            "http://100.128.0.0:8787",
            "http://[2001:db8::1]",
            "http://[fe80::1]",
            "http://[::ffff:100.128.0.1]:8787",
        ] {
            assert!(
                !is_local_http_url(&url(blocked)),
                "{blocked} should not be local"
            );
        }
    }

    #[test]
    fn test_validate_external_url() {
        assert!(validate_external_url("https://example.com/news?item=1#anchor").is_ok());
        assert!(validate_external_url("  https://knowlify.app  ").is_ok());
        assert!(validate_external_url("http://localhost:8080").is_ok());
        assert!(validate_external_url("http://127.0.0.1:8080").is_ok());
        assert!(validate_external_url("http://192.168.1.20:8080").is_ok());
        assert!(validate_external_url("http://nas.local").is_ok());
        assert_eq!(
            validate_external_url("http://example.com").unwrap_err(),
            "Use HTTPS or a local address"
        );

        assert!(validate_external_url("file:///etc/passwd").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("data:text/html,<b>hi</b>").is_err());
        assert!(validate_external_url("http://user:pass@example.com").is_err());
        assert!(validate_external_url("https://user@example.com").is_err());
        assert!(validate_external_url("not a url").is_err());
        assert!(validate_external_url("").is_err());
        assert!(validate_external_url("http://").is_err());
        assert!(validate_external_url("http://:80").is_err());
    }

    #[test]
    fn test_validate_remote_url() {
        assert_eq!(
            validate_remote_url("http://localhost:8787").unwrap(),
            "http://localhost:8787"
        );
        assert!(validate_remote_url("http://192.168.1.10:8787").is_ok());
        assert!(validate_remote_url("http://100.101.1.2:8787").is_ok());
        assert!(validate_remote_url("http://nas:8787").is_ok());
        assert!(validate_remote_url("http://[::1]:8787").is_ok());
        assert_eq!(
            validate_remote_url("https://books.example.com/").unwrap(),
            "https://books.example.com"
        );
        assert_eq!(
            validate_remote_url("https://books.example.com:8443").unwrap(),
            "https://books.example.com:8443"
        );
        assert_eq!(
            validate_remote_url("http://example.com").unwrap_err(),
            "Use HTTPS or a local address"
        );

        // Embedded credentials rejected
        assert!(validate_remote_url("http://user:pass@example.com").is_err());
        assert!(validate_remote_url("https://user@example.com").is_err());

        // Query rejected
        assert!(validate_remote_url("https://example.com/?foo=bar").is_err());

        // Fragment rejected
        assert!(validate_remote_url("https://example.com/#section").is_err());

        // Non-http/https schemes rejected
        assert!(validate_remote_url("ftp://example.com").is_err());
        assert!(validate_remote_url("file:///path").is_err());
        assert!(validate_remote_url("javascript:void(0)").is_err());

        // Invalid or empty URLs rejected
        assert!(validate_remote_url("").is_err());
        assert!(validate_remote_url("not-a-url").is_err());
    }

    #[test]
    fn test_saved_connection_drops_remote_fields_in_local_mode() {
        let saved = saved_connection(
            "local",
            Some("https://books.example.com".into()),
            Some("reader".into()),
            Some("s3cret".into()),
        );
        assert_eq!(saved.mode, "local");
        assert_eq!(saved.url, None);
        assert_eq!(saved.user, None);
        assert_eq!(saved.pass, None);
    }

    #[test]
    fn test_saved_connection_keeps_and_trims_remote_fields() {
        let saved = saved_connection(
            "remote",
            Some("  https://books.example.com  ".into()),
            Some("reader".into()),
            Some("s3cret".into()),
        );
        assert_eq!(saved.mode, "remote");
        assert_eq!(saved.url.as_deref(), Some("https://books.example.com"));
        assert_eq!(saved.user.as_deref(), Some("reader"));
        assert_eq!(saved.pass.as_deref(), Some("s3cret"));
    }

    #[test]
    fn test_capability_exposes_only_the_open_dialog() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main.json"))
                .expect("capabilities/main.json must be valid JSON");
        let permissions: Vec<&str> = capability["permissions"]
            .as_array()
            .expect("permissions must be an array")
            .iter()
            .map(|permission| {
                permission
                    .as_str()
                    .expect("permission identifiers must be strings")
            })
            .collect();

        // The folder picker needs `open`; other dialog commands stay unavailable, and the
        // webview gains no filesystem or shell access.
        assert_eq!(permissions, ["core:default", "dialog:allow-open"]);
    }

    const SIDECAR: &str = "knowlify-node";

    fn resolve_node(
        exe_dir: &std::path::Path,
        override_path: Option<&OsStr>,
        allow_path_fallback: bool,
    ) -> Result<PathBuf, NodeExecutableError> {
        node_executable(
            exe_dir,
            override_path,
            allow_path_fallback,
            SIDECAR,
            regular_file,
        )
    }

    #[test]
    fn test_node_executable_uses_the_sidecar_next_to_the_app() {
        let dir = temp_dir("node-sidecar");
        let sidecar = dir.join(SIDECAR);
        fs::write(&sidecar, b"fake node").expect("write sidecar");
        assert_eq!(
            resolve_node(&dir, None, false).expect("resolve sidecar"),
            sidecar
        );
        fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    #[test]
    fn test_node_executable_prefers_an_explicit_override() {
        let dir = temp_dir("node-override");
        fs::write(dir.join(SIDECAR), b"fake sidecar").expect("write sidecar");
        let custom_dir = dir.join("custom");
        fs::create_dir_all(&custom_dir).expect("create custom dir");
        let custom = custom_dir.join("node-custom");
        fs::write(&custom, b"fake node").expect("write custom node");
        assert_eq!(
            resolve_node(&dir, Some(custom.as_os_str()), false).expect("resolve override"),
            custom
        );
        fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    #[test]
    fn test_node_executable_rejects_a_relative_override() {
        let dir = temp_dir("node-override-relative");
        let error = resolve_node(&dir, Some(OsStr::new("node")), false)
            .expect_err("a relative override must be refused");
        assert_eq!(
            error,
            NodeExecutableError::OverrideNotAbsolute(PathBuf::from("node"))
        );
        fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    #[test]
    fn test_node_executable_rejects_a_missing_override() {
        let dir = temp_dir("node-override-missing");
        let missing = dir.join("missing-node");
        let error = resolve_node(&dir, Some(missing.as_os_str()), false)
            .expect_err("a missing override must be refused");
        assert_eq!(error, NodeExecutableError::OverrideMissing(missing));
        fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    #[test]
    fn test_node_executable_rejects_a_directory_override() {
        let dir = temp_dir("node-override-dir");
        let error = resolve_node(&dir, Some(dir.as_os_str()), false)
            .expect_err("a directory override must be refused");
        assert_eq!(error, NodeExecutableError::OverrideNotFile(dir.clone()));
        fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    #[test]
    fn test_node_executable_release_requires_the_sidecar() {
        let dir = temp_dir("node-sidecar-missing");
        let error =
            resolve_node(&dir, None, false).expect_err("release builds must not fall back to PATH");
        assert_eq!(
            error,
            NodeExecutableError::SidecarMissing(dir.join(SIDECAR))
        );
        fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    #[test]
    fn test_node_executable_release_ignores_a_sidecar_directory() {
        let dir = temp_dir("node-sidecar-dir");
        fs::create_dir(dir.join(SIDECAR)).expect("create sidecar dir");
        let error =
            resolve_node(&dir, None, false).expect_err("a sidecar directory is not an executable");
        assert_eq!(
            error,
            NodeExecutableError::SidecarMissing(dir.join(SIDECAR))
        );
        fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    #[test]
    fn test_node_executable_debug_falls_back_to_path() {
        let dir = temp_dir("node-debug-fallback");
        assert_eq!(
            resolve_node(&dir, None, true).expect("debug fallback"),
            PathBuf::from("node")
        );
        fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    #[test]
    fn test_node_executable_uses_the_windows_sidecar_name() {
        let dir = temp_dir("node-sidecar-exe");
        let sidecar = dir.join("knowlify-node.exe");
        fs::write(&sidecar, b"fake node").expect("write sidecar");
        let resolved = node_executable(&dir, None, false, "knowlify-node.exe", regular_file)
            .expect("resolve Windows sidecar");
        assert_eq!(resolved, sidecar);
        // The extension-less name is not a candidate on Windows.
        assert!(node_executable(&dir, None, false, "knowlify-node", regular_file).is_err());
        fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    /// Mirrors an installed layout: a fake `knowlify-node` script next to the app.
    #[cfg(unix)]
    #[test]
    fn test_node_executable_finds_a_fake_sidecar_script() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;

        let dir = temp_dir("node-sidecar-script");
        let sidecar = dir.join(SIDECAR);
        fs::write(&sidecar, b"#!/bin/sh\necho v26.13.1\n").expect("write sidecar");
        fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o755)).expect("chmod sidecar");
        let resolved = resolve_node(&dir, None, false).expect("resolve sidecar");
        assert_eq!(resolved, sidecar);
        let output = Command::new(&resolved)
            .arg("--version")
            .output()
            .expect("run fake sidecar");
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "v26.13.1");
        fs::remove_dir_all(&dir).expect("remove temp dir");
    }
}
