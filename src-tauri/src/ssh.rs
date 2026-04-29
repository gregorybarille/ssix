use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Barrier, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use ssh2::Session;
use tauri::{AppHandle, Emitter};

pub enum AuthMethod {
    Password(String),
    Key {
        path: String,
        passphrase: Option<String>,
    },
    KeyMemory {
        private_key: String,
        passphrase: Option<String>,
    },
}

impl Clone for AuthMethod {
    fn clone(&self) -> Self {
        match self {
            AuthMethod::Password(p) => AuthMethod::Password(p.clone()),
            AuthMethod::Key { path, passphrase } => AuthMethod::Key {
                path: path.clone(),
                passphrase: passphrase.clone(),
            },
            AuthMethod::KeyMemory {
                private_key,
                passphrase,
            } => AuthMethod::KeyMemory {
                private_key: private_key.clone(),
                passphrase: passphrase.clone(),
            },
        }
    }
}

pub enum SessionMsg {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Disconnect,
}

pub(crate) fn build_startup_command(remote_path: Option<&str>, login_command: Option<&str>) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(path) = remote_path.map(str::trim).filter(|path| !path.is_empty()) {
        parts.push(format!("cd {}", shell_quote(path)));
    }
    if let Some(command) = login_command
        .map(str::trim)
        .filter(|command| !command.is_empty())
    {
        parts.push(command.to_string());
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" && "))
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r#"'\''"#))
}

fn write_startup_command(channel: &mut ssh2::Channel, startup_command: Option<&str>) {
    if let Some(command) = startup_command {
        let _ = channel.write_all(command.as_bytes());
        let _ = channel.write_all(b"\n");
        let _ = channel.flush();
    }
}

/// Session registry. The `sessions` map is keyed by the UUID we hand back
/// to the frontend on `ssh_connect` and stores the worker thread's
/// `Sender<SessionMsg>` so subsequent `ssh_write` / `ssh_resize` /
/// `ssh_disconnect` commands can talk to it.
///
/// Audit-4 Phase 5b: previously a `Mutex<HashMap>`, which serialised
/// every command across every session. Under load (many tunnels +
/// concurrent terminal input) the mutex was the contention hotspot and
/// a panic in any command would poison every other session. `DashMap`
/// shards internally so each session's slot can be locked
/// independently, and a panic mid-mutation only affects that one
/// shard. The frontend-facing API is unchanged.
pub struct SshState {
    pub sessions: dashmap::DashMap<String, Sender<SessionMsg>>,
}

impl SshState {
    pub fn new() -> Self {
        Self {
            sessions: dashmap::DashMap::new(),
        }
    }
}

/// Lock a `Mutex<T>` and recover transparently from poisoning.
///
/// Audit-3 P1#3: every spawned tunnel/jump-shell worker in this module
/// previously called `lock().unwrap()` on the shared session/active/
/// forward_err mutexes. A panic anywhere in those threads (e.g.
/// `forward_bidi` panicking on a malformed peer addr) would poison the
/// mutex and the *next* thread's `.lock().unwrap()` would propagate the
/// panic — taking down every tunnel sharing that mutex with no
/// user-visible error.
///
/// `PoisonError::into_inner` gives us the guarded value back; the only
/// thing we lose is the "previous panic happened" signal, which we'd
/// have lost anyway because the original panic was already unwound.
/// Callers that care about the poison case (e.g. to emit a UI event)
/// can use `Mutex::is_poisoned` before calling this helper.
///
/// Note: the long-lived `SshState.sessions` mutex in `commands/ssh.rs`
/// keeps `lock().map_err(|e| e.to_string())?` because there the caller
/// has a `Result` channel back to the frontend and we'd rather surface
/// the error than silently swallow a possible state corruption.
#[inline]
pub(crate) fn lock_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Status payload emitted on `ssx:tunnel:status:{id}`.
#[derive(Serialize, Clone)]
pub struct TunnelStatus {
    pub state: &'static str, // "listening" | "client_connected" | "client_closed" | "error"
    pub local_port: u16,
    pub destination: String,
    pub message: Option<String>,
    pub active_clients: usize,
}

