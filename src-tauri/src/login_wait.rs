//! Waiting on the server during a login.
//!
//! A step of a login can take long for two reasons that need opposite handling:
//! someone is typing an answer or touching a security key, or the network
//! stopped. A blocking libssh2 call cannot tell them apart. Its timeout counts
//! from the start of the call, callbacks included, nothing can interrupt it, and
//! a reply that never comes ends as a failure that looks like a refusal.
//!
//! So the steps that can wait for a person, keyboard-interactive and the agent,
//! run non-blocking, and [`LoginWait`] waits on the socket between calls. libssh2
//! asks for an answer or a signature inside a call, so only silence from the
//! server counts here. It ends the step with [`STALLED`], a network failure that
//! a reconnect retries (`crate::reconnect`), and a cancelled attempt can stop at
//! any of these waits.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ssh2::{BlockDirections, Session};

use crate::ssh::{is_eagain, wake};

/// How long a server may stay silent before it has anyone to wait for.
pub(crate) const REQUEST_STALL: Duration = Duration::from_secs(15);
/// How long it may stay silent after an answer, which can be its cue to wait for
/// someone to approve a push on their phone. libssh2 gives up on a missing packet
/// after 60 s, with an error that looks like a refused answer, so this ends first.
pub(crate) const REPLY_STALL: Duration = Duration::from_secs(55);
/// Most time a step may spend on the server's side, however it keeps busy.
/// Stops a server that trickles bytes or starts round after round.
const STEP_LIMIT: Duration = Duration::from_secs(300);
/// How often a wait looks at the attempt's cancel flag.
const POLL: Duration = Duration::from_millis(100);

/// Says neither "auth" nor anything a login failure says: the failure view and
/// the retry rules both take it for what it is, a connection problem.
pub(crate) const STALLED: &str = "The server stopped answering during login";

/// Why a step stopped before libssh2 finished it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Interrupted {
    Cancelled,
    Stalled,
}

impl Interrupted {
    pub(crate) fn message(self) -> &'static str {
        match self {
            Self::Cancelled => crate::auth_prompt::CANCELLED,
            Self::Stalled => STALLED,
        }
    }
}

/// While this lives the session is non-blocking; dropping it restores blocking
/// mode, which the rest of the connection setup expects.
pub(crate) struct LoginWait<'a> {
    session: &'a Session,
    socket: wake::Fd,
    /// Set once nobody wants this attempt's result.
    cancelled: Option<Arc<AtomicBool>>,
    started: Instant,
    limit: Duration,
    /// How long the socket has been silent.
    quiet: Duration,
}

impl<'a> LoginWait<'a> {
    pub(crate) fn begin(session: &'a Session, cancelled: Option<Arc<AtomicBool>>) -> Self {
        session.set_blocking(false);
        Self {
            session,
            socket: wake::fd_of(session),
            cancelled,
            started: Instant::now(),
            limit: STEP_LIMIT,
            quiet: Duration::ZERO,
        }
    }

    /// Wait a moment for libssh2's next call to get somewhere, after it said
    /// `EAGAIN`. `stall` is how much silence to accept, and `not_counted` the time
    /// so far that was spent waiting for a person.
    pub(crate) fn pause(
        &mut self,
        stall: Duration,
        not_counted: Duration,
    ) -> Result<(), Interrupted> {
        let cancelled = self.cancelled.as_ref();
        if cancelled.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
            return Err(Interrupted::Cancelled);
        }
        if self.started.elapsed().saturating_sub(not_counted) >= self.limit {
            return Err(Interrupted::Stalled);
        }
        let waiting = Instant::now();
        match self.session.block_directions() {
            BlockDirections::Outbound => wake::wait_writable(self.socket, POLL.min(stall)),
            _ => wake::wait_readable(&[self.socket], POLL.min(stall)),
        }
        self.quiet = if wake::is_readable(self.socket) {
            Duration::ZERO
        } else {
            self.quiet + waiting.elapsed()
        };
        if self.quiet >= stall {
            return Err(Interrupted::Stalled);
        }
        Ok(())
    }

    /// Repeat `call` until libssh2 has an answer other than `EAGAIN`.
    pub(crate) fn until_done<T>(
        &mut self,
        stall: Duration,
        mut call: impl FnMut() -> Result<T, ssh2::Error>,
    ) -> Result<Result<T, ssh2::Error>, Interrupted> {
        loop {
            match call() {
                Err(e) if is_eagain(&e) => self.pause(stall, Duration::ZERO)?,
                finished => return Ok(finished),
            }
        }
    }
}

