use crate::commands::blocking;
use crate::forwards::start_port_forward;
use crate::keychain;
use crate::models::{AppData, AppSettings, Connection, ConnectionKind, Credential, CredentialKind};
use crate::reconnect::ReconnectPolicy;
use crate::session_log::SessionLogPlan;
use crate::ssh::{
    bridge_via_jump_host, build_startup_command, open_authenticated_session,
    open_authenticated_session_over_stream, open_jump_shell, open_shell, start_jump_shell,
    start_ssh_session, AuthMethod, Endpoint, OpenShell, SessionContext, SessionMsg, ShellOptions,
    ShellResilience, SshState,
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
        CredentialKind::Agent {} => AuthMethod::Agent,
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

/// The endpoint of a direct connection, through its proxy command if any.
fn direct_target(data: &AppData, conn: &Connection) -> Result<Endpoint, String> {
    let cred_id = conn
        .credential_id
        .as_deref()
        .ok_or("No credential configured for this connection")?;
    Ok(
        resolve_endpoint(&data.credentials, &conn.host, conn.port, cred_id)?
            .through(conn.proxy_command.as_deref()),
    )
}

/// The jump host and target of a jump connection. The proxy command, if any,
/// reaches the jump host.
fn jump_endpoints(data: &AppData, conn: &Connection) -> Result<(Endpoint, Endpoint), String> {
    let ConnectionKind::JumpShell {
        gateway_host,
        gateway_port,
        gateway_credential_id,
        destination_host,
        destination_port,
    } = &conn.kind
    else {
        return Err("This is not a jump host connection".to_string());
    };
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
    Ok((gateway, destination))
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
            let target = direct_target(data, conn)?;
            let session =
                open_authenticated_session(&target, conn.verbosity, conn.extra_args.as_deref())?;
            Ok(ConnectedSession {
                session,
                destination_label: format!("{}@{}", target.username, target.addr()),
            })
        }
        ConnectionKind::JumpShell { .. } => {
            let (gateway, destination) = jump_endpoints(data, conn)?;
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
        ConnectionKind::PortForward { .. }
        | ConnectionKind::RemoteForward { .. }
        | ConnectionKind::DynamicForward { .. }
        | ConnectionKind::LegacyTunnel { .. } => Err(format!(
            "{} is only available for direct and jump host connections",
            feature
        )),
    }
}

/// A shell connection's options, with its overrides applied over `settings`.
fn shell_options(conn: &Connection, settings: &AppSettings) -> ShellOptions {
    ShellOptions {
        verbosity: conn.verbosity,
        extra_args: conn.extra_args.clone(),
        startup_command: build_startup_command(
            conn.remote_path.as_deref(),
            conn.login_command.as_deref(),
        ),
        keepalive_interval: conn
            .keepalive_interval
            .unwrap_or(settings.keepalive_interval),
        cancelled: None,
        agent_forwarding: conn.agent_forwarding,
    }
}

fn reconnect_policy(conn: &Connection, settings: &AppSettings) -> ReconnectPolicy {
    ReconnectPolicy {
        enabled: conn.auto_reconnect.unwrap_or(settings.auto_reconnect),
        max_attempts: settings.reconnect_max_attempts,
    }
}

