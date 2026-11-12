//! What a shell session does after its connection died: wait, try again with
//! exponential backoff, and stop for good reasons. Runs on the session's own
//! worker thread, so the session keeps its id, its output channel and the
//! terminal's scrollback across reconnects. See `docs/session-resilience.md`.
//!
//! An attempt runs on a helper thread because connecting can block for tens
//! of seconds, and Cancel and closing the pane must not wait for it. A
//! cancelled attempt is told to stop, which it checks before logging in, while
//! a login prompt waits, and before running the login command. Whatever it
//! still opens is dropped.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, TryRecvError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crate::ssh::{ControlRx, OutputEvent, SessionMsg};

/// Delay before the first attempt. Each later attempt waits twice as long.
const FIRST_DELAY_SECS: u64 = 2;
const MAX_DELAY_SECS: u64 = 60;
/// How often a worker checks whether a running attempt has finished.
const ATTEMPT_POLL: Duration = Duration::from_millis(50);
/// How long a shell has to stay up for the count of attempts to start over.
pub(crate) const STABLE_SHELL: Duration = Duration::from_secs(60);

/// Errors from connecting that can go away by themselves. Everything else,
/// above all an authentication or host-key failure, stops the retries: with
/// an allow-list, a failure nobody thought of is never retried against a
/// server that may lock the account. Each entry is part of a message from
/// `ssh.rs`; jump hosts wrap them, so they are searched anywhere.
const RETRYABLE_ERRORS: [&str; 13] = [
    "Failed to resolve",
    "No addresses resolved",
    "TCP connect to",
    "SSH handshake with",
    "Channel open failed",
    "PTY request failed",
    "Shell request failed",
    "channel_direct_tcpip failed",
    "Failed to connect inner SSH session",
    "via jump host timed out",
    "forwarder exited",
    crate::login_wait::STALLED,
    crate::login_wait::LOST,
];

pub(crate) fn is_retryable_connect_error(message: &str) -> bool {
    RETRYABLE_ERRORS.iter().any(|known| message.contains(known))
}

/// Exponential backoff: 2 s, 4 s, 8 s, … up to a minute.
pub(crate) fn reconnect_delay(attempt: u8) -> Duration {
    let doublings = u32::from(attempt.saturating_sub(1));
    let secs = FIRST_DELAY_SECS
        .checked_shl(doublings)
        .unwrap_or(MAX_DELAY_SECS);
    Duration::from_secs(secs.min(MAX_DELAY_SECS))
}

/// Opens a shell again. The flag is set once nobody wants the result.
pub type OpenAttempt<S> = Arc<dyn Fn(Arc<AtomicBool>) -> Result<S, String> + Send + Sync>;

/// Whether and how often a dropped session reconnects by itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReconnectPolicy {
    pub enabled: bool,
    pub max_attempts: u8,
}

/// The automatic attempts used so far. It outlives a reopened shell: a server
/// that accepts a login and drops it straight away would otherwise be retried
/// forever, with the backoff starting over each time.
#[derive(Default)]
pub(crate) struct AttemptCount(u8);

impl AttemptCount {
    /// A shell that lasted starts the count over.
    pub(crate) fn shell_ended(&mut self, lasted: Duration) {
        if lasted >= STABLE_SHELL {
            self.0 = 0;
        }
    }
}

/// What the user asked for while a session was disconnected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UserAction {
    Close,
    Cancel,
    RetryNow,
}