/// Audit-4 Phase 6c: SSH/tunnel event names are namespaced under
/// `ssx:` so they cannot collide with Tauri plugin events or with
/// any future frontend custom-event listener (the frontend already
/// uses an `ssx:` prefix for its DOM events — see App.tsx
/// `ssx:contextmenu`, `ssx:terminal-paste`).
///
/// Callers MUST go through these helpers so a future rename is a
/// single-point change. The frontend mirrors the same names in
/// `src/components/Terminal.tsx` and `src/components/TunnelTab.tsx`;
/// any change here must be reflected there in the same commit.
pub(crate) fn ssh_output_event(session_id: &str) -> String {
    format!("ssx:ssh:output:{}", session_id)
}
pub(crate) fn ssh_error_event(session_id: &str) -> String {
    format!("ssx:ssh:error:{}", session_id)
}
pub(crate) fn ssh_closed_event(session_id: &str) -> String {
    format!("ssx:ssh:closed:{}", session_id)
}
pub(crate) fn tunnel_status_event(session_id: &str) -> String {
    format!("ssx:tunnel:status:{}", session_id)
}

pub fn start_ssh_session(
    host: String,
    port: u16,
    username: String,
    auth: AuthMethod,
    app_handle: AppHandle,
    session_id: String,
    verbosity: u8,
    extra_args: Option<String>,
    startup_command: Option<String>,
) -> Result<Sender<SessionMsg>, String> {
    let (session, mut channel) = open_shell(&host, port, &username, &auth, verbosity, &extra_args)?;
    write_startup_command(&mut channel, startup_command.as_deref());

    let (tx, rx): (Sender<SessionMsg>, Receiver<SessionMsg>) = mpsc::channel();
    let sid = session_id.clone();
    crate::logs::log(
        &app_handle,
        "info",
        "ssh",
        format!("session {} opened to {}@{}:{}", sid, username, host, port),
    );

    thread::spawn(move || {
        // Keep `session` alive for the lifetime of the thread so the channel
        // remains valid.  The session is intentionally held here even though
        // it is not used directly — dropping it would invalidate `channel`.
        let _session = session;
        if verbosity >= 1 {
            let msg = format!(
                "\x1b[2m[SSX] Connected to {}:{} as {}\x1b[0m\r\n",
                host, port, username
            );
            let _ = app_handle.emit(&ssh_output_event(&sid), msg.into_bytes());
        }
        let result = run_io_loop(channel, &app_handle, &sid, rx);
        if let Err(e) = &result {
            crate::logs::log(&app_handle, "error", "ssh", format!("session {}: {}", sid, e));
            let _ = app_handle.emit(&ssh_error_event(&sid), e.clone());
        }
        let _ = app_handle.emit(&ssh_closed_event(&sid), ());
    });

    Ok(tx)
}

pub(crate) fn open_authenticated_session(
    host: &str,
    port: u16,
    username: &str,
    auth: &AuthMethod,
    verbosity: u8,
    extra_args: &Option<String>,
) -> Result<Session, String> {
    let addr = format!("{}:{}", host, port);
    let tcp = TcpStream::connect(&addr)
        .map_err(|e| format!("TCP connect to {} failed: {}", addr, e))?;
    tcp.set_nonblocking(false).ok();
    open_authenticated_session_over_stream(tcp, username, auth, verbosity, extra_args)
}

pub(crate) fn open_authenticated_session_over_stream(
    tcp: TcpStream,
    username: &str,
    auth: &AuthMethod,
    verbosity: u8,
    extra_args: &Option<String>,
) -> Result<Session, String> {
    tcp.set_nonblocking(false).ok();

    let mut session =
        Session::new().map_err(|e| format!("SSH session create failed: {}", e))?;

    if verbosity >= 2 {
        session.trace(ssh2::TraceFlags::all());
    }

    if let Some(args) = extra_args {
        if args.split_whitespace().any(|t| t == "-C") {
            session.set_compress(true);
        }
    }

    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|e| format!("SSH handshake failed: {}", e))?;

    match auth {
        AuthMethod::Password(pw) => {
            session
                .userauth_password(username, pw)
                .map_err(|e| format!("Password auth failed: {}", e))?;
        }
        AuthMethod::Key { path, passphrase } => {
            session
                .userauth_pubkey_file(username, None, Path::new(path), passphrase.as_deref())
                .map_err(|e| format!("Key auth failed: {}", e))?;
        }
        AuthMethod::KeyMemory {
            private_key,
            passphrase,
        } => {
            authenticate_pubkey_memory(&session, username, private_key, passphrase.as_deref())
                .map_err(|e| format!("Key auth failed: {}", e))?;
        }
    }

    if !session.authenticated() {
        return Err("Authentication failed".to_string());
    }

    Ok(session)
}

