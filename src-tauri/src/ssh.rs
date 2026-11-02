//! SSH sessions on top of `ssh2`: interactive shells and jump host bridging.
//! Local forwards (`ssh -L`) build on the helpers here from `crate::forwards`.
//!
//! Every live session is one OS thread. The command layer talks to it through
//! a [`SessionHandle`] — an mpsc queue plus a wake-up pipe — so a keystroke
//! wakes the worker immediately instead of waiting for a poll tick. Workers
//! sleep in `poll(2)` on the SSH socket and the wake pipe, so an idle session
//! costs nothing. Terminal output goes to the webview over a Tauri
//! [`Channel`] as raw bytes: no JSON on the hot path.
//!
//! All sessions (direct, jump host, target behind a jump host, SSH server of a
//! forward) go through
//! [`open_authenticated_session_over_stream`], which enforces a connect
//! timeout, a libssh2 setup timeout and host-key verification. A
//! connection's verbosity adds `ssh -v` style lines to the Logs view along
//! the way (see `crate::ssh_debug`).
//!
//! A shell's worker also watches for a dead connection (keepalives, see
//! [`KeepaliveWatchdog`]), reconnects in place (`crate::reconnect`) and writes
//! the session log (`crate::session_log`).

use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use ssh2::Session;

use crate::reconnect::{reconnect_delay, AttemptCount, OpenAttempt, ReconnectPolicy, Recovery};
use crate::session_log::{SessionLog, SessionLogPlan};
use crate::ssh_debug::{host_key_type_name, SshDebug};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager};

/// TCP connect timeout for every outbound connection (direct host or gateway).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// libssh2 timeout for blocking calls during setup (handshake, auth, channel open).
pub(crate) const SESSION_TIMEOUT_MS: u32 = 15_000;
/// Longest an idle worker waits for socket readiness before re-checking its queue.
/// Idle wait for a forwarder that shares its session with other clients.
const SHARED_WAIT_MAX: Duration = Duration::from_millis(10);
/// Longest single park while waiting for a socket to become writable.
const WRITE_WAIT_MAX: Duration = Duration::from_millis(50);
const WAIT_MAX: Duration = Duration::from_millis(250);
/// Cap on bytes coalesced into one output message.
const OUTPUT_COALESCE_MAX: usize = 256 * 1024;
/// How long a non-blocking write may wait on `WouldBlock` before giving up.
const WRITE_STALL_TIMEOUT: Duration = Duration::from_secs(10);
/// libssh2's "call again later" code, surfaced by ssh2 as `ErrorCode::Session`.
const LIBSSH2_ERROR_EAGAIN: i32 = -37;
/// libssh2's answer to waiting for a channel to close before the server's EOF.
const LIBSSH2_ERROR_INVAL: i32 = -34;
/// Unanswered keepalive intervals before a session counts as dead, as with
/// OpenSSH's default `ServerAliveCountMax`.
const KEEPALIVE_MAX_MISSED: u32 = 3;
/// libssh2 sends no more often than this, whatever the configured interval.
const KEEPALIVE_MIN_INTERVAL_SECS: u32 = 2;
/// Puts a terminal back to normal after a shell vanished mid-program: leaves
/// the alternate screen, resets modes and turns off mouse reporting. The
/// remote can no longer do any of it, and it would hide the error, the
/// scrollback and the new prompt.
///
/// xterm.js restores the saved cursor on `?1049l` even when the normal screen
/// is already showing, which would send the cursor to the top left of a plain
/// prompt. `ESC 7` first saves where it is: on the normal screen the restore
/// then goes nowhere, and on the alternate screen the save lands on that
/// screen's own record, so the normal screen's position still comes back.
const TERMINAL_RESTORE: &[u8] =
    b"\x1b7\x1b[?1049l\x1b[!p\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l";

#[derive(Clone)]
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
    /// Keys held by the SSH agent, FIDO2 keys included (see `crate::agent`).
    Agent,
}

/// Where to connect and as whom.
#[derive(Clone)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    /// OpenSSH-style `ProxyCommand` used instead of a TCP connection; set
    /// on the first hop only (see `crate::proxy`).
    pub proxy_command: Option<String>,
}

impl Endpoint {
    pub fn addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    /// This endpoint reached through `proxy_command`, when there is one.
    pub fn through(mut self, proxy_command: Option<&str>) -> Self {
        self.proxy_command = proxy_command
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .map(str::to_string);
        self
    }
}

/// Per-connection knobs for interactive shells.
#[derive(Clone, Default)]
pub struct ShellOptions {
    pub verbosity: u8,
    pub extra_args: Option<String>,
    pub startup_command: Option<String>,
    /// Seconds between SSH keepalives, 0 for none.
    pub keepalive_interval: u16,
    /// Set by a reconnect attempt's owner once nobody wants the result.
    pub cancelled: Option<Arc<AtomicBool>>,
    /// Let this shell's server use the local SSH agent (`ssh -A`).
    pub agent_forwarding: bool,
}

/// Everything a worker needs to talk back to the app.
pub struct SessionContext {
    pub app: AppHandle,
    pub session_id: String,
    /// Raw terminal output. Created by the frontend before `ssh_connect`.
    pub output: Channel<InvokeResponseBody>,
}

/// Control messages travel on the same channel as the bytes, as JSON, so
/// they are delivered in order with the output and buffered by the
/// frontend sink if the terminal has not mounted yet (a shell that exits
/// immediately is still reported).
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OutputEvent {
    Error {
        message: String,
    },
    Closed,
    /// The connection is lost: attempt `attempt` of `max_attempts` starts in
    /// `delay_ms`. `message` says what went wrong last.
    Reconnecting {
        attempt: u8,
        max_attempts: u8,
        delay_ms: u64,
        message: String,
    },
    /// A new shell took over; the session id stays the same.
    Reconnected,
    /// The connection is lost and nothing more happens until the user asks
    /// (`ssh_reconnect`) or closes the pane.
    ReconnectStopped {
        message: String,
    },
}

impl SessionContext {
    fn send_output(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let _ = self.output.send(InvokeResponseBody::Raw(bytes.to_vec()));
    }

    fn send_event(&self, event: OutputEvent) {
        if let Ok(json) = serde_json::to_string(&event) {
            let _ = self.output.send(InvokeResponseBody::Json(json));
        }
    }

    pub(crate) fn log(&self, level: &str, source: &str, message: String) {
        crate::logs::log(&self.app, level, source, message);
    }

    fn emit_error(&self, message: String) {
        self.send_event(OutputEvent::Error { message });
    }

    /// Put the session in the registry before its worker starts, so a
    /// worker that exits at once still finds (and removes) its own entry.
    pub(crate) fn register(&self, handle: SessionHandle) -> Result<(), String> {
        let state = self
            .app
            .try_state::<SshState>()
            .ok_or_else(|| "SSH state is not managed".to_string())?;
        state.sessions.insert(self.session_id.clone(), handle);
        Ok(())
    }

    /// Drop the session from the registry and tell the frontend it is gone.
    pub(crate) fn finish(&self) {
        if let Some(state) = self.app.try_state::<SshState>() {
            state.sessions.remove(&self.session_id);
        }
        self.send_event(OutputEvent::Closed);
    }
}

pub enum SessionMsg {
    Write(Vec<u8>),
    Resize {
        cols: u32,
        rows: u32,
    },
    Disconnect,
    /// Retry a dropped shell now. Means nothing while the connection is up.
    Reconnect,
    /// Stop retrying a dropped shell. Means nothing while the connection is up.
    CancelReconnect,
}

/// Command-layer side of a session: queue a message and wake the worker.
/// Cloneable so the registry and the caller can both hold one.
#[derive(Clone)]
pub struct SessionHandle {
    tx: Sender<SessionMsg>,
    waker: Arc<wake::Waker>,
}

impl SessionHandle {
    pub fn send(&self, msg: SessionMsg) -> Result<(), String> {
        self.tx
            .send(msg)
            .map_err(|_| "Session is no longer running".to_string())?;
        self.waker.wake();
        Ok(())
    }
}

/// Worker side of the control channel.
pub(crate) struct ControlRx {
    pub(crate) rx: Receiver<SessionMsg>,
    pub(crate) wake: wake::WakeReceiver,
}

pub(crate) fn control_channel() -> Result<(SessionHandle, ControlRx), String> {
    let (tx, rx) = mpsc::channel();
    let (waker, wake) = wake::pair().map_err(|e| format!("Failed to create wake pipe: {}", e))?;
    Ok((
        SessionHandle {
            tx,
            waker: Arc::new(waker),
        },
        ControlRx { rx, wake },
    ))
}

/// Readiness waiting. On Unix a worker blocks in `poll(2)` on the SSH socket
/// and a wake pipe; the command layer writes a byte to the pipe when it
/// queues input. Windows falls back to a short sleep.
#[cfg(unix)]
pub(crate) mod wake {
    use std::io::{self, Read, Write};
    use std::os::fd::{AsRawFd, RawFd};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    pub type Fd = RawFd;

    pub struct Waker(UnixStream);
    pub struct WakeReceiver(UnixStream);

    pub fn pair() -> io::Result<(Waker, WakeReceiver)> {
        let (a, b) = UnixStream::pair()?;
        a.set_nonblocking(true)?;
        b.set_nonblocking(true)?;
        Ok((Waker(a), WakeReceiver(b)))
    }

    impl Waker {
        pub fn wake(&self) {
            // A full pipe already guarantees a wake-up; ignore WouldBlock.
            let _ = (&self.0).write(&[1u8]);
        }
    }

