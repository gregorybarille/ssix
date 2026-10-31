use serde::{Deserialize, Serialize};
use uuid::Uuid;

// Audit-4 Phase 6a: ts-rs is gated to test builds only (see
// Cargo.toml). The macro reads `#[ts(...)]` attributes regardless of
// gating, so we use `#[cfg_attr(test, derive(TS))]` and apply the
// per-type `export_to = "../../src/types/generated/"` path so
// `cargo test` writes the bindings into `<repo>/src/types/generated/`
// (path is relative to the source file = `src-tauri/src/models.rs`).
// Production builds skip ts-rs entirely.
//
// Bindings are committed and a snapshot test (see `models::tests`)
// asserts the on-disk shape matches what the macro emits, so any
// model change that the developer forgets to mirror in `index.ts`
// shows up as a failing `cargo test`.
#[cfg(test)]
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CredentialKind {
    Password {
        password: String,
    },
    /// SSH key credential. Exactly one of `private_key_path` (key on disk) or
    /// `private_key` (inline key contents stored in the secrets file) must be
    /// set. The unset field is `None`/absent. `passphrase` is optional in both
    /// cases.
    SshKey {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        private_key_path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        private_key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        passphrase: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct Credential {
    pub id: String,
    pub name: String,
    pub username: String,
    #[serde(flatten)]
    #[cfg_attr(test, ts(flatten))]
    pub kind: CredentialKind,
    /// When true the credential was auto-created for inline auth and is not
    /// shown in the credentials list. Treated as false when absent (legacy data).
    #[serde(default)]
    pub is_private: bool,
}

impl Credential {
    #[cfg(test)]
    pub fn new(name: String, username: String, kind: CredentialKind) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name,
            username,
            kind,
            is_private: false,
        }
    }
}

/// Secret material belonging to one credential.
///
/// Lives in `secrets.json`, never in `data.json`. The frontend only sees it
/// through `get_credential_secrets`, which the credential edit form calls
/// when it opens; `get_credentials`, `add_credential` and
/// `update_credential` all return redacted credentials.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct CredentialSecrets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_key: Option<String>,
}