#[cfg(not(windows))]
fn authenticate_pubkey_memory(
    session: &Session,
    username: &str,
    private_key: &str,
    passphrase: Option<&str>,
) -> Result<(), ssh2::Error> {
    session.userauth_pubkey_memory(username, None, private_key, passphrase)
}

#[cfg(windows)]
fn authenticate_pubkey_memory(
    session: &Session,
    username: &str,
    private_key: &str,
    passphrase: Option<&str>,
) -> Result<(), ssh2::Error> {
    use std::fs;
    use uuid::Uuid;

    let path = std::env::temp_dir().join(format!("ssx-key-{}.tmp", Uuid::new_v4()));

    fs::write(&path, private_key).map_err(|e| {
        ssh2::Error::new(
            ssh2::ErrorCode::Session(-1),
            &format!("failed to write temporary SSH key: {}", e),
        )
    })?;

    let auth_result = session.userauth_pubkey_file(username, None, &path, passphrase);
    let remove_result = fs::remove_file(&path);

    if let Err(e) = auth_result {
        return Err(e);
    }

    remove_result.map_err(|e| {
        ssh2::Error::new(
            ssh2::ErrorCode::Session(-1),
            &format!("failed to remove temporary SSH key: {}", e),
        )
    })
}

/// Opens a TCP connection, performs the SSH handshake + authentication, requests a
/// PTY and starts a shell.  Returns the session and the ready-to-use channel on
/// success, or a descriptive error string on failure.  Everything here runs on the
/// caller's thread so errors surface synchronously.
fn open_shell(
    host: &str,
    port: u16,
    username: &str,
    auth: &AuthMethod,
    verbosity: u8,
    extra_args: &Option<String>,
) -> Result<(Session, ssh2::Channel), String> {
    let session = open_authenticated_session(host, port, username, auth, verbosity, extra_args)?;

    let mut channel = session
        .channel_session()
        .map_err(|e| format!("Channel open failed: {}", e))?;

    channel
        .request_pty("xterm-256color", None, Some((80, 24, 0, 0)))
        .map_err(|e| format!("PTY request failed: {}", e))?;

    channel
        .shell()
        .map_err(|e| format!("Shell request failed: {}", e))?;

    session.set_blocking(false);

    Ok((session, channel))
}

/// Like `open_shell` but takes an already-connected `TcpStream` (e.g. one that
/// has been bridged through a gateway via `channel_direct_tcpip`).
fn open_shell_over_stream(
    tcp: TcpStream,
    username: &str,
    auth: &AuthMethod,
    verbosity: u8,
    extra_args: &Option<String>,
) -> Result<(Session, ssh2::Channel), String> {
    let session =
        open_authenticated_session_over_stream(tcp, username, auth, verbosity, extra_args)?;

    let mut channel = session
        .channel_session()
        .map_err(|e| format!("Channel open failed: {}", e))?;

    channel
        .request_pty("xterm-256color", None, Some((80, 24, 0, 0)))
        .map_err(|e| format!("PTY request failed: {}", e))?;

    channel
        .shell()
        .map_err(|e| format!("Shell request failed: {}", e))?;

    session.set_blocking(false);

    Ok((session, channel))
}

