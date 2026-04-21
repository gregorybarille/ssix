use crate::keychain;
use crate::models::{Connection, ConnectionKind, Credential, CredentialKind};
use crate::ssh::{
    start_jump_shell, start_port_forward, start_ssh_session, AuthMethod, SessionMsg, SshState,
};
use crate::storage;

/// Resolve a credential by id from the loaded data, enriching it with the
/// secret material from the keychain. Returns the username and `AuthMethod`.
fn resolve_credential(
    credentials: &[Credential],
    cred_id: &str,
) -> Result<(String, AuthMethod), String> {
    let mut cred = credentials
        .iter()
        .find(|c| c.id == cred_id)
        .ok_or_else(|| format!("Credential {} not found", cred_id))?
        .clone();
    keychain::enrich_credential(&mut cred);
    let username = cred.username.clone();
    let auth = match &cred.kind {
        CredentialKind::Password { password } => AuthMethod::Password(password.clone()),
        CredentialKind::SshKey {
            private_key_path,
            passphrase,
        } => AuthMethod::Key {
            path: private_key_path.clone(),
            passphrase: passphrase.clone(),
        },
    };
    Ok((username, auth))
}

#[tauri::command]
pub fn ssh_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    connection_id: String,
) -> Result<String, String> {
    let data = storage::load_data()?;
    let conn: Connection = data
        .connections
        .iter()
        .find(|c| c.id == connection_id)
        .ok_or("Connection not found")?
        .clone();

    let session_id = uuid::Uuid::new_v4().to_string();

    let tx = match &conn.kind {
        ConnectionKind::Direct => {
            let cred_id = conn
                .credential_id
                .as_ref()
                .ok_or("No credential configured for this connection")?;
            let (username, auth) = resolve_credential(&data.credentials, cred_id)?;
            start_ssh_session(
                conn.host.clone(),
                conn.port,
                username,
                auth,
                app,
                session_id.clone(),
            )?
        }
        ConnectionKind::PortForward {
            gateway_host,
            gateway_port,
            gateway_credential_id,
            local_port,
            destination_host,
            destination_port,
        } => {
            let (gw_user, gw_auth) =
                resolve_credential(&data.credentials, gateway_credential_id)?;
            start_port_forward(
                gateway_host.clone(),
                *gateway_port,
                gw_user,
                gw_auth,
                *local_port,
                destination_host.clone(),
                *destination_port,
                app,
                session_id.clone(),
            )?
        }
        ConnectionKind::JumpShell {
            gateway_host,
            gateway_port,
            gateway_credential_id,
            destination_host,
            destination_port,
        } => {
            let dest_cred_id = conn
                .credential_id
                .as_ref()
                .ok_or("Jump-shell connection requires a destination credential")?;
            let (gw_user, gw_auth) =
                resolve_credential(&data.credentials, gateway_credential_id)?;
            let (dest_user, dest_auth) = resolve_credential(&data.credentials, dest_cred_id)?;
            start_jump_shell(
                gateway_host.clone(),
                *gateway_port,
                gw_user,
                gw_auth,
                destination_host.clone(),
                *destination_port,
                dest_user,
                dest_auth,
                app,
                session_id.clone(),
            )?
        }
        ConnectionKind::LegacyTunnel { .. } => {
            // Should not happen — `storage::load_data` migrates these to JumpShell.
            return Err(
                "Legacy tunnel connection encountered after migration. \
                 Please re-save this connection."
                    .to_string(),
            );
        }
    };

    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_id.clone(), tx);

    Ok(session_id)
}

#[tauri::command]
pub fn ssh_write(
    state: tauri::State<'_, SshState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let tx = sessions
        .get(&session_id)
        .ok_or("Session not found")?;
    tx.send(SessionMsg::Write(data)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ssh_resize(
    state: tauri::State<'_, SshState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let tx = sessions
        .get(&session_id)
        .ok_or("Session not found")?;
    tx.send(SessionMsg::Resize { cols, rows })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ssh_disconnect(
    state: tauri::State<'_, SshState>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(tx) = sessions.remove(&session_id) {
        let _ = tx.send(SessionMsg::Disconnect);
    }
    Ok(())
}
