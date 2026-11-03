use crate::auth_prompt::PromptScope;
use crate::commands::blocking;
use crate::forwards::{listen_addr, start_port_forward};
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
///
/// A login that needs answers asks in the session's pane again, on `output`.
/// The prompt belongs to this thread, the one `reconnect::run_attempt` started
/// for this attempt, and `cancelled` ends it.
fn reopen_shell(
    connection_id: &str,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    output: &Channel<InvokeResponseBody>,
) -> Result<OpenShell, String> {
    let _prompts = PromptScope::enter(output, Some(cancelled.clone()));
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
    output: Channel<InvokeResponseBody>,
) -> ShellResilience {
    let (policy_id, reopen_id) = (conn.id.clone(), conn.id.clone());
    let fallback = reconnect_policy(conn, settings);
    ShellResilience {
        policy: std::sync::Arc::new(move || match find_connection(&policy_id) {
            Ok((data, conn)) => reconnect_policy(&conn, &data.settings),
            Err(_) => fallback,
        }),
        reopen: std::sync::Arc::new(move |cancelled| reopen_shell(&reopen_id, cancelled, &output)),
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
    let opts = shell_options(&conn, &data.settings);
    let resilience = shell_resilience(&conn, &data.settings, &session_id, on_output.clone());
    let ctx = SessionContext {
        app,
        session_id: session_id.clone(),
        output: on_output,
    };

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
            bind_address,
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
                listen_addr(bind_address.as_deref(), *local_port)?,
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
        ConnectionKind::RemoteForward {
            gateway_host,
            gateway_port,
            gateway_credential_id,
            remote_port,
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
            crate::forwards::start_remote_forward(
                gateway,
                *remote_port,
                destination_host.clone(),
                *destination_port,
                conn.verbosity,
                ctx,
            )
        }
        ConnectionKind::DynamicForward {
            gateway_host,
            gateway_port,
            gateway_credential_id,
            bind_address,
            local_port,
        } => {
            let gateway = resolve_endpoint(
                &data.credentials,
                gateway_host,
                *gateway_port,
                gateway_credential_id,
            )?
            .through(conn.proxy_command.as_deref());
            crate::forwards::start_dynamic_forward(
                gateway,
                listen_addr(bind_address.as_deref(), *local_port)?,
                conn.verbosity,
                ctx,
            )
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

/// The terminal has taken `bytes` of a session's output. See `OUTPUT_PAUSE_BYTES`.
/// A number that is not a count is refused before it gets here, and one too big
/// only clears the count.
#[tauri::command]
pub fn ssh_output_ack(
    state: tauri::State<'_, SshState>,
    session_id: String,
    bytes: u64,
) -> Result<(), String> {
    let handle = state.sessions.get(&session_id).ok_or("Session not found")?;
    handle.ack_output(bytes);
    Ok(())
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
            let output = Channel::new(|_| Ok(()));
            let error = reopen_shell("gone", Default::default(), &output)
                .err()
                .unwrap();
            assert_eq!(error, "Connection not found");
            assert!(!crate::reconnect::is_retryable_connect_error(&error));
        });
    }
}

/// A keyboard-interactive login surviving a reconnect, against a real server.
/// A plain `cargo test` skips these, and CI's live job has no such server: the
/// E2E suite covers this path there (spec 14). Needs `server-e` from
/// `docker/docker-compose.yml`:
///
/// ```text
/// SSIX_LIVE_KBDINT_SSH=127.0.0.1:2205 SSIX_LIVE_KBDINT_USER=usere \
/// SSIX_LIVE_KBDINT_PASSWORD=passe cargo test live_reopen -- --ignored --test-threads=1
/// ```
#[cfg(test)]
mod live {
    use super::*;
    use crate::auth_prompt;
    use crate::reconnect::is_retryable_connect_error;
    use crate::storage::test_support::with_isolated_data_dir;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    /// `Some` when a keyboard-interactive server is configured: its address
    /// and the user and answer it wants.
    fn server() -> Option<(String, u16, String, String)> {
        let addr = std::env::var("SSIX_LIVE_KBDINT_SSH").ok()?;
        let (host, port) = addr.rsplit_once(':').expect("host:port");
        Some((
            host.to_string(),
            port.parse().expect("port"),
            std::env::var("SSIX_LIVE_KBDINT_USER").ok()?,
            std::env::var("SSIX_LIVE_KBDINT_PASSWORD").ok()?,
        ))
    }