    impl WakeReceiver {
        pub fn fd(&self) -> Fd {
            self.0.as_raw_fd()
        }

        pub fn drain(&self) {
            let mut buf = [0u8; 64];
            while matches!((&self.0).read(&mut buf), Ok(n) if n > 0) {}
        }
    }

    pub fn fd_of<T: AsRawFd>(t: &T) -> Fd {
        t.as_raw_fd()
    }

    fn poll(fds: &[Fd], events: libc::c_short, timeout: Duration) {
        let mut polls: Vec<libc::pollfd> = fds
            .iter()
            .map(|&fd| libc::pollfd {
                fd,
                events,
                revents: 0,
            })
            .collect();
        let ms = timeout.as_millis().min(i32::MAX as u128) as libc::c_int;
        // SAFETY: `polls` is a valid, initialised array of `pollfd` that
        // outlives the call, and `len` matches its length.
        unsafe {
            libc::poll(polls.as_mut_ptr(), polls.len() as libc::nfds_t, ms);
        }
    }

    /// Block until one of `fds` is readable or `timeout` elapses.
    pub fn wait_readable(fds: &[Fd], timeout: Duration) {
        poll(fds, libc::POLLIN, timeout);
    }

    /// Block until `fd` is writable or `timeout` elapses.
    pub fn wait_writable(fd: Fd, timeout: Duration) {
        poll(&[fd], libc::POLLOUT, timeout);
    }

    fn ready_now(fd: Fd, events: libc::c_short) -> bool {
        let mut polls = [libc::pollfd {
            fd,
            events,
            revents: 0,
        }];
        // SAFETY: `polls` is a valid, initialised one-element array of
        // `pollfd` that outlives the call.
        let ready = unsafe { libc::poll(polls.as_mut_ptr(), 1, 0) };
        ready > 0
    }

    /// Whether `fd` has something to read (or was closed), without waiting.
    pub fn is_readable(fd: Fd) -> bool {
        ready_now(fd, libc::POLLIN)
    }

    /// Whether a send on `fd` can go out now (or would fail), without waiting.
    pub fn is_writable(fd: Fd) -> bool {
        ready_now(fd, libc::POLLOUT)
    }
}

#[cfg(windows)]
pub(crate) mod wake {
    use std::io;
    use std::os::windows::io::{AsRawSocket, RawSocket};
    use std::time::Duration;

    pub type Fd = RawSocket;

    pub struct Waker;
    pub struct WakeReceiver;

    pub fn pair() -> io::Result<(Waker, WakeReceiver)> {
        Ok((Waker, WakeReceiver))
    }

    impl Waker {
        pub fn wake(&self) {}
    }

    impl WakeReceiver {
        pub fn fd(&self) -> Fd {
            0
        }
        pub fn drain(&self) {}
    }

    pub fn fd_of<T: AsRawSocket>(t: &T) -> Fd {
        t.as_raw_socket()
    }

    /// No readiness notification on Windows yet: poll at a short interval.
    pub fn wait_readable(_fds: &[Fd], timeout: Duration) {
        std::thread::sleep(timeout.min(Duration::from_millis(5)));
    }

    pub fn wait_writable(_fd: Fd, timeout: Duration) {
        std::thread::sleep(timeout.min(Duration::from_millis(5)));
    }

    /// Whether `fd` has something to read (or was closed), without waiting
    /// or consuming it. libssh2 keeps its socket non-blocking.
    pub fn is_readable(fd: Fd) -> bool {
        use std::mem::ManuallyDrop;
        use std::net::TcpStream;
        use std::os::windows::io::FromRawSocket;
        // SAFETY: `fd` is the session's open socket. `ManuallyDrop` keeps
        // this temporary view of it from closing the socket.
        let stream = ManuallyDrop::new(unsafe { TcpStream::from_raw_socket(fd) });
        let mut byte = [0u8; 1];
        !matches!(stream.peek(&mut byte), Err(e) if e.kind() == io::ErrorKind::WouldBlock)
    }

    /// Whether a send on `fd` can go out now (or would fail), without waiting.
    pub fn is_writable(fd: Fd) -> bool {
        #[repr(C)]
        struct WsaPollFd {
            fd: usize,
            events: i16,
            revents: i16,
        }
        const POLLWRNORM: i16 = 0x0010;
        #[link(name = "ws2_32")]
        extern "system" {
            fn WSAPoll(fds: *mut WsaPollFd, count: u32, timeout: i32) -> i32;
        }
        let mut poll = WsaPollFd {
            fd: fd as usize,
            events: POLLWRNORM,
            revents: 0,
        };
        // SAFETY: `poll` is a valid one-element array that outlives the call,
        // and a timeout of 0 returns at once.
        unsafe { WSAPoll(&mut poll, 1, 0) > 0 }
    }
}

/// Session registry keyed by the UUID handed to the frontend on `ssh_connect`.
/// `DashMap` shards internally so sessions never contend on one lock.
/// Workers remove their own entry when they exit.
pub struct SshState {
    pub sessions: dashmap::DashMap<String, SessionHandle>,
}

impl SshState {
    pub fn new() -> Self {
        Self {
            sessions: dashmap::DashMap::new(),
        }
    }
}

pub(crate) fn build_startup_command(
    remote_path: Option<&str>,
    login_command: Option<&str>,
) -> Option<String> {
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
    }
}

// ---------------------------------------------------------------------------
// Connecting and authenticating
// ---------------------------------------------------------------------------

/// Resolve `host:port` and connect with a bounded timeout, trying each
/// resolved address in turn.
pub(crate) fn connect_tcp(host: &str, port: u16) -> Result<TcpStream, String> {
    let addrs: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("Failed to resolve {}:{}: {}", host, port, e))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("No addresses resolved for {}:{}", host, port));
    }
    let mut last_err = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
            Ok(tcp) => {
                tcp.set_nodelay(true).ok();
                return Ok(tcp);
            }
            Err(e) => last_err = Some(e),
        }
    }
    Err(format!(
        "TCP connect to {}:{} failed: {}",
        host,
        port,
        last_err.map(|e| e.to_string()).unwrap_or_default()
    ))
}

/// Open the stream to `endpoint`: a TCP connection, or its proxy command.
pub(crate) fn connect_endpoint(endpoint: &Endpoint, verbosity: u8) -> Result<TcpStream, String> {
    let debug = SshDebug::new(verbosity, endpoint.addr());
    debug.at(1, || {
        format!("Connecting to {} port {}.", endpoint.host, endpoint.port)
    });
    let started = Instant::now();
    let tcp = match endpoint.proxy_command.as_deref() {
        Some(command) => crate::proxy::connect(command, endpoint, &debug)?,
        None => connect_tcp(&endpoint.host, endpoint.port)?,
    };
    debug.at(1, || "Connection established.".to_string());
    debug.at(2, || match tcp.peer_addr() {
        Ok(peer) => format!("Socket peer: {}", peer),
        Err(e) => format!("Socket peer unknown: {}", e),
    });
    debug.at(3, || {
        format!("TCP connect took {} ms", started.elapsed().as_millis())
    });
    Ok(tcp)
}

pub(crate) fn open_authenticated_session(
    endpoint: &Endpoint,
    verbosity: u8,
    extra_args: Option<&str>,
) -> Result<Session, String> {
    let tcp = connect_endpoint(endpoint, verbosity)?;
    open_authenticated_session_over_stream(tcp, endpoint, verbosity, extra_args)
}

/// Handshake, verify the host key, authenticate. The returned session is in
/// blocking mode with a setup timeout applied.
pub(crate) fn open_authenticated_session_over_stream(
    tcp: TcpStream,
    endpoint: &Endpoint,
    verbosity: u8,
    extra_args: Option<&str>,
) -> Result<Session, String> {
    open_session_unless_cancelled(tcp, endpoint, verbosity, extra_args, None)
}

/// What an attempt ends with once it was cancelled. Nobody reads it.
const ATTEMPT_CANCELLED: &str = "The reconnect attempt was cancelled";

fn stop_if_cancelled(cancelled: Option<&AtomicBool>) -> Result<(), String> {
    match cancelled {
        Some(flag) if flag.load(Ordering::SeqCst) => Err(ATTEMPT_CANCELLED.to_string()),
        _ => Ok(()),
    }
}

/// [`open_authenticated_session_over_stream`] that does not log in once
/// `cancelled` is set: a cancelled attempt must not cost a login on the server.
fn open_session_unless_cancelled(
    tcp: TcpStream,
    endpoint: &Endpoint,
    verbosity: u8,
    extra_args: Option<&str>,
    cancelled: Option<&AtomicBool>,
) -> Result<Session, String> {
    tcp.set_nonblocking(false).ok();

    let debug = SshDebug::new(verbosity, endpoint.addr());
    let mut session = Session::new().map_err(|e| format!("SSH session create failed: {}", e))?;
    session.set_timeout(SESSION_TIMEOUT_MS);

    if extra_args
        .map(|args| args.split_whitespace().any(|t| t == "-C"))
        .unwrap_or(false)
    {
        debug.at(2, || "Compression requested (-C).".to_string());
        session.set_compress(true);
    }

    debug.proposal(&session);
    session.set_tcp_stream(tcp);
    debug.at(1, || "Starting key exchange.".to_string());
    let started = Instant::now();
    session
        .handshake()
        .map_err(|e| format!("SSH handshake with {} failed: {}", endpoint.addr(), e))?;
    debug.at(3, || {
        format!("Key exchange took {} ms", started.elapsed().as_millis())
    });
    debug.negotiated(&session);
    debug.at(1, || match session.host_key() {
        Some((_, kind)) => format!(
            "Server host key: {} {}",
            host_key_type_name(kind),
            crate::known_hosts::fingerprint(&session)
        ),
        None => "Server presented no host key.".to_string(),
    });

    crate::known_hosts::verify_session(&session, &endpoint.host, endpoint.port)?;
    debug.at(1, || {
        format!(
            "Host key verified against {}",
            crate::known_hosts::known_hosts_path().display()
        )
    });

    stop_if_cancelled(cancelled)?;
    authenticate(&session, endpoint, &debug)?;
    Ok(session)
}

