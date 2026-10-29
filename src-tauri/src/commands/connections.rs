use crate::commands::blocking;
use crate::models::{Connection, ConnectionKind};
use crate::storage::{load_data, with_data_mut};
use serde::Deserialize;
use uuid::Uuid;

/// Audit-4 Dup H3: shared field set between AddConnectionInput and
/// UpdateConnectionInput. Previously these two structs duplicated 9
/// fields verbatim — adding a new connection attribute required editing
/// both sites and the test suite couldn't catch a drift if only one was
/// updated. `#[serde(flatten)]` keeps the wire format identical.
#[derive(Debug, Deserialize)]
pub struct ConnectionFields {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub credential_id: Option<String>,
    #[serde(flatten)]
    pub kind: ConnectionKind,
    #[serde(default)]
    pub verbosity: u8,
    #[serde(default)]
    pub extra_args: Option<String>,
    #[serde(default)]
    pub login_command: Option<String>,
    #[serde(default)]
    pub remote_path: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AddConnectionInput {
    #[serde(flatten)]
    pub fields: ConnectionFields,
}

#[derive(Debug, Deserialize)]
pub struct UpdateConnectionInput {
    pub id: String,
    #[serde(flatten)]
    pub fields: ConnectionFields,
}

#[derive(Debug, Deserialize)]
pub struct CloneConnectionInput {
    pub id: String,
    pub new_name: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub credential_id: Option<String>,
}

#[tauri::command]
pub fn get_connections() -> Result<Vec<Connection>, String> {
    let data = load_data()?;
    Ok(data.connections)
}

/// Audit-4 H6: validate user-provided connection fields BEFORE we mutate
/// state. Without this, the frontend was the only line of defence — a
/// hand-crafted IPC call (or a future programmatic caller) could persist
/// blank names, blank hosts, or port 0, then silently fail at SSH-connect
/// time with a confusing error.
fn validate_connection_fields(name: &str, host: &str, port: u16) -> Result<(), String> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("Connection name is required.".to_string());
    }
    if trimmed_name.chars().count() > 128 {
        return Err("Connection name must be 128 characters or fewer.".to_string());
    }
    if host.trim().is_empty() {
        return Err("Host is required.".to_string());
    }
    if port == 0 {
        return Err("Port must be between 1 and 65535.".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn add_connection(input: AddConnectionInput) -> Result<Connection, String> {
    blocking(move || add_connection_sync(input)).await
}

fn add_connection_sync(input: AddConnectionInput) -> Result<Connection, String> {
    let f = input.fields;
    validate_connection_fields(&f.name, &f.host, f.port)?;
    with_data_mut(|data| {
        if data.connections.iter().any(|c| c.name == f.name) {
            return Err(format!("A connection named '{}' already exists", f.name));
        }
        let mut connection =
            Connection::new(f.name, f.host, f.port, f.credential_id, f.kind);
        connection.verbosity = f.verbosity;
        connection.extra_args = f.extra_args;
        connection.login_command = normalize_optional_text(f.login_command);
        connection.remote_path = normalize_remote_path(f.remote_path);
        connection.tags = normalize_tags(f.tags);
        connection.color = f.color;
        data.connections.push(connection.clone());
        Ok(connection)
    })
}

#[tauri::command]
pub async fn update_connection(input: UpdateConnectionInput) -> Result<Connection, String> {
    blocking(move || update_connection_sync(input)).await
}

fn update_connection_sync(input: UpdateConnectionInput) -> Result<Connection, String> {
    let id = input.id;
    let f = input.fields;
    validate_connection_fields(&f.name, &f.host, f.port)?;
    with_data_mut(|data| {
        if data
            .connections
            .iter()
            .any(|c| c.name == f.name && c.id != id)
        {
            return Err(format!("A connection named '{}' already exists", f.name));
        }
        let idx = data
            .connections
            .iter()
            .position(|c| c.id == id)
            .ok_or_else(|| "Connection not found".to_string())?;

        // Capture the old credential_id before overwriting so we can clean up
        // an orphaned private credential if the auth method changes.
        let old_cred_id = data.connections[idx].credential_id.clone();

        data.connections[idx].name = f.name;
        data.connections[idx].host = f.host;
        data.connections[idx].port = f.port;
        data.connections[idx].credential_id = f.credential_id.clone();
        data.connections[idx].kind = f.kind;
        data.connections[idx].verbosity = f.verbosity;
        data.connections[idx].extra_args = f.extra_args;
        data.connections[idx].login_command = normalize_optional_text(f.login_command);
        data.connections[idx].remote_path = normalize_remote_path(f.remote_path);
        data.connections[idx].tags = normalize_tags(f.tags);
        data.connections[idx].color = f.color;
        let updated = data.connections[idx].clone();

        // If the credential changed and the old one was private, check whether it
        // is still referenced by another connection. If not, delete it so it
        // doesn't become an invisible orphan.
        if let Some(ref old_id) = old_cred_id {
            if f.credential_id.as_deref() != Some(old_id.as_str()) {
                let is_private = data.credentials.iter().any(|c| c.id == *old_id && c.is_private);
                if is_private {
                    let still_referenced = data
                        .connections
                        .iter()
                        .any(|c| c.credential_id.as_deref() == Some(old_id.as_str()));
                    if !still_referenced {
                        data.credentials.retain(|c| c.id != *old_id);
                        crate::keychain::delete_all_for_credential(old_id);
                    }
                }
            }
        }
        Ok(updated)
    })
}

#[tauri::command]
pub async fn delete_connection(id: String) -> Result<(), String> {
    blocking(move || {
        with_data_mut(|data| {
            data.connections.retain(|c| c.id != id);
            Ok(())
        })
    })
    .await
}

/// Returns the ID of the private credential associated with the given connection
/// if that credential would become an orphan (not referenced by any other
/// connection) when the connection is deleted.  Returns `None` if there is no
/// private credential or if other connections still reference it.
#[tauri::command]
pub fn get_orphan_private_credential(conn_id: String) -> Result<Option<String>, String> {
    let data = load_data()?;
    let conn = data.connections.iter().find(|c| c.id == conn_id)
        .ok_or_else(|| "Connection not found".to_string())?;
    if let Some(ref cred_id) = conn.credential_id {
        let is_private = data.credentials.iter().any(|c| c.id == *cred_id && c.is_private);
        if is_private {
            let other_refs = data.connections.iter()
                .filter(|c| c.id != conn_id && c.credential_id.as_deref() == Some(cred_id))
                .count();
            if other_refs == 0 {
                return Ok(Some(cred_id.clone()));
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn clone_connection(input: CloneConnectionInput) -> Result<Connection, String> {
    blocking(move || clone_connection_sync(input)).await
}

fn clone_connection_sync(input: CloneConnectionInput) -> Result<Connection, String> {
    // Audit-4 H6: validate the new name (host/port are validated below once
    // the original is loaded and we know the effective values).
    if input.new_name.trim().is_empty() {
        return Err("Connection name is required.".to_string());
    }
    if input.new_name.trim().chars().count() > 128 {
        return Err("Connection name must be 128 characters or fewer.".to_string());
    }
    if matches!(input.port, Some(0)) {
        return Err("Port must be between 1 and 65535.".to_string());
    }
    if let Some(ref h) = input.host {
        if h.trim().is_empty() {
            return Err("Host is required.".to_string());
        }
    }

    // When the clone duplicates a private credential its secrets are
    // written inside the `with_data_mut` closure, but data.json is only
    // committed after the closure returns. Remember the new id so a failed
    // save can remove the orphaned keychain entry.
    let mut created_private_credential: Option<String> = None;

    let result = with_data_mut(|data| {
        if data.connections.iter().any(|c| c.name == input.new_name) {
            return Err(format!("A connection named '{}' already exists", input.new_name));
        }
        let original = data
            .connections
            .iter()
            .find(|c| c.id == input.id)
            .ok_or_else(|| "Connection not found".to_string())?
            .clone();

        // Resolve the credential_id for the clone.
        let credential_id = match input.credential_id {
            Some(ref cid) if cid.is_empty() => None,
            Some(ref cid) => Some(cid.clone()),
            None => {
                // If the original connection's credential is private, duplicate it
                // so each connection owns an independent copy instead of sharing one.
                if let Some(ref orig_cred_id) = original.credential_id {
                    let is_private = data
                        .credentials
                        .iter()
                        .any(|c| c.id == *orig_cred_id && c.is_private);
                    if is_private {
                        if let Some(orig_cred) = data
                            .credentials
                            .iter()
                            .find(|c| c.id == *orig_cred_id)
                            .cloned()
                        {
                            let new_cred_id = Uuid::new_v4().to_string();
                            // Copy every secret in one read and one write.
                            let secrets = crate::keychain::snapshot_for_credential(orig_cred_id)?;
                            if matches!(orig_cred.kind, crate::models::CredentialKind::Password { .. })
                                && secrets.password.is_none()
                            {
                                return Err("Failed to read password from secrets store while duplicating private credential".to_string());
                            }
                            crate::keychain::replace_for_credential(&new_cred_id, &secrets)?;
                            created_private_credential = Some(new_cred_id.clone());
                            let new_kind = match &orig_cred.kind {
                                crate::models::CredentialKind::Password { .. } => {
                                    crate::models::CredentialKind::Password {
                                        password: String::new(),
                                    }
                                }
                                crate::models::CredentialKind::SshKey {
                                    private_key_path,
                                    ..
                                } => crate::models::CredentialKind::SshKey {
                                    private_key_path: private_key_path.clone(),
                                    private_key: None,
                                    passphrase: None,
                                },
                            };
                            let new_cred = crate::models::Credential {
                                id: new_cred_id.clone(),
                                name: orig_cred.name.clone(),
                                username: orig_cred.username.clone(),
                                kind: new_kind,
                                is_private: true,
                            };
                            data.credentials.push(new_cred);
                            Some(new_cred_id)
                        } else {
                            original.credential_id
                        }
                    } else {
                        original.credential_id
                    }
                } else {
                    original.credential_id
                }
            }
        };

        let cloned = Connection {
            id: Uuid::new_v4().to_string(),
            name: input.new_name,
            host: input.host.unwrap_or(original.host),
            port: input.port.unwrap_or(original.port),
            credential_id,
            kind: original.kind,
            verbosity: original.verbosity,
            extra_args: original.extra_args,
            login_command: original.login_command,
            remote_path: original.remote_path,
            tags: original.tags,
            color: original.color,
        };
        data.connections.push(cloned.clone());
        Ok(cloned)
    });

    // If with_data_mut failed (validation Err from the closure, or a
    // save_data failure after it ran), strip the keychain entry we created
    // so the next run doesn't see ghost secrets.
    if result.is_err() {
        if let Some(id) = created_private_credential {
            crate::keychain::delete_all_for_credential(&id);
        }
    }

    result
}

/// Trim, drop empties, and dedupe a tag vector while preserving first-seen order.
fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for t in tags {
        let trimmed = t.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        let key = trimmed.to_lowercase();
        if seen.insert(key) {
            out.push(trimmed);
        }
    }
    out
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_remote_path(value: Option<String>) -> Option<String> {
    normalize_optional_text(value).map(|path| path.replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Connection, ConnectionKind};

    #[test]
    fn test_normalize_tags_dedupes_and_trims() {
        let tags = vec![
            "  Prod  ".to_string(),
            "prod".to_string(),
            "DB".to_string(),
            "".to_string(),
            "db".to_string(),
            "us-east".to_string(),
        ];
        let out = normalize_tags(tags);
        assert_eq!(out, vec!["Prod".to_string(), "DB".to_string(), "us-east".to_string()]);
    }

    #[test]
    fn test_connection_new() {
        let conn = Connection::new(
            "prod".to_string(),
            "192.168.1.1".to_string(),
            22,
            None,
            ConnectionKind::Direct,
        );
        assert_eq!(conn.name, "prod");
        assert_eq!(conn.port, 22);
        assert!(!conn.id.is_empty());
        assert!(conn.tags.is_empty());
        assert!(conn.color.is_none());
    }

    #[test]
    fn test_connection_jump_shell() {
        let kind = ConnectionKind::JumpShell {
            gateway_host: "gateway.example.com".to_string(),
            gateway_port: 22,
            gateway_credential_id: "gw-cred-1".to_string(),
            destination_host: "internal.example.com".to_string(),
            destination_port: 22,
        };
        let conn = Connection::new(
            "jump-prod".to_string(),
            "internal.example.com".to_string(),
            22,
            Some("dest-cred-1".to_string()),
            kind,
        );
        assert_eq!(conn.name, "jump-prod");
    }

    #[test]
    fn test_connection_port_forward() {
        let kind = ConnectionKind::PortForward {
            gateway_host: "gateway.example.com".to_string(),
            gateway_port: 22,
            gateway_credential_id: "gw-cred-1".to_string(),
            local_port: 8080,
            destination_host: "api.internal".to_string(),
            destination_port: 80,
        };
        let conn = Connection::new(
            "forward-api".to_string(),
            "api.internal".to_string(),
            80,
            None,
            kind,
        );
        assert_eq!(conn.name, "forward-api");
    }

    #[test]
    fn test_normalize_optional_text_drops_blank_values() {
        assert_eq!(normalize_optional_text(Some("   ".into())), None);
        assert_eq!(normalize_optional_text(Some(" cmd ".into())), Some("cmd".into()));
    }

    #[test]
    fn test_normalize_remote_path_prefers_forward_slashes() {
        assert_eq!(
            normalize_remote_path(Some(r#"  C:\Users\greg\repo  "#.into())),
            Some("C:/Users/greg/repo".into())
        );
    }

    // Audit-4 H6 regression tests: backend validation of connection fields.
    #[test]
    fn test_validate_rejects_blank_name() {
        let err = validate_connection_fields("   ", "host", 22).unwrap_err();
        assert!(err.contains("name"), "got: {}", err);
    }

    #[test]
    fn test_validate_rejects_blank_host() {
        let err = validate_connection_fields("ok", "  ", 22).unwrap_err();
        assert!(err.contains("Host"), "got: {}", err);
    }

    #[test]
    fn test_validate_rejects_port_zero() {
        let err = validate_connection_fields("ok", "host", 0).unwrap_err();
        assert!(err.contains("Port"), "got: {}", err);
    }

    #[test]
    fn test_validate_rejects_overlong_name() {
        let long = "a".repeat(129);
        let err = validate_connection_fields(&long, "host", 22).unwrap_err();
        assert!(err.contains("128"), "got: {}", err);
    }

    #[test]
    fn test_validate_accepts_typical_inputs() {
        assert!(validate_connection_fields("prod-db", "10.0.0.1", 22).is_ok());
        assert!(validate_connection_fields("a", "x", 1).is_ok());
        assert!(validate_connection_fields("z", "y", 65535).is_ok());
    }
}
