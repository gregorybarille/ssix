//! SSH sessions on top of `ssh2`: interactive shells, local port forwards and
//! jump host bridging.
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

use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use ssh2::Session;

use crate::ssh_debug::{host_key_type_name, SshDebug};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};

/// TCP connect timeout for every outbound connection (direct host or gateway).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// libssh2 timeout for blocking calls during setup (handshake, auth, channel open).
const SESSION_TIMEOUT_MS: u32 = 15_000;
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
    Error { message: String },
    Closed,
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

    fn log(&self, level: &str, source: &str, message: String) {
        crate::logs::log(&self.app, level, source, message);
    }

    fn emit_error(&self, message: String) {
        self.send_event(OutputEvent::Error { message });
    }

    fn emit_forward_status(&self, status: ForwardStatus) {
        let _ = self
            .app
            .emit(&forward_status_event(&self.session_id), status);
    }

    /// Put the session in the registry before its worker starts, so a
    /// worker that exits at once still finds (and removes) its own entry.
    fn register(&self, handle: SessionHandle) -> Result<(), String> {
        let state = self
            .app
            .try_state::<SshState>()
            .ok_or_else(|| "SSH state is not managed".to_string())?;
        state.sessions.insert(self.session_id.clone(), handle);
        Ok(())
    }

    /// Drop the session from the registry and tell the frontend it is gone.
    fn finish(&self) {
        if let Some(state) = self.app.try_state::<SshState>() {
            state.sessions.remove(&self.session_id);
        }
        self.send_event(OutputEvent::Closed);
    }
}

