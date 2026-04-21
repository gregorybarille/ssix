use std::collections::HashMap;
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
}

impl Clone for AuthMethod {
    fn clone(&self) -> Self {
        match self {
            AuthMethod::Password(p) => AuthMethod::Password(p.clone()),
            AuthMethod::Key { path, passphrase } => AuthMethod::Key {
                path: path.clone(),
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

pub struct SshState {
    pub sessions: Mutex<HashMap<String, Sender<SessionMsg>>>,
}

impl SshState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

/// Status payload emitted on `tunnel-status-{id}`.
#[derive(Serialize, Clone)]
pub struct TunnelStatus {
    pub state: &'static str, // "listening" | "client_connected" | "client_closed" | "error"
    pub local_port: u16,
    pub destination: String,
    pub message: Option<String>,
    pub active_clients: usize,
}

pub fn start_ssh_session(
    host: String,
    port: u16,
    username: String,
    auth: AuthMethod,
    app_handle: AppHandle,
    session_id: String,
    verbosity: u8,
) -> Result<Sender<SessionMsg>, String> {
    // Perform TCP connect, SSH handshake, auth, and PTY/shell setup synchronously
    // so that any connection error is returned directly to the caller rather than
    // being lost in a race between the background thread emitting an event and the
    // frontend registering its listener.
    let (session, channel) = open_shell(&host, port, &username, &auth, verbosity)?;

    let (tx, rx): (Sender<SessionMsg>, Receiver<SessionMsg>) = mpsc::channel();
    let sid = session_id.clone();

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
            let _ = app_handle.emit(&format!("ssh-output-{}", sid), msg.into_bytes());
        }
        let result = run_io_loop(channel, &app_handle, &sid, rx);
        if let Err(e) = &result {
            let _ = app_handle.emit(&format!("ssh-error-{}", sid), e.clone());
        }
        let _ = app_handle.emit(&format!("ssh-closed-{}", sid), ());
    });

    Ok(tx)
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
) -> Result<(Session, ssh2::Channel), String> {
    let addr = format!("{}:{}", host, port);
    let tcp = TcpStream::connect(&addr)
        .map_err(|e| format!("TCP connect to {} failed: {}", addr, e))?;
    tcp.set_nonblocking(false).ok();

    let mut session =
        Session::new().map_err(|e| format!("SSH session create failed: {}", e))?;

    if verbosity >= 2 {
        // Enable libssh2 trace output. Output goes to stderr and is useful
        // when running SSX from a terminal for low-level debugging.
        session.trace(ssh2::TraceFlags::all());
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
    }

    if !session.authenticated() {
        return Err("Authentication failed".to_string());
    }

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
) -> Result<(Session, ssh2::Channel), String> {
    tcp.set_nonblocking(false).ok();

    let mut session =
        Session::new().map_err(|e| format!("SSH session create failed: {}", e))?;

    if verbosity >= 2 {
        session.trace(ssh2::TraceFlags::all());
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
    }

    if !session.authenticated() {
        return Err("Authentication failed".to_string());
    }

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
    let output_event = format!("ssh-output-{}", session_id);
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
            Err(_) => break,
        }