/// Wait on the control queue for `timeout`, forever when `None`. Returns
/// `None` when the time is up. Keystrokes typed meanwhile are discarded: they
/// were meant for a shell that is gone, and replaying them into a new one
/// could run a command the user no longer wants. The latest size is kept for
/// the new shell.
fn wait_for_user(
    control: &ControlRx,
    timeout: Option<Duration>,
    pty_size: &mut Option<(u32, u32)>,
) -> Option<UserAction> {
    let deadline = timeout.map(|t| Instant::now() + t);
    loop {
        let message = match deadline {
            Some(deadline) => {
                match control
                    .rx
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                {
                    Ok(message) => message,
                    Err(RecvTimeoutError::Timeout) => return None,
                    Err(RecvTimeoutError::Disconnected) => return Some(UserAction::Close),
                }
            }
            None => match control.rx.recv() {
                Ok(message) => message,
                Err(_) => return Some(UserAction::Close),
            },
        };
        match message {
            SessionMsg::Write(_) => {}
            SessionMsg::Resize { cols, rows } => *pty_size = Some((cols, rows)),
            SessionMsg::Disconnect => return Some(UserAction::Close),
            SessionMsg::CancelReconnect => return Some(UserAction::Cancel),
            SessionMsg::Reconnect => return Some(UserAction::RetryNow),
        }
    }
}

/// A shell an attempt opened that nobody wants any more, as when the user
/// cancelled or closed while it was opening. Dropping it is not enough: see
/// `OpenShell`'s implementation.
pub(crate) trait Discard {
    fn discard(self);
}

enum Attempt<S> {
    Opened(S),
    Failed(String),
    Interrupted(UserAction),
}

/// Run `open` once on a helper thread, staying responsive to the user.
fn run_attempt<S: Discard + Send + 'static>(
    open: &OpenAttempt<S>,
    control: &ControlRx,
    pty_size: &mut Option<(u32, u32)>,
) -> Attempt<S> {
    let (tx, rx) = mpsc::channel();
    let open = Arc::clone(open);
    let cancelled = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&cancelled);
    thread::spawn(move || {
        // The worker is gone when it cancelled or closed: nobody takes the shell.
        if let Err(mpsc::SendError(Ok(shell))) = tx.send(open(flag)) {
            shell.discard();
        }
    });
    loop {
        match rx.try_recv() {
            Ok(Ok(shell)) => {
                // Clear what piled up since the last check, so a late
                // keystroke cannot reach the new shell.
                return match wait_for_user(control, Some(Duration::ZERO), pty_size) {
                    Some(action @ (UserAction::Close | UserAction::Cancel)) => {
                        shell.discard();
                        Attempt::Interrupted(action)
                    }
                    Some(UserAction::RetryNow) | None => Attempt::Opened(shell),
                };
            }
            Ok(Err(message)) => return Attempt::Failed(message),
            Err(TryRecvError::Disconnected) => {
                return Attempt::Failed("The reconnect attempt stopped unexpectedly".to_string())
            }
            Err(TryRecvError::Empty) => {}
        }
        match wait_for_user(control, Some(ATTEMPT_POLL), pty_size) {
            Some(action @ (UserAction::Close | UserAction::Cancel)) => {
                cancelled.store(true, Ordering::SeqCst);
                return Attempt::Interrupted(action);
            }
            // Already attempting: nothing to do sooner.
            Some(UserAction::RetryNow) | None => {}
        }
    }
}

/// One session's way back from a dropped connection.
pub(crate) struct Recovery<'a, S> {
    pub policy: ReconnectPolicy,
    pub open: OpenAttempt<S>,
    pub control: &'a ControlRx,
    pub pty_size: &'a mut Option<(u32, u32)>,
    pub attempts: &'a mut AttemptCount,
    pub delay: fn(u8) -> Duration,
    pub emit: &'a dyn Fn(OutputEvent),
}