/// Tunnel connection kinds.
///
/// `PortForward` opens a local TCP listener on `127.0.0.1:local_port` and forwards
/// every accepted connection through the gateway to `destination_host:destination_port`.
/// The destination need not run sshd — it can be any TCP service (HTTP API, DB, etc.).
/// Equivalent to `ssh -L local_port:destination_host:destination_port gateway`.
///
/// `JumpShell` opens an SSH terminal session to the destination through the gateway,
/// without requiring SSH keys on the gateway. The destination credential is the
/// top-level `Connection.credential_id`. Conceptually `ssh -J gateway destination`.
///
/// Legacy data with `type: "tunnel"` is migrated to `JumpShell` on load.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConnectionKind {
    Direct,
    PortForward {
        gateway_host: String,
        gateway_port: u16,
        gateway_credential_id: String,
        local_port: u16,
        destination_host: String,
        destination_port: u16,
    },
    JumpShell {
        gateway_host: String,
        gateway_port: u16,
        gateway_credential_id: String,
        destination_host: String,
        destination_port: u16,
    },
    /// Legacy variant retained for backwards compatibility with older `data.json`
    /// files. Migrated to `JumpShell` on load (see `migrate_legacy_kinds`).
    /// New code MUST NOT construct this variant.
    #[serde(rename = "tunnel")]
    LegacyTunnel {
        gateway_host: String,
        gateway_port: u16,
        gateway_credential_id: Option<String>,
        destination_host: String,
        destination_port: u16,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub credential_id: Option<String>,
    #[serde(flatten)]
    #[cfg_attr(test, ts(flatten))]
    pub kind: ConnectionKind,
    /// SSH verbosity, like OpenSSH's `-v` flags: 0 = quiet, 1 = `-v`
    /// (connection steps), 2 = `-vv` (negotiated algorithms), 3 = `-vvv`
    /// (local proposals and timings). Lines go to the Logs view; from 1 the
    /// terminal also shows a "Connected" banner.
    #[serde(default)]
    pub verbosity: u8,
    /// Additional CLI-style flags passed to the SSH subsystem (e.g. `-C` for
    /// compression). Parsed and applied before the handshake.
    // Audit-4 Phase 4: skip_serializing_if on every Option/Vec field that
    // already has #[serde(default)]. Round-trips identically and shaves
    // noise from data.json for the common case (most connections leave
    // these unset). Mirrors the existing treatment of `color`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_args: Option<String>,
    /// Local command whose stdin/stdout carry the SSH connection to the
    /// first hop, like OpenSSH's `ProxyCommand` (`%h`, `%p`, `%r`, `%%`).
    /// The first hop is the host of a direct connection, the jump host or
    /// the SSH server of a local forward.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_command: Option<String>,
    /// Command to run after the shell session opens, e.g. `sudo su - deploy`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login_command: Option<String>,
    /// Preferred starting directory on the remote host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_path: Option<String>,
    /// User-defined tags. Used for filtering/search. Empty by default.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// Optional Open Color name (e.g. "blue", "violet") used as the tab accent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

impl Connection {
    pub fn new(
        name: String,
        host: String,
        port: u16,
        credential_id: Option<String>,
        kind: ConnectionKind,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name,
            host,
            port,
            credential_id,
            kind,
            verbosity: 0,
            extra_args: None,
            proxy_command: None,
            login_command: None,
            remote_path: None,
            tags: Vec::new(),
            color: None,
        }
    }

    /// Every credential id this connection refers to: the destination
    /// credential and, for tunnels, the gateway credential.
    pub fn credential_ids(&self) -> impl Iterator<Item = &str> {
        self.credential_id
            .as_deref()
            .into_iter()
            .chain(self.kind.gateway_credential_id())
            .filter(|id| !id.is_empty())
    }
}

impl ConnectionKind {
    /// The gateway's credential id, for the kinds that go through one.
    /// This match and `gateway_credential_id_mut`'s are exhaustive on
    /// purpose: a new kind must say whether it has a gateway credential.
    fn gateway_credential_id(&self) -> Option<&str> {
        match self {
            ConnectionKind::PortForward {
                gateway_credential_id,
                ..
            }
            | ConnectionKind::JumpShell {
                gateway_credential_id,
                ..
            } => Some(gateway_credential_id),
            ConnectionKind::LegacyTunnel {
                gateway_credential_id,
                ..
            } => gateway_credential_id.as_deref(),
            ConnectionKind::Direct => None,
        }
    }

