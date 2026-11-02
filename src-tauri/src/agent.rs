//! The SSH agent: logging in with its keys, and forwarding it to a server.
//!
//! **Logging in.** Each key the agent holds is offered in turn, as `ssh` does,
//! through `crate::login_wait`: a signature can take as long as a touch, which
//! must not read as a server that stopped answering.
//!
//! **FIDO2 (`sk-*`) keys.** The agent does the signing, so there is no key
//! handling here, but libssh2's own agent path cannot carry the result. An
//! `sk-*` signature ends in a flags byte and a counter: `agent_sign` in
//! libssh2's `agent.c` keeps only the signature string, while
//! `_libssh2_userauth_publickey` sends a security key's bytes unframed, as
//! `libssh2_sign_sk` lays them out. The server then cannot parse what it gets.
//! So these keys go through `libssh2_userauth_publickey` with [`sign_with_agent`]
//! as the callback. It asks the same agent over its socket and returns those
//! bytes as they are. Both libssh2 paths are pinned by the live tests below,
//! using a stand-in agent: no test here has seen a hardware key.
//!
//! **Forwarding.** With `ssh -A`, the server opens a channel for each program
//! that talks to `SSH_AUTH_SOCK`. libssh2 reports each one through a callback
//! (`crate::libssh2_ext`), which runs while some thread reads the session and
//! only queues the channel. A [`ForwardPump`] thread then pipes bytes between
//! the channel and a new connection to the local agent. It understands none of
//! them: signing is the local agent's decision, as it is with `ssh`.
//!
//! That pump needs the session to be non-blocking, which a shell's session is
//! once `start_shell` returns. It cannot leave the socket to the shell's worker:
//! inside libssh2, reading or writing a channel and freeing one all read the
//! socket first, and queue whatever they find, for any channel. Two things follow
//! while it serves a channel ([`ForwardPump::serving`]):
//!
//! - A packet for the shell can land in libssh2's queue without the socket ever
//!   turning readable for the worker sleeping on it, so the worker wakes more
//!   often, and shell output is not held up.
//! - A keepalive reply can vanish the same way, and the worker's watchdog takes
//!   bytes on the socket as the proof that the server is there. So the pump looks
//!   at the socket before it can drain it, and passes on what it saw
//!   ([`ForwardPump::take_heard`]). Only bytes actually received count: agent
//!   traffic going out, or data already queued, cannot make a dead connection look
//!   alive.
//!
//! The pump never flushes a channel, for the reason `write_all_nonblocking` in
//! `crate::ssh` gives. Each shell has its own pump: a reconnect asks for forwarding
//! again and starts a new one, because the old session's grant died with it.
//!
//! Forwarding is Unix-only: it needs libssh2's raw channels and the agent's
//! socket. On Windows a connection that enables it says so in the log and
//! opens without it.

use std::path::Path;
use std::time::Duration;

use ssh2::{Agent, PublicKey, Session};

use crate::login_wait::{Interrupted, LoginWait, REQUEST_STALL, STALLED};
use crate::ssh::CredentialFailure;
use crate::ssh_debug::SshDebug;

/// Log in with the first key in the agent that the server accepts.
pub(crate) fn authenticate(
    session: &Session,
    username: &str,
    debug: &SshDebug,
) -> Result<(), CredentialFailure> {
    authenticate_via(session, username, debug, None)
}

/// As [`authenticate`], with `socket` in place of `SSH_AUTH_SOCK` when given.
fn authenticate_via(
    session: &Session,
    username: &str,
    debug: &SshDebug,
    socket: Option<&Path>,
) -> Result<(), CredentialFailure> {
    log_in(session, username, debug, socket, REQUEST_STALL).map_err(agent_failure)
}

/// What a failure says. All but one say "auth", which is how they read as a login
/// failure rather than a connection problem wherever they are shown, and none of
/// those is one a reconnect should retry (`crate::reconnect`). A server that
/// stopped answering is a connection problem, and is left to read as one.
fn agent_failure(failure: CredentialFailure) -> CredentialFailure {
    let said = |reason| format!("Agent auth failed: {}", reason);
    match failure {
        CredentialFailure::Local(reason) if reason == STALLED => CredentialFailure::Local(reason),
        CredentialFailure::Local(reason) => CredentialFailure::Local(said(reason)),
        CredentialFailure::Refused(reason) => CredentialFailure::Refused(said(reason)),
    }
}

fn log_in(
    session: &Session,
    username: &str,
    debug: &SshDebug,
    socket: Option<&Path>,
    stall: Duration,
) -> Result<(), CredentialFailure> {
    let keys_at_hand = || -> Result<(Agent, Vec<PublicKey>), String> {
        let mut agent = session
            .agent()
            .map_err(|e| format!("Could not set up the SSH agent client: {}", e))?;
        if let Some(socket) = socket {
            agent
                .set_identity_path(socket)
                .map_err(|e| format!("Bad SSH agent path: {}", e))?;
        }
        agent.connect().map_err(|e| {
            format!(
                "Could not reach an SSH agent: {}. Check that one is running and that \
                 SSH_AUTH_SOCK is set where SSIX was started",
                e
            )
        })?;
        agent
            .list_identities()
            .map_err(|e| format!("Could not list the SSH agent's keys: {}", e))?;
        let keys = agent
            .identities()
            .map_err(|e| format!("Could not read the SSH agent's keys: {}", e))?;
        if keys.is_empty() {
            return Err("The SSH agent holds no keys. Add one with ssh-add".to_string());
        }
        Ok((agent, keys))
    };
    let (mut agent, keys) = keys_at_hand().map_err(CredentialFailure::Local)?;

    let result = offer_keys(session, &agent, &keys, username, debug, socket, stall);
    let _ = agent.disconnect();
    result
}

fn offer_keys(
    session: &Session,
    agent: &Agent,
    keys: &[PublicKey],
    username: &str,
    debug: &SshDebug,
    socket: Option<&Path>,
    stall: Duration,
) -> Result<(), CredentialFailure> {
    let mut wait = LoginWait::begin(session, crate::auth_prompt::attempt_flag());
    let mut last_error = String::new();
    // Whether the server turned a key down, rather than us never getting a key
    // in front of it: an agent that would not sign, say.
    let mut refused = false;
    for key in keys {
        debug.at(1, || {
            format!(
                "Offering agent key: {} ({})",
                key.comment(),
                key_type(key.blob()).unwrap_or("unknown type")
            )
        });
        let attempt = if is_security_key(key.blob()) {
            authenticate_security_key(&mut wait, stall, session, username, key.blob(), socket)
        } else {
            wait.until_done(stall, || agent.userauth(username, key))
                .map(|attempt| {
                    attempt.map_err(|e| CredentialFailure::from_error(&e, e.to_string()))
                })
        };
        // The next key would meet the same silence, or nobody wants it.
        let attempt =
            attempt.map_err(|stopped| CredentialFailure::Local(stopped.message().to_string()))?;
        match attempt {
            Ok(()) if session.authenticated() => return Ok(()),
            Ok(()) => {
                refused = true;
                last_error = "the server did not finish the login".to_string();
            }
            Err(failure) => {
                refused |= matches!(failure, CredentialFailure::Refused(_));
                let reason = failure.into_message();
                debug.at(1, || format!("Agent key not accepted: {}", reason));
                last_error = reason;
            }
        }
    }
    Err(if refused {
        CredentialFailure::Refused(format!(
            "the server accepted none of the {} key(s) in the SSH agent ({})",
            keys.len(),
            last_error
        ))
    } else {
        CredentialFailure::Local(format!(
            "none of the {} key(s) in the SSH agent could be used ({})",
            keys.len(),
            last_error
        ))
    })
}