/// The method names a server offers (`publickey,keyboard-interactive`). `None`
/// when it could not be asked, which offers nothing but rules nothing out.
fn list_auth_methods(session: &Session, username: &str, debug: &SshDebug) -> Option<String> {
    match crate::libssh2_ext::userauth_list(session, username) {
        Ok(methods) => {
            debug.at(1, || {
                format!("Authentications that can continue: {}", methods)
            });
            // An empty list goes with a server that just accepted "none".
            (!methods.is_empty()).then_some(methods)
        }
        Err(e) => {
            debug.at(1, || {
                format!("Could not list authentication methods: {}", e)
            });
            None
        }
    }
}

fn offers_method(methods: &str, method: &str) -> bool {
    methods.split(',').any(|offered| offered.trim() == method)
}

/// Log in with the endpoint's credential; a server may then still ask for a
/// second factor. Keyboard-interactive covers both a server that takes nothing
/// else and that second step, as it does with `ssh`. A method the server does
/// not offer is skipped, so a saved password never goes to a server that
/// refuses passwords, and a saved password never answers a prompt: only the
/// user does, in the pane (see `crate::auth_prompt`).
pub(crate) fn authenticate(
    session: &Session,
    endpoint: &Endpoint,
    debug: &SshDebug,
) -> Result<(), String> {
    let username = &endpoint.username;
    // Listing the methods sends a "none" request, as `ssh -v` does. A
    // server that accepts it leaves nothing else to do.
    let offered = list_auth_methods(session, username, debug);
    if session.authenticated() {
        debug.at(1, || "Authentication succeeded (none).".to_string());
        return Ok(());
    }

    let (wire_name, method) = match &endpoint.auth {
        AuthMethod::Password(_) => ("password", "password".to_string()),
        AuthMethod::Key { path, .. } => ("publickey", format!("publickey ({})", path)),
        AuthMethod::KeyMemory { .. } => ("publickey", "publickey (stored key)".to_string()),
        AuthMethod::Agent => ("publickey", "publickey (agent)".to_string()),
    };
    let started = Instant::now();
    let first_step = match offered.as_deref() {
        Some(methods) if !offers_method(methods, wire_name) => Err(format!(
            "The server does not accept {} authentication (it offers: {})",
            wire_name, methods
        )),
        _ => {
            debug.at(1, || {
                format!("Next authentication method: {} as {}", method, username)
            });
            authenticate_with_credential(session, endpoint, debug)
        }
    };
    let method = match first_step {
        Ok(()) if session.authenticated() => method,
        outcome => {
            let error = outcome
                .err()
                .unwrap_or_else(|| "Authentication failed".to_string());
            // Refused, or accepted as a first factor: libssh2 reports both as
            // a failure. The server's remaining methods tell them apart.
            let remaining = list_auth_methods(session, username, debug);
            if session.authenticated() {
                method
            } else if !remaining
                .as_deref()
                .is_some_and(|methods| offers_method(methods, "keyboard-interactive"))
            {
                return Err(error);
            } else {
                let Some(pane) = crate::auth_prompt::current_pane() else {
                    return Err(format!(
                        "{}. The server asks for keyboard-interactive answers, which only a \
                         terminal pane can collect: open this connection as a shell",
                        error
                    ));
                };
                debug.at(1, || {
                    format!(
                        "Next authentication method: keyboard-interactive as {}",
                        username
                    )
                });
                crate::auth_prompt::authenticate(pane, session, endpoint, debug, &error)?;
                if !session.authenticated() {
                    return Err("Authentication failed".to_string());
                }
                "keyboard-interactive".to_string()
            }
        }
    };
    debug.at(1, || format!("Authentication succeeded ({}).", method));
    debug.at(3, || {
        format!("Authentication took {} ms", started.elapsed().as_millis())
    });
    Ok(())
}