fn run_io_loop(
    mut channel: ssh2::Channel,
    app_handle: &AppHandle,
    session_id: &str,
    rx: Receiver<SessionMsg>,
) -> Result<(), String> {
    let output_event = ssh_output_event(session_id);
    let error_event = ssh_error_event(session_id);
    let mut buf = [0u8; 8192];

    loop {
        let mut got_data = false;

        // Read stdout
        match channel.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let _ = app_handle.emit(&output_event, &buf[..n]);
                got_data = true;
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => {
                // Audit-4 H1: previously this was `Err(_) => break`, which
                // closed the terminal silently when a real I/O error
                // (network reset, broken pipe, ssh2 internal failure)
                // was indistinguishable from a clean EOF. The user saw
                // "Connection closed" with no clue why. Now we surface
                // the error so the frontend can render a banner before
                // the session-closed event.
                let msg = format!("SSH read error: {}", e);
                crate::logs::log(app_handle, "warn", "ssh", msg.clone());
                let _ = app_handle.emit(&error_event, msg);
                break;
            }
        }

        // Read stderr
        match channel.stderr().read(&mut buf) {
            Ok(n) if n > 0 => {
                let _ = app_handle.emit(&output_event, &buf[..n]);
                got_data = true;
            }
            // stderr errors are intentionally swallowed: WouldBlock is
            // expected, and a real error here will also surface via
            // stdout's read on the next iteration (or the channel-close
            // path below).
            _ => {}
        }

        // Process commands from frontend
        loop {
            match rx.try_recv() {
                Ok(SessionMsg::Write(data)) => {
                    let _ = channel.write_all(&data);
                    let _ = channel.flush();
                }
                Ok(SessionMsg::Resize { cols, rows }) => {
                    // Audit-4 M1: previously `let _ = channel.request_pty_size(...)`
                    // silently dropped resize failures, leaving the user with a
                    // terminal stuck at the wrong dimensions and no diagnostic.
                    // We can't emit a banner from here without risking a noisy
                    // loop on flaky links (xterm.js fires resize on every column
                    // change), so log the first error per session at warn level
                    // and downgrade subsequent ones to debug. Errors are rare
                    // in practice — usually the channel is dead and the next
                    // read() will close the session anyway.
                    if let Err(e) = channel.request_pty_size(cols, rows, None, None) {
                        crate::logs::log(
                            app_handle,
                            "warn",
                            "ssh",
                            format!(
                                "session {} resize to {}x{} failed: {}",
                                session_id, cols, rows, e
                            ),
                        );
                    }
                }
                Ok(SessionMsg::Disconnect) => {
                    let _ = channel.close();
                    let _ = channel.wait_close();
                    return Ok(());
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    let _ = channel.close();
                    let _ = channel.wait_close();
                    return Ok(());
                }
            }
        }

        if channel.eof() {
            break;
        }

        if !got_data {
            thread::sleep(Duration::from_millis(10));
        }
    }

    let _ = channel.close();
    let _ = channel.wait_close();
    Ok(())
}

// ---------------------------------------------------------------------------
// Tunneling: gateway session + port forwarding + jump-shell
// ---------------------------------------------------------------------------

/// Opens an SSH session to a gateway and authenticates. The returned session is
/// left in *blocking* mode so callers can use `channel_direct_tcpip` reliably.
/// Caller is responsible for any subsequent `set_blocking(false)` if needed.
pub(crate) fn open_gateway_session(
    gateway_host: &str,
    gateway_port: u16,
    username: &str,
    auth: &AuthMethod,
) -> Result<Session, String> {
    let addr = format!("{}:{}", gateway_host, gateway_port);
    // Resolve + connect with a 10s timeout so a dead gateway doesn't hang the UI
    // (the OS default connect timeout is ~30s+).
    let socket_addr = addr
        .to_socket_addrs()
        .map_err(|e| format!("Failed to resolve gateway {}: {}", addr, e))?
        .next()
        .ok_or_else(|| format!("No addresses resolved for gateway {}", addr))?;
    let tcp = TcpStream::connect_timeout(&socket_addr, Duration::from_secs(10))
        .map_err(|e| format!("TCP connect to gateway {} failed: {}", addr, e))?;
    tcp.set_nonblocking(false).ok();

    let mut session =
        Session::new().map_err(|e| format!("SSH session create failed: {}", e))?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|e| format!("Gateway SSH handshake failed: {}", e))?;

    match auth {
        AuthMethod::Password(pw) => {
            session
                .userauth_password(username, pw)
                .map_err(|e| format!("Gateway password auth failed: {}", e))?;
        }
        AuthMethod::Key { path, passphrase } => {
            session
                .userauth_pubkey_file(username, None, Path::new(path), passphrase.as_deref())
                .map_err(|e| format!("Gateway key auth failed: {}", e))?;
        }
        AuthMethod::KeyMemory {
            private_key,
            passphrase,
        } => {
            authenticate_pubkey_memory(&session, username, private_key, passphrase.as_deref())
                .map_err(|e| format!("Gateway key auth failed: {}", e))?;
        }
    }

    if !session.authenticated() {
        return Err("Gateway authentication failed".to_string());
    }

    Ok(session)
}

