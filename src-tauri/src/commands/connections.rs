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
    let connection = Connection::new(input.name, input.host, input.port, input.credential_id, input.kind);
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
    data.connections[idx].name = input.name;
    data.connections[idx].host = input.host;
    data.connections[idx].port = input.port;
    data.connections[idx].credential_id = input.credential_id;
    data.connections[idx].kind = input.kind;
    let updated = data.connections[idx].clone();
    save_data(&data)?;
    Ok(updated)
}

#[tauri::command]
pub fn delete_connection(id: String) -> Result<(), String> {
    let mut data = load_data()?;

    // If the connection has a private credential, remove it too so it doesn't
    // become an orphan that can never be seen or deleted through the UI.
    if let Some(conn) = data.connections.iter().find(|c| c.id == id) {
        if let Some(cred_id) = conn.credential_id.clone() {
            if data.credentials.iter().any(|c| c.id == cred_id && c.is_private) {
                data.credentials.retain(|c| c.id != cred_id);
                crate::keychain::delete_all_for_credential(&cred_id);
            }
        }
    }

    data.connections.retain(|c| c.id != id);
    save_data(&data)?;
    Ok(())
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
    let credential_id = match input.credential_id {
        Some(credential_id) if credential_id.is_empty() => None,
        Some(credential_id) => Some(credential_id),
        None => original.credential_id,
    };
    let cloned = Connection {
        id: Uuid::new_v4().to_string(),
        name: input.new_name,
        host: input.host.unwrap_or(original.host),
        port: input.port.unwrap_or(original.port),
        credential_id,
        kind: original.kind,
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