fn authenticate_with_credential(
    session: &Session,
    endpoint: &Endpoint,
    debug: &SshDebug,
) -> Result<(), String> {
    let username = &endpoint.username;
    match &endpoint.auth {
        AuthMethod::Password(pw) => session
            .userauth_password(username, pw)
            .map_err(|e| format!("Password auth failed: {}", e)),
        AuthMethod::Key { path, passphrase } => session
            .userauth_pubkey_file(username, None, Path::new(path), passphrase.as_deref())
            .map_err(|e| format!("Key auth failed: {}", e)),
        AuthMethod::KeyMemory {
            private_key,
            passphrase,
        } => authenticate_pubkey_memory(session, username, private_key, passphrase.as_deref())
            .map_err(|e| format!("Key auth failed: {}", e)),
        AuthMethod::Agent => crate::agent::authenticate(session, username, debug),
    }
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

/// libssh2's WinCNG backend has no in-memory key auth, so stage the key in
/// a 0600 temp file for the duration of the call.
#[cfg(windows)]
fn authenticate_pubkey_memory(
    session: &Session,
    username: &str,
    private_key: &str,
    passphrase: Option<&str>,
) -> Result<(), ssh2::Error> {
    let path = std::env::temp_dir().join(format!("ssix-key-{}.tmp", uuid::Uuid::new_v4()));
    crate::storage::atomic_write(&path, private_key.as_bytes(), Some(0o600)).map_err(|_| {
        ssh2::Error::new(
            ssh2::ErrorCode::Session(-1),
            "failed to write temporary SSH key",
        )
    })?;
    let result = session.userauth_pubkey_file(username, None, &path, passphrase);
    let _ = std::fs::remove_file(&path);
    result
}

/// A shell ready for [`run_io_loop`].
pub struct OpenShell {
    session: Session,
    channel: ssh2::Channel,
    keepalive_interval: u16,
}

/// Authenticate over `tcp` and start a shell.
pub(crate) fn open_shell_over_stream(
    tcp: TcpStream,
    endpoint: &Endpoint,
    opts: &ShellOptions,
) -> Result<OpenShell, String> {
    let session = open_session_unless_cancelled(
        tcp,
        endpoint,
        opts.verbosity,
        opts.extra_args.as_deref(),
        opts.cancelled.as_deref(),
    )?;
    start_shell(session, endpoint, opts)
}

/// Request a PTY, start a shell and run the startup command. The session is
/// switched to non-blocking mode before returning.
fn start_shell(
    session: Session,
    endpoint: &Endpoint,
    opts: &ShellOptions,
) -> Result<OpenShell, String> {
    let debug = SshDebug::new(opts.verbosity, endpoint.addr());
    debug.at(1, || "Opening a session channel.".to_string());
    let mut channel = session
        .channel_session()
        .map_err(|e| format!("Channel open failed: {}", e))?;
    // A PTY merges stderr on the server, but a server may still send extended
    // data. Left queued on its own stream it would hide the end of the shell:
    // libssh2 reports no EOF while any data is unread.
    channel
        .handle_extended_data(ssh2::ExtendedData::Merge)
        .map_err(|e| format!("Channel open failed: {}", e))?;
    debug.at(1, || {
        "Requesting a PTY (xterm-256color, 80x24).".to_string()
    });
    channel
        .request_pty("xterm-256color", None, Some((80, 24, 0, 0)))
        .map_err(|e| format!("PTY request failed: {}", e))?;
    if opts.agent_forwarding {
        crate::agent::request_forwarding(&session, &mut channel, &debug);
    }
    debug.at(1, || "Requesting a shell.".to_string());
    channel
        .shell()
        .map_err(|e| format!("Shell request failed: {}", e))?;
    // The login command can do anything, and nobody asked for it any more.
    stop_if_cancelled(opts.cancelled.as_deref())?;
    if let Some(command) = opts.startup_command.as_deref() {
        debug.at(2, || format!("Sending startup command: {}", command));
    }
    write_startup_command(&mut channel, opts.startup_command.as_deref());

    if opts.keepalive_interval > 0 {
        debug.at(2, || {
            format!("Sending a keepalive every {} s.", opts.keepalive_interval)
        });
        session.set_keepalive(true, u32::from(opts.keepalive_interval));
    }
    session.set_blocking(false);
    Ok(OpenShell {
        session,
        channel,
        keepalive_interval: opts.keepalive_interval,
    })
}

pub(crate) fn open_shell(endpoint: &Endpoint, opts: &ShellOptions) -> Result<OpenShell, String> {
    let tcp = connect_endpoint(endpoint, opts.verbosity)?;
    open_shell_over_stream(tcp, endpoint, opts)
}

/// Open a shell on `destination` through the jump host `gateway`.
pub(crate) fn open_jump_shell(
    gateway: &Endpoint,
    destination: &Endpoint,
    opts: &ShellOptions,
) -> Result<OpenShell, String> {
    let stream = bridge_unless_cancelled(
        gateway,
        &destination.host,
        destination.port,
        opts.verbosity,
        opts.cancelled.as_deref(),
    )?;
    open_shell_over_stream(stream, destination, opts)
        .map_err(|e| format!("Target connect via jump host failed: {}", e))
}

// ---------------------------------------------------------------------------
// Interactive shell sessions
// ---------------------------------------------------------------------------

/// What a shell worker does beyond its first connection.
pub struct ShellResilience {
    /// Read when the connection drops, so a settings change made since the
    /// session opened applies.
    pub policy: Arc<dyn Fn() -> ReconnectPolicy + Send + Sync>,
    /// Open the shell again, from the saved connection as it is by then.
    pub reopen: OpenAttempt<OpenShell>,
    pub log: Option<SessionLogPlan>,
}

pub fn start_ssh_session(
    target: Endpoint,
    opts: ShellOptions,
    ctx: SessionContext,
    resilience: ShellResilience,
) -> Result<SessionHandle, String> {
    let _prompts = crate::auth_prompt::PromptScope::enter(&ctx.output, None);
    let shell = open_shell(&target, &opts)?;
    let (handle, control) = control_channel()?;
    ctx.register(handle.clone())?;
    ctx.log(
        "info",
        "ssh",
        format!(
            "session {} opened to {}@{}",
            ctx.session_id,
            target.username,
            target.addr()
        ),
    );
    let banner = if opts.verbosity >= 1 {
        format!(
            "\x1b[2m[SSIX] Connected to {} as {}\x1b[0m\r\n",
            target.addr(),
            target.username
        )
    } else {
        String::new()
    };
    spawn_shell_worker(shell, ctx, control, banner, "ssh", resilience);
    Ok(handle)
}

fn spawn_shell_worker(
    shell: OpenShell,
    ctx: SessionContext,
    control: ControlRx,
    banner: String,
    source: &'static str,
    resilience: ShellResilience,
) {
    thread::spawn(move || {
        ctx.send_output(banner.as_bytes());
        let mut io = ShellIo {
            log: resilience
                .log
                .as_ref()
                .and_then(|plan| open_log(&ctx, plan)),
            ctx,
            control,
            pty_size: None,
        };
        let mut shell = shell;
        let mut attempts = AttemptCount::default();
        loop {
            let opened = Instant::now();
            let reason = match run_io_loop(shell, &mut io) {
                ShellEnd::Closed => break,
                ShellEnd::Dropped(reason) => reason,
            };
            attempts.shell_ended(opened.elapsed());
            io.report_lost(source, &reason);
            let ctx = &io.ctx;
            let emit = |event: OutputEvent| {
                log_recovery(ctx, source, &event);
                ctx.send_event(event);
            };
            let reopened = Recovery {
                policy: (resilience.policy)(),
                open: Arc::clone(&resilience.reopen),
                control: &io.control,
                pty_size: &mut io.pty_size,
                attempts: &mut attempts,
                delay: reconnect_delay,
                emit: &emit,
            }
            .run(reason);
            match reopened {
                Some(next) => {
                    io.report_reconnected(source);
                    shell = next;
                }
                None => break,
            }
        }
        io.ctx.finish();
    });
}

/// The Logs view's record of a recovery.
fn log_recovery(ctx: &SessionContext, source: &str, event: &OutputEvent) {
    match event {
        OutputEvent::Reconnecting {
            attempt,
            max_attempts,
            delay_ms,
            ..
        } => ctx.log(
            "info",
            source,
            format!(
                "session {}: reconnect attempt {}/{} in {} ms",
                ctx.session_id, attempt, max_attempts, delay_ms
            ),
        ),
        OutputEvent::ReconnectStopped { message } => ctx.log(
            "warn",
            source,
            format!(
                "session {}: stopped reconnecting: {}",
                ctx.session_id, message
            ),
        ),
        _ => {}
    }
}

/// Open the session's log. A session never fails because of its log: the
/// reason shows in the terminal and the Logs view, and the shell goes on.
fn open_log(ctx: &SessionContext, plan: &SessionLogPlan) -> Option<SessionLog> {
    match SessionLog::create(plan) {
        Ok(log) => {
            ctx.log(
                "info",
                "session_log",
                format!(
                    "session {}: logging to {}",
                    ctx.session_id,
                    log.path().display()
                ),
            );
            Some(log)
        }
        Err(e) => {
            warn_log_stopped(ctx, &e);
            None
        }
    }
}

fn warn_log_stopped(ctx: &SessionContext, reason: &str) {
    ctx.log(
        "warn",
        "session_log",
        format!("session {}: {}", ctx.session_id, reason),
    );
    ctx.send_output(
        format!("\r\n\x1b[33m[SSIX] This session is not being logged: {reason}\x1b[0m\r\n")
            .as_bytes(),
    );
}

/// A shell worker's state that survives a reconnect.
struct ShellIo {
    ctx: SessionContext,
    control: ControlRx,
    log: Option<SessionLog>,
    /// The terminal's last known size, for the next shell.
    pty_size: Option<(u32, u32)>,
}

impl ShellIo {
    /// Send shell output to the terminal and the log.
    fn output(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.ctx.send_output(bytes);
        self.write_log(|log| log.append(bytes));
    }

    fn write_log(&mut self, write: impl FnOnce(&mut SessionLog) -> io::Result<()>) {
        let Some(log) = self.log.as_mut() else { return };
        if let Err(e) = write(log) {
            let reason = format!("writing {} failed: {}", log.path().display(), e);
            self.log = None;
            warn_log_stopped(&self.ctx, &reason);
        }
    }

    fn report_lost(&mut self, source: &str, reason: &str) {
        self.ctx.log(
            "warn",
            source,
            format!(
                "session {}: connection lost: {}",
                self.ctx.session_id, reason
            ),
        );
        self.write_log(|log| log.note(&format!("Connection lost: {reason}")));
        self.ctx.send_output(TERMINAL_RESTORE);
        self.ctx.emit_error(reason.to_string());
    }

    fn report_reconnected(&mut self, source: &str) {
        self.ctx.log(
            "info",
            source,
            format!("session {}: reconnected", self.ctx.session_id),
        );
        self.write_log(|log| log.note("Reconnected"));
        self.ctx
            .send_output(b"\r\n\x1b[2m[SSIX] Reconnected.\x1b[0m\r\n");
        self.ctx.send_event(OutputEvent::Reconnected);
    }
}

/// Longest we wait for a channel close to go out on a non-blocking session.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) fn is_eagain(e: &ssh2::Error) -> bool {
    e.code() == ssh2::ErrorCode::Session(LIBSSH2_ERROR_EAGAIN)
}

/// Close a channel, retrying on `EAGAIN`: on a non-blocking session a
/// single `close()` may only queue the request, and dropping the channel
/// then leaks it in libssh2 (and half-open on the server) until the
/// session ends. Returns whether the server's close arrived; OpenSSH sends
/// a command's exit status just before it, so only then is the status known.
pub(crate) fn close_channel(channel: &mut ssh2::Channel) -> bool {
    let deadline = Instant::now() + CLOSE_TIMEOUT;
    let retry = |step: &mut dyn FnMut() -> Result<(), ssh2::Error>| loop {
        match step() {
            Err(e) if is_eagain(&e) && Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(1));
            }
            result => return result.is_ok(),
        }
    };
    retry(&mut || channel.close());
    retry(&mut || channel.wait_close())
}