/// Forward bytes between a local TCP socket and an SSH `direct-tcpip` channel.
/// Runs both directions on a single thread using non-blocking polling so we can
/// detect EOF on either side without blocking the other.
pub(crate) fn forward_bidi(mut local: TcpStream, mut channel: ssh2::Channel) {
    // Both local and channel must be non-blocking so neither direction can
    // stall the other. local uses set_nonblocking; the channel inherits the
    // gateway session's blocking flag — callers must set_blocking(false) on
    // the session before calling this function.
    local.set_nonblocking(true).ok();
    let mut buf_a = [0u8; 16384];
    let mut buf_b = [0u8; 16384];

    loop {
        let mut idle = true;

        // local → channel
        match local.read(&mut buf_a) {
            Ok(0) => {
                let _ = channel.send_eof();
                let _ = channel.wait_eof();
                let _ = channel.close();
                let _ = channel.wait_close();
                return;
            }
            Ok(n) => {
                // Write with retry on WouldBlock — the underlying gateway TCP
                // socket is non-blocking, so a large burst may need multiple
                // attempts before the kernel buffer has room.
                let mut written = 0;
                while written < n {
                    match channel.write(&buf_a[written..n]) {
                        Ok(k) => written += k,
                        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(1));
                        }
                        Err(_) => return,
                    }
                }
                let _ = channel.flush();
                idle = false;
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => {
                let _ = channel.close();
                return;
            }
        }

        // channel → local
        match channel.read(&mut buf_b) {
            Ok(0) => {
                let _ = local.shutdown(std::net::Shutdown::Both);
                return;
            }
            Ok(n) => {
                if local.write_all(&buf_b[..n]).is_err() {
                    let _ = channel.close();
                    return;
                }
                idle = false;
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => {
                let _ = local.shutdown(std::net::Shutdown::Both);
                return;
            }
        }

        if channel.eof() {
            let _ = local.shutdown(std::net::Shutdown::Both);
            return;
        }

        if idle {
            thread::sleep(Duration::from_millis(1));
        }
    }
}

