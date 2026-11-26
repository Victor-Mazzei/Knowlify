//! LAN sharing for the desktop app: persisted intent in `share.json`, the share
//! password, the environment handed to the local server, LAN address discovery
//! and the IPC commands behind the Settings card.

use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    net::{Ipv4Addr, TcpListener, UdpSocket},
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};
use tauri::Manager;

pub const DEFAULT_SHARE_PORT: u16 = 47_870;
pub const SHARE_PASSWORD_LENGTH: usize = 16;
const MIN_SHARE_PORT: u16 = 1024;
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SHARE_USER: &str = "desktop";

/// Variables the child process must never inherit from the user session: code
/// injection into the bundled runtime, a forgeable proxy, and MCP host/origin
/// allowlists that must not come from the shell.
const REMOVED_ENV: [&str; 6] = [
    "NODE_OPTIONS",
    "NODE_PATH",
    "KNOWLIFY_NODE",
    "KNOWLIFY_TRUST_PROXY",
    "KNOWLIFY_MCP_ALLOWED_HOSTS",
    "KNOWLIFY_MCP_ALLOWED_ORIGINS",
];

/// Persisted sharing intent. `port` is kept while sharing is off so turning the
/// switch back on reuses the user's choice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ShareConfig {
    pub enabled: bool,
    pub port: u16,
}

impl Default for ShareConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_SHARE_PORT,
        }
    }
}

impl ShareConfig {
    fn sanitized(self) -> Self {
        Self {
            enabled: self.enabled,
            port: normalize_port(self.port),
        }
    }
}

pub fn normalize_port(port: u16) -> u16 {
    if port >= MIN_SHARE_PORT {
        port
    } else {
        DEFAULT_SHARE_PORT
    }
}

pub fn validate_port(port: u16) -> Result<u16, String> {
    if port >= MIN_SHARE_PORT {
        Ok(port)
    } else {
        Err(format!(
            "Port must be between {MIN_SHARE_PORT} and {}.",
            u16::MAX
        ))
    }
}

pub fn share_config_path(dir: &Path) -> PathBuf {
    dir.join("share.json")
}

pub fn share_password_path(dir: &Path) -> PathBuf {
    dir.join("share-password")
}

pub fn read_share_config(dir: &Path) -> ShareConfig {
    fs::read_to_string(share_config_path(dir))
        .ok()
        .and_then(|raw| serde_json::from_str::<ShareConfig>(&raw).ok())
        .map(ShareConfig::sanitized)
        .unwrap_or_default()
}

pub fn write_share_config(dir: &Path, config: &ShareConfig) -> Result<(), String> {
    let body = serde_json::to_vec(config).map_err(|error| error.to_string())?;
    write_private_file(&share_config_path(dir), &body)
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .and_then(|mut file| file.write_all(bytes))
        .map_err(|error| error.to_string())?;
    crate::ensure_private_file(path).map_err(|error| error.to_string())
}

/// Reads a secret file or creates it with owner-only permissions. A corrupt file
/// is an error instead of a silent rotation: the webview and the server must
/// never disagree about the password.
fn read_or_create_secret(
    path: &Path,
    label: &str,
    is_valid: impl Fn(&str) -> bool,
    generate: impl FnOnce() -> String,
) -> Result<String, String> {
    if path.exists() {
        return read_secret(path, label, is_valid);
    }
    let value = generate();
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(mut file) => {
            file.write_all(value.as_bytes())
                .map_err(|error| error.to_string())?;
            crate::ensure_private_file(path).map_err(|error| error.to_string())?;
            Ok(value)
        }
        // Another command won the race; reuse the password it published.
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            read_secret(path, label, is_valid)
        }
        Err(error) => Err(error.to_string()),
    }
}

fn read_secret(
    path: &Path,
    label: &str,
    is_valid: impl Fn(&str) -> bool,
) -> Result<String, String> {
    crate::ensure_private_file(path).map_err(|error| error.to_string())?;
    let value = fs::read_to_string(path).map_err(|error| error.to_string())?;
    if !is_valid(&value) {
        return Err(format!("Invalid {label} file"));
    }
    Ok(value)
}