    /// Mutable gateway credential id of a current tunnel kind.
    fn gateway_credential_id_mut(&mut self) -> Option<&mut String> {
        match self {
            ConnectionKind::PortForward {
                gateway_credential_id,
                ..
            }
            | ConnectionKind::JumpShell {
                gateway_credential_id,
                ..
            } => Some(gateway_credential_id),
            ConnectionKind::LegacyTunnel { .. } | ConnectionKind::Direct => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct AppSettings {
    #[serde(default = "default_font_size")]
    pub font_size: u8,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_color_scheme")]
    pub color_scheme: String,
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Layout for the Connections list ("list" or "tile"). Defaults to "list".
    #[serde(default = "default_layout")]
    pub connection_layout: String,
    /// Layout for the Credentials list ("list" or "tile"). Defaults to "list".
    #[serde(default = "default_layout")]
    pub credential_layout: String,
    /// Layout for the Tunnels list ("list" or "tile"). Defaults to "list".
    #[serde(default = "default_layout")]
    pub tunnel_layout: String,
    /// Default behavior when launching a new terminal: "tab", "split_right", or "split_down".
    #[serde(default = "default_open_mode")]
    pub default_open_mode: String,
    /// When true, selecting text in a terminal pane immediately copies it to
    /// the system clipboard (classic xterm behavior). Defaults to `false` so
    /// that selecting text never silently overwrites the user's clipboard.
    /// Cmd/Ctrl+C still copies the active selection regardless of this flag.
    #[serde(default)]
    pub auto_copy_selection: bool,
    /// Filesystem path to a local git checkout used for sanitized SSIX config sync.
    #[serde(default)]
    pub git_sync_repo_path: Option<String>,
    /// Git remote name used for fetch/pull/push checks.
    #[serde(default = "default_git_remote")]
    pub git_sync_remote: String,
    /// Optional branch override. When omitted, SSIX uses the current branch.
    #[serde(default)]
    pub git_sync_branch: Option<String>,
    /// Take automatic local backups of the data directory (see `backup.rs`).
    #[serde(default = "default_true")]
    pub backup_enabled: bool,
    /// Hours between automatic backups.
    #[serde(default = "default_backup_interval_hours")]
    pub backup_interval_hours: u32,
    /// How many automatic backups to keep; manual ones are kept until deleted.
    #[serde(default = "default_backup_keep")]
    pub backup_keep: u32,
}

fn default_font_size() -> u8 {
    14
}
fn default_font_family() -> String {
    "JetBrains Mono".to_string()
}
fn default_color_scheme() -> String {
    "blue".to_string()
}
fn default_theme() -> String {
    "dark".to_string()
}
fn default_layout() -> String {
    "list".to_string()
}
fn default_open_mode() -> String {
    "tab".to_string()
}
fn default_git_remote() -> String {
    "origin".to_string()
}
fn default_true() -> bool {
    true
}
fn default_backup_interval_hours() -> u32 {
    24
}
fn default_backup_keep() -> u32 {
    10
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            font_size: default_font_size(),
            font_family: default_font_family(),
            color_scheme: default_color_scheme(),
            theme: default_theme(),
            connection_layout: default_layout(),
            credential_layout: default_layout(),
            tunnel_layout: default_layout(),
            default_open_mode: default_open_mode(),
            auto_copy_selection: false,
            git_sync_repo_path: None,
            git_sync_remote: default_git_remote(),
            git_sync_branch: None,
            backup_enabled: true,
            backup_interval_hours: default_backup_interval_hours(),
            backup_keep: default_backup_keep(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct AppData {
    /// Audit-4 Phase 6b: monotonically-increasing schema stamp. Legacy
    /// `data.json` files written before this field existed deserialize
    /// as version 0; `migrate_to_current()` walks them up to
    /// `CURRENT_SCHEMA_VERSION` and re-stamps before save. Bump
    /// `CURRENT_SCHEMA_VERSION` and add a `migrate_v{N-1}_to_v{N}`
    /// branch any time you change the on-disk shape in a way that
    /// requires a one-time fixup at load time.
    #[serde(default)]
    pub schema_version: u32,
    pub credentials: Vec<Credential>,
    pub connections: Vec<Connection>,
    pub settings: AppSettings,
    /// Saved scripts. Files from before scripts existed have none.
    #[serde(default)]
    pub scripts: Vec<Script>,
}

/// Current `AppData.schema_version` written by this build.
///
/// Version history:
/// - 0 — implicit; pre-Phase-6b files with no `schema_version` field.
///   Treated identically to v1 in-memory; `migrate_legacy_kinds`
///   already covered the LegacyTunnel → JumpShell rewrite that
///   was the only on-disk shape change to date.
/// - 1 — first explicit stamp. No data shape change vs v0; the
///   version is recorded so future migrations can branch on
///   "before/after this point" without ambiguity.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

impl Default for AppData {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            credentials: Vec::new(),
            connections: Vec::new(),
            settings: AppSettings::default(),
            scripts: Vec::new(),
        }
    }
}

pub const DEFAULT_SCRIPT_INTERPRETER: &str = "sh -s";

/// The PowerShell a Windows script runs in when none is given.
pub const DEFAULT_WINDOWS_INTERPRETER: &str = "powershell";

fn default_script_interpreter() -> String {
    DEFAULT_SCRIPT_INTERPRETER.to_string()
}

/// The kind of host a script is written for.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "snake_case")]
pub enum ScriptPlatform {
    /// Linux, macOS, BSD: any host with a POSIX `sh`.
    #[default]
    Posix,
    /// Windows OpenSSH: the body is a PowerShell script.
    Windows,
}

impl ScriptPlatform {
    pub fn default_interpreter(self) -> &'static str {
        match self {
            ScriptPlatform::Posix => DEFAULT_SCRIPT_INTERPRETER,
            ScriptPlatform::Windows => DEFAULT_WINDOWS_INTERPRETER,
        }
    }
}

/// A script the user runs on one or more hosts. On POSIX hosts
/// `interpreter` is the remote command that receives `body` on its standard
/// input (`sh -s`, `bash -s`, `python3 -`); on Windows it is the PowerShell
/// that runs it (`powershell`, `pwsh`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct Script {
    pub id: String,
    pub name: String,
    pub body: String,
    #[serde(default)]
    pub platform: ScriptPlatform,
    #[serde(default = "default_script_interpreter")]
    pub interpreter: String,
}

impl Script {
    pub fn new(name: String, body: String, platform: ScriptPlatform, interpreter: String) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name,
            body,
            platform,
            interpreter,
        }
    }
}