/// Open the shell of a saved connection again after it dropped. It reads the
/// connection and its credentials afresh, so a changed password or edited
/// host applies, and a connection deleted meanwhile stops the retries.
fn reopen_shell(
    connection_id: &str,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<OpenShell, String> {
    let (data, conn) = find_connection(connection_id)?;
    let opts = ShellOptions {
        cancelled: Some(cancelled),
        ..shell_options(&conn, &data.settings)
    };
    match &conn.kind {
        ConnectionKind::Direct => open_shell(&direct_target(&data, &conn)?, &opts),
        ConnectionKind::JumpShell { .. } => {
            let (gateway, destination) = jump_endpoints(&data, &conn)?;
            open_jump_shell(&gateway, &destination, &opts)
        }
        _ => Err(format!(
            "{} is no longer a direct or jump host connection",
            conn.name
        )),
    }
}

/// What a shell session of `conn` does beyond its first connection.
fn shell_resilience(
    conn: &Connection,
    settings: &AppSettings,
    session_id: &str,
) -> ShellResilience {
    let (policy_id, reopen_id) = (conn.id.clone(), conn.id.clone());
    let fallback = reconnect_policy(conn, settings);
    ShellResilience {
        policy: std::sync::Arc::new(move || match find_connection(&policy_id) {
            Ok((data, conn)) => reconnect_policy(&conn, &data.settings),
            Err(_) => fallback,
        }),
        reopen: std::sync::Arc::new(move |cancelled| reopen_shell(&reopen_id, cancelled)),
        log: SessionLogPlan::resolve(conn, settings, session_id),
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
    let opts = shell_options(&conn, &data.settings);
    let resilience = shell_resilience(&conn, &data.settings, &session_id);

    // The session registers itself (via `SessionContext::register`) before
    // its worker thread starts, so nothing is inserted here.
    blocking(move || match &conn.kind {
        ConnectionKind::Direct => {
            start_ssh_session(direct_target(&data, &conn)?, opts, ctx, resilience)
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
        ConnectionKind::JumpShell { .. } => {
            let (gateway, destination) = jump_endpoints(&data, &conn)?;
            start_jump_shell(gateway, destination, opts, ctx, resilience)
        }
        // Data-only until the forwards stream lands (docs/roadmap.md).
        ConnectionKind::RemoteForward { .. } => {
            Err("Remote forwards (ssh -R) are not supported yet".to_string())
        }
        ConnectionKind::DynamicForward { .. } => {
            Err("Dynamic forwards (ssh -D) are not supported yet".to_string())
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

/// Retry a dropped shell now, in its own pane. Does nothing while its
/// connection is up.
#[tauri::command]
pub fn ssh_reconnect(state: tauri::State<'_, SshState>, session_id: String) -> Result<(), String> {
    let handle = state.sessions.get(&session_id).ok_or("Session not found")?;
    handle.send(SessionMsg::Reconnect)
}

/// Stop retrying a dropped shell. Its pane stays, and `ssh_reconnect` can
/// still bring it back.
#[tauri::command]
pub fn ssh_cancel_reconnect(
    state: tauri::State<'_, SshState>,
    session_id: String,
) -> Result<(), String> {
    let handle = state.sessions.get(&session_id).ok_or("Session not found")?;
    handle.send(SessionMsg::CancelReconnect)
}

/// Forget the recorded host key for `host:port` so the next connection
/// records the server's current key (trust-on-first-use again). Returns
/// whether an entry was removed.
#[tauri::command]
pub async fn ssh_forget_host_key(host: String, port: u16) -> Result<bool, String> {
    blocking(move || crate::known_hosts::forget(&host, port)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn direct() -> Connection {
        Connection::new(
            "web".to_string(),
            "web.example".to_string(),
            22,
            None,
            ConnectionKind::Direct,
        )
    }

    #[test]
    fn keepalive_comes_from_the_settings_unless_the_connection_overrides_it() {
        let settings = AppSettings {
            keepalive_interval: 45,
            ..AppSettings::default()
        };
        assert_eq!(shell_options(&direct(), &settings).keepalive_interval, 45);
        for interval in [0, 10] {
            let conn = Connection {
                keepalive_interval: Some(interval),
                ..direct()
            };
            assert_eq!(shell_options(&conn, &settings).keepalive_interval, interval);
        }
    }

    #[test]
    fn auto_reconnect_comes_from_the_settings_unless_the_connection_overrides_it() {
        let on = AppSettings {
            auto_reconnect: true,
            reconnect_max_attempts: 7,
            ..AppSettings::default()
        };
        let off = AppSettings {
            auto_reconnect: false,
            ..on.clone()
        };
        assert!(reconnect_policy(&direct(), &on).enabled);
        assert!(!reconnect_policy(&direct(), &off).enabled);
        assert_eq!(reconnect_policy(&direct(), &on).max_attempts, 7);

        let forced = |auto_reconnect| Connection {
            auto_reconnect: Some(auto_reconnect),
            ..direct()
        };
        assert!(reconnect_policy(&forced(true), &off).enabled);
        assert!(!reconnect_policy(&forced(false), &on).enabled);
    }

    #[test]
    fn a_deleted_connection_is_not_reopened() {
        crate::storage::test_support::with_isolated_data_dir(|| {
            let error = reopen_shell("gone", Default::default()).err().unwrap();
            assert_eq!(error, "Connection not found");
            assert!(!crate::reconnect::is_retryable_connect_error(&error));
        });
    }
}