impl<S: Discard + Send + 'static> Recovery<'_, S> {
    /// Returns the new shell, or `None` once the user closed the session.
    /// When attempts run out, are cancelled or fail for good, this reports it
    /// and waits for the user: Retry tries once more, closing the pane ends.
    pub(crate) fn run(self, reason: String) -> Option<S> {
        let Recovery {
            policy,
            open,
            control,
            pty_size,
            attempts,
            delay,
            emit,
        } = self;
        let max_attempts = policy.max_attempts.max(1);
        let mut automatic = policy.enabled;
        let mut message = reason;
        loop {
            if automatic && attempts.0 < max_attempts {
                attempts.0 += 1;
                let wait = delay(attempts.0);
                emit(OutputEvent::Reconnecting {
                    attempt: attempts.0,
                    max_attempts,
                    delay_ms: wait.as_millis() as u64,
                    message: message.clone(),
                });
                match wait_for_user(control, Some(wait), pty_size) {
                    Some(UserAction::Close) => return None,
                    Some(UserAction::Cancel) => {
                        automatic = false;
                        continue;
                    }
                    Some(UserAction::RetryNow) | None => {}
                }
            } else {
                automatic = false;
                emit(OutputEvent::ReconnectStopped {
                    message: message.clone(),
                });
                loop {
                    match wait_for_user(control, None, pty_size) {
                        Some(UserAction::Close) => return None,
                        Some(UserAction::RetryNow) => break,
                        // Nothing is running to cancel.
                        Some(UserAction::Cancel) | None => {}
                    }
                }
                // Asking again gives the next drop its automatic attempts back.
                attempts.0 = 0;
                emit(OutputEvent::Reconnecting {
                    attempt: 1,
                    max_attempts: 1,
                    delay_ms: 0,
                    message: message.clone(),
                });
            }
            match run_attempt(&open, control, pty_size) {
                Attempt::Opened(shell) => return Some(shell),
                Attempt::Interrupted(UserAction::Close) => return None,
                Attempt::Interrupted(_) => automatic = false,
                Attempt::Failed(error) => {
                    automatic = automatic && is_retryable_connect_error(&error);
                    message = error;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::{control_channel, SessionHandle};
    use std::sync::atomic::AtomicU32;
    use std::sync::Mutex;

    const AUTH_FAILURE: &str = "Password auth failed: [Session(-18)] Authentication failed";
    const HOST_KEY_FAILURE: &str =
        "HOST_KEY_MISMATCH host=h port=22 fingerprint=SHA256:x\nThe host key has changed.";
    const NETWORK_FAILURE: &str = "TCP connect to h:22 failed: Connection refused";

    /// Shells given up on, named after what each test's attempt returned.
    static DISCARDED: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());

    impl Discard for &'static str {
        fn discard(self) {
            DISCARDED.lock().unwrap().push(self);
        }
    }

    fn discarded(shell: &str) -> bool {
        DISCARDED.lock().unwrap().contains(&shell)
    }

    fn instantly(_attempt: u8) -> Duration {
        Duration::ZERO
    }

    fn slowly(_attempt: u8) -> Duration {
        Duration::from_secs(600)
    }

    fn eventually(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            thread::sleep(Duration::from_millis(1));
        }
    }

    /// A recovery running on its own thread, with what it emitted so far.
    struct Harness {
        handle: SessionHandle,
        events: Arc<Mutex<Vec<String>>>,
        opens: Arc<AtomicU32>,
        finished: mpsc::Receiver<Option<&'static str>>,
    }

    impl Harness {
        fn start(
            policy: ReconnectPolicy,
            delay: fn(u8) -> Duration,
            results: impl Fn(u32) -> Result<&'static str, String> + Send + Sync + 'static,
        ) -> Self {
            Self::start_watching(policy, delay, move |n, _| results(n))
        }

        /// As `start`, for attempts that look at their cancel flag.
        fn start_watching(
            policy: ReconnectPolicy,
            delay: fn(u8) -> Duration,
            results: impl Fn(u32, &AtomicBool) -> Result<&'static str, String> + Send + Sync + 'static,
        ) -> Self {
            let (handle, control) = control_channel().unwrap();
            let events = Arc::new(Mutex::new(Vec::new()));
            let opens = Arc::new(AtomicU32::new(0));
            let (done, finished) = mpsc::channel();
            let (log, counter) = (Arc::clone(&events), Arc::clone(&opens));
            thread::spawn(move || {
                let mut pty_size = None;
                let mut attempts = AttemptCount::default();
                let emit = |event: OutputEvent| {
                    log.lock()
                        .unwrap()
                        .push(serde_json::to_string(&event).unwrap());
                };
                let open: OpenAttempt<&'static str> = Arc::new(move |cancelled| {
                    results(counter.fetch_add(1, Ordering::SeqCst) + 1, &cancelled)
                });
                let shell = Recovery {
                    policy,
                    open,
                    control: &control,
                    pty_size: &mut pty_size,
                    attempts: &mut attempts,
                    delay,
                    emit: &emit,
                }
                .run("gone".to_string());
                let _ = done.send(shell);
            });
            Self {
                handle,
                events,
                opens,
                finished,
            }
        }

