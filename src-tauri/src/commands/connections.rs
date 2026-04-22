use crate::models::{Connection, ConnectionKind};
use crate::storage::{load_data, save_data};
use serde::Deserialize;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct AddConnectionInput {
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
}

#[derive(Debug, Deserialize)]
pub struct UpdateConnectionInput {
    pub id: String,
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

#[tauri::command]
pub fn add_connection(input: AddConnectionInput) -> Result<Connection, String> {
    let mut data = load_data()?;
    if data.connections.iter().any(|c| c.name == input.name) {
        return Err(format!("A connection named '{}' already exists", input.name));
    }
    let mut connection = Connection::new(input.name, input.host, input.port, input.credential_id, input.kind);
    connection.verbosity = input.verbosity;
    connection.extra_args = input.extra_args;
    data.connections.push(connection.clone());
    save_data(&data)?;
    Ok(connection)
}

#[tauri::command]
pub fn update_connection(input: UpdateConnectionInput) -> Result<Connection, String> {
    let mut data = load_data()?;
    if data.connections.iter().any(|c| c.name == input.name && c.id != input.id) {
        return Err(format!("A connection named '{}' already exists", input.name));
    }
    let idx = data.connections.iter().position(|c| c.id == input.id)
        .ok_or_else(|| "Connection not found".to_string())?;

    // Capture the old credential_id before overwriting so we can clean up
    // an orphaned private credential if the auth method changes.
    let old_cred_id = data.connections[idx].credential_id.clone();

    data.connections[idx].name = input.name;
    data.connections[idx].host = input.host;
    data.connections[idx].port = input.port;
    data.connections[idx].credential_id = input.credential_id.clone();
    data.connections[idx].kind = input.kind;
    data.connections[idx].verbosity = input.verbosity;
    data.connections[idx].extra_args = input.extra_args;
    let updated = data.connections[idx].clone();

    // If the credential changed and the old one was private, check whether it
    // is still referenced by another connection. If not, delete it so it
    // doesn't become an invisible orphan.
    if let Some(ref old_id) = old_cred_id {
        if input.credential_id.as_deref() != Some(old_id.as_str()) {
            let is_private = data.credentials.iter().any(|c| c.id == *old_id && c.is_private);
            if is_private {
                let still_referenced = data.connections.iter().any(|c| {
                    c.credential_id.as_deref() == Some(old_id.as_str())
                });
                if !still_referenced {
                    data.credentials.retain(|c| c.id != *old_id);
                    crate::keychain::delete_all_for_credential(old_id);
                }
            }
        }
    }

    save_data(&data)?;
    Ok(updated)
}

#[tauri::command]
pub fn delete_connection(id: String) -> Result<(), String> {
    let mut data = load_data()?;
    data.connections.retain(|c| c.id != id);
    save_data(&data)?;
    Ok(())
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
pub fn clone_connection(input: CloneConnectionInput) -> Result<Connection, String> {
    let mut data = load_data()?;
    if data.connections.iter().any(|c| c.name == input.new_name) {
        return Err(format!("A connection named '{}' already exists", input.new_name));
    }
    let original = data.connections.iter().find(|c| c.id == input.id)
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
                let is_private = data.credentials.iter()
                    .any(|c| c.id == *orig_cred_id && c.is_private);
                if is_private {
                    if let Some(orig_cred) = data.credentials.iter().find(|c| c.id == *orig_cred_id).cloned() {
                        let new_cred_id = Uuid::new_v4().to_string();
                        // Copy the secret from the keychain to the new credential's entry.
                        let new_kind = match &orig_cred.kind {
                            crate::models::CredentialKind::Password { .. } => {
                                let secret = crate::keychain::get_password(orig_cred_id)
                                    .ok_or_else(|| "Failed to read password from secrets store while duplicating private credential".to_string())?;
                                crate::keychain::store_password(&new_cred_id, &secret)?;
                                crate::models::CredentialKind::Password { password: String::new() }
                            }
                            crate::models::CredentialKind::SshKey { private_key_path, .. } => {
                                if let Some(pp) = crate::keychain::get_passphrase(orig_cred_id) {
                                    crate::keychain::store_passphrase(&new_cred_id, &pp)?;
                                }
                                crate::models::CredentialKind::SshKey {
                                    private_key_path: private_key_path.clone(),
                                    passphrase: None,
                                }
                            }
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
    };
    data.connections.push(cloned.clone());
    save_data(&data)?;
    Ok(cloned)
}

#[tauri::command]
pub fn search_connections(query: String) -> Result<Vec<Connection>, String> {
    let data = load_data()?;
    let q = query.to_lowercase();
    let results = data.connections
        .into_iter()
        .filter(|c| c.name.to_lowercase().contains(&q) || c.host.to_lowercase().contains(&q))
        .collect();
    Ok(results)
}

#[cfg(test)]
mod tests {
    use crate::models::{Connection, ConnectionKind};

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
}
