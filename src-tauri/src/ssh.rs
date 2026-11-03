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
use std::net::{Shutdown, SocketAddr, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
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
/// Idle wait for a thread that shares its session with another that reads it.
const SHARED_WAIT_MAX: Duration = Duration::from_millis(10);
const WAIT_MAX: Duration = Duration::from_millis(250);
/// Cap on bytes coalesced into one output message.
const OUTPUT_COALESCE_MAX: usize = 256 * 1024;
/// Output the terminal has not caught up with, at which a shell stops reading
/// more. The SSH window then pushes back on the server. xterm throws away what it
/// is given above 50 MB; the frontend's own buffer adds up to 4 MB on top of this.
const OUTPUT_PAUSE_BYTES: u64 = 8 * 1024 * 1024;
/// libssh2's "call again later" code, surfaced by ssh2 as `ErrorCode::Session`.
const LIBSSH2_ERROR_EAGAIN: i32 = -37;
/// libssh2's answer to waiting for a channel to close before the server's EOF.
const LIBSSH2_ERROR_INVAL: i32 = -34;
/// Unanswered keepalive intervals before a session counts as dead, as with
/// OpenSSH's default `ServerAliveCountMax`.
const KEEPALIVE_MAX_MISSED: u32 = 3;
/// How often a jump host bridge with bytes waiting sends a keepalive.
const BRIDGE_KEEPALIVE_SECS: u32 = 30;
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

    pub(crate) fn emit_error(&self, message: String) {
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
    unacked_output: Arc<AtomicU64>,
}

impl SessionHandle {
    pub fn send(&self, msg: SessionMsg) -> Result<(), String> {
        self.tx
            .send(msg)
            .map_err(|_| "Session is no longer running".to_string())?;
        self.waker.wake();
        Ok(())
    }

    /// The terminal has taken `bytes` of output. More than was sent only clears
    /// the count, at the cost of a pause that comes later.
    pub fn ack_output(&self, bytes: u64) {
        let _ = self
            .unacked_output
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |unacked| {
                Some(unacked.saturating_sub(bytes))
            });
        self.waker.wake();
    }
}

/// Worker side of the control channel.
pub(crate) struct ControlRx {
    pub(crate) rx: Receiver<SessionMsg>,
    pub(crate) wake: wake::WakeReceiver,
    /// Output sent to the terminal and not acknowledged yet.
    unacked_output: Arc<AtomicU64>,
}

