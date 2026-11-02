//! Port forwards on top of the session helpers in `crate::ssh`.
//!
//! Three kinds share one engine:
//!
//! - **Local** (`ssh -L`, [`start_port_forward`]): a listener on
//!   `127.0.0.1:<local_port>` whose every accepted connection goes through
//!   the SSH server over a `direct-tcpip` channel to a fixed destination.
//! - **Dynamic** (`ssh -D`, [`start_dynamic_forward`]): the same listener, but
//!   a SOCKS5 proxy: each client names its own destination (see [`socks5`]).
//! - **Remote** (`ssh -R`, [`start_remote_forward`]): the SSH server listens
//!   on its own loopback, and every connection it accepts comes back as a
//!   `forwarded-tcpip` channel that is connected to a target on this side.
//!
//! A forward is a session like any other: it registers a [`SessionHandle`]
//! in `SshState`, only `SessionMsg::Disconnect` means anything to it, and it
//! reports state changes to the frontend on `ssix:forward:status:{id}`
//! (see [`forward_status_event`], mirrored in `src/lib/events.ts`). How it
//! ended travels on the session's output channel like a shell's, so it is
//! never lost: an `error` when it was not asked to stop, then `closed`.
//!
//! Each forward has one supervisor thread ([`supervise`]) and one thread per
//! client. The supervisor accepts clients and watches the SSH session, which
//! nothing else reads while no client is connected: it answers what the
//! server sends (keepalives, rekeying) and notices when the session dies.
//! When the forward ends, for whatever reason, the supervisor closes the
//! port, shuts down every client's socket, and closes the session.

use std::io;
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::os::raw::{c_long, c_void};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::TryRecvError;
use std::sync::{Arc, Mutex, TryLockError};
use std::thread;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use serde::Serialize;
use ssh2::{Channel, ErrorCode, Session};
use tauri::Emitter;

use crate::ssh::{
    close_channel, connect_endpoint, connect_tcp, control_channel, forward_bidi, is_eagain,
    open_authenticated_session_over_stream, wake, ControlRx, Endpoint, SessionContext,
    SessionHandle, SessionMsg, SESSION_TIMEOUT_MS,
};
use crate::ssh_debug::SshDebug;

mod socks5;

/// libssh2's code for a `CHANNEL_OPEN_FAILURE`, the server's own refusal.
const LIBSSH2_ERROR_CHANNEL_FAILURE: i32 = -21;
/// libssh2's code for "no reply within the read timeout".
const LIBSSH2_ERROR_TIMEOUT: i32 = -9;
/// libssh2's code for a `REQUEST_FAILURE`, the server's own refusal of a request.
const LIBSSH2_ERROR_REQUEST_DENIED: i32 = -32;

/// The address a remote forward asks the server to listen on. `ssh -R` sends
/// the same when it is given none: loopback only, unless the server's
/// `GatewayPorts yes` says otherwise.
const REMOTE_BIND_ADDRESS: &str = "localhost";

/// How long the server gets to answer a channel open; see [`SshUplink::open_direct`].
const OPEN_REPLY_TIMEOUT: Duration = Duration::from_millis(SESSION_TIMEOUT_MS as u64);
/// Backstop for an open whose request cannot even be sent (the socket's send
/// buffer stays full), which libssh2's reply timeout does not cover.
const OPEN_DEADLINE: Duration = Duration::from_secs(SESSION_TIMEOUT_MS as u64 / 1000 + 5);
/// What to tell the user about a remote forward's listen request that failed.
/// Only a denied request is the server's decision; the rest is the connection.
fn listen_error_message(server: &str, port: u16, error: &ssh2::Error) -> String {
    match error.code() {
        ErrorCode::Session(LIBSSH2_ERROR_REQUEST_DENIED) => format!(
            "SSH server {} refused to listen on port {}. The port may be in use, \
             or the server's AllowTcpForwarding may not allow it.",
            server, port
        ),
        ErrorCode::Session(LIBSSH2_ERROR_TIMEOUT) => format!(
            "Timed out asking SSH server {} to listen on port {}. Check the connection to it.",
            server, port
        ),
        _ => format!(
            "Lost the connection to SSH server {} while asking it to listen on port {}: {}",
            server, port, error
        ),
    }
}

/// What to tell the user about a channel open that failed. libssh2 gives
/// running out of time no message of its own ("Unexpected error").
fn open_error_message(error: &ssh2::Error, host: &str, port: u16) -> String {
    if error.code() == ErrorCode::Session(LIBSSH2_ERROR_TIMEOUT) {
        format!("timed out opening a channel to {}:{}", host, port)
    } else {
        error.to_string()
    }
}

/// A channel type no server implements, for [`Uplink::probe`].
const PROBE_CHANNEL_TYPE: &str = "ssix-probe@ssix.invalid";

/// How long a SOCKS client gets for each step of its handshake.
const SOCKS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Longest the supervisor sleeps while clients are connected, so it notices
/// the last one leaving and starts watching the session's socket.
const CLIENTS_TICK: Duration = Duration::from_millis(250);
/// The same for a remote forward, where a client's read can also pull in the
/// next `forwarded-tcpip` connection without the socket ever waking anyone.
const REMOTE_CLIENTS_TICK: Duration = Duration::from_millis(20);

/// How often a forward checks on its session, and how much silence it takes.
#[derive(Clone, Copy)]
struct Timing {
    probe_interval: Duration,
    /// Probes in a row the server may leave unanswered, like `ssh`'s
    /// `ServerAliveCountMax`: a short outage must not end a forward.
    max_missed_probes: u32,
    /// How long clients get to close their channels before the session goes.
    client_drain: Duration,
}

const TIMING: Timing = Timing {
    probe_interval: Duration::from_secs(30),
    max_missed_probes: 3,
    client_drain: Duration::from_secs(3),
};

/// Status payload a forward emits on `ssix:forward:status:{id}`. `listen_port`
/// is on this machine for a local or dynamic forward, on the SSH server for a
/// remote one. Mirrored by `ForwardStatus` in `src/store/usePortForwardsStore.ts`.
#[derive(Serialize, Clone)]
pub struct ForwardStatus {
    /// "listening" | "client_connected" | "client_closed" | "client_error"
    /// (one client could not be served; the forward goes on) | "error" (the
    /// forward ended; the same message follows on the output channel).
    pub state: &'static str,
    pub listen_port: u16,
    pub destination: String,
    pub message: Option<String>,
    pub active_clients: usize,
}

/// Event names are namespaced under `ssix:` and mirrored in
/// `src/lib/events.ts`; both sides MUST go through these helpers.
pub(crate) fn forward_status_event(session_id: &str) -> String {
    format!("ssix:forward:status:{}", session_id)
}

/// Where a forward reports to: the app, through [`SessionContext`], or a
/// recorder in tests, which have no Tauri runtime to build a context from.
pub(crate) trait ForwardEvents: Send + Sync + 'static {
    /// Put the session in the registry before its supervisor starts.
    fn register(&self, handle: SessionHandle) -> Result<(), String>;
    fn status(&self, status: ForwardStatus);
    fn log(&self, level: &str, message: String);
    /// The forward is over and nothing follows. `error` says why when it
    /// was not asked to stop.
    fn ended(&self, error: Option<String>);
}

impl ForwardEvents for SessionContext {
    fn register(&self, handle: SessionHandle) -> Result<(), String> {
        SessionContext::register(self, handle)
    }

    fn status(&self, status: ForwardStatus) {
        let _ = self
            .app
            .emit(&forward_status_event(&self.session_id), status);
    }

    fn log(&self, level: &str, message: String) {
        let message = format!("session {}: {}", self.session_id, message);
        SessionContext::log(self, level, "forward", message);
    }

    fn ended(&self, error: Option<String>) {
        if let Some(message) = error {
            self.emit_error(message);
        }
        self.finish();
    }
}

/// The local sockets of a forward's clients, so ending the forward can reach
/// clients busy on their own threads: shutting down its socket makes
/// [`forward_bidi`] see EOF, close the channel and return.
#[derive(Default)]
struct ClientSet {
    sockets: DashMap<u64, TcpStream>,
    next_id: AtomicU64,
    closed: AtomicBool,
}