impl Drop for LoginWait<'_> {
    fn drop(&mut self) {
        self.session.set_blocking(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::{TcpListener, TcpStream};

    /// A session on a socket, and the socket's other end.
    fn session_and_peer() -> (Session, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (peer, _) = listener.accept().unwrap();
        let mut session = Session::new().unwrap();
        session.set_tcp_stream(client);
        (session, peer)
    }

    #[test]
    fn a_silent_server_stalls_once_the_limit_has_passed() {
        let (session, _peer) = session_and_peer();
        let mut wait = LoginWait::begin(&session, None);
        let stall = Duration::from_millis(300);
        let started = Instant::now();
        let outcome = loop {
            if let Err(stopped) = wait.pause(stall, Duration::ZERO) {
                break stopped;
            }
            assert!(started.elapsed() < Duration::from_secs(5), "never stalled");
        };
        assert_eq!(outcome, Interrupted::Stalled);
        assert!(started.elapsed() >= stall);
    }

    #[test]
    fn something_to_read_is_not_silence() {
        let (session, mut peer) = session_and_peer();
        let mut wait = LoginWait::begin(&session, None);
        let stall = Duration::from_millis(100);
        peer.write_all(b"x").unwrap();
        let started = Instant::now();
        while started.elapsed() < stall * 3 {
            wait.pause(stall, Duration::ZERO).unwrap();
        }
    }

    #[test]
    fn time_between_waits_is_not_silence() {
        let (session, _peer) = session_and_peer();
        let mut wait = LoginWait::begin(&session, None);
        let stall = Duration::from_millis(350);
        wait.pause(stall, Duration::ZERO).unwrap();
        // Where libssh2 would be waiting for a person, inside its call.
        std::thread::sleep(stall * 2);
        wait.pause(stall, Duration::ZERO).unwrap();
    }

    #[test]
    fn a_cancelled_attempt_stops_waiting() {
        let (session, _peer) = session_and_peer();
        let flag = Arc::new(AtomicBool::new(false));
        let mut wait = LoginWait::begin(&session, Some(flag.clone()));
        wait.pause(REPLY_STALL, Duration::ZERO).unwrap();
        flag.store(true, Ordering::SeqCst);
        assert_eq!(
            wait.pause(REPLY_STALL, Duration::ZERO),
            Err(Interrupted::Cancelled)
        );
    }

    #[test]
    fn a_step_cannot_outlast_its_limit_except_while_someone_answers() {
        let (session, mut peer) = session_and_peer();
        let mut wait = LoginWait::begin(&session, None);
        peer.write_all(b"x").unwrap();
        wait.limit = Duration::from_millis(50);
        std::thread::sleep(wait.limit * 2);
        assert_eq!(
            wait.pause(REPLY_STALL, Duration::ZERO),
            Err(Interrupted::Stalled)
        );
        wait.pause(REPLY_STALL, Duration::from_secs(60)).unwrap();
    }

    #[test]
    fn the_session_is_blocking_again_afterwards() {
        let (session, _peer) = session_and_peer();
        let wait = LoginWait::begin(&session, None);
        assert!(!session.is_blocking());
        drop(wait);
        assert!(session.is_blocking());
    }

    #[test]
    fn only_a_stall_is_a_failure_to_retry() {
        assert!(!STALLED.to_lowercase().contains("auth"));
        assert!(crate::reconnect::is_retryable_connect_error(
            Interrupted::Stalled.message()
        ));
        assert!(!crate::reconnect::is_retryable_connect_error(
            Interrupted::Cancelled.message()
        ));
    }

    #[test]
    fn a_stall_after_an_answer_comes_before_libssh2_gives_up() {
        const LIBSSH2_PACKET_READ_TIMEOUT: Duration = Duration::from_secs(60);
        assert!(REPLY_STALL < LIBSSH2_PACKET_READ_TIMEOUT);
    }
}

/// A relay between a test's session and a real server that can stop relaying,
/// which is what a network that stops answering looks like from here.
#[cfg(test)]
pub(crate) mod test_support {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    use ssh2::Session;

    pub(crate) struct FreezingProxy {
        addr: SocketAddr,
        pub(crate) frozen: Arc<AtomicBool>,
        stop: Arc<AtomicBool>,
    }

    fn relay(
        mut from: TcpStream,
        mut to: TcpStream,
        frozen: Arc<AtomicBool>,
        stop: Arc<AtomicBool>,
    ) {
        from.set_read_timeout(Some(Duration::from_millis(20)))
            .unwrap();
        let mut buffer = [0u8; 16 * 1024];
        while !stop.load(Ordering::SeqCst) {
            let n = match from.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    continue
                }
                Err(_) => break,
            };
            // Checked after the read: what arrives once frozen must not get through.
            while frozen.load(Ordering::SeqCst) {
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                thread::sleep(Duration::from_millis(10));
            }
            if to.write_all(&buffer[..n]).is_err() {
                break;
            }
        }
        let _ = to.shutdown(std::net::Shutdown::Both);
    }

    impl FreezingProxy {
        pub(crate) fn to(target: &str) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let frozen = Arc::new(AtomicBool::new(false));
            let stop = Arc::new(AtomicBool::new(false));
            let (relay_frozen, relay_stop) = (frozen.clone(), stop.clone());
            let target = target.to_string();
            thread::spawn(move || {
                let (client, _) = listener.accept().unwrap();
                let server = TcpStream::connect(&target).unwrap();
                let (client_copy, server_copy) =
                    (client.try_clone().unwrap(), server.try_clone().unwrap());
                let (frozen, stop) = (relay_frozen.clone(), relay_stop.clone());
                thread::spawn(move || relay(server_copy, client_copy, frozen, stop));
                relay(client, server, relay_frozen, relay_stop);
            });
            Self { addr, frozen, stop }
        }

        pub(crate) fn freeze(&self) {
            self.frozen.store(true, Ordering::SeqCst);
        }

        /// A session through this relay, ready for its login.
        pub(crate) fn session(&self) -> Session {
            let tcp = TcpStream::connect(self.addr).unwrap();
            let mut session = Session::new().unwrap();
            session.set_timeout(crate::ssh::SESSION_TIMEOUT_MS);
            session.set_tcp_stream(tcp);
            session.handshake().unwrap();
            session
        }
    }

    impl Drop for FreezingProxy {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
        }
    }
}