        fn events(&self) -> Vec<String> {
            self.events.lock().unwrap().clone()
        }

        fn opens(&self) -> u32 {
            self.opens.load(Ordering::SeqCst)
        }

        fn wait_for_event(&self, needle: &str) {
            eventually(needle, || {
                self.events().iter().any(|event| event.contains(needle))
            });
        }

        fn finish(&self) -> Option<&'static str> {
            self.finished
                .recv_timeout(Duration::from_secs(10))
                .expect("the recovery should have finished")
        }

        /// The recovery parked after reporting a stop; closing ends it.
        fn close(&self) {
            self.handle.send(SessionMsg::Disconnect).unwrap();
            assert_eq!(self.finish(), None);
        }
    }

    const FIVE_TRIES: ReconnectPolicy = ReconnectPolicy {
        enabled: true,
        max_attempts: 5,
    };

    #[test]
    fn delays_double_up_to_a_minute() {
        let seconds: Vec<u64> = (1..=8).map(|a| reconnect_delay(a).as_secs()).collect();
        assert_eq!(seconds, [2, 4, 8, 16, 32, 60, 60, 60]);
        assert_eq!(reconnect_delay(u8::MAX).as_secs(), 60);
    }

    #[test]
    fn only_known_network_failures_are_retried() {
        for retryable in [
            "Failed to resolve h:22: nodename nor servname provided",
            "No addresses resolved for h:22",
            NETWORK_FAILURE,
            "SSH handshake with h:22 failed: [Session(-13)] disconnect",
            "Channel open failed: [Session(-7)] timeout",
            "PTY request failed: x",
            "Shell request failed: x",
            "Jump host j:22: TCP connect to j:22 failed: refused",
            "Target connect via jump host failed: channel_direct_tcpip failed: refused",
            "Target connect via jump host failed: SSH handshake with t:22 failed: x",
            "Target connect via jump host timed out after 25s",
            "Target connect via jump host failed: forwarder exited",
            "Failed to connect inner SSH session: refused",
            crate::login_wait::STALLED,
            crate::login_wait::LOST,
            "Jump host j:22: The connection was lost during login",
        ] {
            assert!(is_retryable_connect_error(retryable), "{retryable}");
        }
        for permanent in [
            AUTH_FAILURE,
            "Key auth failed: [Session(-19)] Username/PublicKey combination invalid",
            "Authentication failed",
            "SSH agent authentication is not available yet",
            "Jump host j:22: Password auth failed: x",
            "Target connect via jump host failed: Key auth failed: x",
            "Keyboard-interactive auth failed: [Session(-18)] Authentication failed",
            "Keyboard-interactive auth failed: [Session(-13)] socket disconnect",
            "Password auth failed: [Session(-13)] socket disconnect",
            "Password auth failed: [Session(-9)] Timed out waiting on socket",
            "Key auth failed: [Session(-19)] Waiting for publickey USERAUTH response",
            "Key auth failed: x. The server then stopped answering",
            "Key auth failed: x. The connection then closed",
            crate::auth_prompt::CANCELLED,
            crate::auth_prompt::TIMED_OUT,
            "Agent auth failed: Could not reach an SSH agent: refused",
            "Agent auth failed: The SSH agent holds no keys. Add one with ssh-add",
            "Agent auth failed: the server accepted none of the 1 key(s) in the SSH agent (x)",
            HOST_KEY_FAILURE,
            "Jump host j:22: HOST_KEY_MISMATCH host=j port=22 fingerprint=x",
            "h:22 did not present a host key",
            "Connection not found",
            "Credential c1 not found",
            "No credential configured for this connection",
            "Proxy command \"nc\" failed to start: not found",
            "some failure nobody anticipated",
        ] {
            assert!(!is_retryable_connect_error(permanent), "{permanent}");
        }
    }

    #[test]
    fn an_auth_failure_is_never_retried() {
        let h = Harness::start(FIVE_TRIES, instantly, |_| Err(AUTH_FAILURE.to_string()));
        h.wait_for_event("reconnect_stopped");
        thread::sleep(Duration::from_millis(50));
        assert_eq!(h.opens(), 1);
        assert!(h.events().last().unwrap().contains("Password auth failed"));
        h.close();
    }

    /// Someone who walks away from a prompt, cancels it or gets it wrong is
    /// not asked again until they press Retry. Each of these is what a spec
    /// (`/auth/i`) and the status bar read, so each has to say "auth" too.
    #[test]
    fn a_login_that_needed_an_answer_or_an_agent_is_never_retried() {
        for failure in [
            crate::auth_prompt::CANCELLED,
            crate::auth_prompt::TIMED_OUT,
            "Keyboard-interactive auth failed: [Session(-18)] Authentication failed",
            "Agent auth failed: The SSH agent holds no keys. Add one with ssh-add",
        ] {
            assert!(failure.to_lowercase().contains("auth"), "{failure}");
            let h = Harness::start(FIVE_TRIES, instantly, move |_| Err(failure.to_string()));
            h.wait_for_event("reconnect_stopped");
            thread::sleep(Duration::from_millis(50));
            assert_eq!(h.opens(), 1, "{failure}");
            assert!(h.events().last().unwrap().contains(failure), "{failure}");
            h.close();
        }
    }

    #[test]
    fn a_host_key_failure_is_never_retried() {
        let h = Harness::start(FIVE_TRIES, instantly, |_| Err(HOST_KEY_FAILURE.to_string()));
        h.wait_for_event("reconnect_stopped");
        thread::sleep(Duration::from_millis(50));
        assert_eq!(h.opens(), 1);
        assert!(h.events().last().unwrap().contains("HOST_KEY_MISMATCH"));
        h.close();
    }

    #[test]
    fn network_failures_are_retried_until_attempts_run_out() {
        let h = Harness::start(FIVE_TRIES, instantly, |_| Err(NETWORK_FAILURE.to_string()));
        h.wait_for_event("reconnect_stopped");
        assert_eq!(h.opens(), 5);
        let events = h.events();
        assert_eq!(events.len(), 6, "{events:?}");
        assert!(events[0].contains(r#""attempt":1,"max_attempts":5"#));
        assert!(events[0].contains("gone"), "the first message is the drop");
        assert!(events[4].contains(r#""attempt":5,"max_attempts":5"#));
        assert!(events[4].contains("Connection refused"));
        assert!(events[5].contains("Connection refused"));
        h.close();
    }

    #[test]
    fn a_session_returns_as_soon_as_an_attempt_works() {
        let h = Harness::start(FIVE_TRIES, instantly, |n| match n {
            3 => Ok("shell"),
            _ => Err(NETWORK_FAILURE.to_string()),
        });
        assert_eq!(h.finish(), Some("shell"));
        assert_eq!(h.opens(), 3);
        assert!(!h.events().iter().any(|e| e.contains("reconnect_stopped")));
    }

    /// A worker's whole life with a server that accepts the login and drops
    /// the shell after `lasted`, `drops` times at most. Returns how many shells
    /// it opened before running out of attempts.
    fn shells_opened_by_a_server_that_keeps_dropping(lasted: Duration, drops: u32) -> u32 {
        let (handle, control) = control_channel().unwrap();
        let opens = Arc::new(AtomicU32::new(0));
        let counter = Arc::clone(&opens);
        let open: OpenAttempt<&'static str> = Arc::new(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok("shell")
        });
        let mut attempts = AttemptCount::default();
        let mut pty_size = None;
        let stopper = handle.clone();
        for _ in 0..drops {
            // Out of attempts, a recovery parks for the user: closing ends it.
            let emit = |event: OutputEvent| {
                if matches!(event, OutputEvent::ReconnectStopped { .. }) {
                    stopper.send(SessionMsg::Disconnect).unwrap();
                }
            };
            let shell = Recovery {
                policy: ReconnectPolicy {
                    enabled: true,
                    max_attempts: 2,
                },
                open: Arc::clone(&open),
                control: &control,
                pty_size: &mut pty_size,
                attempts: &mut attempts,
                delay: instantly,
                emit: &emit,
            }
            .run("gone".to_string());
            if shell.is_none() {
                break;
            }
            attempts.shell_ended(lasted);
        }
        opens.load(Ordering::SeqCst)
    }

    #[test]
    fn shells_that_keep_dropping_use_up_the_attempts() {
        let short = STABLE_SHELL - Duration::from_secs(1);
        assert_eq!(shells_opened_by_a_server_that_keeps_dropping(short, 10), 2);
    }

    #[test]
    fn a_shell_that_stayed_up_starts_the_count_over() {
        assert_eq!(
            shells_opened_by_a_server_that_keeps_dropping(STABLE_SHELL, 10),
            10
        );
    }

    #[test]
    fn with_reconnect_off_nothing_is_tried_until_the_user_asks() {
        let off = ReconnectPolicy {
            enabled: false,
            max_attempts: 5,
        };
        let h = Harness::start(off, instantly, |_| Ok("shell"));
        h.wait_for_event("reconnect_stopped");
        thread::sleep(Duration::from_millis(50));
        assert_eq!(h.opens(), 0);
        assert!(h.events()[0].contains("gone"));

        h.handle.send(SessionMsg::Reconnect).unwrap();
        assert_eq!(h.finish(), Some("shell"));
        assert_eq!(h.opens(), 1);
    }

    #[test]
    fn retry_tries_once_more_after_a_permanent_failure() {
        let h = Harness::start(FIVE_TRIES, instantly, |n| match n {
            1 => Err(AUTH_FAILURE.to_string()),
            2 => Err(NETWORK_FAILURE.to_string()),
            _ => Ok("shell"),
        });
        h.wait_for_event("reconnect_stopped");
        assert_eq!(h.opens(), 1);

        // One manual try that fails stops again, however retryable the
        // failure, rather than resuming the automatic attempts.
        h.handle.send(SessionMsg::Reconnect).unwrap();
        eventually("the second stop", || {
            h.events()
                .last()
                .is_some_and(|e| e.contains("reconnect_stopped") && e.contains("refused"))
        });
        thread::sleep(Duration::from_millis(50));
        assert_eq!(h.opens(), 2);

        h.handle.send(SessionMsg::Reconnect).unwrap();
        assert_eq!(h.finish(), Some("shell"));
    }

    #[test]
    fn retry_gives_the_next_drop_its_attempts_back() {
        let (handle, control) = control_channel().unwrap();
        let mut attempts = AttemptCount(5);
        let mut pty_size = None;
        let stopper = handle.clone();
        let emit = |event: OutputEvent| {
            if matches!(event, OutputEvent::ReconnectStopped { .. }) {
                stopper.send(SessionMsg::Reconnect).unwrap();
            }
        };
        let shell = Recovery {
            policy: FIVE_TRIES,
            open: Arc::new(|_| Ok("shell")),
            control: &control,
            pty_size: &mut pty_size,
            attempts: &mut attempts,
            delay: instantly,
            emit: &emit,
        }
        .run("gone".to_string());
        assert_eq!(shell, Some("shell"));
        assert_eq!(attempts.0, 0);
    }

    #[test]
    fn cancel_during_the_wait_stops_without_trying() {
        let h = Harness::start(FIVE_TRIES, slowly, |_| Ok("shell"));
        h.wait_for_event("reconnecting");
        h.handle.send(SessionMsg::CancelReconnect).unwrap();
        h.wait_for_event("reconnect_stopped");
        assert_eq!(h.opens(), 0);
        h.close();
    }

    #[test]
    fn cancel_does_not_wait_for_a_running_attempt() {
        let (release, released) = mpsc::channel::<()>();
        let released = Mutex::new(released);
        let h = Harness::start(FIVE_TRIES, instantly, move |_| {
            // A connect stuck on a dead network.
            let _ = released.lock().unwrap().recv();
            Ok("late after cancel")
        });
        eventually("the attempt to start", || h.opens() == 1);

        h.handle.send(SessionMsg::CancelReconnect).unwrap();
        h.wait_for_event("reconnect_stopped");

        // The attempt finishing late changes nothing: its shell is given up.
        release.send(()).unwrap();
        eventually("the late shell to be given up", || {
            discarded("late after cancel")
        });
        assert!(h.finished.try_recv().is_err(), "still parked");
        h.close();
    }

    /// A recovery with an attempt that runs until it is told to stop, as one
    /// reaching its login would. `Receiver` hears when it was told.
    fn recovery_with_a_running_attempt() -> (Harness, mpsc::Receiver<()>) {
        let (told, heard) = mpsc::channel();
        let told = Mutex::new(told);
        let h = Harness::start_watching(FIVE_TRIES, instantly, move |_, cancelled| {
            eventually("the cancel flag", || cancelled.load(Ordering::SeqCst));
            told.lock().unwrap().send(()).unwrap();
            Err("cancelled".to_string())
        });
        eventually("the attempt to start", || h.opens() == 1);
        (h, heard)
    }

    #[test]
    fn cancel_tells_a_running_attempt_to_stop() {
        let (h, heard) = recovery_with_a_running_attempt();
        h.handle.send(SessionMsg::CancelReconnect).unwrap();
        heard.recv_timeout(Duration::from_secs(10)).unwrap();
        h.wait_for_event("reconnect_stopped");
        h.close();
    }

    #[test]
    fn closing_tells_a_running_attempt_to_stop() {
        let (h, heard) = recovery_with_a_running_attempt();
        h.close();
        heard.recv_timeout(Duration::from_secs(10)).unwrap();
    }

    #[test]
    fn closing_ends_the_wait_at_once() {
        let h = Harness::start(FIVE_TRIES, slowly, |_| Ok("shell"));
        h.wait_for_event("reconnecting");
        h.close();
        assert_eq!(h.opens(), 0);
    }

    #[test]
    fn closing_does_not_wait_for_a_running_attempt() {
        let (release, released) = mpsc::channel::<()>();
        let released = Mutex::new(released);
        let h = Harness::start(FIVE_TRIES, instantly, move |_| {
            let _ = released.lock().unwrap().recv();
            Ok("late after close")
        });
        eventually("the attempt to start", || h.opens() == 1);
        h.close();
        release.send(()).unwrap();
        eventually("the late shell to be given up", || {
            discarded("late after close")
        });
    }

    #[test]
    fn dropping_every_handle_counts_as_closing() {
        let h = Harness::start(FIVE_TRIES, slowly, |_| Ok("shell"));
        h.wait_for_event("reconnecting");
        let Harness {
            handle, finished, ..
        } = h;
        drop(handle);
        assert_eq!(
            finished.recv_timeout(Duration::from_secs(10)).unwrap(),
            None
        );
    }

    #[test]
    fn keystrokes_are_discarded_and_the_latest_size_is_kept() {
        let (handle, control) = control_channel().unwrap();
        handle
            .send(SessionMsg::Write(b"rm -rf /\n".to_vec()))
            .unwrap();
        handle
            .send(SessionMsg::Resize {
                cols: 100,
                rows: 30,
            })
            .unwrap();
        handle.send(SessionMsg::Write(b"x".to_vec())).unwrap();
        handle
            .send(SessionMsg::Resize {
                cols: 120,
                rows: 40,
            })
            .unwrap();
        let mut size = None;
        assert_eq!(
            wait_for_user(&control, Some(Duration::ZERO), &mut size),
            None
        );
        assert_eq!(size, Some((120, 40)));
        assert!(matches!(control.rx.try_recv(), Err(TryRecvError::Empty)));
    }
}
