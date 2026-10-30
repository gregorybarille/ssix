use crate::commands::blocking;
use crate::keychain;
use crate::models::{Connection, ConnectionKind, Credential, CredentialKind};
use crate::ssh::{
    bridge_via_jump_host, build_startup_command, open_authenticated_session,
    open_authenticated_session_over_stream, start_jump_shell, start_port_forward,
    start_ssh_session, AuthMethod, Endpoint, SessionContext, SessionMsg, ShellOptions, SshState,
};
use crate::storage;
use tauri::ipc::{Channel, InvokeResponseBody};

/// Resolve a credential by id from the loaded data, enriching it with the
/// secret material from the keychain. Returns the username and `AuthMethod`.
pub(crate) fn resolve_credential(
    credentials: &[Credential],
    cred_id: &str,
) -> Result<(String, AuthMethod), String> {
    let mut cred = credentials
        .iter()
        .find(|c| c.id == cred_id)
        .ok_or_else(|| format!("Credential {} not found", cred_id))?
        .clone();
    keychain::enrich_credential(&mut cred)?;
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

/// Build the SSH endpoint for `host:port` authenticated with credential `cred_id`.
pub(crate) fn resolve_endpoint(
    credentials: &[Credential],
    host: &str,
    port: u16,
    cred_id: &str,
) -> Result<Endpoint, String> {
    let (username, auth) = resolve_credential(credentials, cred_id)?;
    Ok(Endpoint {
        host: host.to_string(),
        port,
        username,
        auth,
        proxy_command: None,
    })
}

/// Shared connection lookup used by ssh_connect, scp_upload and
/// scp_download. Returns `(AppData, Connection)` so callers don't have to
/// re-load the data when they also need credentials.
pub(crate) fn find_connection(
    connection_id: &str,
) -> Result<(crate::models::AppData, Connection), String> {
    let data = storage::load_data()?;
    let conn = data
        .connections
        .iter()
        .find(|c| c.id == connection_id)
        .ok_or_else(|| "Connection not found".to_string())?
        .clone();
    Ok((data, conn))
}

/// An authenticated session to a connection's shell host: the host itself
/// for a direct connection, the target behind the jump host otherwise.
pub(crate) struct ConnectedSession {
    pub session: ssh2::Session,
    pub destination_label: String,
}

/// Open an authenticated session for SCP or a script run. `feature` names
/// the caller in the error a local forward gets.
pub(crate) fn connect_session(
    data: &crate::models::AppData,
    conn: &Connection,
    feature: &str,
) -> Result<ConnectedSession, String> {
    match &conn.kind {
        ConnectionKind::Direct => {
            let cred_id = conn
                .credential_id
                .as_ref()
                .ok_or_else(|| "No credential configured for this connection".to_string())?;
            let target = resolve_endpoint(&data.credentials, &conn.host, conn.port, cred_id)?
                .through(conn.proxy_command.as_deref());
            let session =
                open_authenticated_session(&target, conn.verbosity, conn.extra_args.as_deref())?;
            Ok(ConnectedSession {
                session,
                destination_label: format!("{}@{}", target.username, target.addr()),
            })
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
                .ok_or_else(|| "Jump host connection requires a target credential".to_string())?;
            let gateway = resolve_endpoint(
                &data.credentials,
                gateway_host,
                *gateway_port,
                gateway_credential_id,
            )?
            .through(conn.proxy_command.as_deref());
            let destination = resolve_endpoint(
                &data.credentials,
                destination_host,
                *destination_port,
                dest_cred_id,
            )?;
            let stream = bridge_via_jump_host(
                &gateway,
                &destination.host,
                destination.port,
                conn.verbosity,
            )?;
            let session = open_authenticated_session_over_stream(
                stream,
                &destination,
                conn.verbosity,
                conn.extra_args.as_deref(),
            )?;
            Ok(ConnectedSession {
                session,
                destination_label: format!(
                    "{}@{} via {}",
                    destination.username,
                    destination.addr(),
                    gateway.addr()
                ),
            })
        }
        ConnectionKind::PortForward { .. } | ConnectionKind::LegacyTunnel { .. } => Err(format!(
            "{} is only available for direct and jump host connections",
            feature
        )),
    }
}

/// Open a session for `connection_id`. Shell output is streamed to
/// `on_output` as raw bytes; errors and the close notification arrive on the
/// same channel as JSON `OutputEvent`s (see `crate::ssh::OutputEvent`), so
/// they stay ordered with the bytes.
///
/// Connecting does blocking network I/O (TCP connect, handshake, auth), so
/// it runs on the blocking thread pool rather than the async runtime.
#[tauri::command]
pub async fn ssh_connect(
    app: tauri::AppHandle,
    connection_id: String,
    on_output: Channel<InvokeResponseBody>,
) -> Result<String, String> {
    let (data, conn) = find_connection(&connection_id)?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let ctx = SessionContext {
        app,
        session_id: session_id.clone(),
        output: on_output,
    };
    let opts = ShellOptions {
        verbosity: conn.verbosity,
        extra_args: conn.extra_args.clone(),
        startup_command: build_startup_command(
            conn.remote_path.as_deref(),
            conn.login_command.as_deref(),
        ),
    };

    // The session registers itself (via `SessionContext::register`) before
    // its worker thread starts, so nothing is inserted here.
    blocking(move || match &conn.kind {
        ConnectionKind::Direct => {
            let cred_id = conn
                .credential_id
                .as_deref()
                .ok_or("No credential configured for this connection")?;
            let target = resolve_endpoint(&data.credentials, &conn.host, conn.port, cred_id)?
                .through(conn.proxy_command.as_deref());
            start_ssh_session(target, opts, ctx)
        }
        ConnectionKind::PortForward {
            gateway_host,
            gateway_port,
            gateway_credential_id,
            local_port,
            destination_host,
            destination_port,
        } => {
            let gateway = resolve_endpoint(
                &data.credentials,
                gateway_host,
                *gateway_port,
                gateway_credential_id,
            )?
            .through(conn.proxy_command.as_deref());
            start_port_forward(
                gateway,
                *local_port,
                destination_host.clone(),
                *destination_port,
                conn.verbosity,
                ctx,
            )
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
                .as_deref()
                .ok_or("Jump host connection requires a target credential")?;
            let gateway = resolve_endpoint(
                &data.credentials,
                gateway_host,
                *gateway_port,
                gateway_credential_id,
            )?
            .through(conn.proxy_command.as_deref());
            let destination = resolve_endpoint(
                &data.credentials,
                destination_host,
                *destination_port,
                dest_cred_id,
            )?;
            start_jump_shell(gateway, destination, opts, ctx)
        }
        ConnectionKind::LegacyTunnel { .. } => Err(
            "Legacy tunnel connection encountered after migration. Please re-save this connection."
                .to_string(),
        ),
    })
    .await?;
    Ok(session_id)
}

#[tauri::command]
pub fn ssh_write(
    state: tauri::State<'_, SshState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let handle = state.sessions.get(&session_id).ok_or("Session not found")?;
    handle.send(SessionMsg::Write(data.into_bytes()))
}

#[tauri::command]
pub fn ssh_resize(
    state: tauri::State<'_, SshState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let handle = state.sessions.get(&session_id).ok_or("Session not found")?;
    handle.send(SessionMsg::Resize { cols, rows })
}

#[tauri::command]
pub fn ssh_disconnect(state: tauri::State<'_, SshState>, session_id: String) -> Result<(), String> {
    if let Some((_, handle)) = state.sessions.remove(&session_id) {
        let _ = handle.send(SessionMsg::Disconnect);
    }
    Ok(())
}

/// Forget the recorded host key for `host:port` so the next connection
/// records the server's current key (trust-on-first-use again). Returns
/// whether an entry was removed.
#[tauri::command]
pub async fn ssh_forget_host_key(host: String, port: u16) -> Result<bool, String> {
    blocking(move || crate::known_hosts::forget(&host, port)).await
}