        // Read stderr
        match channel.stderr().read(&mut buf) {
            Ok(n) if n > 0 => {
                let _ = app_handle.emit(&output_event, &buf[..n]);
                got_data = true;
            }
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
                    let _ = channel.request_pty_size(cols, rows, None, None);
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
fn open_gateway_session(
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
    }

    if !session.authenticated() {
        return Err("Gateway authentication failed".to_string());
    }

    Ok(session)
}

/// Forward bytes between a local TCP socket and an SSH `direct-tcpip` channel.
/// Runs both directions on a single thread using non-blocking polling so we can
/// detect EOF on either side without blocking the other.
fn forward_bidi(mut local: TcpStream, mut channel: ssh2::Channel) {
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
        &format!("tunnel-status-{}", sid),
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
                            let sess = session.lock().unwrap();
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
                                    &format!("tunnel-status-{}", sid_inner),
                                    TunnelStatus {
                                        state: "error",
                                        local_port: local_port_inner,
                                        destination: dest_label.clone(),
                                        message: Some(format!(
                                            "channel_direct_tcpip failed: {}",
                                            e
                                        )),
                                        active_clients: *active_inner.lock().unwrap(),
                                    },
                                );
                                return;
                            }
                        };

                        let count = {
                            let mut g = active_inner.lock().unwrap();
                            *g += 1;
                            *g
                        };
                        let _ = app.emit(
                            &format!("tunnel-status-{}", sid_inner),
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
                            let mut g = active_inner.lock().unwrap();
                            *g = g.saturating_sub(1);
                            *g
                        };
                        let _ = app.emit(
                            &format!("tunnel-status-{}", sid_inner),
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
                    let _ = app_handle.emit(
                        &format!("tunnel-status-{}", sid),
                        TunnelStatus {
                            state: "error",
                            local_port,
                            destination: destination_label.clone(),
                            message: Some(format!("accept failed: {}", e)),
                            active_clients: *active.lock().unwrap(),
                        },
                    );
                    break;
                }
            }
        }

        // Listener is dropped here. The gateway session is dropped when the last
        // forwarder thread holding an Arc clone exits.
        let _ = app_handle.emit(&format!("ssh-closed-{}", sid), ());
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
                        let sess = gateway_session.lock().unwrap();
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
                            gateway_session.lock().unwrap().set_blocking(false);
                            // Signal the main thread: the bridge is live, open_shell may proceed.
                            barrier.wait();
                            forward_bidi(local_stream, channel);
                        }
                        Err(e) => {
                            *forward_err.lock().unwrap() =
                                Some(format!("channel_direct_tcpip failed: {}", e));
                            let _ = local_stream.shutdown(std::net::Shutdown::Both);
                            barrier.wait();
                        }
                    }
                }
                Err(e) => {
                    *forward_err.lock().unwrap() = Some(format!("accept() failed: {}", e));
                    barrier.wait();
                }
            }
        });
    }

    let connect_result = TcpStream::connect(("127.0.0.1", local_port))
        .map_err(|e| format!("Failed to connect inner SSH session: {}", e));

    // Wait for the forwarder to finish bridging before starting the SSH handshake.
    barrier.wait();

    if let Some(err) = forward_err.lock().unwrap().take() {
        return Err(format!("Destination connect via gateway failed: {}", err));
    }

    let tcp_stream = connect_result?;

    let (session, channel) = open_shell_over_stream(tcp_stream, &destination_username, &destination_auth, verbosity)
        .map_err(|e| format!("Destination connect via gateway failed: {}", e))?;

    let (tx, rx): (Sender<SessionMsg>, Receiver<SessionMsg>) = mpsc::channel();
    let sid = session_id.clone();

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
            let _ = app_handle.emit(&format!("ssh-output-{}", sid), msg.into_bytes());
        }
        let result = run_io_loop(channel, &app_handle, &sid, rx);
        if let Err(e) = &result {
            let _ = app_handle.emit(&format!("ssh-error-{}", sid), e.clone());
        }
        let _ = app_handle.emit(&format!("ssh-closed-{}", sid), ());
    });

    Ok(tx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ssh_state_new() {
        let state = SshState::new();
        let sessions = state.sessions.lock().unwrap();
        assert!(sessions.is_empty());
    }

    #[test]
    fn test_ssh_state_insert_and_remove() {
        let state = SshState::new();
        let (tx, _rx) = mpsc::channel::<SessionMsg>();

        {
            let mut sessions = state.sessions.lock().unwrap();
            sessions.insert("test-session".to_string(), tx);
            assert_eq!(sessions.len(), 1);
            assert!(sessions.contains_key("test-session"));
        }

        {
            let mut sessions = state.sessions.lock().unwrap();
            sessions.remove("test-session");
            assert!(sessions.is_empty());
        }
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
}