/// Write all of `data` to a non-blocking writer so a large paste or burst
/// is never truncated. On `WouldBlock` the thread parks until `fd` (the
/// socket behind `w`) is writable, or briefly sleeps when no fd is known.
fn write_all_nonblocking<W: Write>(w: &mut W, data: &[u8], fd: Option<wake::Fd>) -> io::Result<()> {
    let mut written = 0;
    let start = Instant::now();
    while written < data.len() {
        match w.write(&data[written..]) {
            Ok(0) => return Err(io::Error::new(io::ErrorKind::WriteZero, "write returned 0")),
            Ok(n) => written += n,
            Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {
                if start.elapsed() > WRITE_STALL_TIMEOUT {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "peer stopped reading",
                    ));
                }
                match fd {
                    Some(fd) => wake::wait_writable(fd, WRITE_WAIT_MAX),
                    None => thread::sleep(Duration::from_millis(1)),
                }
            }
            Err(ref e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    // Never `flush`: nothing is buffered on the way out, and an ssh2 channel's
    // flush throws away what libssh2 has queued to read. For a queued packet
    // under four bytes, such as the echo of a keystroke, it also sends a window
    // adjust of about 2^32 and OpenSSH drops the connection over it.
    Ok(())
}

/// Notices a connection that has gone silent. libssh2 sends keepalives but
/// never checks that they are answered, and a network that drops packets
/// gives TCP nothing to report for many minutes. With `want_reply` set a
/// server must answer each one, so a healthy connection is never quiet for
/// long, whatever the shell is doing.
struct KeepaliveWatchdog {
    /// How long a connection may stay quiet; `None` when keepalive is off.
    limit: Option<Duration>,
    last_heard: Instant,
}

impl KeepaliveWatchdog {
    fn new(keepalive_interval: u16, now: Instant) -> Self {
        let interval = u32::from(keepalive_interval).max(KEEPALIVE_MIN_INTERVAL_SECS);
        Self {
            limit: (keepalive_interval > 0)
                .then(|| Duration::from_secs(u64::from(interval * KEEPALIVE_MAX_MISSED))),
            last_heard: now,
        }
    }

    fn enabled(&self) -> bool {
        self.limit.is_some()
    }

    fn heard(&mut self, now: Instant) {
        self.last_heard = now;
    }

    /// The silence so far, once it exceeds the limit.
    fn silence(&self, now: Instant) -> Option<Duration> {
        let silence = now.saturating_duration_since(self.last_heard);
        (silence >= self.limit?).then_some(silence)
    }
}

/// How a shell's connection ended.
enum ShellEnd {
    /// The shell exited or the user closed the session: nothing to reconnect.
    Closed,
    /// The connection died under a live shell.
    Dropped(String),
}

/// A failed read or write means the connection died, unless the shell had
/// already ended: then only its last goodbye was lost.
fn after_io_error(channel: &mut ssh2::Channel, reason: String) -> ShellEnd {
    if server_sent_eof(channel) {
        close_channel(channel);
        ShellEnd::Closed
    } else {
        ShellEnd::Dropped(reason)
    }
}

/// Whether the server has ended the channel, with or without unread data.
/// `Channel::eof` says no while data is queued, and when the server's last
/// output, EOF and close arrive with the end of the connection, that data can
/// no longer be read. `wait_close` refuses without any I/O until EOF is in.
fn server_sent_eof(channel: &mut ssh2::Channel) -> bool {
    !matches!(
        channel.wait_close(),
        Err(e) if e.code() == ssh2::ErrorCode::Session(LIBSSH2_ERROR_INVAL)
    )
}

/// Pump shell output to the frontend and frontend input to the shell until
/// the channel closes, the frontend disconnects or the connection dies.
fn run_io_loop(shell: OpenShell, io: &mut ShellIo) -> ShellEnd {
    let OpenShell {
        session,
        mut channel,
        keepalive_interval,
    } = shell;
    // Serves a forwarded agent for as long as this shell's connection lives.
    let _agent_pump = crate::agent::ForwardPump::start(&session);
    let mut buf = vec![0u8; 32 * 1024];
    let mut pending: Vec<u8> = Vec::with_capacity(OUTPUT_COALESCE_MAX);
    let fds = [wake::fd_of(&session), io.control.wake.fd()];
    let mut watchdog = KeepaliveWatchdog::new(keepalive_interval, Instant::now());

    // A reconnected shell starts at the PTY's default size; the terminal only
    // reports a size when it changes.
    if let Some((cols, rows)) = io.pty_size {
        resize_pty(&mut channel, cols, rows, &io.ctx);
    }

    loop {
        let mut active = false;
        let mut eof = false;
        pending.clear();

        // Bytes on the socket prove the server is there, even when libssh2
        // consumes them without producing shell output (a keepalive reply).
        if watchdog.enabled() && wake::is_readable(fds[0]) {
            watchdog.heard(Instant::now());
        }

        // Drain everything the remote has for us. Extended data arrives here
        // too: `open_shell_over_stream` merges it into this stream.
        loop {
            match channel.read(&mut buf) {
                Ok(0) => {
                    eof = true;
                    break;
                }
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    active = true;
                    watchdog.heard(Instant::now());
                    if pending.len() >= OUTPUT_COALESCE_MAX {
                        break;
                    }
                }
                Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) => {
                    io.output(&pending);
                    return after_io_error(&mut channel, format!("SSH read error: {}", e));
                }
            }
        }
        io.output(&pending);

        // Apply everything the frontend queued.
        loop {
            match io.control.rx.try_recv() {
                Ok(SessionMsg::Write(data)) => {
                    active = true;
                    if let Err(e) = write_all_nonblocking(&mut channel, &data, Some(fds[0])) {
                        return after_io_error(&mut channel, format!("SSH write error: {}", e));
                    }
                }
                Ok(SessionMsg::Resize { cols, rows }) => {
                    io.pty_size = Some((cols, rows));
                    resize_pty(&mut channel, cols, rows, &io.ctx);
                }
                Ok(SessionMsg::Disconnect) | Err(TryRecvError::Disconnected) => {
                    close_channel(&mut channel);
                    return ShellEnd::Closed;
                }
                Ok(SessionMsg::Reconnect | SessionMsg::CancelReconnect) => {}
                Err(TryRecvError::Empty) => break,
            }
        }

        // libssh2 reports a lost connection as a failed read, so a read of 0
        // always comes from the server's own EOF or close.
        if eof || channel.eof() {
            close_channel(&mut channel);
            return ShellEnd::Closed;
        }

        if watchdog.enabled() {
            if let Err(e) = send_due_keepalive(&session, fds[0]) {
                return ShellEnd::Dropped(format!("SSH keepalive failed: {}", e));
            }
            if let Some(silence) = watchdog.silence(Instant::now()) {
                return ShellEnd::Dropped(format!(
                    "The server did not answer for {} s. If it ignores keepalives, \
                     set this connection's keepalive to 0.",
                    silence.as_secs()
                ));
            }
        }

        if !active {
            wake::wait_readable(&fds, WAIT_MAX);
            io.control.wake.drain();
        }
    }
}

/// Send a keepalive if one is due and the socket can take it now. On a full
/// socket libssh2 reports success, counts the keepalive as sent and leaves it
/// queued, and until the next one comes due every other packet is refused as
/// "try again". A write waiting on that would never see the next one, and
/// would time out on a healthy connection.
pub(crate) fn send_due_keepalive(session: &Session, fd: wake::Fd) -> Result<(), ssh2::Error> {
    if !wake::is_writable(fd) {
        return Ok(());
    }
    session.keepalive_send().map(drop)
}

fn resize_pty(channel: &mut ssh2::Channel, cols: u32, rows: u32, ctx: &SessionContext) {
    if let Err(e) = channel.request_pty_size(cols, rows, None, None) {
        ctx.log(
            "warn",
            "ssh",
            format!(
                "session {} resize to {}x{} failed: {}",
                ctx.session_id, cols, rows, e
            ),
        );
    }
}

// ---------------------------------------------------------------------------
// Hops: jump hosts (ssh -J); local forwards share these from `crate::forwards`
// ---------------------------------------------------------------------------

/// Open the session to the first hop: the SSH server of a forward or
/// the jump host of a jump connection. `role` names it in errors and debug
/// lines.
pub(crate) fn open_hop_session(
    hop: &Endpoint,
    role: &str,
    verbosity: u8,
) -> Result<Session, String> {
    open_hop_unless_cancelled(hop, role, verbosity, None)
}

fn open_hop_unless_cancelled(
    hop: &Endpoint,
    role: &str,
    verbosity: u8,
    cancelled: Option<&AtomicBool>,
) -> Result<Session, String> {
    SshDebug::new(verbosity, hop.addr()).at(1, || {
        format!("Using {} {}", role.to_lowercase(), hop.addr())
    });
    connect_endpoint(hop, verbosity)
        .and_then(|tcp| open_session_unless_cancelled(tcp, hop, verbosity, None, cancelled))
        .map_err(|e| format!("{} {}: {}", role, hop.addr(), e))
}

/// Forward bytes between a local TCP socket and an SSH `direct-tcpip`
/// channel. Both ends are non-blocking; the thread sleeps in `poll(2)` on
/// both sockets while idle, so neither direction can stall the other and an
/// idle forward costs no CPU.
/// `clients` counts the forwarders sharing `session`. With more than one,
/// a sibling's read can pull this channel's packet into libssh2's buffer
/// without the socket ever becoming readable for us, so the idle wait is
/// kept short in that case instead of parking for the full `WAIT_MAX`.
pub(crate) fn forward_bidi(
    mut local: TcpStream,
    mut channel: ssh2::Channel,
    session: &Session,
    clients: &AtomicUsize,
) {
    local.set_nonblocking(true).ok();
    local.set_nodelay(true).ok();
    let local_fd = wake::fd_of(&local);
    let session_fd = wake::fd_of(session);
    let fds = [local_fd, session_fd];
    let mut buf = vec![0u8; 64 * 1024];

    loop {
        let mut idle = true;

        // local → channel
        match local.read(&mut buf) {
            Ok(0) => {
                let _ = channel.send_eof();
                close_channel(&mut channel);
                return;
            }
            Ok(n) => {
                if write_all_nonblocking(&mut channel, &buf[..n], Some(session_fd)).is_err() {
                    close_channel(&mut channel);
                    return;
                }
                idle = false;
            }
            Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {}
            Err(_) => {
                close_channel(&mut channel);
                return;
            }
        }

        // channel → local
        match channel.read(&mut buf) {
            Ok(0) => {
                let _ = local.shutdown(Shutdown::Both);
                return;
            }
            Ok(n) => {
                if write_all_nonblocking(&mut local, &buf[..n], Some(local_fd)).is_err() {
                    close_channel(&mut channel);
                    return;
                }
                idle = false;
            }
            Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {}
            Err(_) => {
                let _ = local.shutdown(Shutdown::Both);
                return;
            }
        }

        if channel.eof() {
            let _ = local.shutdown(Shutdown::Both);
            return;
        }

        if idle {
            let timeout = if clients.load(Ordering::Relaxed) > 1 {
                SHARED_WAIT_MAX
            } else {
                WAIT_MAX
            };
            wake::wait_readable(&fds, timeout);
        }
    }
}

/// Bridge a loopback TCP stream to `destination_host:destination_port`
/// through the jump host `gateway`. Returns the local end once the `direct-tcpip` channel
/// is open, so an SSH handshake on it cannot race the bridge. The jump host
/// session lives as long as the forwarder thread.
pub(crate) fn bridge_via_jump_host(
    gateway: &Endpoint,
    destination_host: &str,
    destination_port: u16,
    verbosity: u8,
) -> Result<TcpStream, String> {
    bridge_unless_cancelled(gateway, destination_host, destination_port, verbosity, None)
}