/// A client's place in the [`ClientSet`], given up when the client is done.
struct ClientSlot<'a> {
    set: &'a ClientSet,
    id: u64,
}

impl Drop for ClientSlot<'_> {
    fn drop(&mut self) {
        self.set.sockets.remove(&self.id);
    }
}

impl ClientSet {
    /// Add a client's socket. `None` means the forward is ending, or the
    /// socket could not be duplicated: the caller drops the client.
    fn register(&self, stream: &TcpStream) -> Option<ClientSlot<'_>> {
        let clone = stream.try_clone().ok()?;
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        self.sockets.insert(id, clone);
        // Checked after the insert: `close_all` sets the flag before walking
        // the set, so a client either is seen there or sees the flag here.
        if self.closed.load(Ordering::SeqCst) {
            self.sockets.remove(&id);
            return None;
        }
        Some(ClientSlot { set: self, id })
    }

    fn close_all(&self) {
        self.closed.store(true, Ordering::SeqCst);
        for socket in self.sockets.iter() {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }
}

/// Free a channel under the session's lock. `ssh2` frees channels without
/// taking it (see `ChannelInner`'s `Drop`), yet `libssh2_channel_free` sends
/// packets and changes the session's state. On a session other threads are
/// using, that corrupts the stream: the server reports "Bad packet length"
/// and drops the connection, and every client with it.
fn free_channel(session: &Session, channel: Channel) {
    let _locked = session.raw();
    drop(channel);
}

/// Close a channel no client will use.
fn discard_channel(session: &Session, mut channel: Channel) {
    close_channel(&mut channel);
    free_channel(session, channel);
}

/// Counts as reading the session for as long as it is held.
struct SessionReader<'a>(&'a AtomicUsize);

impl Drop for SessionReader<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// What a forward's supervisor and client threads share.
struct Hub {
    clients: ClientSet,
    /// Clients with a tunnel up, as reported to the frontend.
    active: AtomicUsize,
    /// How many read the session, for [`forward_bidi`], whose socket wait
    /// misses packets another reader took in: the tunnels, clients opening a
    /// channel, a probe, and the supervisor of a remote forward, which reads
    /// it to accept.
    session_readers: AtomicUsize,
    /// Client threads still running, whatever stage they are at.
    in_flight: AtomicUsize,
    events: Box<dyn ForwardEvents>,
    listen_port: u16,
    destination: String,
}

impl Hub {
    fn new(
        events: Box<dyn ForwardEvents>,
        listen_port: u16,
        destination: String,
        session_readers: usize,
    ) -> Self {
        Self {
            clients: ClientSet::default(),
            active: AtomicUsize::new(0),
            session_readers: AtomicUsize::new(session_readers),
            in_flight: AtomicUsize::new(0),
            events,
            listen_port,
            destination,
        }
    }

    fn status(&self, state: &'static str, message: Option<String>) {
        self.events.status(ForwardStatus {
            state,
            listen_port: self.listen_port,
            destination: self.destination.clone(),
            message,
            active_clients: self.active.load(Ordering::SeqCst),
        });
    }

    fn reading_session(&self) -> SessionReader<'_> {
        self.session_readers.fetch_add(1, Ordering::SeqCst);
        SessionReader(&self.session_readers)
    }

    fn spawn_client(self: &Arc<Self>, work: impl FnOnce(&Hub) + Send + 'static) {
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        let hub = Arc::clone(self);
        thread::spawn(move || {
            work(&hub);
            hub.in_flight.fetch_sub(1, Ordering::SeqCst);
        });
    }

    /// Carry a client's bytes until either side closes or the forward ends.
    fn tunnel(&self, local: TcpStream, channel: Channel, session: &Session, label: String) {
        self.active.fetch_add(1, Ordering::SeqCst);
        let reading = self.reading_session();
        self.status("client_connected", Some(label.clone()));
        // `forward_bidi` takes the channel; this handle makes the free below
        // the one that counts.
        let last_handle = channel.clone();
        forward_bidi(local, channel, session, &self.session_readers);
        free_channel(session, last_handle);
        drop(reading);
        self.active.fetch_sub(1, Ordering::SeqCst);
        self.status("client_closed", Some(label));
    }
}

/// What the supervisor learned by asking the server for a reply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Probe {
    Alive,
    /// The server did not answer in time. It may still come back.
    NoReply,
    /// The connection is gone.
    Dead,
    /// A client is opening a channel, which only one thread can do at a
    /// time, and which reads the session like a probe would.
    Busy,
    /// The frontend asked the forward to stop in the meantime.
    Stopped,
}

/// What the supervisor needs from the SSH session.
trait Uplink: Send + Sync + 'static {
    /// The session's socket, to sleep on while no client reads the session.
    fn fd(&self) -> wake::Fd;
    /// `host:port` of the server, for messages.
    fn server(&self) -> &str;
    /// Whether the server sent something nobody has read yet, EOF included.
    fn has_input(&self) -> bool;
    /// Make a round trip to the server, reading everything it sent so far.
    fn probe(&self, control: &ControlRx) -> Probe;
    /// End the connection, making every call still blocked on it return.
    fn close(&self);
}

/// Whether the peer sent data or closed the connection. Errors count too:
/// reading the socket is what reports them.
fn socket_has_input(socket: &TcpStream) -> bool {
    match socket.peek(&mut [0u8; 1]) {
        Err(e) => !matches!(
            e.kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
        ),
        Ok(_) => true,
    }
}

extern "C" {
    /// In libssh2 since 1.10.1; neither `ssh2` nor `libssh2-sys` wraps it.
    fn libssh2_session_set_read_timeout(session: *mut c_void, timeout: c_long);
}

/// Limit how long libssh2 waits for the reply to a request (60 s by default).
fn set_reply_timeout(session: &Session, timeout: Duration) {
    let mut raw = session.raw();
    // SAFETY: the guard keeps the session pointer valid and locked for the
    // call, which only stores the value in the session.
    unsafe {
        libssh2_session_set_read_timeout(
            &mut *raw as *mut _ as *mut c_void,
            timeout.as_secs() as c_long,
        );
    }
}

/// A forward's SSH session, shared by its supervisor and its client threads.
struct SshUplink {
    session: Session,
    /// The session's socket, for what `ssh2` does not offer: looking for
    /// input without consuming it, and cutting the connection.
    socket: TcpStream,
    /// Held while opening a channel. libssh2 keeps a channel open's progress
    /// in the session, not the channel, so a second open made on a
    /// non-blocking session while one is waiting takes over the first's
    /// request and returns its channel. For a SOCKS client that means
    /// getting connected to where another client asked to go.
    opens: Mutex<()>,
    server: String,
}

impl SshUplink {
    /// Connect and authenticate. The session is still in blocking mode.
    fn connect(gateway: &Endpoint, verbosity: u8) -> Result<Self, String> {
        let server = gateway.addr();
        let fail = |e: String| format!("SSH server {}: {}", server, e);
        SshDebug::new(verbosity, gateway.addr()).at(1, || format!("Using ssh server {}", server));
        let tcp = connect_endpoint(gateway, verbosity).map_err(fail)?;
        let socket = tcp.try_clone().map_err(|e| fail(e.to_string()))?;
        let session =
            open_authenticated_session_over_stream(tcp, gateway, verbosity, None).map_err(fail)?;
        socket
            .set_nonblocking(true)
            .map_err(|e| fail(e.to_string()))?;
        set_reply_timeout(&session, OPEN_REPLY_TIMEOUT);
        Ok(Self {
            session,
            socket,
            opens: Mutex::new(()),
            server,
        })
    }