pub(crate) fn control_channel() -> Result<(SessionHandle, ControlRx), String> {
    let (tx, rx) = mpsc::channel();
    let (waker, wake) = wake::pair().map_err(|e| format!("Failed to create wake pipe: {}", e))?;
    let unacked_output = Arc::new(AtomicU64::new(0));
    Ok((
        SessionHandle {
            tx,
            waker: Arc::new(waker),
            unacked_output: Arc::clone(&unacked_output),
        },
        ControlRx {
            rx,
            wake,
            unacked_output,
        },
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

    /// Block until one of `readable` can be read, one of `writable` can be
    /// written, or `timeout` elapses.
    pub fn wait_ready(readable: &[Fd], writable: &[Fd], timeout: Duration) {
        let polls_of = |fds: &[Fd], events| {
            fds.iter()
                .map(|&fd| libc::pollfd {
                    fd,
                    events,
                    revents: 0,
                })
                .collect::<Vec<_>>()
        };
        let mut polls = polls_of(readable, libc::POLLIN);
        polls.extend(polls_of(writable, libc::POLLOUT));
        let ms = timeout.as_millis().min(i32::MAX as u128) as libc::c_int;
        // SAFETY: `polls` is a valid, initialised array of `pollfd` that
        // outlives the call, and `len` matches its length.
        unsafe {
            libc::poll(polls.as_mut_ptr(), polls.len() as libc::nfds_t, ms);
        }
    }

    /// Block until one of `fds` is readable or `timeout` elapses.
    pub fn wait_readable(fds: &[Fd], timeout: Duration) {
        wait_ready(fds, &[], timeout);
    }

    /// Block until `fd` is writable or `timeout` elapses.
    pub fn wait_writable(fd: Fd, timeout: Duration) {
        wait_ready(&[], &[fd], timeout);
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

    /// End the connection behind `fd` both ways, keeping the descriptor open
    /// for whoever owns it.
    pub fn shutdown(fd: Fd) {
        // SAFETY: `shutdown` takes a descriptor by value and does not close it;
        // on one that is no longer a socket it only returns an error.
        unsafe {
            libc::shutdown(fd, libc::SHUT_RDWR);
        }
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
    pub fn wait_ready(_readable: &[Fd], _writable: &[Fd], timeout: Duration) {
        std::thread::sleep(timeout.min(Duration::from_millis(5)));
    }

    pub fn wait_readable(fds: &[Fd], timeout: Duration) {
        wait_ready(fds, &[], timeout);
    }

    pub fn wait_writable(fd: Fd, timeout: Duration) {
        wait_ready(&[], &[fd], timeout);
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

    /// End the connection behind `fd` both ways, keeping the socket open for
    /// whoever owns it.
    pub fn shutdown(fd: Fd) {
        /// `SD_BOTH` in `winsock2.h`.
        const SD_BOTH: i32 = 2;
        #[link(name = "ws2_32")]
        extern "system" {
            fn shutdown(socket: usize, how: i32) -> i32;
        }
        // SAFETY: `shutdown` takes a socket handle by value and does not close
        // it; on a handle that is no longer a socket it only returns an error.
        unsafe {
            shutdown(fd as usize, SD_BOTH);
        }
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

/// The connection failed while listing the methods.
struct LostConnection;

/// The method names a server offers (`publickey,keyboard-interactive`). `None`
/// when it could not be asked, which offers nothing but rules nothing out. This
/// sends a "none" request, so a connection that fails here has lost nothing secret.
fn list_auth_methods(
    session: &Session,
    username: &str,
    debug: &SshDebug,
) -> Result<Option<String>, LostConnection> {
    match crate::libssh2_ext::userauth_list(session, username) {
        Ok(methods) => {
            debug.at(1, || {
                format!("Authentications that can continue: {}", methods)
            });
            // An empty list goes with a server that just accepted "none".
            Ok((!methods.is_empty()).then_some(methods))
        }
        Err(e) => {
            debug.at(1, || {
                format!("Could not list authentication methods: {}", e)
            });
            if crate::login_wait::connection_failed(&e) {
                Err(LostConnection)
            } else {
                Ok(None)
            }
        }
    }
}

fn offers_method(methods: &str, method: &str) -> bool {
    methods.split(',').any(|offered| offered.trim() == method)
}

/// Why a credential did not finish the login.
#[derive(Debug)]
pub(crate) enum CredentialFailure {
    /// It never got to the server's judgement: no key file, a wrong passphrase,
    /// an agent out of reach, a connection that failed. Nothing the server could
    /// ask would help, and asking would hide what is actually wrong.
    Local(String),
    /// The server said no. libssh2 says the same for a first factor it accepted.
    Refused(String),
}

impl CredentialFailure {
    /// Sorted by what libssh2 reports. It also uses the two refusal codes for
    /// failures of its own, which only their text tells apart.
    pub(crate) fn from_error(error: &ssh2::Error, message: String) -> Self {
        let refusal_code = matches!(
            error.code(),
            ssh2::ErrorCode::Session(
                libssh2_sys::LIBSSH2_ERROR_AUTHENTICATION_FAILED
                    | libssh2_sys::LIBSSH2_ERROR_PUBLICKEY_UNVERIFIED
            )
        );
        let reason = error.message();
        if refusal_code
            && !reason.starts_with("Waiting for")
            && !reason.starts_with("Invalid public key")
            && reason != "Callback returned error"
        {
            Self::Refused(message)
        } else {
            Self::Local(message)
        }
    }

    pub(crate) fn into_message(self) -> String {
        match self {
            Self::Local(message) | Self::Refused(message) => message,
        }
    }
}

/// Whether two method lists name the same methods.
fn same_methods(one: &str, other: &str) -> bool {
    let names = |list: &'_ str| {
        list.split(',')
            .map(|name| name.trim().to_string())
            .collect::<std::collections::BTreeSet<_>>()
    };
    names(one) == names(other)
}

/// Whether a refused credential was in fact accepted as a first factor, which
/// libssh2 cannot say. A server that took it moves on to other methods, while
/// one that refused it still offers what it offered before.
fn accepted_as_first_factor(before: Option<&str>, after: Option<&str>) -> bool {
    matches!((before, after), (Some(before), Some(after)) if !same_methods(before, after))
}

/// What the pane says the server refused.
fn credential_label(auth: &AuthMethod) -> String {
    match auth {
        AuthMethod::Password(_) => "the saved password".to_string(),
        AuthMethod::Key { path, .. } => format!("the key {}", path),
        AuthMethod::KeyMemory { .. } => "the stored key".to_string(),
        AuthMethod::Agent => "the keys in the SSH agent".to_string(),
    }
}

/// The error for a login that ended at the prompt. `first_step` is why the
/// credential did not finish it, and `refused` whether the server turned it down.
/// A refusal is the thing to fix, so it stays in the message, and it must not be
/// retried: a reconnect would send that credential again, so a server going silent
/// does not use the wording that a reconnect takes for a network failure.
fn prompt_failure_message(
    first_step: &str,
    refused: bool,
    failure: crate::auth_prompt::PromptFailure,
) -> String {
    use crate::auth_prompt::PromptFailure;
    use crate::login_wait::{LOST, STALLED};
    match failure {
        PromptFailure::NothingAsked => first_step.to_string(),
        PromptFailure::GaveUp(reason) if !refused => reason.to_string(),
        PromptFailure::ConnectionLost if !refused => LOST.to_string(),
        PromptFailure::GaveUp(STALLED) => {
            format!("{}. The server then stopped answering", first_step)
        }
        PromptFailure::ConnectionLost => format!("{}. The connection then closed", first_step),
        PromptFailure::GaveUp(reason) => format!("{}. {}", first_step, reason),
        PromptFailure::Refused(reason) if !refused => {
            format!("Keyboard-interactive auth failed: {}", reason)
        }
        PromptFailure::Refused(reason) => {
            format!(
                "{}. Keyboard-interactive auth failed: {}",
                first_step, reason
            )
        }
    }
}

/// Where a login goes once the credential left it unfinished. `error` says why,
/// `tried` whether the server got to judge the credential, and `offered` and
/// `remaining` are its methods before and after.
fn continue_after_credential(
    session: &Session,
    endpoint: &Endpoint,
    debug: &SshDebug,
    error: String,
    tried: bool,
    offered: Option<&str>,
    remaining: Option<&str>,
) -> Result<(), String> {
    if !remaining.is_some_and(|methods| offers_method(methods, "keyboard-interactive")) {
        return Err(error);
    }
    let refused = tried && !accepted_as_first_factor(offered, remaining);
    let Some(pane) = crate::auth_prompt::current_pane() else {
        // A server that only turned the credential down has no question waiting:
        // saying a shell would help would send the user the wrong way.
        return Err(if refused {
            error
        } else {
            format!(
                "{}. The server asks for keyboard-interactive answers, which only a \
                 terminal pane can collect: open this connection as a shell",
                error
            )
        });
    };
    debug.at(1, || {
        format!(
            "Next authentication method: keyboard-interactive as {}",
            endpoint.username
        )
    });
    let note = refused.then(|| format!("The server refused {}.", credential_label(&endpoint.auth)));
    crate::auth_prompt::authenticate(pane, session, endpoint, debug, note.as_deref())
        .map_err(|failure| prompt_failure_message(&error, refused, failure))?;
    if session.authenticated() {
        Ok(())
    } else {
        Err("Authentication failed".to_string())
    }
}

/// Log in with the endpoint's credential; a server may then still ask for a
/// second factor. Keyboard-interactive covers both a server that takes nothing
/// else and that second step, as it does with `ssh`, and may follow a refused
/// credential in a shell, whose user can still answer. A method the server does
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
    let offered = list_auth_methods(session, username, debug)
        .map_err(|LostConnection| crate::login_wait::LOST.to_string())?;
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
    // Why the credential left the login unfinished, and whether the server
    // got to judge it. `None` when it finished the login.
    let unfinished = match offered.as_deref() {
        Some(methods) if !offers_method(methods, wire_name) => Some((
            format!(
                "The server does not accept {} authentication (it offers: {})",
                wire_name, methods
            ),
            false,
        )),
        _ => {
            debug.at(1, || {
                format!("Next authentication method: {} as {}", method, username)
            });
            match authenticate_with_credential(session, endpoint, debug) {
                Ok(()) if session.authenticated() => None,
                Ok(()) => Some(("Authentication failed".to_string(), true)),
                Err(CredentialFailure::Refused(error)) => Some((error, true)),
                Err(CredentialFailure::Local(error)) => return Err(error),
            }
        }
    };
    let method = match unfinished {
        None => method,
        Some((error, tried)) => {
            // A connection lost here stays what the credential came to.
            let remaining = list_auth_methods(session, username, debug).unwrap_or(None);
            if session.authenticated() {
                method
            } else {
                continue_after_credential(
                    session,
                    endpoint,
                    debug,
                    error,
                    tried,
                    offered.as_deref(),
                    remaining.as_deref(),
                )?;
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
) -> Result<(), CredentialFailure> {
    let username = &endpoint.username;
    let key_failure =
        |e: ssh2::Error| CredentialFailure::from_error(&e, format!("Key auth failed: {}", e));
    match &endpoint.auth {
        AuthMethod::Password(pw) => session
            .userauth_password(username, pw)
            .map_err(|e| CredentialFailure::from_error(&e, format!("Password auth failed: {}", e))),
        AuthMethod::Key { path, passphrase } => session
            .userauth_pubkey_file(username, None, Path::new(path), passphrase.as_deref())
            .map_err(key_failure),
        AuthMethod::KeyMemory {
            private_key,
            passphrase,
        } => authenticate_pubkey_memory(session, username, private_key, passphrase.as_deref())
            .map_err(key_failure),
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
            out: AppOutput {
                log: resilience
                    .log
                    .as_ref()
                    .and_then(|plan| open_log(&ctx, plan)),
                ctx,
            },
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
            io.out.report_lost(source, &reason);
            let ctx = &io.out.ctx;
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
                    io.out.report_reconnected(source);
                    shell = next;
                }
                None => break,
            }
        }
        io.out.ctx.finish();
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

/// Where a shell's output and troubles go. A trait so that tests can run
/// [`run_io_loop`] against a real server without a Tauri app.
trait ShellOutput {
    fn output(&mut self, bytes: &[u8]);
    fn warn(&self, message: String);
}

/// A shell worker's state that survives a reconnect.
struct ShellIo<O> {
    out: O,
    control: ControlRx,
    /// The terminal's last known size, for the next shell.
    pty_size: Option<(u32, u32)>,
}

impl<O: ShellOutput> ShellIo<O> {
    /// Hand over shell output, counted first so that an ack cannot beat it.
    fn print(&mut self, bytes: &[u8]) {
        self.control
            .unacked_output
            .fetch_add(bytes.len() as u64, Ordering::SeqCst);
        self.out.output(bytes);
    }
}

/// The terminal and the session log.
struct AppOutput {
    ctx: SessionContext,
    log: Option<SessionLog>,
}

impl ShellOutput for AppOutput {
    fn output(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.ctx.send_output(bytes);
        self.write_log(|log| log.append(bytes));
    }

    fn warn(&self, message: String) {
        self.ctx.log(
            "warn",
            "ssh",
            format!("session {}: {}", self.ctx.session_id, message),
        );
    }
}

impl AppOutput {
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

/// Bytes read from one side that the other has not taken yet. Offered once per
/// pass of a loop, so that whatever is slow here holds up nothing else.
#[derive(Default)]
struct Outgoing {
    data: Vec<u8>,
    sent: usize,
}

impl Outgoing {
    fn is_empty(&self) -> bool {
        self.sent == self.data.len()
    }

    fn push(&mut self, bytes: &[u8]) {
        self.data.extend_from_slice(bytes);
    }

    /// Offer what is left to `w`, once, and return how much it took. libssh2
    /// must be offered the same bytes again after a refusal, which this does.
    /// A channel with no window left may answer 0 instead of refusing.
    ///
    /// Never `flush`: nothing is buffered on the way out, and an ssh2 channel's
    /// flush throws away what libssh2 has queued to read. For a queued packet
    /// under four bytes, such as the echo of a keystroke, it also sends a window
    /// adjust of about 2^32 and OpenSSH drops the connection over it.
    fn send<W: Write>(&mut self, w: &mut W) -> io::Result<usize> {
        if self.is_empty() {
            return Ok(0);
        }
        match w.write(&self.data[self.sent..]) {
            Ok(n) => {
                self.sent += n;
                if self.is_empty() {
                    self.data.clear();
                    self.sent = 0;
                }
                Ok(n)
            }
            Err(ref e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                Ok(0)
            }
            Err(e) => Err(e),
        }
    }
}

/// Whether a packet is waiting for room on the socket, rather than for the
/// server to open the channel's window.
fn send_blocked_on_socket(session: &Session) -> bool {
    matches!(
        session.block_directions(),
        ssh2::BlockDirections::Outbound | ssh2::BlockDirections::Both
    )
}

/// Move what the server has sent from the socket into libssh2's queue, without
/// sending anything. `channel.read` cannot be relied on for it: when the channel
/// needs a bigger window it asks for that first, and libssh2 refuses a new packet
/// while another is half sent, so the read returns without reading. A server with
/// its own output backed up stops reading us, the half-sent packet stays, and
/// neither side moves again. `wait_eof` only reads. The server cannot send more
/// than the window, so the queue is bounded by that.
fn take_in(channel: &mut ssh2::Channel) -> Result<(), ssh2::Error> {
    match channel.wait_eof() {
        Err(e) if !is_eagain(&e) => Err(e),
        _ => Ok(()),
    }
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
fn run_io_loop<O: ShellOutput>(shell: OpenShell, io: &mut ShellIo<O>) -> ShellEnd {
    let OpenShell {
        session,
        mut channel,
        keepalive_interval,
    } = shell;
    // Serves a forwarded agent for as long as this shell's connection lives.
    let agent_pump = crate::agent::ForwardPump::start(&session);
    let mut buf = vec![0u8; 32 * 1024];
    let mut pending: Vec<u8> = Vec::with_capacity(OUTPUT_COALESCE_MAX);
    let fds = [wake::fd_of(&session), io.control.wake.fd()];
    let mut watchdog = KeepaliveWatchdog::new(keepalive_interval, Instant::now());
    // Input the server's side has not taken yet. Never waited for here: the
    // loop has to go on reading, and the watchdog judges a server that stops.
    let mut input = Outgoing::default();
    let mut send_blocked = false;
    // A reconnected shell starts at the PTY's default size; the terminal only
    // reports a size when it changes.
    let mut resize = PtyResize {
        wanted: io.pty_size,
        ..PtyResize::default()
    };

    loop {
        let mut active = false;
        let mut eof = false;
        pending.clear();

        // Bytes on the socket prove the server is there, even when libssh2
        // consumes them without producing shell output (a keepalive reply). The
        // agent pump may have got to them first, and says so. Asked every pass,
        // so that what it says is never old news.
        let pump_heard = agent_pump
            .as_ref()
            .is_some_and(crate::agent::ForwardPump::take_heard);
        if watchdog.enabled() && (pump_heard || wake::is_readable(fds[0])) {
            watchdog.heard(Instant::now());
        }

        // Above the limit, leave the output where it is: unread, it keeps the SSH
        // window shut. Everything else in this loop goes on, so a Ctrl+C gets
        // through to stop a flood.
        let paused = io.control.unacked_output.load(Ordering::SeqCst) >= OUTPUT_PAUSE_BYTES;

        // Drain everything the remote has for us. Extended data arrives here
        // too: `open_shell_over_stream` merges it into this stream.
        if !paused {
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
                        io.print(&pending);
                        return after_io_error(&mut channel, format!("SSH read error: {}", e));
                    }
                }
            }
        }
        io.print(&pending);

        // Apply everything the frontend queued.
        loop {
            match io.control.rx.try_recv() {
                Ok(SessionMsg::Write(data)) => input.push(&data),
                Ok(SessionMsg::Resize { cols, rows }) => {
                    io.pty_size = Some((cols, rows));
                    resize.wanted = io.pty_size;
                }
                Ok(SessionMsg::Disconnect) | Err(TryRecvError::Disconnected) => {
                    close_channel(&mut channel);
                    return ShellEnd::Closed;
                }
                Ok(SessionMsg::Reconnect | SessionMsg::CancelReconnect) => {}
                Err(TryRecvError::Empty) => break,
            }
        }

        if let Err(e) = resize.send(|cols, rows| channel.request_pty_size(cols, rows, None, None)) {
            io.out.warn(format!("resize failed: {}", e));
        }
        match input.send(&mut channel) {
            Ok(0) => {}
            Ok(_) => {
                active = true;
                // A full socket that has room again was emptied by the server's
                // TCP acknowledging it. Keepalives can starve while input fills
                // every gap, so this is what says the server is there.
                if send_blocked {
                    watchdog.heard(Instant::now());
                }
            }
            Err(e) => return after_io_error(&mut channel, format!("SSH write error: {}", e)),
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

        let sending = !input.is_empty() || resize.wanted.is_some();
        send_blocked = !active && send_blocked_on_socket(&session);
        if !active {
            // While paused this also keeps the watchdog's view of the socket true
            // and notices a lost connection, and sshd, its output moving, goes on
            // reading what is sent to it.
            if sending || send_blocked || paused {
                if let Err(e) = take_in(&mut channel) {
                    return after_io_error(&mut channel, format!("SSH read error: {}", e));
                }
                // A write reads the socket too, so output may wait in libssh2
                // with nothing left on the socket to wake this thread.
                if !paused && !send_blocked && channel.read_window().available > 0 {
                    continue;
                }
            }
            let shared = agent_pump
                .as_ref()
                .is_some_and(crate::agent::ForwardPump::serving);
            // A shut window has to wait for the server: the socket is writable
            // all along, and waiting on that would spin.
            let socket = [fds[0]];
            let writable: &[wake::Fd] = if send_blocked { &socket } else { &[] };
            wake::wait_ready(&fds, writable, idle_wait(shared));
            io.control.wake.drain();
        }
    }
}

/// How long an idle reader of a session may sleep. Another thread reading the
/// same session can pull its packet into libssh2's queue without the socket ever
/// turning readable for the sleeper, so then it cannot sleep for long.
fn idle_wait(shared: bool) -> Duration {
    if shared {
        SHARED_WAIT_MAX
    } else {
        WAIT_MAX
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

/// A PTY size on its way to the server. libssh2 keeps a window-change it could
/// not finish sending and refuses every other packet until it is retried, so one
/// left behind jams the session. It cannot be retried in a loop on the spot
/// either: while input is half sent the refusal lasts until the input goes, and
/// that needs the worker's loop. So it is offered once per pass, like input.
#[derive(Default)]
struct PtyResize {
    wanted: Option<(u32, u32)>,
    /// The size libssh2 has kept: a retry sends this, whatever it is asked for.
    kept: Option<(u32, u32)>,
}

impl PtyResize {
    fn send(
        &mut self,
        send: impl FnOnce(u32, u32) -> Result<(), ssh2::Error>,
    ) -> Result<(), ssh2::Error> {
        let Some(size) = self.wanted else {
            return Ok(());
        };
        match send(size.0, size.1) {
            Err(e) if is_eagain(&e) => {
                self.kept.get_or_insert(size);
                Ok(())
            }
            result => {
                // A newer size that came in meanwhile has still to go.
                if self.kept.take().is_none_or(|kept| kept == size) {
                    self.wanted = None;
                }
                result
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Hops: jump hosts (ssh -J)
// ---------------------------------------------------------------------------

/// Open the session to the jump host of a jump connection. `role` names it in
/// errors and debug lines.
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

/// What a tunnel has carried, counted once the other side has taken it.
#[derive(Default)]
pub(crate) struct Traffic {
    /// From the local side, into the SSH channel.
    pub(crate) sent: AtomicU64,
    /// From the SSH channel, to the local side.
    pub(crate) received: AtomicU64,
}

/// Forward bytes between a local TCP socket and an SSH `direct-tcpip` channel,
/// as `ssh -L` does. Each direction holds what its destination has not taken and
/// reads no more from its source until it has, so a side that stops reading slows
/// its sender down, however long for, and never holds up the other direction. The
/// thread sleeps in `poll(2)` on what it is waiting for, so a stalled or idle
/// forward costs no CPU.
///
/// There is no time limit. It ends when the local side closes or resets, the
/// channel ends, or the session fails, and whoever owns the session is the one to
/// notice a dead one: a forward's probes, or the keepalive of a jump host bridge,
/// which turns into a failure here once the operating system gives up on it.
/// `clients` counts the forwarders sharing `session`: see [`idle_wait`].
pub(crate) fn forward_bidi(
    mut local: TcpStream,
    mut channel: ssh2::Channel,
    session: &Session,
    clients: &AtomicUsize,
    traffic: &Traffic,
) {
    local.set_nonblocking(true).ok();
    local.set_nodelay(true).ok();
    let local_fd = wake::fd_of(&local);
    let session_fd = wake::fd_of(session);
    let mut buf = vec![0u8; 64 * 1024];
    let mut up = Outgoing::default();
    let mut down = Outgoing::default();

    loop {
        let mut idle = true;

        // local → channel. Local data read before the client closed still goes
        // out first, however long that takes.
        if up.is_empty() {
            match local.read(&mut buf) {
                Ok(0) => {
                    close_channel(&mut channel);
                    return;
                }
                Ok(n) => up.push(&buf[..n]),
                Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {}
                Err(_) => {
                    close_channel(&mut channel);
                    return;
                }
            }
        }
        match up.send(&mut channel) {
            Ok(0) => {}
            Ok(n) => {
                traffic.sent.fetch_add(n as u64, Ordering::Relaxed);
                idle = false;
            }
            Err(_) => {
                close_channel(&mut channel);
                return;
            }
        }

        // channel → local
        if down.is_empty() {
            match channel.read(&mut buf) {
                Ok(0) => {
                    let _ = local.shutdown(Shutdown::Both);
                    return;
                }
                Ok(n) => down.push(&buf[..n]),
                Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {}
                Err(_) => {
                    let _ = local.shutdown(Shutdown::Both);
                    return;
                }
            }
        }
        match down.send(&mut local) {
            Ok(0) => {}
            Ok(n) => {
                traffic.received.fetch_add(n as u64, Ordering::Relaxed);
                idle = false;
            }
            Err(_) => {
                close_channel(&mut channel);
                return;
            }
        }

        if down.is_empty() && channel.eof() {
            let _ = local.shutdown(Shutdown::Both);
            return;
        }

        if idle {
            let send_blocked = send_blocked_on_socket(session);
            if !up.is_empty() || send_blocked {
                // A close with data still queued looks like more data, so only a
                // reset shows here. Closing leaves libssh2 no half-sent packet
                // that it would refuse the close for.
                if !send_blocked && was_reset(&local) {
                    close_channel(&mut channel);
                    return;
                }
                if send_due_keepalive(session, session_fd).is_err()
                    || take_in(&mut channel).is_err()
                {
                    let _ = local.shutdown(Shutdown::Both);
                    close_channel(&mut channel);
                    return;
                }
                // A write reads the socket too, so output may wait in libssh2
                // with nothing left on the socket to wake this thread.
                if !send_blocked && down.is_empty() && channel.read_window().available > 0 {
                    continue;
                }
            }
            let wanted = |fd: wake::Fd, yes: bool| yes.then_some(fd);
            let readable: Vec<_> = [
                wanted(local_fd, up.is_empty()),
                wanted(session_fd, down.is_empty()),
            ]
            .into_iter()
            .flatten()
            .collect();
            let writable: Vec<_> = [
                wanted(local_fd, !down.is_empty()),
                wanted(session_fd, send_blocked),
            ]
            .into_iter()
            .flatten()
            .collect();
            wake::wait_ready(
                &readable,
                &writable,
                idle_wait(clients.load(Ordering::Relaxed) > 1),
            );
        }
    }
}

/// Whether the peer of a non-blocking socket has aborted the connection. macOS
/// goes on returning bytes it already had, so a failed read alone would not say.
fn was_reset(socket: &TcpStream) -> bool {
    matches!(socket.take_error(), Ok(Some(_)))
        || matches!(
            socket.peek(&mut [0u8; 1]),
            Err(e) if !matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted)
        )
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
    let gateway_session = open_hop_unless_cancelled(gateway, "Jump host", verbosity, cancelled)?;
    let debug = SshDebug::new(verbosity, gateway.addr());
    // Past the jump host's login, so no port is open while that takes its time.
    let (stream, local_stream) = crate::proxy::loopback_pair()
        .map_err(|e| format!("Failed to connect inner SSH session: {}", e))?;
    let peer = local_stream
        .peer_addr()
        .map_err(|e| format!("Failed to connect inner SSH session: {}", e))?;

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
                    // Nobody watches this session. Once the jump host dies under
                    // bytes waiting for its window, something has to go out for
                    // the operating system to give up on. No reply, so nothing
                    // piles up in libssh2.
                    session.set_keepalive(false, BRIDGE_KEEPALIVE_SECS);
                    let _ = ready_tx.send(Ok(()));
                    forward_bidi(
                        local_stream,
                        channel,
                        &session,
                        &AtomicUsize::new(1),
                        &Traffic::default(),
                    );
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("channel_direct_tcpip failed: {}", e)));
                    let _ = local_stream.shutdown(Shutdown::Both);
                }
            }
        });
    }

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
mod idle_wait_tests {
    use super::*;

    #[test]
    fn a_reader_with_company_cannot_sleep_for_long() {
        assert_eq!(idle_wait(false), WAIT_MAX);
        assert_eq!(idle_wait(true), SHARED_WAIT_MAX);
        assert!(SHARED_WAIT_MAX < WAIT_MAX);
    }
}

#[cfg(test)]
mod credential_failure_tests {
    use super::*;
    use crate::auth_prompt::{PromptFailure, CANCELLED, TIMED_OUT};
    use crate::login_wait::{LOST, STALLED};
    use crate::reconnect::is_retryable_connect_error;

    fn failure(code: i32, reason: &'static str) -> CredentialFailure {
        let error = ssh2::Error::new(ssh2::ErrorCode::Session(code), reason);
        CredentialFailure::from_error(&error, reason.to_string())
    }

    #[test]
    fn only_the_servers_judgement_counts_as_a_refusal() {
        for (code, reason) in [
            (-18, "Authentication failed (username/password)"),
            (-18, "Username/PublicKey combination invalid"),
            (-19, "Invalid signature for supplied public key"),
        ] {
            assert!(
                matches!(failure(code, reason), CredentialFailure::Refused(_)),
                "{reason}"
            );
        }
        for (code, reason) in [
            (-16, "Unable to extract public key from private key file"),
            (-15, "Password expired, and callback failed"),
            (-13, "socket disconnect"),
            (-9, "Timed out waiting on socket"),
            (-19, "Waiting for USERAUTH response"),
            (-19, "Callback returned error"),
            (-19, "Invalid public key, too short"),
            (-1, "failed to write temporary SSH key"),
        ] {
            assert!(
                matches!(failure(code, reason), CredentialFailure::Local(_)),
                "{reason}"
            );
        }
    }

    #[test]
    fn a_method_list_that_changed_means_the_first_factor_was_accepted() {
        let accepted = |before, after| accepted_as_first_factor(before, after);
        assert!(accepted(Some("password"), Some("keyboard-interactive")));
        assert!(accepted(
            Some("publickey,password"),
            Some("keyboard-interactive")
        ));
        assert!(!accepted(
            Some("publickey,keyboard-interactive"),
            Some("keyboard-interactive, publickey")
        ));
        assert!(!accepted(None, Some("keyboard-interactive")));
        assert!(!accepted(Some("password"), None));
    }

    #[test]
    fn a_refusal_stays_in_the_message_whatever_ends_the_prompt() {
        let first = "Key auth failed: combination invalid";
        let with_refusal = |failure| prompt_failure_message(first, true, failure);
        assert_eq!(with_refusal(PromptFailure::NothingAsked), first);
        for reason in [CANCELLED, TIMED_OUT] {
            let message = with_refusal(PromptFailure::GaveUp(reason));
            assert!(
                message.starts_with(first) && message.contains(reason),
                "{message}"
            );
            assert!(!is_retryable_connect_error(&message));
        }
        let wrong = with_refusal(PromptFailure::Refused("no".to_string()));
        assert!(wrong.starts_with(first), "{wrong}");
        assert!(
            wrong.contains("Keyboard-interactive auth failed: no"),
            "{wrong}"
        );
    }

    /// A retry would send the credential the server just refused.
    #[test]
    fn a_silent_server_after_a_refusal_is_not_retried() {
        let first = "Key auth failed: combination invalid";
        for failure in [
            PromptFailure::GaveUp(STALLED),
            PromptFailure::ConnectionLost,
        ] {
            let message = prompt_failure_message(first, true, failure);
            assert!(message.starts_with(first), "{message}");
            assert!(!is_retryable_connect_error(&message), "{message}");
        }
    }

    #[test]
    fn a_connection_lost_after_a_refusal_says_so_and_is_not_retried() {
        let first = "Key auth failed: combination invalid";
        let message = prompt_failure_message(first, true, PromptFailure::ConnectionLost);
        assert_eq!(message, format!("{first}. The connection then closed"));
    }

    #[test]
    fn without_a_refusal_the_prompt_speaks_for_itself() {
        let first = "The server does not accept password authentication (it offers: publickey)";
        let on_its_own = |failure| prompt_failure_message(first, false, failure);
        assert_eq!(on_its_own(PromptFailure::GaveUp(CANCELLED)), CANCELLED);
        assert_eq!(on_its_own(PromptFailure::GaveUp(STALLED)), STALLED);
        assert_eq!(on_its_own(PromptFailure::ConnectionLost), LOST);
        assert!(is_retryable_connect_error(&on_its_own(
            PromptFailure::GaveUp(STALLED)
        )));
        assert_eq!(
            on_its_own(PromptFailure::Refused("no".to_string())),
            "Keyboard-interactive auth failed: no"
        );
        assert_eq!(on_its_own(PromptFailure::NothingAsked), first);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::atomic::AtomicU8;

    #[cfg(unix)]
    mod live_io;

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

    /// Write all of `data` to a non-blocking writer, giving up after 10 s
    /// without progress.
    fn write_all_nonblocking<W: Write>(
        w: &mut W,
        data: &[u8],
        fd: Option<wake::Fd>,
    ) -> io::Result<()> {
        let mut outgoing = Outgoing::default();
        outgoing.push(data);
        let mut moved = Instant::now();
        while !outgoing.is_empty() {
            if outgoing.send(w)? > 0 {
                moved = Instant::now();
                continue;
            }
            if moved.elapsed() > Duration::from_secs(10) {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "peer stopped reading",
                ));
            }
            match fd {
                Some(fd) => wake::wait_writable(fd, Duration::from_millis(50)),
                None => thread::sleep(Duration::from_millis(1)),
            }
        }
        Ok(())
    }

    #[test]
    fn an_ack_lowers_the_count_never_below_zero_and_wakes_the_worker() {
        let (handle, control) = control_channel().unwrap();
        control.unacked_output.store(100, Ordering::SeqCst);
        handle.ack_output(30);
        assert_eq!(control.unacked_output.load(Ordering::SeqCst), 70);
        handle.ack_output(u64::MAX);
        assert_eq!(control.unacked_output.load(Ordering::SeqCst), 0);
        #[cfg(unix)]
        assert!(wake::is_readable(control.wake.fd()));
    }

    /// A writer that takes `step` bytes every other call and refuses the rest.
    struct Trickle {
        out: Vec<u8>,
        step: usize,
        calls: usize,
    }

    impl Write for Trickle {
        fn write(&mut self, data: &[u8]) -> io::Result<usize> {
            self.calls += 1;
            if self.calls.is_multiple_of(2) {
                return Err(io::Error::new(io::ErrorKind::WouldBlock, "later"));
            }
            let n = data.len().min(self.step);
            self.out.extend_from_slice(&data[..n]);
            Ok(n)
        }

        fn flush(&mut self) -> io::Result<()> {
            panic!("a channel's flush discards what it has queued to read");
        }
    }

    #[test]
    fn outgoing_offers_once_per_call_and_keeps_its_place_and_order() {
        let mut w = Trickle {
            out: Vec::new(),
            step: 2,
            calls: 0,
        };
        let mut outgoing = Outgoing::default();
        outgoing.push(b"hello");
        assert_eq!(outgoing.send(&mut w).unwrap(), 2);
        assert_eq!(w.calls, 1);
        // Refused: nothing moves, and the same bytes are offered next time.
        assert_eq!(outgoing.send(&mut w).unwrap(), 0);
        assert!(!outgoing.is_empty());
        // What arrives meanwhile goes behind it.
        outgoing.push(b" world");
        while !outgoing.is_empty() {
            outgoing.send(&mut w).unwrap();
        }
        assert_eq!(w.out, b"hello world");
        assert_eq!(outgoing.send(&mut w).unwrap(), 0, "nothing left to offer");
    }

    #[test]
    fn outgoing_takes_a_write_of_nothing_as_no_room_and_passes_on_real_errors() {
        struct Answers(Vec<io::Result<usize>>);
        impl Write for Answers {
            fn write(&mut self, _data: &[u8]) -> io::Result<usize> {
                self.0.remove(0)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let mut w = Answers(vec![
            Ok(0),
            Err(io::Error::from(io::ErrorKind::Interrupted)),
            Err(io::Error::from(io::ErrorKind::BrokenPipe)),
        ]);
        let mut outgoing = Outgoing::default();
        outgoing.push(b"x");
        assert_eq!(outgoing.send(&mut w).unwrap(), 0);
        assert_eq!(outgoing.send(&mut w).unwrap(), 0);
        assert!(outgoing.send(&mut w).is_err());
        assert!(!outgoing.is_empty());
    }

    fn eagain() -> ssh2::Error {
        ssh2::Error::new(ssh2::ErrorCode::Session(LIBSSH2_ERROR_EAGAIN), "later")
    }

    #[test]
    fn a_refused_resize_is_retried_until_it_goes() {
        let mut resize = PtyResize {
            wanted: Some((80, 24)),
            ..PtyResize::default()
        };
        assert!(resize.send(|_, _| Err(eagain())).is_ok());
        assert_eq!(resize.wanted, Some((80, 24)));
        assert!(resize.send(|_, _| Err(eagain())).is_ok());

        let mut sent = None;
        let done = resize.send(|cols, rows| {
            sent = Some((cols, rows));
            Ok(())
        });
        assert!(done.is_ok());
        assert_eq!(sent, Some((80, 24)));
        assert_eq!(resize.wanted, None);

        let mut asked = false;
        resize
            .send(|_, _| {
                asked = true;
                Ok(())
            })
            .unwrap();
        assert!(!asked, "nothing left to send");
    }

    /// libssh2 finishes the packet it kept and ignores the new numbers, so the
    /// newer size needs a send of its own.
    #[test]
    fn a_size_that_arrives_during_a_retry_goes_out_after_it() {
        let mut resize = PtyResize {
            wanted: Some((80, 24)),
            ..PtyResize::default()
        };
        resize.send(|_, _| Err(eagain())).unwrap();
        resize.wanted = Some((100, 30));
        resize.send(|_, _| Ok(())).unwrap();
        assert_eq!(resize.wanted, Some((100, 30)));
        resize.send(|_, _| Ok(())).unwrap();
        assert_eq!(resize.wanted, None);
    }

    #[test]
    fn a_resize_that_really_failed_is_reported_and_forgotten() {
        let mut resize = PtyResize {
            wanted: Some((80, 24)),
            ..PtyResize::default()
        };
        let failed = ssh2::Error::new(ssh2::ErrorCode::Session(-7), "gone");
        assert!(resize.send(|_, _| Err(failed)).is_err());
        assert_eq!(resize.wanted, None);
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

    /// A saved password and a stored key.
    fn credentials_for_a_lost_login() -> Vec<Endpoint> {
        use crate::commands::ssh_keygen::{generate_ssh_key_sync, GenerateSshKeyInput, KeyStorage};
        let password = crate::remote_script::live::Target::from_env().endpoint;
        let key = generate_ssh_key_sync(GenerateSshKeyInput {
            storage: KeyStorage::Inline,
            name_hint: None,
            passphrase: None,
            comment: None,
        })
        .unwrap();
        let mut with_key = password.clone();
        with_key.auth = AuthMethod::KeyMemory {
            private_key: key.private_key,
            passphrase: None,
        };
        vec![password, with_key]
    }

    fn assert_stops_the_retries(failure: CredentialFailure) {
        assert!(matches!(failure, CredentialFailure::Local(_)));
        let error = failure.into_message();
        assert!(
            error.starts_with("Password auth failed") || error.starts_with("Key auth failed"),
            "{error}"
        );
        assert!(!crate::reconnect::is_retryable_connect_error(&error));
    }

    /// Once a credential went out, a close can be a server hanging up on it, and
    /// sending it again could lock the account.
    #[test]
    #[ignore]
    fn live_a_connection_closed_after_the_credential_went_out_is_not_retried() {
        use crate::login_wait::test_support::FreezingProxy;
        for endpoint in credentials_for_a_lost_login() {
            let proxy = FreezingProxy::to(&endpoint.addr());
            let session = proxy.session();
            proxy.freeze();
            proxy.cut_after(Duration::from_millis(300));
            let debug = SshDebug::new(0, "live-test");
            let failure = authenticate_with_credential(&session, &endpoint, &debug).unwrap_err();
            assert_stops_the_retries(failure);
        }
    }

    /// No reply in time can be a server still judging the credential.
    #[test]
    #[ignore]
    fn live_a_credential_with_no_reply_in_time_is_not_retried() {
        use crate::login_wait::test_support::FreezingProxy;
        for endpoint in credentials_for_a_lost_login() {
            let proxy = FreezingProxy::to(&endpoint.addr());
            let session = proxy.session();
            session.set_timeout(1_000);
            proxy.freeze();
            let debug = SshDebug::new(0, "live-test");
            let failure = authenticate_with_credential(&session, &endpoint, &debug).unwrap_err();
            assert_stops_the_retries(failure);
        }
    }

    /// Every kind of credential, none of which leaves on a connection already lost.
    fn every_credential_kind() -> Vec<Endpoint> {
        let mut endpoints = credentials_for_a_lost_login();
        let mut agent = endpoints[0].clone();
        agent.auth = AuthMethod::Agent;
        endpoints.push(agent);
        endpoints
    }

    fn assert_lost(error: String) {
        assert_eq!(error, crate::login_wait::LOST);
        assert!(crate::reconnect::is_retryable_connect_error(&error));
    }

    #[test]
    #[ignore]
    fn live_a_connection_closed_before_the_credential_went_out_can_be_retried() {
        use crate::login_wait::test_support::FreezingProxy;
        for endpoint in every_credential_kind() {
            let proxy = FreezingProxy::to(&endpoint.addr());
            let session = proxy.session();
            proxy.cut();
            let debug = SshDebug::new(0, "live-test");
            assert_lost(authenticate(&session, &endpoint, &debug).unwrap_err());
        }
    }

    #[test]
    #[ignore]
    fn live_a_network_stalled_before_the_credential_went_out_can_be_retried() {
        use crate::login_wait::test_support::FreezingProxy;
        for endpoint in every_credential_kind() {
            let proxy = FreezingProxy::to(&endpoint.addr());
            let session = proxy.session();
            session.set_timeout(1_000);
            proxy.freeze();
            let debug = SshDebug::new(0, "live-test");
            assert_lost(authenticate(&session, &endpoint, &debug).unwrap_err());
        }
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

    /// libssh2's own Windows backend (WinCNG) has no curve25519, ed25519 or
    /// ECDSA, and loses about 1 login in 256: it keeps a leading zero on the
    /// Diffie-Hellman secret, so its exchange hash differs from the server's.
    /// A login that negotiates curve25519 is not on that backend.
    #[test]
    #[ignore]
    fn live_logins_use_curve25519_and_know_ed25519_on_every_platform() {
        let target = crate::remote_script::live::Target::from_env();
        crate::storage::test_support::with_isolated_data_dir(|| {
            let session = open_authenticated_session(&target.endpoint, 0, None).unwrap();
            let kex = session.methods(ssh2::MethodType::Kex).unwrap_or_default();
            assert!(kex.starts_with("curve25519-sha256"), "negotiated {kex}");
            let host_keys = session.supported_algs(ssh2::MethodType::HostKey).unwrap();
            assert!(host_keys.contains(&"ssh-ed25519"), "{host_keys:?}");
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
    /// Leave what either side sends unread.
    const RELAY_FROZEN: u8 = 6;
    /// Pass on what the client sends at about 128 KB/s at most.
    const RELAY_TRICKLE_UP: u8 = 7;

    /// A loopback relay to a real server, so that a test can control what the
    /// client's socket sees.
    struct Relay {
        port: u16,
        mode: Arc<AtomicU8>,
        discard_up: Arc<AtomicUsize>,
    }

    impl Relay {
        fn start(server: &Endpoint) -> Self {
            Self::start_with(server, |_| {})
        }

        /// `prepare` gets the relay's socket towards the client.
        fn start_with(server: &Endpoint, prepare: fn(&TcpStream)) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let mode = Arc::new(AtomicU8::new(RELAY_FLOW));
            let discard_up = Arc::new(AtomicUsize::new(0));
            let (relay_mode, relay_discard) = (Arc::clone(&mode), Arc::clone(&discard_up));
            let server = server.addr();
            thread::spawn(move || {
                let (client, _) = listener.accept().unwrap();
                prepare(&client);
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
                    if mode == RELAY_FROZEN {
                        thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    if mode != RELAY_HOLD_UP {
                        let room = if mode == RELAY_TRICKLE_UP {
                            128
                        } else {
                            buf.len()
                        };
                        let Some(n) = relay_read(&client, &mut buf[..room]) else {
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