/// The local (master) password: 64 hex characters, unchanged from earlier
/// versions that wrote it next to `connection.json`.
pub fn local_password(dir: &Path) -> Result<String, String> {
    read_or_create_secret(
        &dir.join("password"),
        "local password",
        |value| value.len() == 64,
        || {
            let mut bytes = [0u8; 32];
            OsRng.fill_bytes(&mut bytes);
            bytes.iter().map(|byte| format!("{byte:02x}")).collect()
        },
    )
}

/// 16 Crockford base32 characters (80 bits), without the ambiguous letters and
/// without the visual hyphens the UI adds.
pub fn generate_share_password() -> String {
    let mut bytes = [0u8; SHARE_PASSWORD_LENGTH];
    OsRng.fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|byte| CROCKFORD[(byte & 31) as usize] as char)
        .collect()
}

pub fn is_share_password(value: &str) -> bool {
    value.len() == SHARE_PASSWORD_LENGTH && value.bytes().all(|byte| CROCKFORD.contains(&byte))
}

pub fn read_or_create_share_password(dir: &Path) -> Result<String, String> {
    read_or_create_secret(
        &share_password_path(dir),
        "share password",
        is_share_password,
        generate_share_password,
    )
}

pub fn rotate_share_password_file(dir: &Path) -> Result<String, String> {
    let value = generate_share_password();
    write_private_file(&share_password_path(dir), value.as_bytes())?;
    Ok(value)
}

/// Environment for one local-server launch. Kept separate from `Command` so the
/// contract is testable without spawning a process.
#[derive(Debug, PartialEq, Eq)]
pub struct ServerEnv {
    pub host: &'static str,
    pub port: u16,
    pub data_dir: PathBuf,
    pub web_dir: Option<PathBuf>,
    pub password: String,
    pub force_env_password: bool,
    pub removed: Vec<&'static str>,
}

pub struct ServerEnvInput<'a> {
    /// Bind on all IPv4 interfaces and serve the bundled web app.
    pub bind_lan: bool,
    /// The password came from `share-password`; an old `password_hash` in the
    /// database must not override it.
    pub force_env_password: bool,
    pub password: &'a str,
    pub data_dir: &'a Path,
    pub web_dir: &'a Path,
    pub port: u16,
}

pub fn server_env(input: &ServerEnvInput<'_>) -> ServerEnv {
    let mut removed = REMOVED_ENV.to_vec();
    if !input.bind_lan {
        removed.push("KNOWLIFY_WEB_DIR");
    }
    if !input.force_env_password {
        removed.push("KNOWLIFY_FORCE_ENV_PASSWORD");
    }
    ServerEnv {
        host: if input.bind_lan {
            "0.0.0.0"
        } else {
            "127.0.0.1"
        },
        port: input.port,
        data_dir: input.data_dir.to_path_buf(),
        web_dir: input.bind_lan.then(|| input.web_dir.to_path_buf()),
        password: input.password.to_string(),
        force_env_password: input.force_env_password,
        removed,
    }
}

impl ServerEnv {
    pub fn vars(&self) -> Vec<(&'static str, String)> {
        let mut vars = vec![
            ("HOST", self.host.to_string()),
            ("PORT", self.port.to_string()),
            (
                "KNOWLIFY_DATA",
                self.data_dir.to_string_lossy().into_owned(),
            ),
            ("KNOWLIFY_USER", SHARE_USER.to_string()),
            ("KNOWLIFY_PASSWORD", self.password.clone()),
            ("KNOWLIFY_ACCOUNT_LOCKED", "1".to_string()),
            ("KNOWLIFY_LLM_ALLOW_PRIVATE", "on".to_string()),
            ("KNOWLIFY_NETWORK_GUARD", "lan".to_string()),
        ];
        if let Some(web_dir) = &self.web_dir {
            vars.push(("KNOWLIFY_WEB_DIR", web_dir.to_string_lossy().into_owned()));
        }
        if self.force_env_password {
            vars.push(("KNOWLIFY_FORCE_ENV_PASSWORD", "1".to_string()));
        }
        vars
    }

