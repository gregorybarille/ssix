use crate::keychain;
use crate::models::{Connection, ConnectionKind, Credential, CredentialKind};
use crate::ssh::{
    build_startup_command, start_jump_shell, start_port_forward, start_ssh_session, AuthMethod,
    SessionMsg, SshState,
};
use crate::storage;

/// Resolve a credential by id from the loaded data, enriching it with the
/// secret material from the keychain. Returns the username and `AuthMethod`.
///
/// Audit-4 Phase 5a: re-exposed as `pub(crate)` so the file-transfer
/// commands in `commands/scp.rs` can reuse the same lookup logic.
pub(crate) fn resolve_credential(
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
            private_key,
            passphrase,
        } => match (private_key.as_deref(), private_key_path.as_deref()) {
            (Some(pk), _) => AuthMethod::KeyMemory {
                private_key: pk.to_string(),
                passphrase: passphrase.clone(),
            },
            (None, Some(path)) => AuthMethod::Key {
                path: path.to_string(),
                passphrase: passphrase.clone(),
            },
            (None, None) => {
                return Err(format!(
                    "Credential {} (ssh_key) has neither a private_key_path nor inline key",
                    cred_id
                ));
            }
        },
    };
    Ok((username, auth))
}

/// Audit-4 Dup M2: shared connection lookup used by ssh_connect, scp_upload,
/// and scp_download. Previously each site duplicated the same `iter().find()
/// .ok_or().clone()` chain with subtly different error messages ("Connection
/// not found" vs "Connection not found".to_string() vs the bare &str). One
/// helper, one error string, one place to add future logging.
///
/// Returns `(AppData, Connection)` so callers don't have to re-load the
/// data when they need both (most do, e.g. for credential lookup).
///
/// Audit-4 Phase 5a: re-exposed as `pub(crate)` for `commands/scp.rs`.
pub(crate) fn find_connection(connection_id: &str) -> Result<(crate::models::AppData, Connection), String> {
    let data = storage::load_data()?;
    let conn = data
        .connections
        .iter()
        .find(|c| c.id == connection_id)
        .ok_or_else(|| "Connection not found".to_string())?
        .clone();
    Ok((data, conn))
}

#[tauri::command]
pub async fn ssh_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    connection_id: String,
) -> Result<String, String> {
    let (data, conn) = find_connection(&connection_id)?;

    let session_id = uuid::Uuid::new_v4().to_string();
    let startup_command = build_startup_command(
        conn.remote_path.as_deref(),
        conn.login_command.as_deref(),
    );

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
                conn.verbosity,
                conn.extra_args.clone(),
                startup_command,
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
                conn.verbosity,
                conn.extra_args.clone(),
                startup_command,
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

    state.sessions.insert(session_id.clone(), tx);

    Ok(session_id)
}


#[tauri::command]
pub fn ssh_write(
    state: tauri::State<'_, SshState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let tx = state
        .sessions
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
    let tx = state
        .sessions
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
    if let Some((_, tx)) = state.sessions.remove(&session_id) {
        let _ = tx.send(SessionMsg::Disconnect);
    }
    Ok(())
}