/// One SSH wire-format string and what follows it.
fn ssh_string(data: &[u8]) -> Option<(&[u8], &[u8])> {
    let (len, rest) = data.split_first_chunk::<4>()?;
    let len = u32::from_be_bytes(*len) as usize;
    (rest.len() >= len).then(|| rest.split_at(len))
}

/// The algorithm a public key blob starts with.
fn key_type(blob: &[u8]) -> Option<&str> {
    let (name, _) = ssh_string(blob)?;
    std::str::from_utf8(name).ok()
}

/// A FIDO2 key held by the agent (`sk-ssh-ed25519@openssh.com` and friends).
fn is_security_key(blob: &[u8]) -> bool {
    key_type(blob).is_some_and(|name| name.starts_with("sk-"))
}

#[cfg(windows)]
fn authenticate_security_key(
    _wait: &mut LoginWait<'_>,
    _stall: Duration,
    _session: &Session,
    _username: &str,
    _blob: &[u8],
    _socket: Option<&Path>,
) -> Result<Result<(), CredentialFailure>, Interrupted> {
    Ok(Err(CredentialFailure::Local(
        "Security keys in the SSH agent are not supported on Windows yet".to_string(),
    )))
}

#[cfg(unix)]
use sign::authenticate_security_key;

#[cfg(unix)]
mod sign {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use ssh2::Session;

    use super::{ssh_string, CredentialFailure, Interrupted, LoginWait};
    use crate::libssh2_ext;

    /// How long a security key may take to sign, which means waiting for a touch.
    const SIGNATURE_TIMEOUT: Duration = Duration::from_secs(120);
    const SSH_AGENT_FAILURE: u8 = 5;
    const SSH_AGENTC_SIGN_REQUEST: u8 = 13;
    const SSH_AGENT_SIGN_RESPONSE: u8 = 14;
    /// OpenSSH's limit on one agent message.
    const MAX_AGENT_MESSAGE: usize = 256 * 1024;

    fn connect_to_agent(socket: Option<&Path>) -> Result<UnixStream, String> {
        let path = match socket {
            Some(path) => path.to_path_buf(),
            None => std::env::var_os("SSH_AUTH_SOCK")
                .map(PathBuf::from)
                .ok_or("SSH_AUTH_SOCK is not set")?,
        };
        let agent =
            UnixStream::connect(&path).map_err(|e| format!("Could not reach the agent: {}", e))?;
        agent
            .set_read_timeout(Some(SIGNATURE_TIMEOUT))
            .map_err(|e| format!("Could not set up the agent connection: {}", e))?;
        Ok(agent)
    }

    pub(super) fn authenticate_security_key(
        wait: &mut LoginWait<'_>,
        stall: Duration,
        session: &Session,
        username: &str,
        blob: &[u8],
        socket: Option<&Path>,
    ) -> Result<Result<(), CredentialFailure>, Interrupted> {
        let mut agent = match connect_to_agent(socket) {
            Ok(agent) => agent,
            Err(reason) => return Ok(Err(CredentialFailure::Local(reason))),
        };

        // libssh2's callback returns only a code, so the reason waits here.
        let mut failure = None;
        let result = wait.until_done(stall, || {
            libssh2_ext::userauth_publickey(session, username, blob, |data| {
                match sign_with_agent(&mut agent, blob, data) {
                    Ok(signature) => Some(signature),
                    Err(e) => {
                        failure = Some(e);
                        None
                    }
                }
            })
        })?;
        Ok(match (result, failure) {
            (Ok(()), _) => Ok(()),
            (Err(_), Some(reason)) => Err(CredentialFailure::Local(reason)),
            (Err(e), None) => Err(CredentialFailure::from_error(&e, e.to_string())),
        })
    }

    /// Ask the agent to sign `data` and return what follows the method name
    /// in its signature, as libssh2 wants it for a security key.
    fn sign_with_agent(
        agent: &mut UnixStream,
        blob: &[u8],
        data: &[u8],
    ) -> Result<Vec<u8>, String> {
        agent
            .write_all(&sign_request(blob, data))
            .map_err(|e| format!("Could not reach the agent: {}", e))?;
        let mut len = [0u8; 4];
        agent
            .read_exact(&mut len)
            .map_err(|e| format!("The agent did not answer: {}", e))?;
        let len = u32::from_be_bytes(len) as usize;
        if len > MAX_AGENT_MESSAGE {
            return Err("The agent sent an oversized answer".to_string());
        }
        let mut reply = vec![0u8; len];
        agent
            .read_exact(&mut reply)
            .map_err(|e| format!("The agent did not answer: {}", e))?;
        security_key_signature(&reply)
    }

    /// `SSH_AGENTC_SIGN_REQUEST`, length prefix included.
    pub(super) fn sign_request(blob: &[u8], data: &[u8]) -> Vec<u8> {
        let body_len = 1 + 4 + blob.len() + 4 + data.len() + 4;
        let mut message = Vec::with_capacity(4 + body_len);
        message.extend_from_slice(&(body_len as u32).to_be_bytes());
        message.push(SSH_AGENTC_SIGN_REQUEST);
        for field in [blob, data] {
            message.extend_from_slice(&(field.len() as u32).to_be_bytes());
            message.extend_from_slice(field);
        }
        message.extend_from_slice(&0u32.to_be_bytes());
        message
    }

    /// From `SSH_AGENT_SIGN_RESPONSE { string { string method, string sig,
    /// byte flags, uint32 counter } }`, everything after `method`.
    pub(super) fn security_key_signature(reply: &[u8]) -> Result<Vec<u8>, String> {
        let malformed = || "The agent sent a malformed signature".to_string();
        let (&kind, body) = reply.split_first().ok_or_else(malformed)?;
        if kind == SSH_AGENT_FAILURE {
            return Err(
                "The agent refused to sign: the security key may need a touch, or a PIN \
                 ssh-add has not been given"
                    .to_string(),
            );
        }
        if kind != SSH_AGENT_SIGN_RESPONSE {
            return Err(malformed());
        }
        let (signature, _) = ssh_string(body).ok_or_else(malformed)?;
        let (_method, rest) = ssh_string(signature).ok_or_else(malformed)?;
        let (_sig, flags_and_counter) = ssh_string(rest).ok_or_else(malformed)?;
        if flags_and_counter.len() != 5 {
            return Err(malformed());
        }
        Ok(rest.to_vec())
    }
}