    pub fn apply(&self, command: &mut Command) {
        for name in &self.removed {
            command.env_remove(name);
        }
        for (name, value) in self.vars() {
            command.env(name, value);
        }
    }
}

/// Address shown in the QR code and the card. Accepted only when it is an RFC1918
/// private address or CGNAT (Tailscale), never loopback, link-local or public.
pub fn is_shareable_lan_ip(ip: Ipv4Addr) -> bool {
    ip.is_private() || crate::is_cgnat(ip)
}

/// Primary IPv4 address selected by the routing table. Connecting a UDP socket
/// only picks a route: no packet leaves the machine.
pub fn lan_ipv4() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    // TEST-NET-1 is guaranteed not to be a real destination; nothing is sent.
    socket.connect("192.0.2.1:9").ok()?;
    match socket.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(ip) if is_shareable_lan_ip(ip) => Some(ip),
        _ => None,
    }
}

/// True when the port can be bound on every IPv4 interface. The listener is
/// released immediately; `try_wait` on the child catches a lost race.
pub fn is_port_available(port: u16) -> bool {
    TcpListener::bind(("0.0.0.0", port)).is_ok()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ShareErrorCode {
    PortInUse,
    NoNetwork,
    StartFailed,
    NotLocal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShareError {
    pub code: ShareErrorCode,
    pub message: String,
}

impl ShareError {
    pub fn port_in_use(port: u16) -> Self {
        Self {
            code: ShareErrorCode::PortInUse,
            message: format!(
                "Port {port} is already in use. Choose another port or stop the other program."
            ),
        }
    }

    pub fn no_network() -> Self {
        Self {
            code: ShareErrorCode::NoNetwork,
            message: "No local network detected. Connect to Wi-Fi or Ethernet.".to_string(),
        }
    }

    pub fn start_failed(port: u16) -> Self {
        Self {
            code: ShareErrorCode::StartFailed,
            message: format!("The local server could not start on port {port}."),
        }
    }

    pub fn not_local() -> Self {
        Self {
            code: ShareErrorCode::NotLocal,
            message: "Sharing is only available in local mode.".to_string(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ShareRuntime {
    pub running: bool,
    pub error: Option<ShareError>,
}

/// Last launch result, shared between `establish` and the commands.
#[derive(Default)]
pub struct ShareState(Mutex<ShareRuntime>);

impl ShareState {
    pub fn snapshot(&self) -> ShareRuntime {
        self.0.lock().map(|state| state.clone()).unwrap_or_default()
    }

    pub fn reset(&self) {
        if let Ok(mut state) = self.0.lock() {
            *state = ShareRuntime::default();
        }
    }

    pub fn set_running(&self, running: bool) {
        if let Ok(mut state) = self.0.lock() {
            state.running = running;
        }
    }

    pub fn set_error(&self, error: ShareError) {
        if let Ok(mut state) = self.0.lock() {
            state.error = Some(error);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareStatus {
    pub available: bool,
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub default_port: u16,
    pub urls: Vec<String>,
    pub user: String,
    pub password: Option<String>,
    pub error: Option<ShareError>,
}

pub struct StatusInput<'a> {
    pub mode: Option<&'a str>,
    pub config: &'a ShareConfig,
    pub runtime: &'a ShareRuntime,
    pub server_alive: bool,
    pub password: Option<String>,
    pub lan_ip: Option<Ipv4Addr>,
    pub node_available: bool,
}

pub fn build_status(input: StatusInput<'_>) -> ShareStatus {
    let base = |available: bool, running: bool| ShareStatus {
        available,
        enabled: false,
        running,
        port: input.config.port,
        default_port: DEFAULT_SHARE_PORT,
        urls: Vec::new(),
        user: SHARE_USER.to_string(),
        password: None,
        error: None,
    };
    if input.mode == Some("remote") {
        return ShareStatus {
            error: Some(ShareError::not_local()),
            ..base(false, false)
        };
    }
    if input.mode != Some("local") {
        return base(false, false);
    }

    let running = input.runtime.running && input.server_alive;
    let mut error = input.runtime.error.clone();
    let urls = if input.config.enabled && running {
        match input.lan_ip {
            Some(ip) => vec![format!("http://{ip}:{}", input.config.port)],
            None => {
                if error.is_none() {
                    error = Some(ShareError::no_network());
                }
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    ShareStatus {
        available: input.node_available,
        enabled: input.config.enabled,
        running,
        port: input.config.port,
        default_port: DEFAULT_SHARE_PORT,
        urls,
        user: SHARE_USER.to_string(),
        password: if input.config.enabled {
            input.password
        } else {
            None
        },
        error,
    }
}

fn status_for(app: &tauri::AppHandle) -> Result<ShareStatus, String> {
    let saved = crate::read_saved(app);
    let mode = saved.as_ref().map(|saved| saved.mode.as_str());
    let dir = crate::app_data_dir(app)?;
    let config = read_share_config(&dir);
    let runtime = app.state::<ShareState>().snapshot();
    let local = mode == Some("local");
    let password = if local && config.enabled {
        Some(read_or_create_share_password(&dir)?)
    } else {
        None
    };
    let lan_ip = if local && config.enabled {
        lan_ipv4()
    } else {
        None
    };
    Ok(build_status(StatusInput {
        mode,
        config: &config,
        runtime: &runtime,
        server_alive: app.state::<crate::Server>().is_running(),
        password,
        lan_ip,
        node_available: crate::resolve_node_executable().is_ok(),
    }))
}

fn not_local_status(dir: &Path) -> ShareStatus {
    build_status(StatusInput {
        mode: Some("remote"),
        config: &read_share_config(dir),
        runtime: &ShareRuntime::default(),
        server_alive: false,
        password: None,
        lan_ip: None,
        node_available: false,
    })
}

fn require_local(app: &tauri::AppHandle, dir: &Path) -> Option<ShareStatus> {
    match crate::read_saved(app).map(|saved| saved.mode) {
        Some(mode) if mode == "local" => None,
        _ => Some(not_local_status(dir)),
    }
}

/// Current state for the Settings card. Never returns the local password.
#[tauri::command]
pub fn share_status(app: tauri::AppHandle) -> Result<ShareStatus, String> {
    status_for(&app)
}

/// Persists the intent, validates the port and restarts the sidecar. A port that
/// cannot be bound does not fall back to another fixed port: the server starts
/// on loopback and the status carries `port_in_use` until the user retries.
#[tauri::command]
pub async fn set_share(
    app: tauri::AppHandle,
    enabled: bool,
    port: Option<u16>,
) -> Result<ShareStatus, String> {
    let dir = crate::app_data_dir(&app)?;
    if let Some(status) = require_local(&app, &dir) {
        return Ok(status);
    }
    let mut config = read_share_config(&dir);
    if let Some(port) = port {
        config.port = validate_port(port)?;
    }
    config.enabled = enabled;
    write_share_config(&dir, &config)?;
    // The web calls __KNOWLIFY_RECONNECT__ right after this command; restart
    // now so the returned status reflects what is actually listening.
    crate::establish(app.clone(), "local".into(), None, None, None).await?;
    status_for(&app)
}

/// Replaces the share password and restarts the sidecar so paired devices lose
/// access. Only meaningful while sharing is enabled.
#[tauri::command]
pub async fn rotate_share_password(app: tauri::AppHandle) -> Result<ShareStatus, String> {
    let dir = crate::app_data_dir(&app)?;
    if let Some(status) = require_local(&app, &dir) {
        return Ok(status);
    }
    let config = read_share_config(&dir);
    if config.enabled {
        rotate_share_password_file(&dir)?;
        crate::establish(app.clone(), "local".into(), None, None, None).await?;
    }
    status_for(&app)
}

#[cfg(test)]
mod tests {
    use super::{
        build_status, generate_share_password, is_port_available, is_share_password,
        is_shareable_lan_ip, local_password, normalize_port, read_or_create_share_password,
        read_share_config, rotate_share_password_file, server_env, validate_port,
        write_share_config, ServerEnvInput, ShareConfig, ShareErrorCode, ShareRuntime, StatusInput,
        DEFAULT_SHARE_PORT,
    };
    use std::{
        fs,
        net::{Ipv4Addr, TcpListener},
        path::PathBuf,
    };

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "knowlify-desktop-share-test-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn env_input<'a>(
        bind_lan: bool,
        force_env_password: bool,
        password: &'a str,
        data_dir: &'a std::path::Path,
        web_dir: &'a std::path::Path,
    ) -> ServerEnvInput<'a> {
        ServerEnvInput {
            bind_lan,
            force_env_password,
            password,
            data_dir,
            web_dir,
            port: 47_870,
        }
    }

    #[test]
    fn test_share_config_defaults_to_off_with_the_contract_port() {
        let config = ShareConfig::default();
        assert_eq!(
            (config.enabled, config.port, DEFAULT_SHARE_PORT),
            (false, 47_870, 47_870)
        );
        assert_eq!(normalize_port(1023), DEFAULT_SHARE_PORT);
        assert_eq!(normalize_port(1024), 1024);
        assert_eq!(normalize_port(65_535), 65_535);
    }

    #[test]
    fn test_share_config_round_trips_and_sanitizes_a_bad_port() {
        let dir = temp_dir("config");
        assert_eq!(
            read_share_config(&dir),
            ShareConfig {
                enabled: false,
                port: DEFAULT_SHARE_PORT
            }
        );

        write_share_config(
            &dir,
            &ShareConfig {
                enabled: true,
                port: 50_000,
            },
        )
        .expect("write config");
        assert_eq!(
            read_share_config(&dir),
            ShareConfig {
                enabled: true,
                port: 50_000
            }
        );

        // A hand-edited or truncated file never enables sharing or an invalid port.
        for raw in [
            "not json",
            "{\"enabled\":true,\"port\":80}",
            "{\"enabled\":\"yes\"}",
            "{}",
        ] {
            fs::write(dir.join("share.json"), raw).expect("write raw config");
            let config = read_share_config(&dir);
            assert_eq!(config.port, DEFAULT_SHARE_PORT, "{raw}");
        }
        assert!(!read_share_config(&dir).enabled);
        fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    #[test]
    fn test_share_config_is_valid_json_with_the_contract_fields() {
        let dir = temp_dir("config-json");
        write_share_config(
            &dir,
            &ShareConfig {
                enabled: true,
                port: 47_870,
            },
        )
        .expect("write config");
        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("share.json")).expect("read"))
                .expect("parse");
        assert_eq!(
            value,
            serde_json::json!({ "enabled": true, "port": 47_870 })
        );
        fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    #[test]
    fn test_port_validation_accepts_the_contract_range() {
        assert_eq!(validate_port(1024).expect("minimum"), 1024);
        assert_eq!(validate_port(47_870).expect("default"), 47_870);
        assert_eq!(validate_port(65_535).expect("maximum"), 65_535);
        assert!(validate_port(0).is_err());
        assert!(validate_port(1023).is_err());
        assert!(validate_port(80)
            .expect_err("privileged port")
            .contains("1024"));
    }

    #[test]
    fn test_port_check_rejects_a_real_listener() {
        let listener = TcpListener::bind("0.0.0.0:0").expect("bind ephemeral listener");
        let port = listener.local_addr().expect("address").port();
        assert!(!is_port_available(port), "a bound port must be busy");
        drop(listener);
        assert!(is_port_available(port), "the released port is available");
    }

    #[test]
    fn test_share_password_has_the_crockford_alphabet_and_length() {
        let first = generate_share_password();
        let second = generate_share_password();
        assert_eq!(first.len(), 16);
        assert_eq!(second.len(), 16);
        assert_ne!(first, second, "passwords must not repeat");
        assert!(is_share_password(&first));
        for invalid in ["", "SHORT", "IIIIIIIIIIIIIIII", "0123456789abcdef"] {
            assert!(!is_share_password(invalid), "{invalid} is not valid");
        }
        assert!(is_share_password("0123456789ABCDEF"));
        assert!(is_share_password("GHJKMNPQRSTVWXYZ"));
    }

    #[test]
    fn test_share_password_is_stable_until_rotated() {
        let dir = temp_dir("share-password");
        let first = read_or_create_share_password(&dir).expect("create");
        let again = read_or_create_share_password(&dir).expect("read");
        assert_eq!(first, again);
        assert!(is_share_password(&first));

        let rotated = rotate_share_password_file(&dir).expect("rotate");
        assert_ne!(rotated, first);
        assert_eq!(
            fs::read_to_string(dir.join("share-password")).expect("read file"),
            rotated
        );
        assert_eq!(
            read_or_create_share_password(&dir).expect("read rotated"),
            rotated
        );
        fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    #[test]
    fn test_a_corrupt_share_password_is_not_silently_replaced() {
        let dir = temp_dir("share-password-corrupt");
        fs::write(dir.join("share-password"), "short").expect("write corrupt");
        let error = read_or_create_share_password(&dir).expect_err("corrupt file must fail");
        assert!(error.contains("Invalid share password file"));
        fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    #[cfg(unix)]
    #[test]
    fn test_secrets_are_owner_only() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let dir = temp_dir("secret-permissions");
        let share = read_or_create_share_password(&dir).expect("share password");
        let local = local_password(&dir).expect("local password");
        assert_eq!(local.len(), 64);
        for path in [dir.join("share-password"), dir.join("password")] {
            assert_eq!(
                fs::metadata(&path).expect("metadata").mode() & 0o777,
                0o600,
                "{}",
                path.display()
            );
            assert!(!fs::read_to_string(path)
                .expect("read secret")
                .trim()
                .is_empty());
        }
        fs::set_permissions(
            dir.join("share-password"),
            fs::Permissions::from_mode(0o644),
        )
        .expect("chmod share password");
        assert_eq!(
            read_or_create_share_password(&dir).expect("read share password"),
            share
        );
        assert_eq!(
            fs::metadata(dir.join("share-password"))
                .expect("metadata")
                .mode()
                & 0o777,
            0o600,
            "reading re-tightens the permissions"
        );
        fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    #[test]
    fn test_server_env_when_sharing_binds_lan_and_serves_the_web_app() {
        let data = PathBuf::from("/data");
        let web = PathBuf::from("/resources/server/web");
        let env = server_env(&env_input(true, true, "SHAREPASSWORD123", &data, &web));
        assert_eq!(env.host, "0.0.0.0");
        assert_eq!(env.port, 47_870);
        assert_eq!(env.web_dir.as_deref(), Some(web.as_path()));
        assert!(env.force_env_password);

        let vars = env.vars();
        let value = |name: &str| {
            vars.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(value("HOST"), Some("0.0.0.0"));
        assert_eq!(value("KNOWLIFY_NETWORK_GUARD"), Some("lan"));
        assert_eq!(value("KNOWLIFY_WEB_DIR"), Some("/resources/server/web"));
        assert_eq!(value("KNOWLIFY_FORCE_ENV_PASSWORD"), Some("1"));
        assert_eq!(value("KNOWLIFY_PASSWORD"), Some("SHAREPASSWORD123"));
        assert_eq!(value("KNOWLIFY_USER"), Some("desktop"));
        assert_eq!(value("KNOWLIFY_ACCOUNT_LOCKED"), Some("1"));
        assert_eq!(value("KNOWLIFY_LLM_ALLOW_PRIVATE"), Some("on"));
        assert_eq!(value("KNOWLIFY_DATA"), Some("/data"));
        for name in ["KNOWLIFY_WEB_DIR", "KNOWLIFY_FORCE_ENV_PASSWORD"] {
            assert!(!env.removed.contains(&name), "{name} is set, not removed");
        }
    }

    #[test]
    fn test_server_env_when_off_stays_on_loopback_with_the_local_password() {
        let data = PathBuf::from("/data");
        let web = PathBuf::from("/resources/server/web");
        let env = server_env(&env_input(false, false, "local-password", &data, &web));
        assert_eq!(env.host, "127.0.0.1");
        assert_eq!(env.web_dir, None);
        assert!(!env.force_env_password);

        let vars = env.vars();
        let names: Vec<&str> = vars.iter().map(|(name, _)| *name).collect();
        assert!(!names.contains(&"KNOWLIFY_WEB_DIR"));
        assert!(!names.contains(&"KNOWLIFY_FORCE_ENV_PASSWORD"));
        assert_eq!(
            vars.iter()
                .find(|(name, _)| *name == "KNOWLIFY_NETWORK_GUARD")
                .map(|(_, value)| value.as_str()),
            Some("lan"),
            "the loopback server also validates peers and Host"
        );
        for name in [
            "NODE_OPTIONS",
            "NODE_PATH",
            "KNOWLIFY_NODE",
            "KNOWLIFY_TRUST_PROXY",
            "KNOWLIFY_MCP_ALLOWED_HOSTS",
            "KNOWLIFY_MCP_ALLOWED_ORIGINS",
            "KNOWLIFY_WEB_DIR",
            "KNOWLIFY_FORCE_ENV_PASSWORD",
        ] {
            assert!(env.removed.contains(&name), "{name} must be removed");
        }
        for (name, _) in &vars {
            assert!(
                !name.starts_with("KNOWLIFY_TRUST") && !name.contains("MCP_ALLOWED"),
                "no inherited proxy or MCP allowlist is passed"
            );
        }
    }

    #[test]
    fn test_server_env_when_sharing_falls_back_to_loopback() {
        // The port was taken: the server stays on loopback but keeps the share
        // password, so the webview and the server still agree.
        let data = PathBuf::from("/data");
        let web = PathBuf::from("/resources/server/web");
        let env = server_env(&env_input(false, true, "SHAREPASSWORD123", &data, &web));
        assert_eq!(env.host, "127.0.0.1");
        assert_eq!(env.web_dir, None);
        assert!(env.force_env_password);
        let vars = env.vars();
        assert_eq!(
            vars.iter()
                .find(|(name, _)| *name == "KNOWLIFY_FORCE_ENV_PASSWORD")
                .map(|(_, value)| value.as_str()),
            Some("1")
        );
        assert!(!vars.iter().any(|(name, _)| *name == "KNOWLIFY_WEB_DIR"));
    }

    #[test]
    fn test_lan_ip_classification() {
        for allowed in [
            Ipv4Addr::new(10, 0, 0, 1),
            Ipv4Addr::new(172, 16, 0, 1),
            Ipv4Addr::new(172, 31, 255, 255),
            Ipv4Addr::new(192, 168, 1, 20),
            Ipv4Addr::new(100, 64, 0, 1),
            Ipv4Addr::new(100, 127, 255, 255),
        ] {
            assert!(is_shareable_lan_ip(allowed), "{allowed} is shareable");
        }
        for blocked in [
            Ipv4Addr::LOCALHOST,
            Ipv4Addr::new(8, 8, 8, 8),
            Ipv4Addr::new(100, 63, 255, 255),
            Ipv4Addr::new(100, 128, 0, 1),
            Ipv4Addr::new(169, 254, 1, 1),
            Ipv4Addr::new(0, 0, 0, 0),
            Ipv4Addr::new(224, 0, 0, 1),
        ] {
            assert!(!is_shareable_lan_ip(blocked), "{blocked} is not shareable");
        }
    }

    #[test]
    fn test_discovered_ip_is_always_shareable() {
        if let Some(ip) = super::lan_ipv4() {
            assert!(is_shareable_lan_ip(ip), "{ip} escaped the classifier");
        }
    }

    #[test]
    fn test_status_is_not_local_in_remote_mode() {
        let config = ShareConfig::default();
        let status = build_status(StatusInput {
            mode: Some("remote"),
            config: &config,
            runtime: &ShareRuntime::default(),
            server_alive: false,
            password: None,
            lan_ip: None,
            node_available: true,
        });
        assert!(!status.available);
        assert!(!status.enabled);
        assert_eq!(
            status.error.as_ref().map(|error| &error.code),
            Some(&ShareErrorCode::NotLocal)
        );
        assert!(status.password.is_none());
        assert!(status.urls.is_empty());
        assert_eq!(status.default_port, 47_870);
    }

    #[test]
    fn test_status_lists_the_url_when_sharing_is_running() {
        let config = ShareConfig {
            enabled: true,
            port: 50_000,
        };
        let runtime = ShareRuntime {
            running: true,
            error: None,
        };
        let status = build_status(StatusInput {
            mode: Some("local"),
            config: &config,
            runtime: &runtime,
            server_alive: true,
            password: Some("PASSWORD12345678".into()),
            lan_ip: Some(Ipv4Addr::new(10, 0, 0, 20)),
            node_available: true,
        });
        assert!(status.available);
        assert!(status.enabled);
        assert!(status.running);
        assert_eq!(status.port, 50_000);
        assert_eq!(status.urls, ["http://10.0.0.20:50000"]);
        assert_eq!(status.user, "desktop");
        assert_eq!(status.password.as_deref(), Some("PASSWORD12345678"));
        assert!(status.error.is_none());

        let value = serde_json::to_value(&status).expect("serialize status");
        assert_eq!(value["defaultPort"], 47_870);
        assert_eq!(value["urls"][0], "http://10.0.0.20:50000");
    }

    #[test]
    fn test_status_without_a_network_reports_no_network() {
        let config = ShareConfig {
            enabled: true,
            port: 47_870,
        };
        let runtime = ShareRuntime {
            running: true,
            error: None,
        };
        let status = build_status(StatusInput {
            mode: Some("local"),
            config: &config,
            runtime: &runtime,
            server_alive: true,
            password: Some("PASSWORD12345678".into()),
            lan_ip: None,
            node_available: true,
        });
        assert!(status.running);
        assert!(status.urls.is_empty());
        assert_eq!(
            status.error.as_ref().map(|error| &error.code),
            Some(&ShareErrorCode::NoNetwork)
        );
        assert_eq!(status.password.as_deref(), Some("PASSWORD12345678"));
    }

    #[test]
    fn test_status_off_has_no_url_password_or_error() {
        let config = ShareConfig::default();
        let status = build_status(StatusInput {
            mode: Some("local"),
            config: &config,
            runtime: &ShareRuntime::default(),
            server_alive: true,
            password: Some("must-not-leak".into()),
            lan_ip: Some(Ipv4Addr::new(192, 168, 1, 20)),
            node_available: true,
        });
        assert!(status.available);
        assert!(!status.enabled);
        assert!(!status.running);
        assert!(status.urls.is_empty());
        assert!(status.password.is_none());
        assert!(status.error.is_none());
    }

    #[test]
    fn test_status_keeps_the_port_error_after_the_loopback_fallback() {
        let config = ShareConfig {
            enabled: true,
            port: 47_870,
        };
        let runtime = ShareRuntime {
            running: false,
            error: Some(super::ShareError::port_in_use(47_870)),
        };
        let status = build_status(StatusInput {
            mode: Some("local"),
            config: &config,
            runtime: &runtime,
            server_alive: true,
            password: Some("PASSWORD12345678".into()),
            lan_ip: Some(Ipv4Addr::new(192, 168, 1, 20)),
            node_available: true,
        });
        assert!(status.enabled);
        assert!(!status.running);
        assert!(status.urls.is_empty());
        assert_eq!(
            status.error.as_ref().map(|error| &error.code),
            Some(&ShareErrorCode::PortInUse)
        );
        assert_eq!(status.password.as_deref(), Some("PASSWORD12345678"));
    }
}