pub enum SessionMsg {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Disconnect,
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
struct ControlRx {
    rx: Receiver<SessionMsg>,
    wake: wake::WakeReceiver,
}

fn control_channel() -> Result<(SessionHandle, ControlRx), String> {
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

/// Status payload a local forward emits on `ssix:forward:status:{id}`.
#[derive(Serialize, Clone)]
pub struct ForwardStatus {
    pub state: &'static str, // "listening" | "client_connected" | "client_closed" | "error"
    pub local_port: u16,
    pub destination: String,
    pub message: Option<String>,
    pub active_clients: usize,
}

/// Event names are namespaced under `ssix:` and mirrored in
/// `src/lib/events.ts`; both sides MUST go through these helpers.
pub(crate) fn forward_status_event(session_id: &str) -> String {
    format!("ssix:forward:status:{}", session_id)
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
        let _ = channel.flush();
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
fn connect_endpoint(endpoint: &Endpoint, verbosity: u8) -> Result<TcpStream, String> {
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

    authenticate(&session, endpoint, &debug)?;
    Ok(session)
}

fn authenticate(session: &Session, endpoint: &Endpoint, debug: &SshDebug) -> Result<(), String> {
    let username = &endpoint.username;
    // Listing the methods sends a "none" request, as `ssh -v` does. A
    // server that accepts it leaves nothing else to do.
    if debug.enabled(1) {
        match session.auth_methods(username) {
            Ok(methods) => debug.at(1, || {
                format!("Authentications that can continue: {}", methods)
            }),
            Err(e) => debug.at(1, || {
                format!("Could not list authentication methods: {}", e)
            }),
        }
        if session.authenticated() {
            debug.at(1, || "Authentication succeeded (none).".to_string());
            return Ok(());
        }
    }
    let method = match &endpoint.auth {
        AuthMethod::Password(_) => "password".to_string(),
        AuthMethod::Key { path, .. } => format!("publickey ({})", path),
        AuthMethod::KeyMemory { .. } => "publickey (stored key)".to_string(),
    };
    debug.at(1, || {
        format!("Next authentication method: {} as {}", method, username)
    });
    let started = Instant::now();
    match &endpoint.auth {
        AuthMethod::Password(pw) => session
            .userauth_password(username, pw)
            .map_err(|e| format!("Password auth failed: {}", e))?,
        AuthMethod::Key { path, passphrase } => session
            .userauth_pubkey_file(username, None, Path::new(path), passphrase.as_deref())
            .map_err(|e| format!("Key auth failed: {}", e))?,
        AuthMethod::KeyMemory {
            private_key,
            passphrase,
        } => authenticate_pubkey_memory(session, username, private_key, passphrase.as_deref())
            .map_err(|e| format!("Key auth failed: {}", e))?,
    }

    if !session.authenticated() {
        return Err("Authentication failed".to_string());
    }
    debug.at(1, || format!("Authentication succeeded ({}).", method));
    debug.at(3, || {
        format!("Authentication took {} ms", started.elapsed().as_millis())
    });
    Ok(())
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

/// Authenticate over `tcp`, request a PTY, start a shell and run the startup
/// command. The session is switched to non-blocking mode before returning.
fn open_shell_over_stream(
    tcp: TcpStream,
    endpoint: &Endpoint,
    opts: &ShellOptions,
) -> Result<(Session, ssh2::Channel), String> {
    let session = open_authenticated_session_over_stream(
        tcp,
        endpoint,
        opts.verbosity,
        opts.extra_args.as_deref(),
    )?;

    let debug = SshDebug::new(opts.verbosity, endpoint.addr());
    debug.at(1, || "Opening a session channel.".to_string());
    let mut channel = session
        .channel_session()
        .map_err(|e| format!("Channel open failed: {}", e))?;
    debug.at(1, || {
        "Requesting a PTY (xterm-256color, 80x24).".to_string()
    });
    channel
        .request_pty("xterm-256color", None, Some((80, 24, 0, 0)))
        .map_err(|e| format!("PTY request failed: {}", e))?;
    debug.at(1, || "Requesting a shell.".to_string());
    channel
        .shell()
        .map_err(|e| format!("Shell request failed: {}", e))?;
    if let Some(command) = opts.startup_command.as_deref() {
        debug.at(2, || format!("Sending startup command: {}", command));
    }
    write_startup_command(&mut channel, opts.startup_command.as_deref());

    session.set_blocking(false);
    Ok((session, channel))
}

fn open_shell(
    endpoint: &Endpoint,
    opts: &ShellOptions,
) -> Result<(Session, ssh2::Channel), String> {
    let tcp = connect_endpoint(endpoint, opts.verbosity)?;
    open_shell_over_stream(tcp, endpoint, opts)
}

// ---------------------------------------------------------------------------
// Interactive shell sessions
// ---------------------------------------------------------------------------

pub fn start_ssh_session(
    target: Endpoint,
    opts: ShellOptions,
    ctx: SessionContext,
) -> Result<SessionHandle, String> {
    let (session, channel) = open_shell(&target, &opts)?;
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
    spawn_shell_worker(session, channel, ctx, control, banner, "ssh");
    Ok(handle)
}

fn spawn_shell_worker(
    session: Session,
    channel: ssh2::Channel,
    ctx: SessionContext,
    control: ControlRx,
    banner: String,
    source: &'static str,
) {
    thread::spawn(move || {
        ctx.send_output(banner.as_bytes());
        if let Err(e) = run_io_loop(&session, channel, &ctx, control) {
            ctx.log(
                "error",
                source,
                format!("session {}: {}", ctx.session_id, e),
            );
            ctx.emit_error(e);
        }
        ctx.finish();
        // `session` must outlive `channel`; drop it last.
        drop(session);
    });
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
    let _ = w.flush();
    Ok(())
}

/// Pump shell output to the frontend and frontend input to the shell until
/// the channel closes or the frontend disconnects.
fn run_io_loop(
    session: &Session,
    mut channel: ssh2::Channel,
    ctx: &SessionContext,
    control: ControlRx,
) -> Result<(), String> {
    let mut buf = vec![0u8; 32 * 1024];
    let mut pending: Vec<u8> = Vec::with_capacity(OUTPUT_COALESCE_MAX);
    let fds = [wake::fd_of(session), control.wake.fd()];

    loop {
        let mut active = false;
        let mut eof = false;
        pending.clear();

        // Drain everything the remote has for us (a PTY merges stderr into
        // stdout, so there is no separate stderr stream to read).
        loop {
            match channel.read(&mut buf) {
                Ok(0) => {
                    eof = true;
                    break;
                }
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    active = true;
                    if pending.len() >= OUTPUT_COALESCE_MAX {
                        break;
                    }
                }
                Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) => {
                    ctx.send_output(&pending);
                    close_channel(&mut channel);
                    return Err(format!("SSH read error: {}", e));
                }
            }
        }
        ctx.send_output(&pending);

        // Apply everything the frontend queued.
        loop {
            match control.rx.try_recv() {
                Ok(SessionMsg::Write(data)) => {
                    active = true;
                    if let Err(e) = write_all_nonblocking(&mut channel, &data, Some(fds[0])) {
                        close_channel(&mut channel);
                        return Err(format!("SSH write error: {}", e));
                    }
                }
                Ok(SessionMsg::Resize { cols, rows }) => {
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
                Ok(SessionMsg::Disconnect) | Err(TryRecvError::Disconnected) => {
                    close_channel(&mut channel);
                    return Ok(());
                }
                Err(TryRecvError::Empty) => break,
            }
        }

        if eof || channel.eof() {
            break;
        }

        if !active {
            wake::wait_readable(&fds, WAIT_MAX);
            control.wake.drain();
        }
    }

    close_channel(&mut channel);
    Ok(())
}

// ---------------------------------------------------------------------------
// Hops: local forwards (ssh -L) and jump hosts (ssh -J)
// ---------------------------------------------------------------------------

/// Open the session to the first hop: the SSH server of a local forward or
/// the jump host of a jump connection. `role` names it in errors and debug
/// lines.
pub(crate) fn open_hop_session(
    hop: &Endpoint,
    role: &str,
    verbosity: u8,
) -> Result<Session, String> {
    SshDebug::new(verbosity, hop.addr()).at(1, || {
        format!("Using {} {}", role.to_lowercase(), hop.addr())
    });
    open_authenticated_session(hop, verbosity, None)
        .map_err(|e| format!("{} {}: {}", role, hop.addr(), e))
}

/// Open a `direct-tcpip` channel on a non-blocking session, waiting for the
/// socket whenever libssh2 asks to be called again.
fn open_direct_tcpip(
    session: &Session,
    destination_host: &str,
    destination_port: u16,
    peer: SocketAddr,
) -> Result<ssh2::Channel, String> {
    let deadline = Instant::now() + Duration::from_millis(SESSION_TIMEOUT_MS as u64);
    let fds = [wake::fd_of(session)];
    let peer_ip = peer.ip().to_string();
    loop {
        match session.channel_direct_tcpip(
            destination_host,
            destination_port,
            Some((&peer_ip, peer.port())),
        ) {
            Ok(channel) => return Ok(channel),
            Err(e) if is_eagain(&e) => {
                if Instant::now() >= deadline {
                    return Err(format!(
                        "timed out opening a channel to {}:{}",
                        destination_host, destination_port
                    ));
                }
                wake::wait_readable(&fds, Duration::from_millis(50));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
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
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind ephemeral loopback port: {}", e))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| format!("local_addr() failed: {}", e))?
        .port();
    let gateway_session = open_hop_session(gateway, "Jump host", verbosity)?;
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

/// Listen on `127.0.0.1:local_port` and forward every accepted connection
/// through the SSH server `gateway` to `destination_host:destination_port`
/// (`ssh -L`).
///
/// Only `SessionMsg::Disconnect` is meaningful for a port forward; `Write`
/// and `Resize` are ignored. Bind and SSH server errors are returned
/// synchronously.
pub fn start_port_forward(
    gateway: Endpoint,
    local_port: u16,
    destination_host: String,
    destination_port: u16,
    verbosity: u8,
    ctx: SessionContext,
) -> Result<SessionHandle, String> {
    let bind_addr = SocketAddr::from(([127, 0, 0, 1], local_port));
    let listener = TcpListener::bind(bind_addr)
        .map_err(|e| format!("Failed to bind 127.0.0.1:{}: {}", local_port, e))?;

    let session = open_hop_session(&gateway, "SSH server", verbosity)?;
    let debug = SshDebug::new(verbosity, gateway.addr());
    debug.at(1, || {
        format!(
            "Local forwarding listening on 127.0.0.1 port {}.",
            local_port
        )
    });
    // Non-blocking so one slow client can never stall the others: libssh2
    // serialises every call made on a session.
    session.set_blocking(false);

    let (handle, control) = control_channel()?;
    ctx.register(handle.clone())?;
    let stop = Arc::new(AtomicBool::new(false));
    let active = Arc::new(AtomicUsize::new(0));
    let destination = format!("{}:{}", destination_host, destination_port);
    let ctx = Arc::new(ctx);

    let status = {
        let ctx = Arc::clone(&ctx);
        let destination = destination.clone();
        let active = Arc::clone(&active);
        move |state: &'static str, message: Option<String>| {
            ctx.emit_forward_status(ForwardStatus {
                state,
                local_port,
                destination: destination.clone(),
                message,
                active_clients: active.load(Ordering::SeqCst),
            });
        }
    };
    status("listening", None);

    // Control thread: block on the queue; on Disconnect (or when the handle
    // is dropped) raise the stop flag and poke the listener so accept()
    // returns.
    {
        let stop = Arc::clone(&stop);
        thread::spawn(move || {
            loop {
                match control.rx.recv() {
                    Ok(SessionMsg::Disconnect) | Err(_) => break,
                    Ok(_) => {}
                }
            }
            stop.store(true, Ordering::SeqCst);
            let _ = TcpStream::connect_timeout(&bind_addr, Duration::from_secs(1));
        });
    }

    thread::spawn(move || {
        loop {
            let (local_stream, peer) = match listener.accept() {
                Ok(accepted) => accepted,
                Err(e) => {
                    ctx.log(
                        "error",
                        "forward",
                        format!("session {}: accept failed: {}", ctx.session_id, e),
                    );
                    status("error", Some(format!("accept failed: {}", e)));
                    break;
                }
            };
            if stop.load(Ordering::SeqCst) {
                break;
            }

            let session = session.clone();
            let destination_host = destination_host.clone();
            let active = Arc::clone(&active);
            let status = status.clone();
            let debug = debug.clone();
            thread::spawn(move || {
                debug.at(1, || {
                    format!(
                        "Connection to port {} forwarding to {} port {} requested.",
                        local_port, destination_host, destination_port
                    )
                });
                let channel =
                    match open_direct_tcpip(&session, &destination_host, destination_port, peer) {
                        Ok(channel) => channel,
                        Err(e) => {
                            status("error", Some(format!("channel_direct_tcpip failed: {}", e)));
                            return;
                        }
                    };
                active.fetch_add(1, Ordering::SeqCst);
                status("client_connected", Some(format!("from {}", peer)));
                forward_bidi(local_stream, channel, &session, &active);
                active.fetch_sub(1, Ordering::SeqCst);
                status("client_closed", Some(format!("from {}", peer)));
                debug.at(2, || format!("Forwarded connection from {} closed.", peer));
            });
        }
        drop(listener);
        ctx.finish();
    });

    Ok(handle)
}

/// Open an interactive shell on `destination`, reached through the jump host
/// `gateway` (`ssh -J`).
pub fn start_jump_shell(
    gateway: Endpoint,
    destination: Endpoint,
    opts: ShellOptions,
    ctx: SessionContext,
) -> Result<SessionHandle, String> {
    let stream = bridge_via_jump_host(
        &gateway,
        &destination.host,
        destination.port,
        opts.verbosity,
    )?;
    let (session, channel) = open_shell_over_stream(stream, &destination, &opts)
        .map_err(|e| format!("Target connect via jump host failed: {}", e))?;
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
    spawn_shell_worker(session, channel, ctx, control, banner, "jump_host");
    Ok(handle)
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
                Ok(())
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