impl AppData {
    /// Run every migration from the loaded `schema_version` up to
    /// `CURRENT_SCHEMA_VERSION` and stamp the result. Idempotent: a
    /// file already at `CURRENT_SCHEMA_VERSION` is left untouched.
    ///
    /// Migration order matters: `migrate_legacy_kinds` runs first
    /// regardless of stamp because pre-stamp files (v0) may carry the
    /// LegacyTunnel variant that v1+ readers must not see.
    ///
    /// Returns whether anything changed, the version stamp included, so
    /// `storage::persist_migrations` knows the file needs saving. A future
    /// `if self.schema_version < N` branch needs no extra bookkeeping: the
    /// stamp moving is itself a change.
    pub fn migrate_to_current(&mut self) -> bool {
        let loaded_version = self.schema_version;
        // Step 1: legacy variants are dropped on every load (cheap, idempotent).
        let migrated = self.migrate_legacy_kinds();
        let dropped = self.drop_dangling_credential_refs();

        // Step 2: future-proofing scaffold. Add branches here as the
        // schema evolves:
        //
        //   if self.schema_version < 2 {
        //       // migrate v1 → v2
        //   }
        //   if self.schema_version < 3 { … }

        self.schema_version = CURRENT_SCHEMA_VERSION;
        migrated || dropped || loaded_version != CURRENT_SCHEMA_VERSION
    }

    /// Clear credential references whose credential no longer exists.
    /// Builds before `delete_credential` refused credentials in use left
    /// them behind; cleared, the connection form flags the empty picker
    /// inline instead of the save failing on an id the user cannot see.
    /// Returns whether any reference was cleared.
    pub fn drop_dangling_credential_refs(&mut self) -> bool {
        let mut any = false;
        let known: std::collections::HashSet<&str> =
            self.credentials.iter().map(|c| c.id.as_str()).collect();
        for conn in &mut self.connections {
            let mut dropped = false;
            if conn
                .credential_id
                .as_deref()
                .is_some_and(|id| !known.contains(id))
            {
                conn.credential_id = None;
                dropped = true;
            }
            if let Some(gateway) = conn.kind.gateway_credential_id_mut() {
                if !gateway.is_empty() && !known.contains(gateway.as_str()) {
                    gateway.clear();
                    dropped = true;
                }
            }
            any |= dropped;
            if dropped {
                crate::logs::log_local(
                    "warn",
                    "migration",
                    format!(
                        "Connection {} referred to a deleted credential; it needs a new one",
                        conn.id
                    ),
                );
            }
        }
        any
    }

