use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CredentialKind {
    Password { password: String },
    SshKey { private_key_path: String, passphrase: Option<String> },
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
    /// SSH verbosity level (0 = silent, 1–3 = increasing detail). Output is
    /// written to the terminal pane before the shell prompt appears.
    #[serde(default)]
    pub verbosity: u8,
    /// Additional CLI-style flags passed to the SSH subsystem (e.g. `-C` for
    /// compression). Parsed and applied before the handshake.
    #[serde(default)]
    pub extra_args: Option<String>,
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
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub font_size: u8,
    pub font_family: String,
    pub color_scheme: String,
    pub theme: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            font_size: 14,
            font_family: "JetBrains Mono".to_string(),
            color_scheme: "blue".to_string(),
            theme: "dark".to_string(),
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
}