    /// Open a `direct-tcpip` channel on the non-blocking session, waiting for
    /// the socket whenever libssh2 asks to be called again.
    ///
    /// An open is never given up half way, since the next one would inherit
    /// it (see `opens`). libssh2 ends it itself when the server takes longer
    /// than [`OPEN_REPLY_TIMEOUT`], and that bounds how long a destination
    /// that never answers holds up everyone else's opens. If even that does
    /// not end it, the session is unusable and is cut here.
    fn open_direct(
        &self,
        hub: &Hub,
        destination_host: &str,
        destination_port: u16,
        peer: SocketAddr,
    ) -> Result<Channel, ssh2::Error> {
        let _open = self.opens.lock().unwrap_or_else(|e| e.into_inner());
        let _reading = hub.reading_session();
        let deadline = Instant::now() + OPEN_DEADLINE;
        let fds = [wake::fd_of(&self.socket)];
        let peer_ip = peer.ip().to_string();
        loop {
            match self.session.channel_direct_tcpip(
                destination_host,
                destination_port,
                Some((&peer_ip, peer.port())),
            ) {
                Err(e) if is_eagain(&e) => {
                    if Instant::now() >= deadline {
                        let _ = self.socket.shutdown(Shutdown::Both);
                        return Err(ssh2::Error::new(
                            ErrorCode::Session(LIBSSH2_ERROR_TIMEOUT),
                            "timed out",
                        ));
                    }
                    wake::wait_readable(&fds, Duration::from_millis(50));
                }
                result => return result,
            }
        }
    }
}

impl Uplink for SshUplink {
    fn fd(&self) -> wake::Fd {
        wake::fd_of(&self.socket)
    }

    fn server(&self) -> &str {
        &self.server
    }

    fn has_input(&self) -> bool {
        socket_has_input(&self.socket)
    }

    /// `ssh2` has no way to just read a session, and a global request's reply
    /// cannot be waited for, so this opens a channel of a type no server
    /// knows. RFC 4254 has the server refuse it with `CHANNEL_OPEN_FAILURE`:
    /// a round trip that leaves nothing behind on the server, unlike a
    /// session channel, which `MaxSessions 0` would also refuse. Waiting for
    /// the reply reads and handles everything the server sent before it.
    fn probe(&self, control: &ControlRx) -> Probe {
        let _open = match self.opens.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::Poisoned(e)) => e.into_inner(),
            Err(TryLockError::WouldBlock) => return Probe::Busy,
        };
        let deadline = Instant::now() + OPEN_DEADLINE;
        let fds = [self.fd(), control.wake.fd()];
        loop {
            match self
                .session
                .channel_open(PROBE_CHANNEL_TYPE, 2 * 1024 * 1024, 32 * 1024, None)
            {
                // A server that took it answered all the same.
                Ok(channel) => {
                    free_channel(&self.session, channel);
                    return Probe::Alive;
                }
                Err(e) if is_eagain(&e) => {}
                Err(e) => {
                    return match e.code() {
                        ErrorCode::Session(LIBSSH2_ERROR_CHANNEL_FAILURE) => Probe::Alive,
                        ErrorCode::Session(LIBSSH2_ERROR_TIMEOUT) => Probe::NoReply,
                        _ => Probe::Dead,
                    }
                }
            }
            // Cannot even send: this open will never end, and the session
            // cannot be used again with one left behind.
            if Instant::now() >= deadline {
                return Probe::Dead;
            }
            wake::wait_readable(&fds, Duration::from_millis(50));
            // In this order: a stop that lands after the drain leaves its wake
            // for the next wait, and one before it is seen by the check.
            control.wake.drain();
            if stop_requested(control) {
                return Probe::Stopped;
            }
        }
    }

    fn close(&self) {
        let deadline = Instant::now() + Duration::from_millis(500);
        while matches!(
            self.session.disconnect(None, "Forward stopped", None),
            Err(ref e) if is_eagain(e) && Instant::now() < deadline
        ) {
            wake::wait_writable(self.fd(), Duration::from_millis(50));
        }
        let _ = self.socket.shutdown(Shutdown::Both);
        // On a non-blocking session libssh2 gives up on freeing the session
        // the moment it would block, and leaks it. Nothing blocks any more:
        // the socket is shut down.
        self.session.set_blocking(true);
    }
}

type ServeTcp = Arc<dyn Fn(&Hub, TcpStream, SocketAddr) + Send + Sync>;
type ServeChannel = Arc<dyn Fn(&Hub, Channel) + Send + Sync>;

/// Where a forward's clients come from, and what serves each one.
enum Incoming {
    /// A local or dynamic forward: a socket on this machine.
    Tcp {
        listener: TcpListener,
        serve: ServeTcp,
    },
    /// A remote forward: the server's port, through the session.
    Ssh {
        listener: ssh2::Listener,
        serve: ServeChannel,
    },
    /// Clients found only by asking, like `Ssh`, which needs a real session.
    #[cfg(test)]
    Queued {
        waiting: Arc<AtomicUsize>,
        accepted: Arc<AtomicUsize>,
    },
}

impl Incoming {
    /// Start a thread for everyone waiting. An error ends the forward.
    fn accept_all(&mut self, hub: &Arc<Hub>) -> Result<(), String> {
        match self {
            Incoming::Tcp { listener, serve } => loop {
                match listener.accept() {
                    Ok((stream, peer)) => {
                        let serve = Arc::clone(serve);
                        hub.spawn_client(move |hub| serve(hub, stream, peer));
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(()),
                    Err(e)
                        if matches!(
                            e.kind(),
                            io::ErrorKind::Interrupted | io::ErrorKind::ConnectionAborted
                        ) => {}
                    Err(e) => return Err(format!("accept failed: {}", e)),
                }
            },
            Incoming::Ssh { listener, serve } => loop {
                match listener.accept() {
                    Ok(channel) => {
                        let serve = Arc::clone(serve);
                        hub.spawn_client(move |hub| serve(hub, channel));
                    }
                    // libssh2 only says "nothing queued", also when the read
                    // behind it failed; the probe decides about the session.
                    Err(_) => return Ok(()),
                }
            },
            #[cfg(test)]
            Incoming::Queued { waiting, accepted } => {
                accepted.fetch_add(waiting.swap(0, Ordering::SeqCst), Ordering::SeqCst);
                Ok(())
            }
        }
    }

    /// The socket that wakes the supervisor for a new client, if there is one
    /// of its own.
    fn fd(&self) -> Option<wake::Fd> {
        match self {
            Incoming::Tcp { listener, .. } => Some(wake::fd_of(listener)),
            _ => None,
        }
    }

    fn clients_tick(&self) -> Duration {
        match self {
            Incoming::Tcp { .. } => CLIENTS_TICK,
            _ => REMOTE_CLIENTS_TICK,
        }
    }
}

/// Whether the frontend asked this forward to stop, or dropped its handle.
fn stop_requested(control: &ControlRx) -> bool {
    loop {
        match control.rx.try_recv() {
            Ok(SessionMsg::Disconnect) | Err(TryRecvError::Disconnected) => return true,
            Ok(_) => {}
            Err(TryRecvError::Empty) => return false,
        }
    }
}

/// Accept clients and watch the session until the forward has to end, then
/// take everything down. See the module documentation.
fn supervise<U: Uplink>(
    hub: Arc<Hub>,
    uplink: Arc<U>,
    mut incoming: Incoming,
    control: ControlRx,
    timing: Timing,
) {
    hub.status("listening", None);
    let lost = || format!("Lost the connection to the SSH server {}", uplink.server());
    let mut next_probe = Instant::now() + timing.probe_interval;
    let mut missed_probes = 0;
    let failure = loop {
        if stop_requested(&control) {
            break None;
        }
        if let Err(e) = incoming.accept_all(&hub) {
            break Some(e);
        }

        // While clients are connected they read the session, and they would
        // wake this thread for every packet: look at the socket only without
        // them, and at intervals otherwise.
        let idle = hub.in_flight.load(Ordering::SeqCst) == 0;
        if Instant::now() >= next_probe || (idle && uplink.has_input()) {
            let answer = {
                let _reading = hub.reading_session();
                uplink.probe(&control)
            };
            match answer {
                Probe::Alive => {
                    missed_probes = 0;
                    next_probe = Instant::now() + timing.probe_interval;
                }
                Probe::NoReply => {
                    missed_probes += 1;
                    if missed_probes >= timing.max_missed_probes {
                        break Some(format!(
                            "The SSH server {} stopped responding",
                            uplink.server()
                        ));
                    }
                    next_probe = Instant::now();
                }
                Probe::Dead => break Some(lost()),
                Probe::Busy => {}
                Probe::Stopped => break None,
            }
            // The probe read the session, which can have queued a remote
            // forward's connection with nothing left on the socket to wake
            // this thread for it.
            if let Err(e) = incoming.accept_all(&hub) {
                break Some(e);
            }
        }

        // Looked at again: that can have started a client.
        let idle = hub.in_flight.load(Ordering::SeqCst) == 0;
        let mut fds = vec![control.wake.fd()];
        fds.extend(incoming.fd());
        let timeout = if idle {
            fds.push(uplink.fd());
            next_probe.saturating_duration_since(Instant::now())
        } else {
            incoming.clients_tick()
        };
        wake::wait_readable(&fds, timeout);
        control.wake.drain();
    };

    // The port first, so nobody new arrives. For a remote forward this tells
    // the server to stop listening.
    drop(incoming);
    hub.clients.close_all();
    let drained = Instant::now() + timing.client_drain;
    while hub.in_flight.load(Ordering::SeqCst) > 0 && Instant::now() < drained {
        thread::sleep(Duration::from_millis(10));
    }
    uplink.close();

    if let Some(reason) = &failure {
        hub.events.log("error", reason.clone());
        hub.status("error", Some(reason.clone()));
    }
    hub.events.ended(failure);
}

/// Register the forward and start its supervisor.
fn launch<E: ForwardEvents>(
    uplink: Arc<SshUplink>,
    incoming: Incoming,
    listen_port: u16,
    destination: String,
    session_readers: usize,
    events: E,
) -> Result<SessionHandle, String> {
    let (handle, control) = control_channel()?;
    events.register(handle.clone())?;
    // Non-blocking so one slow client can never stall the others: libssh2
    // serialises every call made on a session.
    uplink.session.set_blocking(false);
    let hub = Arc::new(Hub::new(
        Box::new(events),
        listen_port,
        destination,
        session_readers,
    ));
    thread::spawn(move || supervise(hub, uplink, incoming, control, TIMING));
    Ok(handle)
}

/// Bind the local end of a local or dynamic forward: loopback only.
fn bind_loopback(port: u16) -> Result<TcpListener, String> {
    let fail = |e: io::Error| format!("Failed to bind 127.0.0.1:{}: {}", port, e);
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).map_err(fail)?;
    listener.set_nonblocking(true).map_err(fail)?;
    Ok(listener)
}