    /// Migrate legacy `ConnectionKind::LegacyTunnel` entries to `JumpShell`.
    /// `LegacyTunnel.gateway_credential_id` was optional; if absent, we drop the
    /// connection's tunnel-ness and convert it to `Direct` (with a warning logged)
    /// since `JumpShell` requires a gateway credential.
    /// Returns whether any connection was migrated.
    pub fn migrate_legacy_kinds(&mut self) -> bool {
        let mut any = false;
        for conn in &mut self.connections {
            if let ConnectionKind::LegacyTunnel {
                gateway_host,
                gateway_port,
                gateway_credential_id,
                destination_host,
                destination_port,
            } = &conn.kind
            {
                any = true;
                conn.kind = match gateway_credential_id {
                    Some(cred_id) => ConnectionKind::JumpShell {
                        gateway_host: gateway_host.clone(),
                        gateway_port: *gateway_port,
                        gateway_credential_id: cred_id.clone(),
                        destination_host: destination_host.clone(),
                        destination_port: *destination_port,
                    },
                    None => {
                        crate::logs::log_local(
                            "warn",
                            "migration",
                            format!(
                                "Connection {} had legacy tunnel without gateway credential; converting to Direct",
                                conn.id
                            ),
                        );
                        ConnectionKind::Direct
                    }
                };
            }
        }
        any
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_serde_direct_roundtrip() {
        let kind = ConnectionKind::Direct;
        let json = serde_json::to_string(&kind).unwrap();
        assert_eq!(json, r#"{"type":"direct"}"#);
        let back: ConnectionKind = serde_json::from_str(&json).unwrap();
        assert_eq!(back, kind);
    }

    #[test]
    fn test_serde_port_forward_roundtrip() {
        let kind = ConnectionKind::PortForward {
            gateway_host: "gw.example".into(),
            gateway_port: 22,
            gateway_credential_id: "gw-cred".into(),
            local_port: 9000,
            destination_host: "api.internal".into(),
            destination_port: 80,
        };
        let json = serde_json::to_string(&kind).unwrap();
        assert!(json.contains(r#""type":"port_forward""#));
        assert!(json.contains(r#""local_port":9000"#));
        let back: ConnectionKind = serde_json::from_str(&json).unwrap();
        assert_eq!(back, kind);
    }

    #[test]
    fn test_serde_jump_shell_roundtrip() {
        let kind = ConnectionKind::JumpShell {
            gateway_host: "gw.example".into(),
            gateway_port: 22,
            gateway_credential_id: "gw-cred".into(),
            destination_host: "internal.example".into(),
            destination_port: 22,
        };
        let json = serde_json::to_string(&kind).unwrap();
        assert!(json.contains(r#""type":"jump_shell""#));
        let back: ConnectionKind = serde_json::from_str(&json).unwrap();
        assert_eq!(back, kind);
    }

    #[test]
    fn test_legacy_tunnel_deserializes() {
        let json = r#"{
            "type": "tunnel",
            "gateway_host": "gw.example",
            "gateway_port": 22,
            "gateway_credential_id": "gw-cred",
            "destination_host": "internal.example",
            "destination_port": 22
        }"#;
        let parsed: ConnectionKind = serde_json::from_str(json).unwrap();
        assert!(matches!(parsed, ConnectionKind::LegacyTunnel { .. }));
    }

    #[test]
    fn test_dangling_credential_refs_are_cleared_on_load() {
        let kept = Credential::new(
            "kept".into(),
            "root".into(),
            CredentialKind::Password {
                password: String::new(),
            },
        );
        let jump = ConnectionKind::JumpShell {
            gateway_host: "gw".into(),
            gateway_port: 22,
            gateway_credential_id: "deleted-gateway".into(),
            destination_host: "db".into(),
            destination_port: 22,
        };
        let mut data = AppData {
            credentials: vec![kept.clone()],
            connections: vec![
                Connection::new(
                    "a".into(),
                    "h".into(),
                    22,
                    Some("deleted".into()),
                    ConnectionKind::Direct,
                ),
                Connection::new("b".into(), "db".into(), 22, Some(kept.id.clone()), jump),
            ],
            ..AppData::default()
        };
        data.migrate_to_current();

        assert_eq!(data.connections[0].credential_id, None);
        assert_eq!(
            data.connections[1].credential_id.as_deref(),
            Some(kept.id.as_str())
        );
        match &data.connections[1].kind {
            ConnectionKind::JumpShell {
                gateway_credential_id,
                ..
            } => assert_eq!(gateway_credential_id, ""),
            other => panic!("expected a jump shell, got {other:?}"),
        }
        assert_eq!(
            data.connections[1].credential_ids().collect::<Vec<_>>(),
            vec![kept.id.as_str()]
        );
    }

    #[test]
    fn test_migrate_legacy_with_credential() {
        let mut data = AppData::default();
        data.connections.push(Connection {
            id: "c1".into(),
            name: "old".into(),
            host: "internal.example".into(),
            port: 22,
            credential_id: Some("dest-cred".into()),
            verbosity: 0,
            extra_args: None,
            proxy_command: None,
            login_command: None,
            remote_path: None,
            tags: Vec::new(),
            color: None,
            kind: ConnectionKind::LegacyTunnel {
                gateway_host: "gw.example".into(),
                gateway_port: 22,
                gateway_credential_id: Some("gw-cred".into()),
                destination_host: "internal.example".into(),
                destination_port: 22,
            },
        });

        data.migrate_legacy_kinds();

        match &data.connections[0].kind {
            ConnectionKind::JumpShell {
                gateway_credential_id,
                destination_host,
                ..
            } => {
                assert_eq!(gateway_credential_id, "gw-cred");
                assert_eq!(destination_host, "internal.example");
            }
            other => panic!("expected JumpShell, got {:?}", other),
        }
    }

    #[test]
    fn test_migrate_legacy_without_credential_becomes_direct() {
        let mut data = AppData::default();
        data.connections.push(Connection {
            id: "c2".into(),
            name: "old".into(),
            host: "internal.example".into(),
            port: 22,
            credential_id: None,
            verbosity: 0,
            extra_args: None,
            proxy_command: None,
            login_command: None,
            remote_path: None,
            tags: Vec::new(),
            color: None,
            kind: ConnectionKind::LegacyTunnel {
                gateway_host: "gw.example".into(),
                gateway_port: 22,
                gateway_credential_id: None,
                destination_host: "internal.example".into(),
                destination_port: 22,
            },
        });

        data.migrate_legacy_kinds();

        assert_eq!(data.connections[0].kind, ConnectionKind::Direct);
    }

    #[test]
    fn test_migrate_leaves_modern_kinds_untouched() {
        let mut data = AppData::default();
        let pf = ConnectionKind::PortForward {
            gateway_host: "gw".into(),
            gateway_port: 22,
            gateway_credential_id: "gw-cred".into(),
            local_port: 9000,
            destination_host: "api".into(),
            destination_port: 80,
        };
        data.connections.push(Connection {
            id: "c3".into(),
            name: "modern".into(),
            host: "api".into(),
            port: 80,
            credential_id: None,
            verbosity: 0,
            extra_args: None,
            proxy_command: None,
            login_command: None,
            remote_path: None,
            tags: Vec::new(),
            color: None,
            kind: pf.clone(),
        });
        data.migrate_legacy_kinds();
        assert_eq!(data.connections[0].kind, pf);
    }

    #[test]
    fn test_connection_verbosity_default_is_zero() {
        let conn = Connection::new(
            "test".into(),
            "host".into(),
            22,
            None,
            ConnectionKind::Direct,
        );
        assert_eq!(conn.verbosity, 0);
    }

    #[test]
    fn test_connection_verbosity_serde_default() {
        // JSON without verbosity field should deserialize with verbosity == 0.
        let json = r#"{
            "id": "x",
            "name": "test",
            "host": "h",
            "port": 22,
            "type": "direct"
        }"#;
        let conn: Connection = serde_json::from_str(json).unwrap();
        assert_eq!(conn.verbosity, 0);
    }

    #[test]
    fn test_connection_extra_args_serde_default() {
        let json = r#"{
            "id": "x",
            "name": "test",
            "host": "h",
            "port": 22,
            "type": "direct"
        }"#;
        let conn: Connection = serde_json::from_str(json).unwrap();
        assert!(conn.extra_args.is_none());
    }

    #[test]
    fn test_connection_startup_fields_serde_default() {
        let json = r#"{
            "id": "x",
            "name": "test",
            "host": "h",
            "port": 22,
            "type": "direct"
        }"#;
        let conn: Connection = serde_json::from_str(json).unwrap();
        assert!(conn.login_command.is_none());
        assert!(conn.remote_path.is_none());
    }

    #[test]
    fn test_ssh_key_legacy_path_only_deserializes() {
        // Legacy JSON: SshKey with private_key_path as required string and no private_key field.
        let json =
            r#"{"type":"ssh_key","private_key_path":"/home/u/.ssh/id_rsa","passphrase":null}"#;
        let kind: CredentialKind = serde_json::from_str(json).unwrap();
        match kind {
            CredentialKind::SshKey {
                private_key_path,
                private_key,
                passphrase,
            } => {
                assert_eq!(private_key_path.as_deref(), Some("/home/u/.ssh/id_rsa"));
                assert!(private_key.is_none());
                assert!(passphrase.is_none());
            }
            _ => panic!("expected SshKey"),
        }
    }

    #[test]
    fn test_ssh_key_inline_roundtrip() {
        let kind = CredentialKind::SshKey {
            private_key_path: None,
            private_key: Some("-----BEGIN OPENSSH PRIVATE KEY-----\n...".into()),
            passphrase: None,
        };
        let json = serde_json::to_string(&kind).unwrap();
        assert!(json.contains(r#""type":"ssh_key""#));
        assert!(json.contains(r#""private_key":"#));
        assert!(!json.contains("private_key_path"));
        let back: CredentialKind = serde_json::from_str(&json).unwrap();
        assert_eq!(back, kind);
    }

    #[test]
    fn test_ssh_key_path_only_roundtrip_omits_private_key() {
        let kind = CredentialKind::SshKey {
            private_key_path: Some("/home/u/.ssh/id_ed25519".into()),
            private_key: None,
            passphrase: None,
        };
        let json = serde_json::to_string(&kind).unwrap();
        assert!(json.contains(r#""private_key_path":"#));
        assert!(!json.contains(r#""private_key":"#));
        assert!(!json.contains(r#""passphrase":"#));
    }

    #[test]
    fn test_connection_tags_default_empty() {
        let json = r#"{"id":"x","name":"n","host":"h","port":22,"type":"direct"}"#;
        let conn: Connection = serde_json::from_str(json).unwrap();
        assert!(conn.tags.is_empty());
        assert!(conn.color.is_none());
    }

    #[test]
    fn test_connection_with_tags_and_color_roundtrip() {
        let mut c = Connection::new("prod".into(), "h".into(), 22, None, ConnectionKind::Direct);
        c.tags = vec!["prod".into(), "us-east".into()];
        c.color = Some("violet".into());
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains(r#""tags":["prod","us-east"]"#));
        assert!(json.contains(r#""color":"violet""#));
        let back: Connection = serde_json::from_str(&json).unwrap();
        assert_eq!(back.tags, c.tags);
        assert_eq!(back.color, c.color);
    }

    #[test]
    fn test_connection_color_omitted_when_none() {
        let c = Connection::new("prod".into(), "h".into(), 22, None, ConnectionKind::Direct);
        let json = serde_json::to_string(&c).unwrap();
        assert!(!json.contains("color"));
    }

    #[test]
    fn test_app_settings_legacy_json_loads_with_layout_defaults() {
        // Legacy data.json without the new layout fields must still load.
        let json = r#"{"font_size":14,"font_family":"JetBrains Mono","color_scheme":"blue","theme":"dark"}"#;
        let s: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.connection_layout, "list");
        assert_eq!(s.credential_layout, "list");
        assert_eq!(s.tunnel_layout, "list");
        assert_eq!(s.default_open_mode, "tab");
        assert_eq!(s.git_sync_remote, "origin");
        assert!(s.git_sync_repo_path.is_none());
        assert!(
            !s.auto_copy_selection,
            "legacy data must default to opt-in auto-copy=false"
        );
    }

    #[test]
    fn test_app_settings_default_auto_copy_selection_is_false() {
        let s = AppSettings::default();
        assert!(
            !s.auto_copy_selection,
            "default must be off — selecting text MUST NOT silently overwrite the clipboard"
        );
    }

    #[test]
    fn test_app_settings_auto_copy_selection_roundtrip() {
        let s = AppSettings {
            auto_copy_selection: true,
            ..AppSettings::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains(r#""auto_copy_selection":true"#));
        let back: AppSettings = serde_json::from_str(&json).unwrap();
        assert!(back.auto_copy_selection);
    }

    #[test]
    fn test_app_settings_default_includes_layouts() {
        let s = AppSettings::default();
        assert_eq!(s.connection_layout, "list");
        assert_eq!(s.default_open_mode, "tab");
        assert_eq!(s.git_sync_remote, "origin");
    }

    // Audit-4 Phase 6b: schema_version stamping + migration ----------------

    #[test]
    fn test_app_data_default_stamps_current_schema_version() {
        let data = AppData::default();
        assert_eq!(data.schema_version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn test_app_data_legacy_json_without_schema_version_loads_as_zero() {
        // Pre-Phase-6b on-disk shape: no schema_version field.
        let json = r#"{
            "credentials": [],
            "connections": [],
            "settings": {}
        }"#;
        let data: AppData = serde_json::from_str(json).unwrap();
        assert_eq!(data.schema_version, 0);
    }

    #[test]
    fn test_migrate_to_current_stamps_version_and_clears_legacy() {
        // Simulate a v0 file with a LegacyTunnel — the most realistic
        // worst case for an upgrade in the wild.
        let mut data = AppData {
            schema_version: 0,
            credentials: Vec::new(),
            connections: vec![Connection {
                id: "c1".into(),
                name: "old".into(),
                host: "internal.example".into(),
                port: 22,
                credential_id: None,
                verbosity: 0,
                extra_args: None,
                proxy_command: None,
                login_command: None,
                remote_path: None,
                tags: Vec::new(),
                color: None,
                kind: ConnectionKind::LegacyTunnel {
                    gateway_host: "gw.example".into(),
                    gateway_port: 22,
                    gateway_credential_id: Some("gw-cred".into()),
                    destination_host: "internal.example".into(),
                    destination_port: 22,
                },
            }],
            settings: AppSettings::default(),
            scripts: Vec::new(),
        };

        data.migrate_to_current();

        assert_eq!(data.schema_version, CURRENT_SCHEMA_VERSION);
        assert!(matches!(
            data.connections[0].kind,
            ConnectionKind::JumpShell { .. }
        ));
    }

    #[test]
    fn test_migrate_to_current_is_idempotent() {
        let mut data = AppData::default();
        data.migrate_to_current();
        assert_eq!(data.schema_version, CURRENT_SCHEMA_VERSION);
        // Run again — must not regress or panic.
        data.migrate_to_current();
        assert_eq!(data.schema_version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn test_app_data_roundtrip_preserves_schema_version() {
        let data = AppData::default();
        let json = serde_json::to_string(&data).unwrap();
        assert!(json.contains(&format!(r#""schema_version":{}"#, CURRENT_SCHEMA_VERSION)));
        let back: AppData = serde_json::from_str(&json).unwrap();
        assert_eq!(back.schema_version, CURRENT_SCHEMA_VERSION);
    }
}