/// Bind a local TCP listener on `127.0.0.1:local_port` and forward every accepted
/// connection through `gateway_session` to `destination_host:destination_port`.
///
/// Returns a `Sender<SessionMsg>` that the command layer can store in `SshState`.
/// Only `SessionMsg::Disconnect` is meaningful for port-forward sessions; `Write`
/// and `Resize` are ignored.
///
/// Errors at bind or gateway-connect time are returned synchronously.
pub fn start_port_forward(
    gateway_host: String,
    gateway_port: u16,
    gateway_username: String,
    gateway_auth: AuthMethod,
    local_port: u16,
    destination_host: String,
    destination_port: u16,
    app_handle: AppHandle,
    session_id: String,
) -> Result<Sender<SessionMsg>, String> {
    // Bind first so port-conflict errors surface immediately.
    let bind_addr: SocketAddr = format!("127.0.0.1:{}", local_port)
        .parse()
        .map_err(|e: std::net::AddrParseError| e.to_string())?;
    let listener = TcpListener::bind(bind_addr)
        .map_err(|e| format!("Failed to bind 127.0.0.1:{}: {}", local_port, e))?;
    listener.set_nonblocking(true).ok();

    // Open gateway session up-front so auth/connect errors surface synchronously.
    let session =
        open_gateway_session(&gateway_host, gateway_port, &gateway_username, &gateway_auth)?;
    // Keep gateway session in blocking mode for channel_direct_tcpip.
    let session = Arc::new(Mutex::new(session));

    let (tx, rx): (Sender<SessionMsg>, Receiver<SessionMsg>) = mpsc::channel();
    let sid = session_id.clone();
    let destination_label = format!("{}:{}", destination_host, destination_port);
    let active = Arc::new(Mutex::new(0usize));

    // Emit "listening" status.
    let _ = app_handle.emit(
        &tunnel_status_event(&sid),
        TunnelStatus {
            state: "listening",
            local_port,
            destination: destination_label.clone(),
            message: None,
            active_clients: 0,
        },
    );

    thread::spawn(move || {
        loop {
            // Drain control messages.
            match rx.try_recv() {
                Ok(SessionMsg::Disconnect) => break,
                Ok(_) => {}
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => break,
            }

            match listener.accept() {
                Ok((local_stream, peer)) => {
                    let session = Arc::clone(&session);
                    let dest_host = destination_host.clone();
                    let dest_label = destination_label.clone();
                    let app = app_handle.clone();
                    let sid_inner = sid.clone();
                    let active_inner = Arc::clone(&active);
                    let local_port_inner = local_port;

                    thread::spawn(move || {
                        let chan_result = {
                            let sess = lock_recover(&session);
                            sess.channel_direct_tcpip(
                                &dest_host,
                                destination_port,
                                Some((&peer.ip().to_string(), peer.port())),
                            )
                        };

                        let channel = match chan_result {
                            Ok(c) => c,
                            Err(e) => {
                                let _ = app.emit(
                                    &tunnel_status_event(&sid_inner),
                                    TunnelStatus {
                                        state: "error",
                                        local_port: local_port_inner,
                                        destination: dest_label.clone(),
                                        message: Some(format!(
                                            "channel_direct_tcpip failed: {}",
                                            e
                                        )),
                                        active_clients: *lock_recover(&active_inner),
                                    },
                                );
                                return;
                            }
                        };

                        let count = {
                            let mut g = lock_recover(&active_inner);
                            *g += 1;
                            *g
                        };
                        let _ = app.emit(
                            &tunnel_status_event(&sid_inner),
                            TunnelStatus {
                                state: "client_connected",
                                local_port: local_port_inner,
                                destination: dest_label.clone(),
                                message: Some(format!("from {}", peer)),
                                active_clients: count,
                            },
                        );

                        forward_bidi(local_stream, channel);

                        let count = {
                            let mut g = lock_recover(&active_inner);
                            *g = g.saturating_sub(1);
                            *g
                        };
                        let _ = app.emit(
                            &tunnel_status_event(&sid_inner),
                            TunnelStatus {
                                state: "client_closed",
                                local_port: local_port_inner,
                                destination: dest_label.clone(),
                                message: Some(format!("from {}", peer)),
                                active_clients: count,
                            },
                        );
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    crate::logs::log(
                        &app_handle,
                        "error",
                        "tunnel",
                        format!("session {}: accept failed: {}", sid, e),
                    );
                    let _ = app_handle.emit(
                        &tunnel_status_event(&sid),
                        TunnelStatus {
                            state: "error",
                            local_port,
                            destination: destination_label.clone(),
                            message: Some(format!("accept failed: {}", e)),
                            active_clients: *lock_recover(&active),
                        },
                    );
                    break;
                }
            }
        }

        // Listener is dropped here. The gateway session is dropped when the last
        // forwarder thread holding an Arc clone exits.
        let _ = app_handle.emit(&ssh_closed_event(&sid), ());
    });

    Ok(tx)
}

/// Open an SSH terminal to `destination_host:destination_port` reached *through*
/// a gateway. Implementation: bind a random loopback port, port-forward through
/// the gateway, then run a normal SSH session against `127.0.0.1:<random_port>`.
///
/// Errors at any synchronous step (bind, gateway connect, destination connect,
/// auth, PTY/shell) surface immediately.
pub fn start_jump_shell(
    gateway_host: String,
    gateway_port: u16,
    gateway_username: String,
    gateway_auth: AuthMethod,
    destination_host: String,
    destination_port: u16,
    destination_username: String,
    destination_auth: AuthMethod,
    app_handle: AppHandle,
    session_id: String,
    verbosity: u8,
    extra_args: Option<String>,
    startup_command: Option<String>,
) -> Result<Sender<SessionMsg>, String> {
    // Bind a random free loopback port for the inner SSH session.
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind ephemeral loopback port: {}", e))?;
    let local_addr = listener
        .local_addr()
        .map_err(|e| format!("local_addr() failed: {}", e))?;
    let local_port = local_addr.port();

    // Open gateway session synchronously so auth errors surface now.
    let gateway_session =
        open_gateway_session(&gateway_host, gateway_port, &gateway_username, &gateway_auth)?;
    let gateway_session = Arc::new(Mutex::new(gateway_session));

    // Use a barrier so open_shell (below) only proceeds after the forwarder
    // thread has accepted the connection AND successfully opened the
    // channel_direct_tcpip. This eliminates the SSH-banner race where the
    // inner TcpStream connects but the pipe isn't bridged yet.
    // barrier(2): one wait in the forwarder thread, one wait here.
    let barrier = Arc::new(Barrier::new(2));
    // Carry any error from the forwarder back to the main thread.
    let forward_err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    // Switch listener back to blocking so accept() is a clean blocking call.
    listener.set_nonblocking(false).ok();

    {
        let gateway_session = Arc::clone(&gateway_session);
        let destination_host_inner = destination_host.clone();
        let barrier = Arc::clone(&barrier);
        let forward_err = Arc::clone(&forward_err);
        thread::spawn(move || {
            // Block until the inner SSH session connects.
            match listener.accept() {
                Ok((local_stream, peer)) => {
                    let chan_result = {
                        let sess = lock_recover(&gateway_session);
                        sess.channel_direct_tcpip(
                            &destination_host_inner,
                            destination_port,
                            Some((&peer.ip().to_string(), peer.port())),
                        )
                    };
                    match chan_result {
                        Ok(channel) => {
                            // Must switch to non-blocking before forward_bidi so
                            // channel.read() doesn't block and deadlock with the
                            // handshake on the main thread.
                            lock_recover(&gateway_session).set_blocking(false);
                            // Signal the main thread: the bridge is live, open_shell may proceed.
                            barrier.wait();
                            forward_bidi(local_stream, channel);
                        }
                        Err(e) => {
                            *lock_recover(&forward_err) =
                                Some(format!("channel_direct_tcpip failed: {}", e));
                            let _ = local_stream.shutdown(std::net::Shutdown::Both);
                            barrier.wait();
                        }
                    }
                }
                Err(e) => {
                    *lock_recover(&forward_err) = Some(format!("accept() failed: {}", e));
                    barrier.wait();
                }
            }
        });
    }

    let connect_result = TcpStream::connect(("127.0.0.1", local_port))
        .map_err(|e| format!("Failed to connect inner SSH session: {}", e));

    // Audit-4 H5: if the connect failed, the spawned forwarder is still
    // blocked in `listener.accept()` and will NEVER reach `barrier.wait()`.
    // Calling `barrier.wait()` here would deadlock the main thread forever.
    // We must check the connect result FIRST, and short-circuit before the
    // barrier when it failed. We also poke the listener with a self-connect
    // so the accept() call wakes up and the forwarder thread can exit
    // cleanly (best-effort — if it fails, the thread leaks but the user
    // gets a real error instead of a hang).
    let tcp_stream = match connect_result {
        Ok(stream) => stream,
        Err(e) => {
            // Best-effort: unblock the accept() so the spawned thread exits.
            let _ = TcpStream::connect(("127.0.0.1", local_port));
            return Err(e);
        }
    };

    // Wait for the forwarder to finish bridging before starting the SSH handshake.
    barrier.wait();

    if let Some(err) = lock_recover(&forward_err).take() {
        return Err(format!("Destination connect via gateway failed: {}", err));
    }

    let (session, mut channel) = open_shell_over_stream(tcp_stream, &destination_username, &destination_auth, verbosity, &extra_args)
        .map_err(|e| format!("Destination connect via gateway failed: {}", e))?;
    write_startup_command(&mut channel, startup_command.as_deref());

    let (tx, rx): (Sender<SessionMsg>, Receiver<SessionMsg>) = mpsc::channel();
    let sid = session_id.clone();
    crate::logs::log(
        &app_handle,
        "info",
        "jump_shell",
        format!(
            "session {} opened: {}@{}:{} via {}:{}",
            sid, destination_username, destination_host, destination_port, gateway_host, gateway_port
        ),
    );

    thread::spawn(move || {
        let _session = session;
        // Hold gateway_session alive for the lifetime of the shell so the
        // forwarder's channel_direct_tcpip stays valid.
        let _gateway_session = gateway_session;
        if verbosity >= 1 {
            let msg = format!(
                "\x1b[2m[SSX] Connected to {}:{} via gateway {}:{} as {}\x1b[0m\r\n",
                destination_host, destination_port, gateway_host, gateway_port, destination_username
            );
            let _ = app_handle.emit(&ssh_output_event(&sid), msg.into_bytes());
        }
        let result = run_io_loop(channel, &app_handle, &sid, rx);
        if let Err(e) = &result {
            crate::logs::log(&app_handle, "error", "jump_shell", format!("session {}: {}", sid, e));
            let _ = app_handle.emit(&ssh_error_event(&sid), e.clone());
        }
        let _ = app_handle.emit(&ssh_closed_event(&sid), ());
    });

    Ok(tx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ssh_state_new() {
        let state = SshState::new();
        assert!(state.sessions.is_empty());
    }

    #[test]
    fn test_ssh_state_insert_and_remove() {
        let state = SshState::new();
        let (tx, _rx) = mpsc::channel::<SessionMsg>();

        state.sessions.insert("test-session".to_string(), tx);
        assert_eq!(state.sessions.len(), 1);
        assert!(state.sessions.contains_key("test-session"));

        state.sessions.remove("test-session");
        assert!(state.sessions.is_empty());
    }

    #[test]
    fn test_session_msg_send_receive() {
        let (tx, rx) = mpsc::channel::<SessionMsg>();

        tx.send(SessionMsg::Write(b"hello".to_vec())).unwrap();
        tx.send(SessionMsg::Resize { cols: 80, rows: 24 }).unwrap();
        tx.send(SessionMsg::Disconnect).unwrap();

        match rx.recv().unwrap() {
            SessionMsg::Write(data) => assert_eq!(data, b"hello"),
            _ => panic!("expected Write"),
        }

        match rx.recv().unwrap() {
            SessionMsg::Resize { cols, rows } => {
                assert_eq!(cols, 80);
                assert_eq!(rows, 24);
            }
            _ => panic!("expected Resize"),
        }

        match rx.recv().unwrap() {
            SessionMsg::Disconnect => {}
            _ => panic!("expected Disconnect"),
        }
    }

    #[test]
    fn test_sender_disconnect_detection() {
        let (tx, rx) = mpsc::channel::<SessionMsg>();
        drop(tx);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn test_build_startup_command_combines_remote_path_and_login_command() {
        assert_eq!(
            build_startup_command(Some("/srv/app"), Some("sudo su - deploy")),
            Some("cd '/srv/app' && sudo su - deploy".into())
        );
    }

    #[test]
    fn test_build_startup_command_handles_quotes() {
        assert_eq!(
            build_startup_command(Some("/srv/it's"), None),
            Some("cd '/srv/it'\\''s'".into())
        );
    }

    /// Audit-3 P1#3: poisoned mutex must NOT take down sibling worker
    /// threads. Before this fix, a panic in any tunnel forwarder thread
    /// poisoned the shared `session` / `active` / `forward_err` mutex
    /// and every subsequent `.lock().unwrap()` call propagated a fresh
    /// panic — cascading until every tunnel using that mutex was dead.
    #[test]
    fn test_lock_recover_returns_value_after_poison() {
        use std::panic::{catch_unwind, AssertUnwindSafe};
        use std::sync::Arc;

        let m = Arc::new(Mutex::new(42usize));
        let m_inner = Arc::clone(&m);
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let _g = m_inner.lock().unwrap();
            panic!("simulate forwarder thread panic while holding lock");
        }));

        assert!(m.is_poisoned(), "precondition: mutex should be poisoned");

        // The whole point: a sibling thread can still read/write.
        {
            let g = lock_recover(&m);
            assert_eq!(*g, 42, "lock_recover must return the inner value");
        }
        {
            let mut g = lock_recover(&m);
            *g = 99;
        }
        assert_eq!(*lock_recover(&m), 99);
    }

    #[test]
    fn test_lock_recover_works_on_unpoisoned_mutex() {
        let m = Mutex::new(String::from("hello"));
        let g = lock_recover(&m);
        assert_eq!(*g, "hello");
    }

    #[test]
    fn test_lock_recover_does_not_panic_under_thread_panic() {
        // Poison the mutex from one thread, lock from another. Without
        // lock_recover, the second thread would panic.
        use std::sync::Arc;

        let m = Arc::new(Mutex::new(0u32));
        let m_panic = Arc::clone(&m);
        let _ = thread::spawn(move || {
            let _g = m_panic.lock().unwrap();
            panic!("dying thread");
        })
        .join();

        assert!(m.is_poisoned());

        // Recovery must not panic.
        let mut g = lock_recover(&m);
        *g += 1;
        assert_eq!(*g, 1);
    }
}
