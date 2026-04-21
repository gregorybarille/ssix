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
}

impl Credential {
    #[cfg(test)]
    pub fn new(name: String, username: String, kind: CredentialKind) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name,
            username,
            kind,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConnectionKind {
    Direct,
    Tunnel {
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