#[cfg(windows)]
pub(crate) fn request_forwarding(
    _session: &Session,
    _channel: &mut ssh2::Channel,
    _debug: &SshDebug,
) {
    crate::logs::log_local(
        "warn",
        "ssh",
        "Agent forwarding is not supported on Windows yet; connecting without it",
    );
}

/// Never exists on Windows: [`Self::start`] always says there is nothing to do.
#[cfg(windows)]
pub(crate) enum ForwardPump {}

#[cfg(windows)]
impl ForwardPump {
    pub(crate) fn start(_session: &Session) -> Option<Self> {
        None
    }

    pub(crate) fn serving(&self) -> bool {
        match *self {}
    }

    pub(crate) fn take_heard(&self) -> bool {
        match *self {}
    }
}

#[cfg(unix)]
pub(crate) use forward::{request_forwarding, ForwardPump};

#[cfg(unix)]
mod forward {
    use std::io::{self, Read, Write};
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Condvar, Mutex};
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};

    use ssh2::Session;

    use crate::libssh2_ext::{self, AgentChannelSink, Locked, RawChannel};
    use crate::ssh::wake;
    use crate::ssh_debug::SshDebug;

    /// Agent connections served at once; a server asking for more gets the
    /// extra channels closed at once.
    const MAX_BRIDGES: usize = 16;
    /// Bytes held per direction. OpenSSH caps an agent message at 256 KiB.
    const MAX_BUFFERED: usize = 256 * 1024 + 4;
    /// How often an idle pump checks that its session still runs.
    const IDLE_CHECK: Duration = Duration::from_millis(250);
    /// Waits between looks at libssh2's queue while a bridge is open: short
    /// during a conversation, longer once an agent connection sits idle.
    const BUSY_WAIT_MIN: Duration = Duration::from_millis(1);
    const BUSY_WAIT_MAX: Duration = Duration::from_millis(50);
    /// How long to wait for channels to close when the session ends.
    const CLOSE_TIMEOUT: Duration = Duration::from_secs(1);
    /// How long an agent may keep answering after the server stopped sending.
    const ANSWER_LINGER: Duration = Duration::from_secs(120);

    /// What the libssh2 callback and the pump share. The session's abstract
    /// pointer holds one reference until the pump stops listening. A setup
    /// whose shell request fails after this never starts a pump, and leaves
    /// this small struct behind: libssh2 has nowhere to call back to free it.
    struct Forwarding {
        socket: PathBuf,
        arrivals: Mutex<Vec<RawChannel>>,
        wake: Condvar,
        stop: AtomicBool,
        /// Whether the pump has a channel, which makes it read the session.
        serving: AtomicBool,
        /// Whether it saw bytes from the server since the worker last asked.
        heard: AtomicBool,
    }

    impl AgentChannelSink for Forwarding {
        fn channel_opened(&self, channel: RawChannel) {
            self.arrivals
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(channel);
            // Before the pump wakes: this runs on the thread reading the session,
            // usually the worker, which is about to choose how long to sleep.
            self.serving.store(true, Ordering::Release);
            self.wake.notify_all();
        }
    }

    impl Forwarding {
        fn take_arrivals(&self) -> Vec<RawChannel> {
            std::mem::take(&mut *self.arrivals.lock().unwrap_or_else(|e| e.into_inner()))
        }

        /// Sleep until a channel arrives or `IDLE_CHECK` passes.
        fn wait_for_arrival(&self) {
            let arrivals = self.arrivals.lock().unwrap_or_else(|e| e.into_inner());
            if arrivals.is_empty() && !self.stop.load(Ordering::Acquire) {
                let _ = self.wake.wait_timeout(arrivals, IDLE_CHECK);
            }
        }
    }

    fn warn(message: String) {
        crate::logs::log_local("warn", "ssh", message);
    }

    /// Ask the server to forward the agent on `channel`, before its shell
    /// starts: sshd sets `SSH_AUTH_SOCK` when it does. Refusal is not an error,
    /// as with `ssh -A`: the shell opens without forwarding and the log says so.
    pub(crate) fn request_forwarding(
        session: &Session,
        channel: &mut ssh2::Channel,
        debug: &SshDebug,
    ) {
        match std::env::var_os("SSH_AUTH_SOCK").filter(|socket| !socket.is_empty()) {
            Some(socket) => request_forwarding_to(session, channel, debug, Path::new(&socket)),
            None => warn(
                "Agent forwarding is on, but SSH_AUTH_SOCK is not set: connecting without it"
                    .to_string(),
            ),
        }
    }

    pub(super) fn request_forwarding_to(
        session: &Session,
        channel: &mut ssh2::Channel,
        debug: &SshDebug,
        socket: &Path,
    ) {
        let state = Arc::new(Forwarding {
            socket: socket.to_path_buf(),
            arrivals: Mutex::new(Vec::new()),
            wake: Condvar::new(),
            stop: AtomicBool::new(false),
            serving: AtomicBool::new(false),
            heard: AtomicBool::new(false),
        });
        // Listening starts first: the server may open a channel as soon as it
        // has granted the request.
        libssh2_ext::with_session(session, |locked| {
            libssh2_ext::listen_for_agent_channels(locked, state);
        });
        match channel.request_auth_agent_forwarding() {
            Ok(()) => debug.at(1, || "Agent forwarding granted.".to_string()),
            Err(e) => {
                libssh2_ext::with_session(session, |locked| {
                    libssh2_ext::stop_agent_channels::<Forwarding>(locked);
                });
                warn(format!("The server refused agent forwarding: {}", e));
            }
        }
    }

    /// Serves a session's agent channels from a thread of its own, until
    /// dropped. Holds a session clone, so it keeps the session alive; the
    /// shell's worker owns this for as long as it runs.
    pub(crate) struct ForwardPump {
        state: Arc<Forwarding>,
        thread: Option<JoinHandle<()>>,
    }

    impl ForwardPump {
        /// Start serving, if forwarding was granted on `session`.
        pub(crate) fn start(session: &Session) -> Option<Self> {
            let state = libssh2_ext::with_session(session, |locked| {
                libssh2_ext::agent_channel_sink::<Forwarding>(locked)
            })?;
            let thread = {
                let session = session.clone();
                let state = state.clone();
                thread::spawn(move || pump(session, state))
            };
            Some(Self {
                state,
                thread: Some(thread),
            })
        }

        /// Whether the pump is reading the session as well, so that a sleeping
        /// worker may not see what arrives (see the module docs).
        pub(crate) fn serving(&self) -> bool {
            self.state.serving.load(Ordering::Acquire)
        }

        /// Whether the server sent anything the pump saw since the last call.
        pub(crate) fn take_heard(&self) -> bool {
            self.state.heard.swap(false, Ordering::AcqRel)
        }
    }

    impl Drop for ForwardPump {
        fn drop(&mut self) {
            self.state.stop.store(true, Ordering::Release);
            self.state.wake.notify_all();
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    /// One agent connection: a server channel piped to a local socket.
    struct Bridge {
        channel: RawChannel,
        agent: UnixStream,
        to_agent: Vec<u8>,
        to_channel: Vec<u8>,
        channel_ended: bool,
        agent_ended: bool,
        /// When everything the server sent had reached the agent.
        delivered_at: Option<Instant>,
    }

    impl Bridge {
        /// Connect a new channel to the local agent.
        fn connect(channel: RawChannel, socket: &Path) -> Result<Self, RawChannel> {
            let agent = UnixStream::connect(socket).and_then(|agent| {
                agent.set_nonblocking(true)?;
                Ok(agent)
            });
            match agent {
                Ok(agent) => Ok(Self {
                    channel,
                    agent,
                    to_agent: Vec::new(),
                    to_channel: Vec::new(),
                    channel_ended: false,
                    agent_ended: false,
                    delivered_at: None,
                }),
                Err(e) => {
                    warn(format!(
                        "Agent forwarding could not reach the local agent: {}",
                        e
                    ));
                    Err(channel)
                }
            }
        }

        /// Move what can move without blocking. Returns whether anything did.
        /// Only a channel error is returned: a dead agent connection still has
        /// to finish its write to the channel below.
        fn pump(&mut self, locked: &Locked<'_>, buf: &mut [u8]) -> io::Result<bool> {
            let mut moved = false;

            if !self.channel_ended && self.to_agent.len() < MAX_BUFFERED {
                if self.channel.has_data(locked) {
                    match self.channel.read(locked, buf) {
                        Ok(0) => self.channel_ended = true,
                        Ok(n) => {
                            self.to_agent.extend_from_slice(&buf[..n]);
                            moved = true;
                        }
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                        Err(e) => return Err(e),
                    }
                } else if self.channel.eof(locked) {
                    self.channel_ended = true;
                }
            }

            if !self.to_agent.is_empty() {
                match self.agent.write(&self.to_agent) {
                    Ok(n) => {
                        self.to_agent.drain(..n);
                        moved |= n > 0;
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                    Err(_) => self.agent_gone(),
                }
            }

            if self.reads_agent() {
                match self.agent.read(buf) {
                    Ok(0) => self.agent_gone(),
                    Ok(n) => {
                        self.to_channel.extend_from_slice(&buf[..n]);
                        moved = true;
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                    Err(_) => self.agent_gone(),
                }
            }

            if !self.to_channel.is_empty() {
                // After WouldBlock libssh2 may hold part of this write, and
                // answers every other write on the session with EAGAIN until
                // the same call finishes it. So these bytes stay in
                // `to_channel`, the next pass repeats the call, and a bridge
                // does not end while there are any: abandoning one would stall
                // the shell on this session.
                match self.channel.write(locked, &self.to_channel) {
                    Ok(n) => {
                        self.to_channel.drain(..n);
                        moved |= n > 0;
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                    Err(e) => return Err(e),
                }
            }

            Ok(moved)
        }

        /// Whether `pump` would read the agent's socket now.
        fn reads_agent(&self) -> bool {
            !self.agent_ended && self.to_channel.len() < MAX_BUFFERED
        }

        fn agent_gone(&mut self) {
            self.agent_ended = true;
            self.to_agent.clear();
        }

        /// Whether this connection is over. The agent's hang-up ends it, once
        /// its last words went out. The server's only stops the sending: the
        /// agent then sees EOF and may still answer, possibly after a touch.
        fn finished(&mut self) -> bool {
            if self.agent_ended && self.to_channel.is_empty() {
                return true;
            }
            if !self.channel_ended || !self.to_agent.is_empty() {
                return false;
            }
            let delivered_at = *self.delivered_at.get_or_insert_with(|| {
                let _ = self.agent.shutdown(Shutdown::Write);
                Instant::now()
            });
            delivered_at.elapsed() > ANSWER_LINGER
        }
    }

    /// Wait up to `wait` for something to read on the sockets that will be read.
    /// The others stay out of it: an agent that hung up, or one whose answer has
    /// nowhere to go yet, always polls as readable, and would make this spin.
    pub(super) fn wait_for_readers(
        sockets: impl Iterator<Item = (wake::Fd, bool)>,
        wait: Duration,
    ) {
        let readers: Vec<wake::Fd> = sockets
            .filter(|&(_, will_read)| will_read)
            .map(|(socket, _)| socket)
            .collect();
        if readers.is_empty() {
            thread::sleep(wait);
        } else {
            wake::wait_readable(&readers, wait);
        }
    }

    fn pump(session: Session, state: Arc<Forwarding>) {
        let mut bridges: Vec<Bridge> = Vec::new();
        let mut closing: Vec<RawChannel> = Vec::new();
        let mut buf = vec![0u8; 32 * 1024];
        let mut wait = BUSY_WAIT_MIN;
        // Not inside `with_session`: asking the session for it takes the same lock.
        let socket = wake::fd_of(&session);

        while !state.stop.load(Ordering::Acquire) {
            for channel in state.take_arrivals() {
                if bridges.len() >= MAX_BRIDGES {
                    warn("The server opened too many agent channels".to_string());
                    closing.push(channel);
                    continue;
                }
                match Bridge::connect(channel, &state.socket) {
                    Ok(bridge) => bridges.push(bridge),
                    Err(channel) => closing.push(channel),
                }
                wait = BUSY_WAIT_MIN;
            }
            let serving = !bridges.is_empty() || !closing.is_empty();
            state.serving.store(serving, Ordering::Release);
            if !serving {
                state.wait_for_arrival();
                continue;
            }

            let moved = libssh2_ext::with_session(&session, |locked| {
                // Before anything below can drain the socket. Bytes that land in
                // the instant before the first call reads them go uncounted, but
                // the watchdog only gives up after several intervals of nothing,
                // and this looks again on every pass.
                if wake::is_readable(socket) {
                    state.heard.store(true, Ordering::Release);
                }
                let mut moved = false;
                let mut open = Vec::with_capacity(bridges.len());
                for mut bridge in bridges.drain(..) {
                    match bridge.pump(locked, &mut buf) {
                        Ok(any) if !bridge.finished() => {
                            moved |= any;
                            open.push(bridge);
                        }
                        Ok(_) => {
                            moved = true;
                            closing.push(bridge.channel);
                        }
                        Err(e) => {
                            warn(format!("Agent forwarding channel failed: {}", e));
                            closing.push(bridge.channel);
                        }
                    }
                }
                bridges = open;
                closing = closing
                    .drain(..)
                    .filter_map(|channel| channel.free(locked))
                    .collect();
                moved
            });

            if moved {
                wait = BUSY_WAIT_MIN;
                continue;
            }
            let sockets = bridges
                .iter()
                .map(|bridge| (wake::fd_of(&bridge.agent), bridge.reads_agent()));
            wait_for_readers(sockets, wait);
            wait = (wait * 2).min(BUSY_WAIT_MAX);
        }

        finish(&session, &state, bridges, closing);
    }

    /// Stop listening, then close every channel. A channel that cannot close
    /// in time is left to the session, which frees what is left when it ends.
    fn finish(
        session: &Session,
        state: &Forwarding,
        bridges: Vec<Bridge>,
        mut closing: Vec<RawChannel>,
    ) {
        closing.extend(bridges.into_iter().map(|bridge| bridge.channel));
        libssh2_ext::with_session(session, |locked| {
            libssh2_ext::stop_agent_channels::<Forwarding>(locked);
        });
        // Nothing can arrive after that: the callback ran under the same lock.
        closing.extend(state.take_arrivals());

        let deadline = Instant::now() + CLOSE_TIMEOUT;
        while !closing.is_empty() && Instant::now() < deadline {
            closing = libssh2_ext::with_session(session, |locked| {
                closing
                    .drain(..)
                    .filter_map(|channel| channel.free(locked))
                    .collect()
            });
            if !closing.is_empty() {
                thread::sleep(BUSY_WAIT_MIN);
            }
        }
    }
}

#[cfg(all(test, unix))]
mod pump_wait_tests {
    use super::forward::wait_for_readers;
    use crate::ssh::wake;
    use std::iter::once;
    use std::os::unix::net::UnixStream;
    use std::time::{Duration, Instant};

    #[test]
    fn a_socket_it_will_not_read_does_not_cut_the_wait_short() {
        let (hung_up, peer) = UnixStream::pair().unwrap();
        drop(peer);
        let socket = wake::fd_of(&hung_up);
        let wait = Duration::from_millis(100);

        let started = Instant::now();
        wait_for_readers(once((socket, false)), wait);
        assert!(started.elapsed() >= wait);

        // The same socket ends the wait at once when it will be read.
        let started = Instant::now();
        wait_for_readers(once((socket, true)), Duration::from_secs(5));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn no_sockets_at_all_still_wait() {
        let wait = Duration::from_millis(50);
        let started = Instant::now();
        wait_for_readers(std::iter::empty(), wait);
        assert!(started.elapsed() >= wait);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::sign::{security_key_signature, sign_request};
    use super::*;

    fn string(value: &[u8]) -> Vec<u8> {
        let mut out = (value.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(value);
        out
    }

    #[test]
    fn recognises_security_keys_by_their_algorithm() {
        assert!(is_security_key(&string(b"sk-ssh-ed25519@openssh.com")));
        assert!(is_security_key(&string(
            b"sk-ecdsa-sha2-nistp256@openssh.com"
        )));
        assert!(!is_security_key(&string(b"ssh-ed25519")));
        assert!(!is_security_key(&string(b"rsa-sha2-256")));
        assert!(!is_security_key(b"\x00\x00"));
        assert!(!is_security_key(b"\x00\x00\x00\x09short"));
    }

    #[test]
    fn reads_ssh_strings_without_running_off_the_end() {
        assert_eq!(
            ssh_string(b"\x00\x00\x00\x02abcd"),
            Some((&b"ab"[..], &b"cd"[..]))
        );
        assert_eq!(ssh_string(b"\x00\x00\x00\x05abcd"), None);
        assert_eq!(ssh_string(b"\xff\xff\xff\xffabcd"), None);
        assert_eq!(ssh_string(b""), None);
    }

    #[test]
    fn frames_a_sign_request_as_the_agent_protocol_says() {
        let message = sign_request(b"key", b"data");
        let mut expected = vec![13];
        expected.extend(string(b"key"));
        expected.extend(string(b"data"));
        expected.extend([0, 0, 0, 0]);
        assert_eq!(message[..4], (expected.len() as u32).to_be_bytes());
        assert_eq!(message[4..], expected);
    }

    /// What an agent answers for a security key.
    fn reply(signature_body: &[u8]) -> Vec<u8> {
        let mut blob = string(b"sk-ssh-ed25519@openssh.com");
        blob.extend_from_slice(signature_body);
        let mut reply = vec![14];
        reply.extend(string(&blob));
        reply
    }

    #[test]
    fn keeps_the_flags_and_counter_libssh2_would_drop() {
        let mut body = string(&[7u8; 64]);
        body.push(0x01); // flags: user present
        body.extend(42u32.to_be_bytes()); // counter
        assert_eq!(security_key_signature(&reply(&body)).unwrap(), body);
    }

    #[test]
    fn refuses_malformed_agent_answers() {
        assert!(security_key_signature(&[]).is_err());
        assert!(security_key_signature(&[99, 0]).is_err());
        assert!(security_key_signature(&[5])
            .unwrap_err()
            .contains("refused"));
        // A signature without flags and counter would only fail at the server.
        assert!(security_key_signature(&reply(&string(&[7u8; 64]))).is_err());
        let mut truncated = reply(&string(&[7u8; 64]));
        truncated.truncate(truncated.len() - 10);
        assert!(security_key_signature(&truncated).is_err());
    }
}

/// Runs against a real sshd with a stand-in SSH agent, so a plain `cargo test`
/// skips them. The stand-in keeps an Ed25519 key in memory and signs the way
/// `ssh-agent` does, including for a software `sk-ssh-ed25519@openssh.com` key:
/// the server verifies those exactly as it would a hardware key's. Nothing
/// here touches a hardware key, its driver or a real touch.
///
/// ```text
/// SSIX_LIVE_SSH=127.0.0.1:2201 SSIX_LIVE_USER=usera SSIX_LIVE_PASSWORD=passa \
/// SSIX_LIVE_PLATFORM=posix cargo test live_ -- --ignored --test-threads=1
/// ```
#[cfg(all(test, unix))]
mod live {
    use super::forward::{request_forwarding_to, ForwardPump};
    use super::*;
    use crate::login_wait::test_support::FreezingProxy;
    use crate::ssh::{open_authenticated_session, AuthMethod, Endpoint};
    use crate::storage::test_support::with_isolated_data_dir;
    use base64::Engine;
    use ed25519_dalek::{Signer, SigningKey};
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    const APPLICATION: &[u8] = b"ssh:ssix-test";

    fn put_string(out: &mut Vec<u8>, value: &[u8]) {
        out.extend_from_slice(&(value.len() as u32).to_be_bytes());
        out.extend_from_slice(value);
    }

    /// A key held by the stand-in agent.
    #[derive(Clone)]
    struct TestKey {
        signing: SigningKey,
        security_key: bool,
        comment: String,
    }

    impl TestKey {
        fn new(seed: [u8; 32], security_key: bool, comment: &str) -> Self {
            Self {
                signing: SigningKey::from_bytes(&seed),
                security_key,
                comment: comment.to_string(),
            }
        }

        fn algorithm(&self) -> &'static [u8] {
            if self.security_key {
                b"sk-ssh-ed25519@openssh.com"
            } else {
                b"ssh-ed25519"
            }
        }

        fn blob(&self) -> Vec<u8> {
            let mut blob = Vec::new();
            put_string(&mut blob, self.algorithm());
            put_string(&mut blob, self.signing.verifying_key().as_bytes());
            if self.security_key {
                put_string(&mut blob, APPLICATION);
            }
            blob
        }

        fn authorized_keys_line(&self) -> String {
            format!(
                "{} {} {}",
                String::from_utf8_lossy(self.algorithm()),
                base64::engine::general_purpose::STANDARD.encode(self.blob()),
                self.comment
            )
        }

        /// The agent's signature blob for `data`.
        fn sign(&self, data: &[u8]) -> Vec<u8> {
            let mut signature = Vec::new();
            put_string(&mut signature, self.algorithm());
            if self.security_key {
                // PROTOCOL.u2f: the key signs these hashes, not the data.
                let (flags, counter) = (0x01u8, 7u32);
                let mut signed = Sha256::digest(APPLICATION).to_vec();
                signed.push(flags);
                signed.extend(counter.to_be_bytes());
                signed.extend(Sha256::digest(data));
                put_string(&mut signature, &self.signing.sign(&signed).to_bytes());
                signature.push(flags);
                signature.extend(counter.to_be_bytes());
            } else {
                put_string(&mut signature, &self.signing.sign(data).to_bytes());
            }
            signature
        }
    }

    /// One connection's worth of the agent protocol: list keys, sign.
    fn serve_agent_connection(mut client: UnixStream, keys: &[TestKey], signing_takes: Duration) {
        loop {
            let mut len = [0u8; 4];
            if client.read_exact(&mut len).is_err() {
                return;
            }
            let mut message = vec![0u8; u32::from_be_bytes(len) as usize];
            if client.read_exact(&mut message).is_err() {
                return;
            }
            let mut reply = Vec::new();
            match message.first() {
                Some(11) => {
                    reply.push(12);
                    reply.extend((keys.len() as u32).to_be_bytes());
                    for key in keys {
                        put_string(&mut reply, &key.blob());
                        put_string(&mut reply, key.comment.as_bytes());
                    }
                }
                Some(13) => {
                    thread::sleep(signing_takes);
                    let (blob, rest) = ssh_string(&message[1..]).expect("key blob");
                    let (data, _) = ssh_string(rest).expect("data");
                    match keys.iter().find(|key| key.blob() == blob) {
                        Some(key) => {
                            reply.push(14);
                            put_string(&mut reply, &key.sign(data));
                        }
                        None => reply.push(5),
                    }
                }
                _ => reply.push(5),
            }
            let mut framed = (reply.len() as u32).to_be_bytes().to_vec();
            framed.extend(reply);
            if client.write_all(&framed).is_err() {
                return;
            }
        }
    }

    struct TestAgent {
        dir: PathBuf,
        socket: PathBuf,
    }

    impl Drop for TestAgent {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// Serve `keys` over a Unix socket until the test process exits.
    fn start_agent(keys: Vec<TestKey>) -> TestAgent {
        start_slow_agent(keys, Duration::ZERO)
    }

    /// As [`start_agent`], taking `signing_takes` to sign, as a touch does.
    fn start_slow_agent(keys: Vec<TestKey>, signing_takes: Duration) -> TestAgent {
        let dir =
            std::env::temp_dir().join(format!("ssix-{}", &uuid::Uuid::new_v4().to_string()[..8]));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("a.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        thread::spawn(move || {
            for client in listener.incoming().flatten() {
                let keys = keys.clone();
                thread::spawn(move || serve_agent_connection(client, &keys, signing_takes));
            }
        });
        TestAgent { dir, socket }
    }

    fn password_endpoint() -> Endpoint {
        let var =
            |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{} is not set", name));
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

    /// Run `command` on a blocking session and return its output.
    fn run(session: &Session, command: &str) -> String {
        let mut channel = session.channel_session().unwrap();
        channel.exec(command).unwrap();
        let mut output = String::new();
        channel.read_to_string(&mut output).unwrap();
        channel.wait_close().unwrap();
        output
    }

    /// Authorize `key` for the test user. Random keys never collide, and the
    /// file only grows by a line per run on a throwaway container.
    fn authorize(session: &Session, key: &TestKey) {
        run(
            session,
            &format!(
                "umask 077; mkdir -p ~/.ssh; printf '%s\\n' '{}' >> ~/.ssh/authorized_keys",
                key.authorized_keys_line()
            ),
        );
    }

    fn with_password_session(test: impl FnOnce(&Session)) {
        with_isolated_data_dir(|| {
            let session = open_authenticated_session(&password_endpoint(), 0, None).unwrap();
            test(&session);
        });
    }

    /// A session that has not logged in yet: the server's `publickey` method
    /// is what these tests exercise.
    fn unauthenticated_session() -> Session {
        let endpoint = password_endpoint();
        let tcp = std::net::TcpStream::connect(endpoint.addr()).unwrap();
        let mut session = Session::new().unwrap();
        session.set_timeout(crate::ssh::SESSION_TIMEOUT_MS);
        session.set_tcp_stream(tcp);
        session.handshake().unwrap();
        session
    }

    fn random_seed() -> [u8; 32] {
        let id = uuid::Uuid::new_v4();
        let mut seed = [0u8; 32];
        seed[..16].copy_from_slice(id.as_bytes());
        seed[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        seed
    }

    fn username() -> String {
        password_endpoint().username
    }

    fn debug() -> SshDebug {
        SshDebug::new(0, "live-test")
    }

    #[test]
    #[ignore = "needs a Unix SSH server (SSIX_LIVE_SSH)"]
    fn live_agent_login_with_ed25519_key() {
        let key = TestKey::new(random_seed(), false, "ssix-live-plain");
        let agent = start_agent(vec![key.clone()]);
        with_password_session(|session| authorize(session, &key));

        let session = unauthenticated_session();
        authenticate_via(&session, &username(), &debug(), Some(&agent.socket)).unwrap();
        assert!(session.authenticated());
        assert_eq!(session.timeout(), crate::ssh::SESSION_TIMEOUT_MS);
    }

    #[test]
    #[ignore = "needs a Unix SSH server (SSIX_LIVE_SSH)"]
    fn live_agent_login_tries_every_key() {
        let unknown = TestKey::new(random_seed(), false, "ssix-live-unknown");
        let known = TestKey::new(random_seed(), false, "ssix-live-known");
        let agent = start_agent(vec![unknown, known.clone()]);
        with_password_session(|session| authorize(session, &known));

        let session = unauthenticated_session();
        authenticate_via(&session, &username(), &debug(), Some(&agent.socket)).unwrap();
        assert!(session.authenticated());
    }

    #[test]
    #[ignore = "needs a Unix SSH server (SSIX_LIVE_SSH)"]
    fn live_agent_login_reports_an_empty_agent_and_refused_keys() {
        let agent = start_agent(vec![]);
        let session = unauthenticated_session();
        let failure =
            authenticate_via(&session, &username(), &debug(), Some(&agent.socket)).unwrap_err();
        assert!(matches!(failure, CredentialFailure::Local(_)));
        let error = failure.into_message();
        assert!(error.contains("Agent auth failed"), "{error}");
        assert!(error.contains("holds no keys"), "{error}");
        assert!(!crate::reconnect::is_retryable_connect_error(&error));

        let refused = TestKey::new(random_seed(), false, "ssix-live-refused");
        let agent = start_agent(vec![refused]);
        let session = unauthenticated_session();
        let failure =
            authenticate_via(&session, &username(), &debug(), Some(&agent.socket)).unwrap_err();
        assert!(matches!(failure, CredentialFailure::Refused(_)));
        let error = failure.into_message();
        assert!(error.contains("Agent auth failed"), "{error}");
        assert!(error.contains("accepted none of the 1 key(s)"), "{error}");
        assert!(!crate::reconnect::is_retryable_connect_error(&error));
    }

    #[test]
    #[ignore = "needs a Unix SSH server (SSIX_LIVE_SSH)"]
    fn live_agent_login_reports_a_missing_agent() {
        let session = unauthenticated_session();
        let missing = std::env::temp_dir().join("ssix-no-such-agent.sock");
        let failure =
            authenticate_via(&session, &username(), &debug(), Some(&missing)).unwrap_err();
        assert!(matches!(failure, CredentialFailure::Local(_)));
        let error = failure.into_message();
        assert!(error.contains("Agent auth failed"), "{error}");
        assert!(error.contains("Could not reach an SSH agent"), "{error}");
        assert!(!crate::reconnect::is_retryable_connect_error(&error));
    }

    /// A close while keys are offered can be a server counting them against
    /// `MaxAuthTries`, so it is not retried.
    #[test]
    #[ignore = "needs a Unix SSH server (SSIX_LIVE_SSH)"]
    fn live_agent_login_closed_while_keys_are_offered_is_not_retried() {
        let proxy = FreezingProxy::to(&password_endpoint().addr());
        let session = proxy.session();
        let refused = TestKey::new(random_seed(), false, "ssix-live-cut-off");
        let agent = start_agent(vec![refused]);
        proxy.freeze();
        proxy.cut_after(Duration::from_millis(300));

        let failure =
            authenticate_via(&session, &username(), &debug(), Some(&agent.socket)).unwrap_err();

        let error = failure.into_message();
        assert!(error.contains("Agent auth failed"), "{error}");
        assert!(!crate::reconnect::is_retryable_connect_error(&error));
    }

    /// More keys than `MaxAuthTries`: a real server hanging up on them.
    #[test]
    #[ignore = "needs a Unix SSH server (SSIX_LIVE_SSH)"]
    fn live_agent_login_cut_off_by_too_many_refused_keys_is_not_retried() {
        const MORE_THAN_SSHD_ALLOWS: usize = 8;
        let keys = (0..MORE_THAN_SSHD_ALLOWS)
            .map(|_| TestKey::new(random_seed(), false, "ssix-live-too-many"))
            .collect();
        let agent = start_agent(keys);
        let session = unauthenticated_session();

        let failure =
            authenticate_via(&session, &username(), &debug(), Some(&agent.socket)).unwrap_err();

        assert!(matches!(failure, CredentialFailure::Refused(_)));
        let error = failure.into_message();
        assert!(error.contains("Agent auth failed"), "{error}");
        assert!(!crate::reconnect::is_retryable_connect_error(&error));
    }

    /// A network that stops is not a refused key. With one key after another
    /// it used to end as "accepted none", which a reconnect does not retry.
    #[test]
    #[ignore = "needs a Unix SSH server (SSIX_LIVE_SSH)"]
    fn live_agent_login_stall_can_be_retried() {
        let proxy = FreezingProxy::to(&password_endpoint().addr());
        let session = proxy.session();
        let refused = TestKey::new(random_seed(), false, "ssix-live-stalled");
        let agent = start_agent(vec![refused]);
        let _ = crate::libssh2_ext::userauth_list(&session, &username());
        proxy.freeze();

        let started = Instant::now();
        let stall = Duration::from_secs(1);
        let failure = log_in(&session, &username(), &debug(), Some(&agent.socket), stall)
            .map_err(agent_failure)
            .unwrap_err();

        assert!(matches!(failure, CredentialFailure::Local(_)));
        let error = failure.into_message();
        assert_eq!(error, crate::login_wait::STALLED);
        assert!(crate::reconnect::is_retryable_connect_error(&error));
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(session.is_blocking());
    }

    /// Accepts connections and keeps them open without ever answering, until
    /// told to hang up.
    struct SilentAgent {
        socket: PathBuf,
        dir: PathBuf,
        held: Arc<Mutex<Vec<UnixStream>>>,
    }

    impl SilentAgent {
        fn start() -> Self {
            let dir = std::env::temp_dir()
                .join(format!("ssix-{}", &uuid::Uuid::new_v4().to_string()[..8]));
            std::fs::create_dir_all(&dir).unwrap();
            let socket = dir.join("s.sock");
            let listener = UnixListener::bind(&socket).unwrap();
            let held = Arc::new(Mutex::new(Vec::new()));
            let accepted = held.clone();
            thread::spawn(move || {
                for client in listener.incoming().flatten() {
                    accepted.lock().unwrap().push(client);
                }
            });
            Self { socket, dir, held }
        }

        fn hang_up(&self) {
            self.held.lock().unwrap().clear();
        }
    }

    impl Drop for SilentAgent {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting: {what}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    /// What the worker's watchdog depends on while the pump shares the socket.
    /// The bridge below sits idle, so all that moves is one keepalive reply.
    #[test]
    #[ignore = "needs a Unix SSH server (SSIX_LIVE_SSH)"]
    fn live_pump_passes_on_what_the_server_sent_and_nothing_else() {
        let agent = SilentAgent::start();
        with_password_session(|session| {
            let mut channel = session.channel_session().unwrap();
            request_forwarding_to(session, &mut channel, &debug(), &agent.socket);
            channel.exec("ssh-add -l").unwrap();
            let fd = crate::ssh::wake::fd_of(session);
            session.set_blocking(false);
            let pump = ForwardPump::start(session).expect("forwarding was not granted");
            assert!(!pump.serving());

            let mut buf = [0u8; 4096];
            let mut read_all = || {
                while channel.read(&mut buf).is_ok_and(|n| n > 0) {}
            };
            // The agent channel's arrival is noticed while something reads.
            wait_until("a channel to serve", || {
                read_all();
                pump.serving()
            });
            // `ssh-add` still has its request to send once the channel is open.
            let mut quiet_since = Instant::now();
            wait_until("the server to go quiet", || {
                read_all();
                if crate::ssh::wake::is_readable(fd) {
                    quiet_since = Instant::now();
                }
                quiet_since.elapsed() > Duration::from_secs(1)
            });

            // Silence: nothing left to report, however often the pump looks.
            pump.take_heard();
            thread::sleep(Duration::from_millis(200));
            assert!(!pump.take_heard(), "bytes that never came were reported");

            // The worker is not reading now, and the pump sees the reply.
            session.set_keepalive(true, 2);
            session.keepalive_send().unwrap();
            wait_until("the pump to see the reply", || pump.take_heard());

            // Read and gone from the socket, so it counts once and no more.
            read_all();
            pump.take_heard();
            thread::sleep(Duration::from_millis(200));
            assert!(!pump.take_heard(), "the same bytes were reported twice");

            agent.hang_up();
            wait_until("the bridge to end", || !pump.serving());
            drop(pump);
        });
    }

    /// A signature takes as long as the touch does, and libssh2 is inside its
    /// call meanwhile, on both of the paths a key can take.
    #[test]
    #[ignore = "needs a Unix SSH server (SSIX_LIVE_SSH)"]
    fn live_agent_signature_wait_is_not_a_stall() {
        for security_key in [false, true] {
            let key = TestKey::new(random_seed(), security_key, "ssix-live-touch");
            let agent = start_slow_agent(vec![key.clone()], Duration::from_secs(2));
            with_password_session(|session| authorize(session, &key));
            let session = unauthenticated_session();
            let stall = Duration::from_millis(500);
            log_in(&session, &username(), &debug(), Some(&agent.socket), stall).unwrap();
            assert!(session.authenticated());
        }
    }

    #[test]
    #[ignore = "needs a Unix SSH server (SSIX_LIVE_SSH)"]
    fn live_agent_login_with_software_security_key() {
        let key = TestKey::new(random_seed(), true, "ssix-live-sk");
        let agent = start_agent(vec![key.clone()]);
        with_password_session(|session| authorize(session, &key));

        let session = unauthenticated_session();
        authenticate_via(&session, &username(), &debug(), Some(&agent.socket)).unwrap();
        assert!(session.authenticated());
    }

    /// The reason `authenticate_security_key` exists: if this ever starts to
    /// pass after a libssh2 upgrade, that code can go.
    #[test]
    #[ignore = "needs a Unix SSH server (SSIX_LIVE_SSH)"]
    fn live_libssh2_agent_path_cannot_log_in_with_a_security_key() {
        let key = TestKey::new(random_seed(), true, "ssix-live-sk-libssh2");
        let agent_process = start_agent(vec![key.clone()]);
        with_password_session(|session| authorize(session, &key));

        let session = unauthenticated_session();
        let mut agent = session.agent().unwrap();
        agent.set_identity_path(&agent_process.socket).unwrap();
        agent.connect().unwrap();
        agent.list_identities().unwrap();
        let identities = agent.identities().unwrap();
        assert!(agent.userauth(&username(), &identities[0]).is_err());
        assert!(!session.authenticated());
    }

    /// Run `command` on a non-blocking channel the way a shell's worker reads
    /// it, with the forwarding pump running beside it.
    fn run_with_forwarding(socket: &std::path::Path, command: &str) -> String {
        let mut output = String::new();
        with_password_session(|session| {
            let mut channel = session.channel_session().unwrap();
            request_forwarding_to(session, &mut channel, &debug(), socket);
            channel.exec(command).unwrap();
            // As the shell's worker runs: keepalives go out next to the pump.
            session.set_keepalive(true, 1);
            let fd = crate::ssh::wake::fd_of(session);
            session.set_blocking(false);
            let pump = ForwardPump::start(session);
            assert!(pump.is_some(), "forwarding was not granted");

            let deadline = Instant::now() + Duration::from_secs(20);
            let mut buf = [0u8; 4096];
            loop {
                match channel.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => output.push_str(&String::from_utf8_lossy(&buf[..n])),
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "timed out; got {output:?}");
                        crate::ssh::send_due_keepalive(session, fd).unwrap();
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(e) => panic!("read failed: {e}"),
                }
            }
            drop(pump);
        });
        output
    }

    #[test]
    #[ignore = "needs a Unix SSH server (SSIX_LIVE_SSH)"]
    fn live_forwarded_agent_answers_on_the_server() {
        let key = TestKey::new(random_seed(), false, "ssix-live-forwarded");
        let agent = start_agent(vec![key]);
        // Several programs in a row, each a new agent channel.
        let output = run_with_forwarding(
            &agent.socket,
            "ssh-add -L; echo second; ssh-add -l; echo sock=$SSH_AUTH_SOCK",
        );
        assert_eq!(output.matches("ssix-live-forwarded").count(), 2, "{output}");
        assert!(output.contains("ssh-ed25519 "), "{output}");
        assert!(output.contains("sock=/"), "{output}");
    }

    #[test]
    #[ignore = "needs a Unix SSH server (SSIX_LIVE_SSH)"]
    fn live_forwarded_agent_handles_a_missing_local_agent() {
        let missing = std::env::temp_dir().join("ssix-no-such-agent.sock");
        let output = run_with_forwarding(&missing, "ssh-add -L; echo exit=$?");
        // The client gets an error, not a hang: the channel closes at once.
        assert!(
            output.contains("exit=") && !output.contains("exit=0"),
            "{output}"
        );
    }

    #[test]
    #[ignore = "needs a Unix SSH server (SSIX_LIVE_SSH)"]
    fn live_no_forwarding_unless_requested() {
        with_password_session(|session| {
            assert!(ForwardPump::start(session).is_none());
            let output = run(session, "echo sock=[$SSH_AUTH_SOCK]");
            assert!(output.contains("sock=[]"), "{output}");
        });
    }

    /// The server still reaches the pump when the shell uses it at the same
    /// time as a large transfer on the same session.
    #[test]
    #[ignore = "needs a Unix SSH server (SSIX_LIVE_SSH)"]
    fn live_forwarding_coexists_with_a_busy_session() {
        let key = TestKey::new(random_seed(), false, "ssix-live-busy");
        let agent = start_agent(vec![key]);
        let output = run_with_forwarding(
            &agent.socket,
            "head -c 2000000 /dev/zero | tr '\\0' x; echo; ssh-add -L; echo done",
        );
        assert!(output.contains("ssix-live-busy"), "{output}");
        assert!(output.trim_end().ends_with("done"), "{}", output.len());
        assert!(output.matches('x').count() >= 2_000_000);
    }

    /// Long enough for keepalives to go out between the agent's connections.
    /// Their answers stay queued in libssh2 for the life of the session, and
    /// must not stop the pump from seeing what arrives for its channels.
    #[test]
    #[ignore = "needs a Unix SSH server (SSIX_LIVE_SSH)"]
    fn live_forwarding_works_between_keepalives() {
        let key = TestKey::new(random_seed(), false, "ssix-live-keepalive");
        let agent = start_agent(vec![key]);
        let output = run_with_forwarding(
            &agent.socket,
            "for i in 1 2 3 4; do ssh-add -L; sleep 1; done; echo done",
        );
        assert_eq!(output.matches("ssix-live-keepalive").count(), 4, "{output}");
        assert!(output.trim_end().ends_with("done"), "{output}");
    }

    /// Stopping must not hang or leave the session unusable for what remains.
    #[test]
    #[ignore = "needs a Unix SSH server (SSIX_LIVE_SSH)"]
    fn live_pump_stops_promptly() {
        let agent = start_agent(vec![]);
        with_password_session(|session| {
            let mut channel = session.channel_session().unwrap();
            request_forwarding_to(session, &mut channel, &debug(), &agent.socket);
            channel.exec("sleep 5").unwrap();
            session.set_blocking(false);
            let pump = ForwardPump::start(session).expect("granted");
            let started = Instant::now();
            drop(pump);
            assert!(started.elapsed() < Duration::from_secs(2));
            assert!(ForwardPump::start(session).is_none());
        });
    }
}