fn bridge_unless_cancelled(
    gateway: &Endpoint,
    destination_host: &str,
    destination_port: u16,
    verbosity: u8,
    cancelled: Option<&AtomicBool>,
) -> Result<TcpStream, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind ephemeral loopback port: {}", e))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| format!("local_addr() failed: {}", e))?
        .port();
    let gateway_session = open_hop_unless_cancelled(gateway, "Jump host", verbosity, cancelled)?;
    let debug = SshDebug::new(verbosity, gateway.addr());

    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    {
        let session = gateway_session.clone();
        let destination_host = destination_host.to_string();
        thread::spawn(move || {
            debug.at(1, || {
                format!(
                    "Opening a direct-tcpip channel to {}:{}.",
                    destination_host, destination_port
                )
            });
            let (local_stream, peer) = match listener.accept() {
                Ok(accepted) => accepted,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("accept() failed: {}", e)));
                    return;
                }
            };
            // Blocking open (single channel, nothing else to stall), then
            // non-blocking for the forwarding loop.
            match session.channel_direct_tcpip(
                &destination_host,
                destination_port,
                Some((&peer.ip().to_string(), peer.port())),
            ) {
                Ok(channel) => {
                    debug.at(2, || format!("direct-tcpip channel open for {}", peer));
                    session.set_blocking(false);
                    let _ = ready_tx.send(Ok(()));
                    forward_bidi(local_stream, channel, &session, &AtomicUsize::new(1));
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("channel_direct_tcpip failed: {}", e)));
                    let _ = local_stream.shutdown(Shutdown::Both);
                }
            }
        });
    }

    let stream = match TcpStream::connect(("127.0.0.1", local_port)) {
        Ok(stream) => stream,
        Err(e) => {
            // Unblock accept() so the forwarder thread can exit.
            let _ = TcpStream::connect(("127.0.0.1", local_port));
            return Err(format!("Failed to connect inner SSH session: {}", e));
        }
    };

    let budget = CONNECT_TIMEOUT + Duration::from_millis(SESSION_TIMEOUT_MS as u64);
    match ready_rx.recv_timeout(budget) {
        Ok(Ok(())) => Ok(stream),
        Ok(Err(e)) => Err(format!("Target connect via jump host failed: {}", e)),
        Err(RecvTimeoutError::Timeout) => Err(format!(
            "Target connect via jump host timed out after {}s",
            budget.as_secs()
        )),
        Err(RecvTimeoutError::Disconnected) => {
            Err("Target connect via jump host failed: forwarder exited".to_string())
        }
    }
}