/// Listen on `127.0.0.1:local_port` and forward every accepted connection
/// through the SSH server `gateway` to `destination_host:destination_port`
/// (`ssh -L`). Bind and SSH server errors are returned synchronously.
pub(crate) fn start_port_forward<E: ForwardEvents>(
    gateway: Endpoint,
    local_port: u16,
    destination_host: String,
    destination_port: u16,
    verbosity: u8,
    events: E,
) -> Result<SessionHandle, String> {
    let listener = bind_loopback(local_port)?;
    let uplink = Arc::new(SshUplink::connect(&gateway, verbosity)?);
    let debug = SshDebug::new(verbosity, gateway.addr());
    debug.at(1, || {
        format!(
            "Local forwarding listening on 127.0.0.1 port {}.",
            local_port
        )
    });
    let destination = format!("{}:{}", destination_host, destination_port);
    let serve: ServeTcp = {
        let uplink = Arc::clone(&uplink);
        Arc::new(move |hub, stream, peer| {
            let Some(_slot) = hub.clients.register(&stream) else {
                return;
            };
            debug.at(1, || {
                format!(
                    "Connection to port {} forwarding to {} port {} requested.",
                    local_port, destination_host, destination_port
                )
            });
            match uplink.open_direct(hub, &destination_host, destination_port, peer) {
                Ok(channel) => {
                    let label = format!("from {}", peer);
                    hub.tunnel(stream, channel, &uplink.session, label);
                    debug.at(2, || format!("Forwarded connection from {} closed.", peer));
                }
                Err(e) => hub.status(
                    "client_error",
                    Some(format!(
                        "channel_direct_tcpip failed: {}",
                        open_error_message(&e, &destination_host, destination_port)
                    )),
                ),
            }
        })
    };
    let incoming = Incoming::Tcp { listener, serve };
    launch(uplink, incoming, local_port, destination, 0, events)
}

/// Run a SOCKS5 proxy on `127.0.0.1:local_port` (`ssh -D`): each client names
/// a destination, which the SSH server `gateway` connects to and resolves if
/// it is a name. Bind and SSH server errors are returned synchronously.
pub(crate) fn start_dynamic_forward<E: ForwardEvents>(
    gateway: Endpoint,
    local_port: u16,
    verbosity: u8,
    events: E,
) -> Result<SessionHandle, String> {
    let listener = bind_loopback(local_port)?;
    let uplink = Arc::new(SshUplink::connect(&gateway, verbosity)?);
    let debug = SshDebug::new(verbosity, gateway.addr());
    debug.at(1, || {
        format!(
            "Dynamic forwarding (SOCKS5) listening on 127.0.0.1 port {}.",
            local_port
        )
    });
    let serve: ServeTcp = {
        let uplink = Arc::clone(&uplink);
        Arc::new(move |hub, stream, peer| serve_socks_client(hub, &uplink, stream, peer, &debug))
    };
    let incoming = Incoming::Tcp { listener, serve };
    launch(uplink, incoming, local_port, "SOCKS".to_string(), 0, events)
}

fn serve_socks_client(
    hub: &Hub,
    uplink: &SshUplink,
    mut stream: TcpStream,
    peer: SocketAddr,
    debug: &SshDebug,
) {
    let Some(_slot) = hub.clients.register(&stream) else {
        return;
    };
    // An accepted socket inherits a non-blocking listener's mode on BSD and
    // macOS, and the handshake reads it step by step.
    let blocking = stream
        .set_nonblocking(false)
        .and_then(|()| stream.set_read_timeout(Some(SOCKS_HANDSHAKE_TIMEOUT)))
        .and_then(|()| stream.set_write_timeout(Some(SOCKS_HANDSHAKE_TIMEOUT)));
    if blocking.is_err() {
        return;
    }

    let target = match socks5::negotiate(&mut stream) {
        Ok(target) => target,
        Err(why) => {
            debug.at(1, || format!("SOCKS client {}: {}", peer, why));
            hub.status("client_error", Some(format!("from {}: {}", peer, why)));
            socks5::close_gracefully(&stream);
            return;
        }
    };
    debug.at(1, || {
        format!("SOCKS client {} connecting to {}.", peer, target)
    });

    let channel = match uplink.open_direct(hub, &target.host, target.port, peer) {
        Ok(channel) => channel,
        Err(e) => {
            let _ = socks5::write_reply(&mut stream, socks5::reply_for_open_error(&e));
            hub.status(
                "client_error",
                Some(format!(
                    "from {} to {}: {}",
                    peer,
                    target,
                    open_error_message(&e, &target.host, target.port)
                )),
            );
            socks5::close_gracefully(&stream);
            return;
        }
    };
    if socks5::write_reply(&mut stream, socks5::Reply::Succeeded).is_err() {
        discard_channel(&uplink.session, channel);
        return;
    }
    let label = format!("from {} to {}", peer, target);
    hub.tunnel(stream, channel, &uplink.session, label);
    debug.at(2, || format!("SOCKS connection from {} closed.", peer));
}