    /// Save a connection to that server, with a password it would never see.
    fn save_connection(host: String, port: u16, username: String) -> String {
        let credential = Credential::new(
            "kbdint".to_string(),
            username,
            CredentialKind::Password {
                password: "not-the-answer".to_string(),
            },
        );
        let connection = Connection::new(
            "kbdint".to_string(),
            host,
            port,
            Some(credential.id.clone()),
            ConnectionKind::Direct,
        );
        let id = connection.id.clone();
        crate::storage::with_data_mut(|data| {
            data.credentials.push(credential);
            data.connections.push(connection);
            Ok(())
        })
        .unwrap();
        id
    }

    /// A pane's channel: its events land in a list, and `respond` sees each
    /// prompt's id.
    fn pane(
        respond: impl Fn(String) + Send + Sync + 'static,
    ) -> (
        Channel<InvokeResponseBody>,
        Arc<Mutex<Vec<serde_json::Value>>>,
    ) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                let event: serde_json::Value = serde_json::from_str(&json).unwrap();
                if event["kind"] == "auth_prompt" {
                    respond(event["prompt_id"].as_str().unwrap().to_string());
                }
                seen.lock().unwrap().push(event);
            }
            Ok(())
        });
        (channel, events)
    }

    fn kinds(events: &Mutex<Vec<serde_json::Value>>) -> Vec<String> {
        events
            .lock()
            .unwrap()
            .iter()
            .map(|event| event["kind"].as_str().unwrap().to_string())
            .collect()
    }

    /// `reopen_shell` runs on whatever thread `run_attempt` starts, so a thread
    /// of its own here is the real situation, not a convenience.
    #[test]
    #[ignore = "needs a keyboard-interactive server (SSIX_LIVE_KBDINT_SSH)"]
    fn live_reopen_asks_in_the_pane_again() {
        let Some((host, port, username, answer)) = server() else {
            return;
        };
        with_isolated_data_dir(|| {
            let id = save_connection(host, port, username);
            let (output, events) = pane(move |prompt_id| {
                let answer = answer.clone();
                std::thread::spawn(move || {
                    auth_prompt::answer(&prompt_id, vec![answer]).unwrap();
                });
            });
            let shell = std::thread::spawn(move || reopen_shell(&id, Default::default(), &output))
                .join()
                .unwrap();
            assert!(shell.is_ok(), "{:?}", shell.err());
            assert_eq!(kinds(&events), ["auth_prompt", "auth_prompt_closed"]);
        });
    }

    /// What Cancel on the reconnect bar and closing the pane do: nothing else
    /// answers this prompt, so a wait that did not notice would last minutes.
    #[test]
    #[ignore = "needs a keyboard-interactive server (SSIX_LIVE_KBDINT_SSH)"]
    fn live_reopen_ends_a_waiting_prompt_when_cancelled() {
        let Some((host, port, username, _)) = server() else {
            return;
        };
        with_isolated_data_dir(|| {
            let id = save_connection(host, port, username);
            let cancelled = Arc::new(AtomicBool::new(false));
            let flag = cancelled.clone();
            let (output, events) = pane(move |_| flag.store(true, Ordering::SeqCst));
            let started = Instant::now();
            let error = std::thread::spawn(move || reopen_shell(&id, cancelled, &output))
                .join()
                .unwrap()
                .err()
                .expect("cancelled");
            assert_eq!(error, auth_prompt::CANCELLED);
            assert!(!is_retryable_connect_error(&error));
            assert!(started.elapsed() < Duration::from_secs(10));
            assert_eq!(kinds(&events), ["auth_prompt", "auth_prompt_closed"]);
        });
    }

    /// The prompt's own Cancel button, and a wrong answer: both stop the
    /// reconnect rather than asking again.
    #[test]
    #[ignore = "needs a keyboard-interactive server (SSIX_LIVE_KBDINT_SSH)"]
    fn live_reopen_fails_for_good_on_cancel_and_on_a_wrong_answer() {
        let Some((host, port, username, _)) = server() else {
            return;
        };
        with_isolated_data_dir(|| {
            let id = save_connection(host, port, username);
            let (output, _) = pane(|prompt_id| auth_prompt::cancel(&prompt_id));
            let cancel_id = id.clone();
            let error =
                std::thread::spawn(move || reopen_shell(&cancel_id, Default::default(), &output))
                    .join()
                    .unwrap()
                    .err()
                    .expect("cancelled");
            assert_eq!(error, auth_prompt::CANCELLED);

            let (output, _) = pane(|prompt_id| {
                std::thread::spawn(move || {
                    auth_prompt::answer(&prompt_id, vec!["wrong".to_string()]).unwrap();
                });
            });
            let error = std::thread::spawn(move || reopen_shell(&id, Default::default(), &output))
                .join()
                .unwrap()
                .err()
                .expect("refused");
            assert!(error.to_lowercase().contains("auth"), "{error}");
            assert!(!is_retryable_connect_error(&error), "{error}");
        });
    }
}