/// Open an interactive shell on `destination`, reached through the jump host
/// `gateway` (`ssh -J`).
pub fn start_jump_shell(
    gateway: Endpoint,
    destination: Endpoint,
    opts: ShellOptions,
    ctx: SessionContext,
    resilience: ShellResilience,
) -> Result<SessionHandle, String> {
    let _prompts = crate::auth_prompt::PromptScope::enter(&ctx.output, None);
    let shell = open_jump_shell(&gateway, &destination, &opts)?;
    let (handle, control) = control_channel()?;
    ctx.register(handle.clone())?;
    ctx.log(
        "info",
        "jump_host",
        format!(
            "session {} opened: {}@{} via {}",
            ctx.session_id,
            destination.username,
            destination.addr(),
            gateway.addr()
        ),
    );
    let banner = if opts.verbosity >= 1 {
        format!(
            "\x1b[2m[SSIX] Connected to {} via jump host {} as {}\x1b[0m\r\n",
            destination.addr(),
            gateway.addr(),
            destination.username
        )
    } else {
        String::new()
    };
    spawn_shell_worker(shell, ctx, control, banner, "jump_host", resilience);
    Ok(handle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU8;

    #[test]
    fn test_ssh_state_new() {
        let state = SshState::new();
        assert!(state.sessions.is_empty());
    }

    #[test]
    fn test_ssh_state_insert_and_remove() {
        let state = SshState::new();
        let (handle, _control) = control_channel().unwrap();

        state.sessions.insert("test-session".to_string(), handle);
        assert_eq!(state.sessions.len(), 1);
        assert!(state.sessions.contains_key("test-session"));

        state.sessions.remove("test-session");
        assert!(state.sessions.is_empty());
    }

    #[test]
    fn handle_send_queues_messages_in_order() {
        let (handle, control) = control_channel().unwrap();

        handle.send(SessionMsg::Write(b"hello".to_vec())).unwrap();
        handle
            .send(SessionMsg::Resize { cols: 80, rows: 24 })
            .unwrap();
        handle.send(SessionMsg::Disconnect).unwrap();

        match control.rx.recv().unwrap() {
            SessionMsg::Write(data) => assert_eq!(data, b"hello"),
            _ => panic!("expected Write"),
        }
        match control.rx.recv().unwrap() {
            SessionMsg::Resize { cols, rows } => {
                assert_eq!(cols, 80);
                assert_eq!(rows, 24);
            }
            _ => panic!("expected Resize"),
        }
        assert!(matches!(control.rx.recv().unwrap(), SessionMsg::Disconnect));
    }

    #[test]
    fn handle_send_fails_once_worker_is_gone() {
        let (handle, control) = control_channel().unwrap();
        drop(control);
        assert!(handle.send(SessionMsg::Disconnect).is_err());
    }

    #[test]
    fn dropped_handle_is_seen_as_disconnected() {
        let (handle, control) = control_channel().unwrap();
        drop(handle);
        assert!(matches!(
            control.rx.try_recv(),
            Err(TryRecvError::Disconnected)
        ));
    }

    /// A queued message must wake a worker parked in `wait_readable`
    /// immediately rather than after the full timeout.
    #[cfg(unix)]
    #[test]
    fn wake_pipe_interrupts_wait_readable() {
        let (handle, control) = control_channel().unwrap();
        let fds = [control.wake.fd()];

        // Nothing queued: the wait runs to its (short) timeout.
        let start = Instant::now();
        wake::wait_readable(&fds, Duration::from_millis(30));
        assert!(start.elapsed() >= Duration::from_millis(25));

        // Queue from another thread after a delay; the wait must return early.
        // The handle is returned from the thread so it stays alive: dropping
        // it would close the pipe, which also reads as "readable".
        let waker = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            handle.send(SessionMsg::Write(b"x".to_vec())).unwrap();
            handle
        });
        let start = Instant::now();
        wake::wait_readable(&fds, Duration::from_secs(5));
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "wait did not wake on input"
        );
        let _handle = waker.join().unwrap();

        control.wake.drain();
        // Drained pipe: a wait with no pending wake times out again.
        let start = Instant::now();
        wake::wait_readable(&fds, Duration::from_millis(30));
        assert!(start.elapsed() >= Duration::from_millis(25));
    }

    #[test]
    fn write_all_nonblocking_retries_until_everything_is_written() {
        /// Writer that accepts at most two bytes per call and reports
        /// WouldBlock on every other call.
        struct Trickle {
            out: Vec<u8>,
            calls: usize,
        }
        impl Write for Trickle {
            fn write(&mut self, data: &[u8]) -> io::Result<usize> {
                self.calls += 1;
                if self.calls.is_multiple_of(2) {
                    return Err(io::Error::new(io::ErrorKind::WouldBlock, "later"));
                }
                let n = data.len().min(2);
                self.out.extend_from_slice(&data[..n]);
                Ok(n)
            }
            fn flush(&mut self) -> io::Result<()> {
                panic!("a channel's flush discards what it has queued to read");
            }
        }
        let mut w = Trickle {
            out: Vec::new(),
            calls: 0,
        };
        write_all_nonblocking(&mut w, b"hello world", None).unwrap();
        assert_eq!(w.out, b"hello world");
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

    #[test]
    fn output_events_have_the_shape_the_frontend_reads() {
        let json = |event: OutputEvent| serde_json::to_string(&event).unwrap();
        assert_eq!(
            json(OutputEvent::Error {
                message: "x".into()
            }),
            r#"{"kind":"error","message":"x"}"#
        );
        assert_eq!(json(OutputEvent::Closed), r#"{"kind":"closed"}"#);
        assert_eq!(
            json(OutputEvent::Reconnecting {
                attempt: 2,
                max_attempts: 5,
                delay_ms: 4000,
                message: "gone".into()
            }),
            r#"{"kind":"reconnecting","attempt":2,"max_attempts":5,"delay_ms":4000,"message":"gone"}"#
        );
        assert_eq!(json(OutputEvent::Reconnected), r#"{"kind":"reconnected"}"#);
        assert_eq!(
            json(OutputEvent::ReconnectStopped {
                message: "no".into()
            }),
            r#"{"kind":"reconnect_stopped","message":"no"}"#
        );
    }

    #[test]
    fn watchdog_is_off_at_interval_zero() {
        let start = Instant::now();
        let watchdog = KeepaliveWatchdog::new(0, start);
        assert!(!watchdog.enabled());
        assert_eq!(watchdog.silence(start + Duration::from_secs(86_400)), None);
    }

    #[test]
    fn watchdog_gives_up_after_three_silent_intervals() {
        let start = Instant::now();
        let mut watchdog = KeepaliveWatchdog::new(30, start);
        assert!(watchdog.enabled());
        assert_eq!(watchdog.silence(start + Duration::from_secs(89)), None);
        assert_eq!(
            watchdog.silence(start + Duration::from_secs(90)),
            Some(Duration::from_secs(90))
        );

        // Anything from the server starts the count over.
        watchdog.heard(start + Duration::from_secs(89));
        assert_eq!(watchdog.silence(start + Duration::from_secs(120)), None);
        assert!(watchdog.silence(start + Duration::from_secs(179)).is_some());
    }

    /// libssh2 raises an interval of 1 to 2, so 1 must not leave room for a
    /// single unanswered keepalive only.
    #[test]
    fn watchdog_follows_the_shortest_interval_libssh2_sends_at() {
        let start = Instant::now();
        let watchdog = KeepaliveWatchdog::new(1, start);
        assert_eq!(watchdog.silence(start + Duration::from_secs(5)), None);
        assert!(watchdog.silence(start + Duration::from_secs(6)).is_some());
    }

    #[test]
    fn is_readable_reports_waiting_bytes_without_consuming_them() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut near = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut far, _) = listener.accept().unwrap();
        far.set_nonblocking(true).unwrap();
        let fd = wake::fd_of(&far);

        assert!(!wake::is_readable(fd));
        near.write_all(b"x").unwrap();
        near.flush().unwrap();
        let start = Instant::now();
        while !wake::is_readable(fd) {
            assert!(start.elapsed() < Duration::from_secs(5), "never readable");
            thread::sleep(Duration::from_millis(1));
        }
        // Still there: the check consumed nothing.
        assert!(wake::is_readable(fd));
        let mut byte = [0u8; 1];
        far.read_exact(&mut byte).unwrap();
        assert_eq!(&byte, b"x");
        assert!(!wake::is_readable(fd));

        // A closed peer reads as readable, so the worker goes on to find out.
        drop(near);
        let start = Instant::now();
        while !wake::is_readable(fd) {
            assert!(start.elapsed() < Duration::from_secs(5), "close not seen");
            thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn is_writable_turns_false_when_the_socket_is_full() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let near = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut far, _) = listener.accept().unwrap();
        near.set_nonblocking(true).unwrap();
        far.set_nonblocking(true).unwrap();
        let fd = wake::fd_of(&near);

        assert!(wake::is_writable(fd));
        fill_socket(&near, fd);
        assert!(!wake::is_writable(fd));

        let mut buf = [0u8; 64 * 1024];
        let start = Instant::now();
        while !wake::is_writable(fd) {
            assert!(start.elapsed() < Duration::from_secs(10), "never writable");
            let _ = far.read(&mut buf);
        }
    }

    /// Write to a non-blocking socket until it reports no room. Returns the
    /// bytes it took. A socket can refuse a large write and still have room
    /// for a smaller one, so the writes shrink as they are refused.
    fn fill_socket(mut socket: &TcpStream, fd: wake::Fd) -> usize {
        let junk = [0u8; 16 * 1024];
        let mut size = junk.len();
        let mut filled = 0;
        let start = Instant::now();
        loop {
            assert!(
                start.elapsed() < Duration::from_secs(30),
                "the socket reports room but takes nothing"
            );
            match socket.write(&junk[..size]) {
                Ok(n) => filled += n,
                // The kernel may still be moving bytes along.
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(20));
                    if !wake::is_writable(fd) {
                        return filled;
                    }
                    size = (size / 2).max(1);
                }
                Err(e) => panic!("filling the socket failed: {e}"),
            }
        }
    }

    /// The first attempts of a reconnect meet these real failures, so their
    /// wording has to stay on `reconnect`'s allow-list.
    #[test]
    fn real_network_failures_are_retryable() {
        use crate::reconnect::is_retryable_connect_error;
        let endpoint = |port| Endpoint {
            host: "127.0.0.1".into(),
            port,
            username: "u".into(),
            auth: AuthMethod::Password("p".into()),
            proxy_command: None,
        };
        let closed = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let refused = open_authenticated_session(&endpoint(closed), 0, None)
            .err()
            .unwrap();
        assert!(is_retryable_connect_error(&refused), "{refused}");

        let unknown = connect_tcp("host.invalid", 22).err().unwrap();
        assert!(is_retryable_connect_error(&unknown), "{unknown}");

        // A server that hangs up before the handshake finishes.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || drop(listener.accept()));
        let hung_up = open_authenticated_session(&endpoint(port), 0, None)
            .err()
            .unwrap();
        assert!(is_retryable_connect_error(&hung_up), "{hung_up}");
    }

    /// The watchdog relies on a keepalive's reply reaching the socket while
    /// leaving the shell's stream alone. Needs a real server, so a plain
    /// `cargo test` skips it: see `remote_script::live` for how to run it.
    #[test]
    #[ignore]
    fn live_keepalive_replies_show_on_the_socket_only() {
        let target = crate::remote_script::live::Target::from_env();
        crate::storage::test_support::with_isolated_data_dir(|| {
            let opts = ShellOptions {
                keepalive_interval: 2,
                ..ShellOptions::default()
            };
            let OpenShell {
                session,
                mut channel,
                ..
            } = open_shell(&target.endpoint, &opts).unwrap();
            let fd = wake::fd_of(&session);
            wait_for_quiet(&mut channel, fd);

            session.keepalive_send().unwrap();
            let sent = Instant::now();
            while !wake::is_readable(fd) {
                assert!(
                    sent.elapsed() < Duration::from_secs(20),
                    "the server never answered the keepalive"
                );
                thread::sleep(Duration::from_millis(20));
            }

            // The reply is consumed without producing output or ending the shell.
            read_available(&mut channel);
            assert!(!wake::is_readable(fd));
            assert!(!channel.eof());
        });
    }

    /// Typing as fast as the echo comes back, so an echo is often queued in
    /// libssh2 by the write that follows it.
    #[test]
    #[ignore]
    fn live_fast_typing_keeps_the_session() {
        let target = crate::remote_script::live::Target::from_env();
        crate::storage::test_support::with_isolated_data_dir(|| {
            let OpenShell {
                session,
                mut channel,
                ..
            } = open_shell(&target.endpoint, &ShellOptions::default()).unwrap();
            let fd = wake::fd_of(&session);
            wait_for_quiet(&mut channel, fd);

            for _ in 0..5000 {
                write_all_nonblocking(&mut channel, b"x", Some(fd)).unwrap();
                read_available(&mut channel);
            }

            // A server that took offence has closed the connection by now.
            wait_for_quiet(&mut channel, fd);
            assert!(!channel.eof());
        });
    }

    /// With the socket full, a keepalive must not get in the way of the writes
    /// that follow once it has room again.
    #[cfg(unix)]
    #[test]
    #[ignore]
    fn live_a_due_keepalive_on_a_full_socket_holds_nothing_up() {
        use std::mem::ManuallyDrop;
        use std::os::fd::FromRawFd;

        let target = crate::remote_script::live::Target::from_env();
        crate::storage::test_support::with_isolated_data_dir(|| {
            let relay = Relay::start(&target.endpoint);
            let opts = ShellOptions {
                keepalive_interval: 2,
                ..ShellOptions::default()
            };
            let OpenShell {
                session,
                mut channel,
                ..
            } = open_shell_over_stream(relay.connect(), &target.endpoint, &opts).unwrap();
            let fd = wake::fd_of(&session);
            wait_for_quiet(&mut channel, fd);

            // Fill the socket behind libssh2's back, with bytes the relay will
            // drop so that the encrypted stream it carries stays intact.
            relay.set_mode(RELAY_HOLD_UP);
            thread::sleep(Duration::from_millis(100));
            // SAFETY: `fd` is the session's open socket. `ManuallyDrop` keeps
            // this temporary view of it from closing the socket.
            let socket = ManuallyDrop::new(unsafe { TcpStream::from_raw_fd(fd) });
            let filled = fill_socket(&socket, fd);
            assert!(!wake::is_writable(fd));

            send_due_keepalive(&session, fd).unwrap();

            relay.discard_up(filled);
            relay.set_mode(RELAY_FLOW);
            write_all_nonblocking(&mut channel, b"x", Some(fd))
                .expect("the keepalive held up the write");
            let sent = Instant::now();
            while read_available(&mut channel) == 0 {
                assert!(
                    sent.elapsed() < Duration::from_secs(10),
                    "the shell never echoed"
                );
                thread::sleep(Duration::from_millis(20));
            }
        });
    }

    /// A cancelled attempt stops before the login, where a wrong password
    /// would show that it tried, and before the login command.
    #[test]
    #[ignore]
    fn live_a_cancelled_attempt_neither_logs_in_nor_starts_the_login_command() {
        let target = crate::remote_script::live::Target::from_env();
        crate::storage::test_support::with_isolated_data_dir(|| {
            let opts = ShellOptions {
                startup_command: Some("true".to_string()),
                cancelled: Some(Arc::new(AtomicBool::new(true))),
                ..ShellOptions::default()
            };
            let wrong_password = Endpoint {
                auth: AuthMethod::Password("not-the-password".into()),
                ..target.endpoint.clone()
            };
            let error = open_shell(&wrong_password, &opts).err().unwrap();
            assert_eq!(error, ATTEMPT_CANCELLED);

            let session = open_authenticated_session(&target.endpoint, 0, None).unwrap();
            let error = start_shell(session, &target.endpoint, &opts).err().unwrap();
            assert_eq!(error, ATTEMPT_CANCELLED);
        });
    }

    /// A network that dies under a live shell surfaces as a failed read, never
    /// as a read of 0: the loop's clean-close path depends on that.
    #[test]
    #[ignore]
    fn live_a_lost_connection_is_a_failed_read_and_counts_as_dropped() {
        let target = crate::remote_script::live::Target::from_env();
        crate::storage::test_support::with_isolated_data_dir(|| {
            let relay = Relay::start(&target.endpoint);
            let OpenShell {
                session,
                mut channel,
                ..
            } = open_shell_over_stream(relay.connect(), &target.endpoint, &ShellOptions::default())
                .unwrap();
            let fd = wake::fd_of(&session);
            wait_for_quiet(&mut channel, fd);

            relay.set_mode(RELAY_CUT);
            let error = read_until_it_fails(&mut channel);

            let ShellEnd::Dropped(reason) = after_io_error(&mut channel, error.to_string()) else {
                panic!("a lost connection counted as the shell ending");
            };
            assert!(!reason.is_empty());
        });
    }

    /// A shell that exits over a healthy connection reads as 0.
    #[test]
    #[ignore]
    fn live_a_shell_that_exits_reads_as_zero() {
        let target = crate::remote_script::live::Target::from_env();
        if target.windows() {
            return;
        }
        crate::storage::test_support::with_isolated_data_dir(|| {
            let OpenShell {
                session,
                mut channel,
                ..
            } = open_shell(&target.endpoint, &ShellOptions::default()).unwrap();
            let fd = wake::fd_of(&session);
            wait_for_quiet(&mut channel, fd);

            write_all_nonblocking(&mut channel, b"exit\n", Some(fd)).unwrap();
            let mut buf = [0u8; 4096];
            let start = Instant::now();
            loop {
                assert!(
                    start.elapsed() < Duration::from_secs(10),
                    "the shell never ended"
                );
                match channel.read(&mut buf) {
                    Ok(0) => return,
                    Ok(_) => {}
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(20));
                    }
                    Err(e) => panic!("the shell's end read as a failure: {e}"),
                }
            }
        });
    }

    /// What a shell does with extended data. A PTY keeps a real server from
    /// sending any to a shell, so this runs a command without one.
    #[test]
    #[ignore]
    fn live_merged_extended_data_leaves_the_end_visible() {
        let target = crate::remote_script::live::Target::from_env();
        if target.windows() {
            return;
        }
        crate::storage::test_support::with_isolated_data_dir(|| {
            let session = open_authenticated_session(&target.endpoint, 0, None).unwrap();
            let mut channel = session.channel_session().unwrap();
            channel
                .handle_extended_data(ssh2::ExtendedData::Merge)
                .unwrap();
            channel.exec("echo err >&2").unwrap();

            let mut output = String::new();
            channel.read_to_string(&mut output).unwrap();

            assert_eq!(output, "err\n");
            assert!(channel.eof());
        });
    }

    /// A server that hangs up in one go: last output, EOF, close and the end
    /// of the TCP stream all arrive together. libssh2 fails the read before
    /// the queued output can be read, and that output is lost, but the shell
    /// did end and nothing should reconnect it.
    #[test]
    #[ignore]
    fn live_a_goodbye_that_arrives_with_the_connection_end_counts_as_closed() {
        let target = crate::remote_script::live::Target::from_env();
        if target.windows() {
            return;
        }
        crate::storage::test_support::with_isolated_data_dir(|| {
            let relay = Relay::start(&target.endpoint);
            let OpenShell {
                session,
                mut channel,
                ..
            } = open_shell_over_stream(relay.connect(), &target.endpoint, &ShellOptions::default())
                .unwrap();
            let fd = wake::fd_of(&session);
            wait_for_quiet(&mut channel, fd);

            relay.set_mode(RELAY_HOLD_DOWN);
            write_all_nonblocking(&mut channel, b"exit\n", Some(fd)).unwrap();
            // Time for the server's goodbye to pile up behind the relay.
            thread::sleep(Duration::from_millis(1500));
            relay.set_mode(RELAY_LAST_WORDS);
            let start = Instant::now();
            while relay.mode() != RELAY_DONE {
                assert!(
                    start.elapsed() < Duration::from_secs(10),
                    "the relay never finished"
                );
                thread::sleep(Duration::from_millis(10));
            }

            let error = read_until_it_fails(&mut channel);
            assert!(!channel.eof(), "the output should still be masking EOF");
            assert!(
                matches!(
                    after_io_error(&mut channel, error.to_string()),
                    ShellEnd::Closed
                ),
                "the shell ended, so nothing should reconnect it"
            );
        });
    }

    /// Read until a read fails, returning the failure. A read of 0 fails the
    /// test: it would say the shell ended.
    fn read_until_it_fails(channel: &mut ssh2::Channel) -> io::Error {
        let mut buf = [0u8; 4096];
        let start = Instant::now();
        loop {
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "no read ever failed"
            );
            match channel.read(&mut buf) {
                Ok(0) => panic!("the read reported a clean end"),
                Ok(_) => {}
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(20));
                }
                Err(e) => return e,
            }
        }
    }

    const RELAY_FLOW: u8 = 0;
    /// Leave what the client sends unread.
    const RELAY_HOLD_UP: u8 = 1;
    /// Leave what the server sends unread.
    const RELAY_HOLD_DOWN: u8 = 2;
    /// Pass on all the server has sent so far in one go, then end the stream
    /// towards the client and become `RELAY_DONE`.
    const RELAY_LAST_WORDS: u8 = 3;
    const RELAY_DONE: u8 = 4;
    /// End the connection at once on both sides.
    const RELAY_CUT: u8 = 5;

    /// A loopback relay to a real server, so that a test can control what the
    /// client's socket sees.
    struct Relay {
        port: u16,
        mode: Arc<AtomicU8>,
        discard_up: Arc<AtomicUsize>,
    }

    impl Relay {
        fn start(server: &Endpoint) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let mode = Arc::new(AtomicU8::new(RELAY_FLOW));
            let discard_up = Arc::new(AtomicUsize::new(0));
            let (relay_mode, relay_discard) = (Arc::clone(&mode), Arc::clone(&discard_up));
            let server = server.addr();
            thread::spawn(move || {
                let (client, _) = listener.accept().unwrap();
                let server = TcpStream::connect(server).unwrap();
                client.set_nonblocking(true).unwrap();
                server.set_nonblocking(true).unwrap();
                let mut buf = vec![0u8; 16 * 1024];
                loop {
                    let mode = relay_mode.load(Ordering::SeqCst);
                    match mode {
                        RELAY_CUT => {
                            let _ = client.shutdown(Shutdown::Both);
                            let _ = server.shutdown(Shutdown::Both);
                            return;
                        }
                        RELAY_LAST_WORDS => {
                            while let Some(n) = relay_read(&server, &mut buf) {
                                if n == 0 {
                                    break;
                                }
                                relay_write(&client, &buf[..n]);
                            }
                            let _ = client.shutdown(Shutdown::Write);
                            relay_mode.store(RELAY_DONE, Ordering::SeqCst);
                        }
                        RELAY_DONE => {
                            thread::sleep(Duration::from_millis(10));
                            continue;
                        }
                        _ => {}
                    }
                    if mode != RELAY_HOLD_UP {
                        let Some(n) = relay_read(&client, &mut buf) else {
                            return;
                        };
                        let skip = relay_discard.load(Ordering::SeqCst).min(n);
                        relay_discard.fetch_sub(skip, Ordering::SeqCst);
                        relay_write(&server, &buf[skip..n]);
                    }
                    if mode != RELAY_HOLD_DOWN {
                        let Some(n) = relay_read(&server, &mut buf) else {
                            return;
                        };
                        relay_write(&client, &buf[..n]);
                    }
                    thread::sleep(Duration::from_millis(1));
                }
            });
            Self {
                port,
                mode,
                discard_up,
            }
        }

        fn connect(&self) -> TcpStream {
            TcpStream::connect(("127.0.0.1", self.port)).unwrap()
        }

        fn set_mode(&self, mode: u8) {
            self.mode.store(mode, Ordering::SeqCst);
        }

        fn mode(&self) -> u8 {
            self.mode.load(Ordering::SeqCst)
        }

        /// Drop the next `bytes` that the client sends.
        fn discard_up(&self, bytes: usize) {
            self.discard_up.store(bytes, Ordering::SeqCst);
        }
    }

    /// The bytes waiting on a relay's socket, `None` once it has closed.
    fn relay_read(mut from: &TcpStream, buf: &mut [u8]) -> Option<usize> {
        match from.read(buf) {
            Ok(0) => None,
            Ok(n) => Some(n),
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => Some(0),
            Err(_) => None,
        }
    }

    fn relay_write(mut to: &TcpStream, data: &[u8]) {
        let _ = write_all_nonblocking(&mut to, data, None);
    }

    /// The bytes the shell had for us: 0 when nothing was waiting.
    fn read_available(channel: &mut ssh2::Channel) -> usize {
        let mut buf = [0u8; 4096];
        let mut total = 0;
        loop {
            match channel.read(&mut buf) {
                Ok(0) => panic!("the shell ended"),
                Ok(n) => total += n,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return total,
                Err(e) => panic!("read failed: {e}"),
            }
        }
    }

    fn wait_for_quiet(channel: &mut ssh2::Channel, fd: wake::Fd) {
        let mut quiet_since = Instant::now();
        while quiet_since.elapsed() < Duration::from_secs(3) {
            if wake::is_readable(fd) {
                read_available(channel);
                quiet_since = Instant::now();
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn endpoint_addr_formats_host_and_port() {
        let ep = Endpoint {
            host: "example.com".into(),
            port: 2222,
            username: "u".into(),
            auth: AuthMethod::Password("p".into()),
            proxy_command: None,
        };
        assert_eq!(ep.addr(), "example.com:2222");
    }
}