/// Ask the SSH server `gateway` to listen on its loopback at `remote_port`
/// and connect every connection it accepts to
/// `destination_host:destination_port` on this side (`ssh -R`). The server's
/// refusal is returned synchronously, like `ExitOnForwardFailure`.
pub(crate) fn start_remote_forward<E: ForwardEvents>(
    gateway: Endpoint,
    remote_port: u16,
    destination_host: String,
    destination_port: u16,
    verbosity: u8,
    events: E,
) -> Result<SessionHandle, String> {
    let uplink = Arc::new(SshUplink::connect(&gateway, verbosity)?);
    let (listener, _) = uplink
        .session
        .channel_forward_listen(remote_port, Some(REMOTE_BIND_ADDRESS), None)
        .map_err(|e| listen_error_message(&gateway.addr(), remote_port, &e))?;
    let debug = SshDebug::new(verbosity, gateway.addr());
    debug.at(1, || {
        format!(
            "Remote forwarding listening on {} port {} of the server.",
            REMOTE_BIND_ADDRESS, remote_port
        )
    });
    let destination = format!("{}:{}", destination_host, destination_port);
    let serve: ServeChannel = {
        let uplink = Arc::clone(&uplink);
        let destination = destination.clone();
        Arc::new(move |hub, channel| {
            debug.at(1, || {
                format!(
                    "Connection on remote port {} forwarding to {}.",
                    remote_port, destination
                )
            });
            let local = match connect_tcp(&destination_host, destination_port) {
                Ok(local) => local,
                Err(e) => {
                    discard_channel(&uplink.session, channel);
                    hub.status("client_error", Some(e));
                    return;
                }
            };
            let Some(_slot) = hub.clients.register(&local) else {
                discard_channel(&uplink.session, channel);
                return;
            };
            let label = format!("to {}", destination);
            hub.tunnel(local, channel, &uplink.session, label);
            debug.at(2, || {
                format!("Connection on remote port {} closed.", remote_port)
            });
        })
    };
    let incoming = Incoming::Ssh { listener, serve };
    // The supervisor reads the session to accept, even with no client on it.
    launch(uplink, incoming, remote_port, destination, 1, events)
}

/// A recorder in place of the app, for the tests here.
#[cfg(test)]
mod test_support {
    use super::*;

    #[derive(Default)]
    pub(super) struct Recorder {
        pub(super) statuses: Mutex<Vec<ForwardStatus>>,
        pub(super) ended: Mutex<Option<Option<String>>>,
    }

    impl Recorder {
        pub(super) fn ended_with(&self) -> Option<Option<String>> {
            self.ended.lock().unwrap().clone()
        }

        pub(super) fn saw(&self, state: &str) -> bool {
            self.statuses
                .lock()
                .unwrap()
                .iter()
                .any(|s| s.state == state)
        }
    }

    impl ForwardEvents for Arc<Recorder> {
        fn register(&self, _handle: SessionHandle) -> Result<(), String> {
            Ok(())
        }
        fn status(&self, status: ForwardStatus) {
            self.statuses.lock().unwrap().push(status);
        }
        fn log(&self, _level: &str, _message: String) {}
        fn ended(&self, error: Option<String>) {
            *self.ended.lock().unwrap() = Some(error);
        }
    }

    /// Poll `condition` until it holds, or fail after `timeout`.
    pub(super) fn wait_for(what: &str, timeout: Duration, condition: impl Fn() -> bool) {
        let deadline = Instant::now() + timeout;
        while !condition() {
            assert!(Instant::now() < deadline, "timed out waiting for {}", what);
            thread::sleep(Duration::from_millis(5));
        }
    }

    pub(super) fn port_is_closed(port: u16) -> bool {
        TcpStream::connect(("127.0.0.1", port)).is_err()
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use std::collections::VecDeque;
    use std::io::{Read, Write};

    const SOON: Duration = Duration::from_secs(5);
    /// Long enough that a test finishing in time did not rely on a probe.
    const NEVER: Duration = Duration::from_secs(3600);

    fn timing(probe_interval: Duration) -> Timing {
        Timing {
            probe_interval,
            max_missed_probes: 3,
            client_drain: Duration::from_secs(2),
        }
    }

    fn socket_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let a = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (b, _) = listener.accept().unwrap();
        (a, b)
    }

    /// A session whose server is the other end of a socket pair: dropping
    /// that end looks like the server closing the connection. Probes answer
    /// from a script, then with `Alive`.
    struct FakeUplink {
        socket: TcpStream,
        script: Mutex<VecDeque<Probe>>,
        probes: AtomicUsize,
        closed: AtomicBool,
        /// Runs inside every probe, where the real one reads the session.
        on_probe: ProbeHook,
    }

    type ProbeHook = Mutex<Box<dyn FnMut(&TcpStream) + Send>>;

    impl FakeUplink {
        fn new(socket: TcpStream, script: &[Probe]) -> Self {
            socket.set_nonblocking(true).unwrap();
            Self {
                socket,
                script: Mutex::new(script.iter().copied().collect()),
                probes: AtomicUsize::new(0),
                closed: AtomicBool::new(false),
                on_probe: Mutex::new(Box::new(|_| {})),
            }
        }
    }

    /// Run `supervise` over `uplink` and `incoming`, for the tests that need
    /// more of either than a [`Fixture`] offers.
    fn supervised(
        uplink: &Arc<FakeUplink>,
        incoming: Incoming,
        timing: Timing,
    ) -> (Arc<Hub>, Arc<Recorder>, SessionHandle) {
        let events = Arc::new(Recorder::default());
        let hub = Arc::new(Hub::new(
            Box::new(Arc::clone(&events)),
            0,
            "test".to_string(),
            0,
        ));
        let (handle, control) = control_channel().unwrap();
        {
            let hub = Arc::clone(&hub);
            let uplink = Arc::clone(uplink);
            thread::spawn(move || supervise(hub, uplink, incoming, control, timing));
        }
        (hub, events, handle)
    }

