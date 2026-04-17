use crate::keychain;
use crate::models::{ConnectionKind, CredentialKind};
use crate::ssh::{start_ssh_session, AuthMethod, SessionMsg, SshState};
use crate::storage;

#[tauri::command]
pub fn ssh_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    connection_id: String,
) -> Result<String, String> {
    let data = storage::load_data()?;
    let conn = data
        .connections
        .iter()
        .find(|c| c.id == connection_id)
        .ok_or("Connection not found")?;

    let cred_id = conn
        .credential_id
        .as_ref()
        .ok_or("No credential configured for this connection")?;

    // Check connection kind — tunnel connections require gateway setup not yet supported
    if let ConnectionKind::Tunnel { .. } = &conn.kind {
        return Err(
            "Tunnel/jump-host connections are not yet supported. \
             Please configure a direct connection instead."
                .to_string(),
        );
    }

    let mut cred = data
        .credentials
        .iter()
        .find(|c| c.id == *cred_id)
        .ok_or("Credential not found")?
        .clone();

    // Enrich from OS keychain so the actual password/passphrase is available.
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

    let session_id = uuid::Uuid::new_v4().to_string();

    let tx = start_ssh_session(
        conn.host.clone(),
        conn.port,
        username,
        auth,
        app,
        session_id.clone(),
    )?;

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
