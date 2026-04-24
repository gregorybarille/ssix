use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
pub struct Credential {
    pub id: String,
    pub name: String,
    pub username: String,
    #[serde(flatten)]
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
pub struct Connection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub credential_id: Option<String>,
    #[serde(flatten)]
    pub kind: ConnectionKind,
    /// SSH verbosity level: 0 = silent, 1 = standard SSH debug output,
    /// 2 = enables libssh2 trace (verbose). Output is written to the terminal
    /// pane before the shell prompt appears.
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
    pub fn new(name: String, host: String, port: u16, credential_id: Option<String>, kind: ConnectionKind) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name,
            host,
            port,
            credential_id,
            kind,
            verbosity: 0,
            extra_args: None,
            login_command: None,
            remote_path: None,
            tags: Vec::new(),
            color: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// Filesystem path to a local git checkout used for sanitized SSX config sync.
    #[serde(default)]
    pub git_sync_repo_path: Option<String>,
    /// Git remote name used for fetch/pull/push checks.
    #[serde(default = "default_git_remote")]
    pub git_sync_remote: String,
    /// Optional branch override. When omitted, SSX uses the current branch.
    #[serde(default)]
    pub git_sync_branch: Option<String>,
}

fn default_font_size() -> u8 { 14 }
fn default_font_family() -> String { "JetBrains Mono".to_string() }
fn default_color_scheme() -> String { "blue".to_string() }
fn default_theme() -> String { "dark".to_string() }
fn default_layout() -> String { "list".to_string() }
fn default_open_mode() -> String { "tab".to_string() }
fn default_git_remote() -> String { "origin".to_string() }

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
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppData {
    pub credentials: Vec<Credential>,
    pub connections: Vec<Connection>,
    pub settings: AppSettings,
}

impl AppData {
    /// Migrate legacy `ConnectionKind::LegacyTunnel` entries to `JumpShell`.
    /// `LegacyTunnel.gateway_credential_id` was optional; if absent, we drop the
    /// connection's tunnel-ness and convert it to `Direct` (with a warning logged)
    /// since `JumpShell` requires a gateway credential.
    pub fn migrate_legacy_kinds(&mut self) {
        for conn in &mut self.connections {
            if let ConnectionKind::LegacyTunnel {
                gateway_host,
                gateway_port,
                gateway_credential_id,
                destination_host,
                destination_port,
            } = &conn.kind
            {
                conn.kind = match gateway_credential_id {
                    Some(cred_id) => ConnectionKind::JumpShell {
                        gateway_host: gateway_host.clone(),
                        gateway_port: *gateway_port,
                        gateway_credential_id: cred_id.clone(),
                        destination_host: destination_host.clone(),
                        destination_port: *destination_port,
                    },
                    None => {
                        eprintln!(
                            "[migration] Connection {} had legacy tunnel without gateway \
                             credential; converting to Direct",
                            conn.id
                        );
                        ConnectionKind::Direct
                    }
                };
            }
        }
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
        let json = r#"{"type":"ssh_key","private_key_path":"/home/u/.ssh/id_rsa","passphrase":null}"#;
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
        let mut c = Connection::new(
            "prod".into(), "h".into(), 22, None, ConnectionKind::Direct,
        );
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
        let c = Connection::new(
            "prod".into(), "h".into(), 22, None, ConnectionKind::Direct,
        );
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
        assert!(!s.auto_copy_selection, "legacy data must default to opt-in auto-copy=false");
    }

    #[test]
    fn test_app_settings_default_auto_copy_selection_is_false() {
        let s = AppSettings::default();
        assert!(!s.auto_copy_selection,
            "default must be off — selecting text MUST NOT silently overwrite the clipboard");
    }

    #[test]
    fn test_app_settings_auto_copy_selection_roundtrip() {
        let mut s = AppSettings::default();
        s.auto_copy_selection = true;
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
}