    impl Uplink for FakeUplink {
        fn fd(&self) -> wake::Fd {
            wake::fd_of(&self.socket)
        }
        fn server(&self) -> &str {
            "fake:22"
        }
        fn has_input(&self) -> bool {
            socket_has_input(&self.socket)
        }
        fn probe(&self, _control: &ControlRx) -> Probe {
            self.probes.fetch_add(1, Ordering::SeqCst);
            (self.on_probe.lock().unwrap())(&self.socket);
            if matches!(self.socket.peek(&mut [0u8; 1]), Ok(0)) {
                return Probe::Dead;
            }
            self.script
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Probe::Alive)
        }
        fn close(&self) {
            self.closed.store(true, Ordering::SeqCst);
        }
    }

    /// A forward over a [`FakeUplink`]. Its clients behave like tunnels:
    /// they stay on their thread until their socket closes.
    struct Fixture {
        events: Arc<Recorder>,
        uplink: Arc<FakeUplink>,
        server_end: Option<TcpStream>,
        handle: Option<SessionHandle>,
        port: u16,
        clients_served: Arc<AtomicUsize>,
    }

    impl Fixture {
        fn start(timing: Timing, script: &[Probe]) -> Self {
            let listener = bind_loopback(0).unwrap();
            let port = listener.local_addr().unwrap().port();
            let (socket, server_end) = socket_pair();
            let uplink = Arc::new(FakeUplink::new(socket, script));
            let clients_served = Arc::new(AtomicUsize::new(0));
            let serve: ServeTcp = {
                let clients_served = Arc::clone(&clients_served);
                Arc::new(move |hub, mut stream, _peer| {
                    let Some(_slot) = hub.clients.register(&stream) else {
                        return;
                    };
                    stream.set_nonblocking(false).unwrap();
                    clients_served.fetch_add(1, Ordering::SeqCst);
                    let mut sink = [0u8; 64];
                    while matches!(stream.read(&mut sink), Ok(n) if n > 0) {}
                })
            };
            let events = Arc::new(Recorder::default());
            let hub = Arc::new(Hub::new(
                Box::new(Arc::clone(&events)),
                port,
                "test".to_string(),
                0,
            ));
            let (handle, control) = control_channel().unwrap();
            {
                let uplink = Arc::clone(&uplink);
                let incoming = Incoming::Tcp { listener, serve };
                thread::spawn(move || supervise(hub, uplink, incoming, control, timing));
            }
            Self {
                events,
                uplink,
                server_end: Some(server_end),
                handle: Some(handle),
                port,
                clients_served,
            }
        }

        /// A client the forward has accepted and is now serving.
        fn connected_client(&self) -> TcpStream {
            let served = self.clients_served.load(Ordering::SeqCst);
            let client = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
            client.set_read_timeout(Some(SOON)).unwrap();
            wait_for("the forward to serve the client", SOON, || {
                self.clients_served.load(Ordering::SeqCst) > served
            });
            client
        }

        fn wait_for_end(&self) -> Option<String> {
            wait_for("the forward to end", SOON, || {
                self.events.ended_with().is_some()
            });
            self.events.ended_with().unwrap()
        }

        fn kill_server(&mut self) {
            self.server_end = None;
        }
    }

    /// The bytes a client gets once the forward drops it: EOF, or a reset.
    fn assert_dropped(client: &mut TcpStream) {
        let mut buf = [0u8; 16];
        match client.read(&mut buf) {
            Ok(0) => {}
            Err(e) => assert!(
                !matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ),
                "the client is still connected: {}",
                e
            ),
            Ok(n) => panic!("unexpected {} bytes", n),
        }
    }

    #[test]
    fn stopping_drops_tunnelling_clients_and_closes_the_port() {
        let f = Fixture::start(timing(NEVER), &[]);
        let mut first = f.connected_client();
        let mut second = f.connected_client();

        let handle = f.handle.as_ref().unwrap();
        handle.send(SessionMsg::Disconnect).unwrap();

        assert_dropped(&mut first);
        assert_dropped(&mut second);
        assert_eq!(f.wait_for_end(), None);
        assert!(port_is_closed(f.port));
        assert!(f.uplink.closed.load(Ordering::SeqCst));
        assert!(!f.events.saw("error"));
    }

    #[test]
    fn messages_other_than_a_disconnect_mean_nothing_to_a_forward() {
        let f = Fixture::start(timing(NEVER), &[]);
        let handle = f.handle.as_ref().unwrap();
        handle
            .send(SessionMsg::Resize { cols: 1, rows: 1 })
            .unwrap();
        handle.send(SessionMsg::Write(vec![1])).unwrap();
        let _still_accepting = f.connected_client();
        assert_eq!(f.events.ended_with(), None);
    }

    #[test]
    fn a_dropped_handle_stops_the_forward_like_a_disconnect() {
        let mut f = Fixture::start(timing(NEVER), &[]);
        let mut client = f.connected_client();
        f.handle = None;
        assert_dropped(&mut client);
        assert_eq!(f.wait_for_end(), None);
    }

    /// With no client and no probe due, only the socket can wake the forward.
    #[test]
    fn an_idle_forward_ends_as_soon_as_the_server_closes_the_connection() {
        let mut f = Fixture::start(timing(NEVER), &[]);
        f.kill_server();

        let reason = f.wait_for_end().expect("a reason for the frontend");
        assert!(reason.contains("Lost the connection"), "{}", reason);
        assert!(port_is_closed(f.port));
        assert!(f.uplink.closed.load(Ordering::SeqCst));
        assert!(f.events.saw("error"));
    }

    #[test]
    fn a_forward_with_clients_notices_a_dead_session_at_the_next_probe() {
        let mut f = Fixture::start(timing(Duration::from_millis(50)), &[]);
        let mut client = f.connected_client();
        f.kill_server();

        let reason = f.wait_for_end().expect("a reason for the frontend");
        assert!(reason.contains("Lost the connection"), "{}", reason);
        assert_dropped(&mut client);
    }

    #[test]
    fn only_a_denied_listen_request_blames_the_server() {
        let message = |code: i32| {
            listen_error_message(
                "bastion:22",
                8080,
                &ssh2::Error::new(ErrorCode::Session(code), "libssh2's words"),
            )
        };
        assert!(message(LIBSSH2_ERROR_REQUEST_DENIED).contains("refused to listen on port 8080"));
        for code in [
            LIBSSH2_ERROR_TIMEOUT,
            -7,  // LIBSSH2_ERROR_SOCKET_SEND
            -13, // LIBSSH2_ERROR_SOCKET_DISCONNECT
            -43, // LIBSSH2_ERROR_SOCKET_RECV
        ] {
            let reason = message(code);
            assert!(!reason.contains("refused"), "{}", reason);
            assert!(reason.contains("bastion:22"), "{}", reason);
            assert!(reason.contains("8080"), "{}", reason);
        }
    }

    #[test]
    fn a_channel_open_that_ran_out_of_time_says_so_and_where_to() {
        let timeout = ssh2::Error::new(
            ErrorCode::Session(LIBSSH2_ERROR_TIMEOUT),
            "Unexpected error",
        );
        assert_eq!(
            open_error_message(&timeout, "db.internal", 5432),
            "timed out opening a channel to db.internal:5432"
        );
        let refused = ssh2::Error::new(
            ErrorCode::Session(LIBSSH2_ERROR_CHANNEL_FAILURE),
            "Channel open failure (connect failed)",
        );
        assert!(open_error_message(&refused, "db.internal", 5432).contains("connect failed"));
    }

    #[test]
    fn a_connection_a_probe_read_is_accepted_without_waiting_for_the_next_probe() {
        let (socket, mut server_end) = socket_pair();
        let uplink = Arc::new(FakeUplink::new(socket, &[]));
        let waiting = Arc::new(AtomicUsize::new(0));
        let accepted = Arc::new(AtomicUsize::new(0));
        {
            // What libssh2 does in a probe: it reads the socket dry and queues
            // the connection, so the socket wakes nobody for it afterwards.
            let waiting = Arc::clone(&waiting);
            *uplink.on_probe.lock().unwrap() = Box::new(move |mut socket: &TcpStream| {
                let mut buf = [0u8; 16];
                while matches!(socket.read(&mut buf), Ok(n) if n > 0) {}
                waiting.store(1, Ordering::SeqCst);
            });
        }
        let incoming = Incoming::Queued {
            waiting,
            accepted: Arc::clone(&accepted),
        };
        let (_hub, events, handle) = supervised(&uplink, incoming, timing(NEVER));

        server_end.write_all(b"x").unwrap();
        wait_for("the connection to be accepted", SOON, || {
            accepted.load(Ordering::SeqCst) == 1
        });

        handle.send(SessionMsg::Disconnect).unwrap();
        wait_for("the forward to end", SOON, || events.ended_with().is_some());
    }

    #[test]
    fn a_probe_counts_as_reading_the_session_while_it_runs() {
        let (socket, _server_end) = socket_pair();
        let uplink = Arc::new(FakeUplink::new(socket, &[]));
        let incoming = Incoming::Tcp {
            listener: bind_loopback(0).unwrap(),
            serve: Arc::new(|_: &Hub, _: TcpStream, _: SocketAddr| {}),
        };
        let (hub, events, handle) = supervised(&uplink, incoming, timing(Duration::from_millis(1)));

        let seen = Arc::new(AtomicUsize::new(usize::MAX));
        {
            let hub = Arc::clone(&hub);
            let seen = Arc::clone(&seen);
            *uplink.on_probe.lock().unwrap() = Box::new(move |_| {
                seen.store(hub.session_readers.load(Ordering::SeqCst), Ordering::SeqCst);
            });
        }
        wait_for("a probe", SOON, || {
            seen.load(Ordering::SeqCst) != usize::MAX
        });
        assert_eq!(seen.load(Ordering::SeqCst), 1);

        handle.send(SessionMsg::Disconnect).unwrap();
        wait_for("the forward to end", SOON, || events.ended_with().is_some());
        assert_eq!(hub.session_readers.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_silent_server_ends_the_forward_after_several_missed_probes() {
        let f = Fixture::start(
            timing(Duration::from_millis(5)),
            &[Probe::NoReply, Probe::NoReply, Probe::NoReply],
        );
        let reason = f.wait_for_end().expect("a reason for the frontend");
        assert!(reason.contains("stopped responding"), "{}", reason);
        assert_eq!(f.uplink.probes.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn an_answer_forgives_earlier_missed_probes() {
        let f = Fixture::start(
            timing(Duration::from_millis(5)),
            &[
                Probe::NoReply,
                Probe::NoReply,
                Probe::Alive,
                Probe::NoReply,
                Probe::NoReply,
                Probe::Busy,
                Probe::Alive,
            ],
        );
        wait_for("the script to run out", SOON, || {
            f.uplink.probes.load(Ordering::SeqCst) > 8
        });
        assert_eq!(f.events.ended_with(), None);
        let _still_accepting = f.connected_client();
    }

    #[test]
    fn a_stop_during_a_probe_is_not_a_failure() {
        let f = Fixture::start(timing(Duration::from_millis(5)), &[Probe::Stopped]);
        assert_eq!(f.wait_for_end(), None);
        assert!(port_is_closed(f.port));
    }

    #[test]
    fn a_client_arriving_after_the_end_is_not_registered() {
        let set = ClientSet::default();
        let (a, _keep_a) = socket_pair();
        let (b, mut b_peer) = socket_pair();
        b_peer.set_read_timeout(Some(SOON)).unwrap();

        let slot = set.register(&b).expect("still open");
        set.close_all();
        assert_dropped(&mut b_peer);
        assert!(set.register(&a).is_none());
        assert_eq!(set.sockets.len(), 1);
        drop(slot);
        assert!(set.sockets.is_empty());
    }

    #[test]
    fn a_taken_port_is_reported() {
        let taken = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        let error = bind_loopback(port).unwrap_err();
        assert!(error.contains(&format!("127.0.0.1:{}", port)), "{}", error);
    }

    #[test]
    fn the_status_event_name_matches_the_frontend() {
        assert_eq!(forward_status_event("abc"), "ssix:forward:status:abc");
    }
}

/// Runs against a real SSH server, so a plain `cargo test` skips them; see
/// `remote_script::live` for how to run them. Not on Windows, whose test
/// container is about scripts and whose sockets cannot wake the supervisor.
#[cfg(all(test, unix))]
mod live {
    use super::test_support::*;
    use super::*;
    use crate::ssh::AuthMethod;
    use crate::storage::test_support::with_isolated_data_dir;
    use std::io::{Read, Write};
    use std::net::Ipv6Addr;

    const SOON: Duration = Duration::from_secs(10);
    /// The SSH server's own sshd, as a destination every server can reach.
    const SSHD: (&str, u16) = ("127.0.0.1", 22);

    fn server() -> Endpoint {
        let var = |name: &str| {
            std::env::var(name)
                .unwrap_or_else(|_| panic!("{} is not set; see `remote_script::live`", name))
        };
        let addr = var("SSIX_LIVE_SSH");
        let (host, port) = addr.rsplit_once(':').expect("SSIX_LIVE_SSH is host:port");
        Endpoint {
            host: host.to_string(),
            port: port.parse().expect("SSIX_LIVE_SSH port"),
            username: var("SSIX_LIVE_USER"),
            auth: AuthMethod::Password(var("SSIX_LIVE_PASSWORD")),
            proxy_command: None,
        }
    }

    /// A local forward to `port` on the server's loopback, which is the only
    /// way in to what a remote forward listens on.
    fn forward_to_server_port(port: u16) -> (u16, SessionHandle, Arc<Recorder>) {
        let events = Arc::new(Recorder::default());
        let local_port = free_port();
        let handle = start_port_forward(
            server(),
            local_port,
            "127.0.0.1".to_string(),
            port,
            0,
            Arc::clone(&events),
        )
        .unwrap();
        (local_port, handle, events)
    }

    fn free_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn connect(port: u16) -> TcpStream {
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.set_read_timeout(Some(SOON)).unwrap();
        stream
    }

    fn read_ssh_banner(stream: &mut TcpStream) -> String {
        let mut banner = Vec::new();
        let mut buf = [0u8; 256];
        while !banner.contains(&b'\n') {
            let n = stream.read(&mut buf).expect("the SSH banner");
            assert!(n > 0, "closed before the SSH banner");
            banner.extend_from_slice(&buf[..n]);
        }
        let banner = String::from_utf8_lossy(&banner).to_string();
        assert!(banner.starts_with("SSH-2.0"), "{}", banner);
        banner
    }

    /// EOF or a reset, once a tunnel has been torn down.
    fn assert_closed(stream: &mut TcpStream) {
        let mut buf = [0u8; 4096];
        loop {
            match stream.read(&mut buf) {
                Ok(0) => return,
                Ok(_) => {}
                Err(e) => {
                    assert!(
                        !matches!(
                            e.kind(),
                            io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                        ),
                        "the client is still connected"
                    );
                    return;
                }
            }
        }
    }

    fn stop(handle: &SessionHandle, events: &Arc<Recorder>) {
        handle.send(SessionMsg::Disconnect).unwrap();
        wait_for("the forward to end", SOON, || events.ended_with().is_some());
        assert_eq!(events.ended_with().unwrap(), None);
    }

    /// Send a SOCKS5 CONNECT for `address` (type, bytes, port); returns the
    /// reply code and the connection.
    fn socks_request(port: u16, command: u8, address: &[u8]) -> (u8, TcpStream) {
        let mut stream = connect(port);
        stream.write_all(&[5, 1, 0]).unwrap();
        let mut chosen = [0u8; 2];
        stream.read_exact(&mut chosen).unwrap();
        assert_eq!(chosen, [5, 0]);
        stream.write_all(&[5, command, 0]).unwrap();
        stream.write_all(address).unwrap();
        let mut reply = [0u8; 10];
        stream.read_exact(&mut reply).unwrap();
        assert_eq!(reply[0], 5);
        (reply[1], stream)
    }

    fn ipv4_address(ip: [u8; 4], port: u16) -> Vec<u8> {
        let mut address = vec![1];
        address.extend_from_slice(&ip);
        address.extend_from_slice(&port.to_be_bytes());
        address
    }

    /// The probe has to work on a real server, and leave the session usable:
    /// libssh2 keeps a channel open's state in the session.
    #[test]
    #[ignore]
    fn live_probe_gets_a_reply_and_leaves_the_session_usable() {
        with_isolated_data_dir(|| {
            let uplink = SshUplink::connect(&server(), 0).unwrap();
            uplink.session.set_blocking(false);
            let (_handle, control) = control_channel().unwrap();
            for _ in 0..3 {
                assert_eq!(uplink.probe(&control), Probe::Alive);
            }
            let hub = Hub::new(
                Box::new(Arc::new(Recorder::default())),
                0,
                "test".to_string(),
                0,
            );
            let peer = "127.0.0.1:1".parse().unwrap();
            let channel = uplink.open_direct(&hub, SSHD.0, SSHD.1, peer);
            assert!(channel.is_ok());
            assert_eq!(hub.session_readers.load(Ordering::SeqCst), 0);
            assert_eq!(uplink.probe(&control), Probe::Alive);
        });
    }

    #[test]
    #[ignore]
    fn live_stopping_a_local_forward_drops_a_tunnelling_client() {
        with_isolated_data_dir(|| {
            let events = Arc::new(Recorder::default());
            let port = free_port();
            let handle = start_port_forward(
                server(),
                port,
                SSHD.0.to_string(),
                SSHD.1,
                0,
                Arc::clone(&events),
            )
            .unwrap();
            let mut client = connect(port);
            read_ssh_banner(&mut client);
            wait_for("the tunnel", SOON, || events.saw("client_connected"));

            stop(&handle, &events);

            assert_closed(&mut client);
            assert!(port_is_closed(port));
        });
    }

    /// A TCP relay to the server, to cut the connection under a session.
    struct Relay {
        port: u16,
        sockets: Arc<DashMap<u64, TcpStream>>,
    }

    impl Relay {
        fn to(server: &Endpoint) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let upstream = server.addr();
            let sockets: Arc<DashMap<u64, TcpStream>> = Arc::new(DashMap::new());
            let held = Arc::clone(&sockets);
            thread::spawn(move || {
                let mut next = 0;
                for down in listener.incoming().flatten() {
                    let up = TcpStream::connect(&upstream).unwrap();
                    for (mut from, mut to) in [
                        (down.try_clone().unwrap(), up.try_clone().unwrap()),
                        (up.try_clone().unwrap(), down.try_clone().unwrap()),
                    ] {
                        thread::spawn(move || {
                            let _ = io::copy(&mut from, &mut to);
                            let _ = to.shutdown(Shutdown::Both);
                        });
                    }
                    held.insert(next, down);
                    held.insert(next + 1, up);
                    next += 2;
                }
            });
            Self { port, sockets }
        }

        fn cut(&self) {
            for socket in self.sockets.iter() {
                let _ = socket.shutdown(Shutdown::Both);
            }
        }

        fn endpoint(&self, server: &Endpoint) -> Endpoint {
            Endpoint {
                host: "127.0.0.1".to_string(),
                port: self.port,
                ..server.clone()
            }
        }
    }

    #[test]
    #[ignore]
    fn live_an_idle_forward_notices_the_session_dying() {
        with_isolated_data_dir(|| {
            let server = server();
            let relay = Relay::to(&server);
            let events = Arc::new(Recorder::default());
            let port = free_port();
            let _handle = start_port_forward(
                relay.endpoint(&server),
                port,
                SSHD.0.to_string(),
                SSHD.1,
                0,
                Arc::clone(&events),
            )
            .unwrap();

            relay.cut();

            wait_for("the forward to end", SOON, || events.ended_with().is_some());
            let reason = events.ended_with().unwrap().expect("a failure");
            assert!(reason.contains("Lost the connection"), "{}", reason);
            assert!(port_is_closed(port));
        });
    }

    /// A one-connection-at-a-time echo server on this side of the session.
    fn echo_server() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                thread::spawn(move || {
                    let (mut from, mut to) = (stream.try_clone().unwrap(), stream);
                    let _ = io::copy(&mut from, &mut to);
                });
            }
        });
        port
    }

    #[test]
    #[ignore]
    fn live_a_remote_forward_carries_connections_back_here() {
        with_isolated_data_dir(|| {
            let events = Arc::new(Recorder::default());
            let remote_port = free_port();
            let handle = start_remote_forward(
                server(),
                remote_port,
                "127.0.0.1".to_string(),
                echo_server(),
                0,
                Arc::clone(&events),
            )
            .unwrap();

            // The port is on the server's loopback, so the way in is a local
            // forward through the same server.
            let (client_port, client_handle, client_events) = forward_to_server_port(remote_port);

            for round in 0..3 {
                let mut client = connect(client_port);
                let message = format!("round {}", round);
                client.write_all(message.as_bytes()).unwrap();
                let mut echoed = vec![0u8; message.len()];
                client.read_exact(&mut echoed).unwrap();
                assert_eq!(echoed, message.as_bytes());
            }
            wait_for("the tunnel", SOON, || events.saw("client_connected"));

            // Listening on a taken port is refused up front.
            let refused = start_remote_forward(
                server(),
                remote_port,
                "127.0.0.1".to_string(),
                1,
                0,
                Arc::new(Recorder::default()),
            );
            let error = refused.err().expect("the port is taken");
            assert!(error.contains("refused to listen"), "{}", error);

            let mut held = connect(client_port);
            held.write_all(b"x").unwrap();
            let mut one = [0u8; 1];
            held.read_exact(&mut one).unwrap();

            stop(&handle, &events);

            assert_closed(&mut held);
            // The server stopped listening: nothing gets through any more.
            let mut late = connect(client_port);
            assert_closed(&mut late);
            stop(&client_handle, &client_events);
        });
    }

    #[test]
    #[ignore]
    fn live_a_remote_forward_survives_an_unreachable_target() {
        with_isolated_data_dir(|| {
            let events = Arc::new(Recorder::default());
            let remote_port = free_port();
            let closed_port = free_port();
            let handle = start_remote_forward(
                server(),
                remote_port,
                "127.0.0.1".to_string(),
                closed_port,
                0,
                Arc::clone(&events),
            )
            .unwrap();
            let (client_port, client_handle, client_events) = forward_to_server_port(remote_port);

            let mut client = connect(client_port);
            assert_closed(&mut client);
            wait_for("the failure", SOON, || events.saw("client_error"));
            assert_eq!(events.ended_with(), None);

            stop(&client_handle, &client_events);
            stop(&handle, &events);
        });
    }

    #[test]
    #[ignore]
    fn live_a_dynamic_forward_speaks_socks5() {
        with_isolated_data_dir(|| {
            let events = Arc::new(Recorder::default());
            let port = free_port();
            let handle = start_dynamic_forward(server(), port, 0, Arc::clone(&events)).unwrap();

            // CONNECT to an IPv4 address.
            let (reply, mut stream) = socks_request(port, 1, &ipv4_address([127, 0, 0, 1], 22));
            assert_eq!(reply, 0);
            read_ssh_banner(&mut stream);

            // CONNECT to a name, which only the server resolves here.
            let mut name = vec![3, 9];
            name.extend_from_slice(b"localhost");
            name.extend_from_slice(&22u16.to_be_bytes());
            let (reply, mut named) = socks_request(port, 1, &name);
            assert_eq!(reply, 0);
            read_ssh_banner(&mut named);

            // CONNECT to an IPv6 address. Whether the server has `::1` depends
            // on its network, but the request must get as far as the server.
            let mut ipv6 = vec![4];
            ipv6.extend_from_slice(&Ipv6Addr::LOCALHOST.octets());
            ipv6.extend_from_slice(&22u16.to_be_bytes());
            let (reply, _) = socks_request(port, 1, &ipv6);
            assert!(matches!(reply, 0 | 5), "reply {}", reply);

            // The server's refusal reaches the client as such.
            let (reply, mut refused) = socks_request(port, 1, &ipv4_address([127, 0, 0, 1], 1));
            assert_eq!(reply, 5);
            assert_closed(&mut refused);

            // BIND and UDP ASSOCIATE.
            for command in [2, 3] {
                let (reply, mut unsupported) =
                    socks_request(port, command, &ipv4_address([127, 0, 0, 1], 22));
                assert_eq!(reply, 7);
                assert_closed(&mut unsupported);
            }

            // A client that only speaks username/password.
            let mut auth = connect(port);
            auth.write_all(&[5, 1, 2]).unwrap();
            let mut chosen = [0u8; 2];
            auth.read_exact(&mut chosen).unwrap();
            assert_eq!(chosen, [5, 0xFF]);
            assert_closed(&mut auth);

            // An established tunnel goes down with the forward.
            stop(&handle, &events);
            assert_closed(&mut stream);
            assert_closed(&mut named);
            assert!(port_is_closed(port));
        });
    }

    /// libssh2 keeps a channel open's state in the session: without the lock
    /// in `open_direct`, clients opening at the same time get each other's
    /// channels and end up talking to the wrong host. The destinations are an
    /// echo server, through a remote forward, and a closed port; hammering
    /// sshd itself would get this address penalised (`PerSourcePenalties`).
    #[test]
    #[ignore]
    fn live_concurrent_socks_clients_get_their_own_destinations() {
        with_isolated_data_dir(|| {
            let echo_events = Arc::new(Recorder::default());
            let remote_port = free_port();
            let echo_handle = start_remote_forward(
                server(),
                remote_port,
                "127.0.0.1".to_string(),
                echo_server(),
                0,
                Arc::clone(&echo_events),
            )
            .unwrap();

            let events = Arc::new(Recorder::default());
            let port = free_port();
            let handle = start_dynamic_forward(server(), port, 0, Arc::clone(&events)).unwrap();

            let clients: Vec<_> = (0..16)
                .map(|i| {
                    thread::spawn(move || {
                        for round in 0..8 {
                            if i % 2 == 0 {
                                let address = ipv4_address([127, 0, 0, 1], remote_port);
                                let (reply, mut stream) = socks_request(port, 1, &address);
                                assert_eq!(reply, 0);
                                let message = format!("client {} round {}", i, round);
                                stream.write_all(message.as_bytes()).unwrap();
                                let mut echoed = vec![0u8; message.len()];
                                stream.read_exact(&mut echoed).unwrap();
                                assert_eq!(echoed, message.as_bytes());
                            } else {
                                let address = ipv4_address([127, 0, 0, 1], 1);
                                let (reply, _) = socks_request(port, 1, &address);
                                assert_eq!(reply, 5);
                            }
                        }
                    })
                })
                .collect();
            let results: Vec<_> = clients.into_iter().map(|client| client.join()).collect();
            let failures: Vec<_> = events
                .statuses
                .lock()
                .unwrap()
                .iter()
                .filter(|s| s.state == "client_error")
                .filter_map(|s| s.message.clone())
                .filter(|m| !m.contains("connect failed"))
                .collect();
            assert!(failures.is_empty(), "{:?}", failures);
            assert!(results.iter().all(Result::is_ok));

            stop(&handle, &events);
            stop(&echo_handle, &echo_events);
        });
    }
}
