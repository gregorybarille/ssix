//! Keyboard-interactive authentication, answered inside the terminal pane.
//!
//! This is how a 2FA or OTP server asks its questions. libssh2 calls back on
//! the thread that is authenticating; the callback sends the questions to the
//! pane over the session's output channel, as JSON next to its bytes (mirrored
//! by `AuthEvent` in `src/lib/authPrompt.ts`), and waits for `ssh_auth_answer`
//! or `ssh_auth_cancel`.
//!
//! Only a shell has a pane to ask in. `start_ssh_session`, `start_jump_shell`
//! and a reconnect attempt (`reopen_shell`) enter a [`PromptScope`] for the
//! thread doing the connecting, which is why `authenticate` needs no extra
//! parameter and why SCP, script runs and forwards refuse such a server with a
//! clear message.
//!
//! A reconnect attempt can be abandoned while a prompt waits: closing the pane
//! or cancelling the reconnect sets its flag, which ends the wait as Cancel
//! does. Every way out of a prompt fails the login with a message that says
//! "auth" and is not retryable (`crate::reconnect`), so nobody is asked again
//! and again by a connection they walked away from.
//!
//! Answers are passed along and dropped. Nothing here logs, stores or formats
//! them, and [`Reply`] has no `Debug` so that they cannot be logged by accident.

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use serde::Serialize;
use ssh2::{KeyboardInteractivePrompt, Prompt, Session};
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::ssh::{wake, Endpoint};
use crate::ssh_debug::SshDebug;

/// How long a pane may wait for an answer. A server usually gives up first
/// (OpenSSH's `LoginGraceTime` is two minutes).
const ANSWER_TIMEOUT: Duration = Duration::from_secs(300);
/// libssh2's timeout during the exchange. It counts from the start of the
/// call and includes the time spent in the callback, so the 15 s setup timeout
/// would fail any answer that took longer than that to type.
const EXCHANGE_TIMEOUT_MS: u32 = 900_000;
/// Longest server text passed on, per field. Anything longer is not a prompt.
const MAX_TEXT_CHARS: usize = 4096;
/// Longest answers accepted over IPC, in total.
const MAX_ANSWER_BYTES: usize = 64 * 1024;
/// How often a waiting prompt looks at its attempt's cancel flag.
const CANCEL_POLL: Duration = Duration::from_millis(100);

pub(crate) const CANCELLED: &str = "Authentication cancelled";
pub(crate) const TIMED_OUT: &str =
    "Authentication timed out waiting for an answer to the server's prompt";

enum Reply {
    Answers(Vec<String>),
    Cancelled,
}

struct Pending {
    reply: Sender<Reply>,
    fields: usize,
}

/// Prompts waiting for an answer, by the id sent to the pane.
static PENDING: LazyLock<DashMap<String, Pending>> = LazyLock::new(DashMap::new);

/// Deliver the answers for `prompt_id`. The prompt stays open when they are
/// refused, so a pane can try again.
pub(crate) fn answer(prompt_id: &str, answers: Vec<String>) -> Result<(), String> {
    let pending = PENDING
        .get(prompt_id)
        .ok_or("This prompt is no longer waiting for an answer")?;
    if answers.len() != pending.fields {
        return Err(format!(
            "The server asked for {} answers, not {}",
            pending.fields,
            answers.len()
        ));
    }
    if answers.iter().map(String::len).sum::<usize>() > MAX_ANSWER_BYTES {
        return Err("That answer is too long".to_string());
    }
    pending
        .reply
        .send(Reply::Answers(answers))
        .map_err(|_| "This prompt is no longer waiting for an answer".to_string())
}

/// Stop waiting for `prompt_id`, which ends its connection attempt.
pub(crate) fn cancel(prompt_id: &str) {
    if let Some(pending) = PENDING.get(prompt_id) {
        let _ = pending.reply.send(Reply::Cancelled);
    }
}

/// Where a prompt goes: the JSON of one event for the pane.
type Sink = Arc<dyn Fn(String) + Send + Sync>;

#[derive(Clone)]
struct Scope {
    sink: Sink,
    /// Set once nobody wants this attempt's result (`reconnect::OpenAttempt`).
    cancelled: Option<Arc<AtomicBool>>,
}

thread_local! {
    static SCOPE: RefCell<Option<Scope>> = const { RefCell::new(None) };
}

/// While this lives, connecting on this thread may ask questions in the pane
/// behind `output`. `cancelled`, when given, ends a waiting prompt once set.
pub(crate) struct PromptScope(());

impl PromptScope {
    pub(crate) fn enter(
        output: &Channel<InvokeResponseBody>,
        cancelled: Option<Arc<AtomicBool>>,
    ) -> Self {
        let output = output.clone();
        let sink: Sink = Arc::new(move |json| {
            let _ = output.send(InvokeResponseBody::Json(json));
        });
        Self::install(Scope { sink, cancelled })
    }

    fn install(scope: Scope) -> Self {
        SCOPE.with(|current| *current.borrow_mut() = Some(scope));
        Self(())
    }
}

impl Drop for PromptScope {
    fn drop(&mut self) {
        SCOPE.with(|scope| *scope.borrow_mut() = None);
    }
}

/// Whether this thread has a pane to ask in.
pub(crate) fn has_pane() -> bool {
    SCOPE.with(|scope| scope.borrow().is_some())
}

/// Run keyboard-interactive authentication, asking in this thread's pane. A
/// server that advertises the method and then asks nothing (no PAM behind it)
/// has only refused the credential, so `refused_before` stays the answer.
pub(crate) fn authenticate(
    session: &Session,
    endpoint: &Endpoint,
    debug: &SshDebug,
    refused_before: &str,
) -> Result<(), String> {
    let Scope { sink, cancelled } = SCOPE
        .with(|scope| scope.borrow().clone())
        .ok_or("Keyboard-interactive auth needs a terminal pane to ask in")?;
    let mut prompter = PanePrompter {
        sink,
        cancelled,
        asked: false,
        host: endpoint.addr(),
        username: endpoint.username.clone(),
        socket: Some(wake::fd_of(session)),
        timeout: ANSWER_TIMEOUT,
        instructions: String::new(),
        given_up: None,
        debug: debug.clone(),
    };
    let setup_timeout = session.timeout();
    session.set_timeout(EXCHANGE_TIMEOUT_MS);
    let result = session.userauth_keyboard_interactive(&endpoint.username, &mut prompter);
    session.set_timeout(setup_timeout);
    if let Some(reason) = prompter.given_up {
        return Err(reason.to_string());
    }
    match result {
        Err(_) if !prompter.asked => Err(refused_before.to_string()),
        other => other.map_err(|e| format!("Keyboard-interactive auth failed: {}", e)),
    }
}

#[derive(Serialize)]
struct PromptField {
    text: String,
    echo: bool,
}

/// One message for the pane; `src/lib/authPrompt.ts` parses them.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum AuthEvent<'a> {
    AuthPrompt {
        prompt_id: &'a str,
        host: &'a str,
        username: &'a str,
        instructions: &'a str,
        prompts: Vec<PromptField>,
    },
    AuthPromptClosed {
        prompt_id: &'a str,
    },
}

/// Server text as the pane shows it: control characters, which could only
/// disguise what is being asked, go. Line breaks and tabs stay.
fn printable(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .take(MAX_TEXT_CHARS)
        .collect()
}

struct PanePrompter {
    sink: Sink,
    /// Set once nobody wants this attempt's result.
    cancelled: Option<Arc<AtomicBool>>,
    /// Whether the server put a question to the user.
    asked: bool,
    host: String,
    username: String,
    /// The session's socket, to end the conversation when giving up.
    socket: Option<wake::Fd>,
    timeout: Duration,
    /// Text of a round with no questions, kept for the next one that has some.
    instructions: String,
    /// Set when the user or the timeout ended the exchange.
    given_up: Option<&'static str>,
    debug: SshDebug,
}

impl PanePrompter {
    fn send(&self, event: &AuthEvent<'_>) {
        if let Ok(json) = serde_json::to_string(event) {
            (self.sink)(json);
        }
    }

    /// Ask one round's questions and wait. `None` means the exchange is over.
    fn ask(&mut self, instructions: &str, prompts: &[Prompt<'_>]) -> Option<Vec<String>> {
        let prompt_id = uuid::Uuid::new_v4().to_string();
        let (reply, answers) = mpsc::channel();
        PENDING.insert(
            prompt_id.clone(),
            Pending {
                reply,
                fields: prompts.len(),
            },
        );
        let shown = std::mem::take(&mut self.instructions) + &printable(instructions);
        self.send(&AuthEvent::AuthPrompt {
            prompt_id: &prompt_id,
            host: &self.host,
            username: &self.username,
            instructions: &shown,
            prompts: prompts
                .iter()
                .map(|prompt| PromptField {
                    text: printable(&prompt.text),
                    echo: prompt.echo,
                })
                .collect(),
        });
        let received = self.wait_for_reply(&answers);
        PENDING.remove(&prompt_id);
        self.send(&AuthEvent::AuthPromptClosed {
            prompt_id: &prompt_id,
        });
        match received {
            Ok(answers) => Some(answers),
            Err(reason) => {
                self.give_up(reason);
                None
            }
        }
    }

    /// The answers, or why there will be none.
    fn wait_for_reply(&self, replies: &Receiver<Reply>) -> Result<Vec<String>, &'static str> {
        let deadline = Instant::now() + self.timeout;
        while !self.attempt_abandoned() {
            let left = deadline.saturating_duration_since(Instant::now());
            match replies.recv_timeout(left.min(CANCEL_POLL)) {
                Ok(Reply::Answers(answers)) => return Ok(answers),
                Ok(Reply::Cancelled) | Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) if left <= CANCEL_POLL => return Err(TIMED_OUT),
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
        Err(CANCELLED)
    }

    fn attempt_abandoned(&self) -> bool {
        self.cancelled
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::SeqCst))
    }

    /// End the conversation by closing the socket: libssh2 cannot abort from
    /// inside its callback, and sending blank answers instead would cost the
    /// user a failed attempt on servers that lock accounts after a few.
    fn give_up(&mut self, reason: &'static str) {
        self.given_up = Some(reason);
        #[cfg(unix)]
        if let Some(socket) = self.socket {
            // SAFETY: the socket belongs to the session this exchange runs on,
            // which is alive for the whole `userauth_keyboard_interactive` call
            // this runs inside. `shutdown` does not close the descriptor.
            unsafe {
                libc::shutdown(socket, libc::SHUT_RDWR);
            }
        }
        #[cfg(not(unix))]
        let _ = self.socket;
    }
}

impl KeyboardInteractivePrompt for PanePrompter {
    fn prompt<'a>(
        &mut self,
        _username: &str,
        instructions: &str,
        prompts: &[Prompt<'a>],
    ) -> Vec<String> {
        let blank = || vec![String::new(); prompts.len()];
        if self.attempt_abandoned() {
            self.give_up(CANCELLED);
        }
        if self.given_up.is_some() {
            return blank();
        }
        if prompts.is_empty() {
            // Nothing to answer, and no way to show it yet: libssh2 goes back
            // to the server as soon as this returns.
            self.instructions.push_str(&printable(instructions));
            return Vec::new();
        }
        self.asked = true;
        self.debug.at(1, || {
            format!("The server asks {} question(s).", prompts.len())
        });
        self.ask(instructions, prompts).unwrap_or_else(blank)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::borrow::Cow;
    use std::sync::Mutex;
    use std::thread;

    fn prompts(fields: &[(&'static str, bool)]) -> Vec<Prompt<'static>> {
        fields
            .iter()
            .map(|&(text, echo)| Prompt {
                text: Cow::Borrowed(text),
                echo,
            })
            .collect()
    }

    /// A prompter whose events land in a list, and that list.
    fn prompter(timeout: Duration) -> (PanePrompter, Arc<Mutex<Vec<serde_json::Value>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink_events = events.clone();
        let prompter = PanePrompter {
            sink: Arc::new(move |json| {
                let event = serde_json::from_str(&json).unwrap();
                sink_events.lock().unwrap().push(event);
            }),
            cancelled: None,
            asked: false,
            host: "host:22".into(),
            username: "me".into(),
            socket: None,
            timeout,
            instructions: String::new(),
            given_up: None,
            debug: SshDebug::new(0, "host:22"),
        };
        (prompter, events)
    }

    /// Wait for the next prompt event and return its id.
    fn wait_for_prompt(events: &Mutex<Vec<serde_json::Value>>) -> String {
        for _ in 0..500 {
            let found = events
                .lock()
                .unwrap()
                .iter()
                .rev()
                .find(|e| e["kind"] == "auth_prompt")
                .map(|e| e["prompt_id"].as_str().unwrap().to_string());
            if let Some(id) = found {
                if PENDING.contains_key(&id) {
                    return id;
                }
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("no prompt was sent");
    }

    #[test]
    fn sends_the_questions_and_returns_the_answers() {
        let (mut prompter, events) = prompter(Duration::from_secs(5));
        let watcher = events.clone();
        let responder = thread::spawn(move || {
            let id = wait_for_prompt(&watcher);
            answer(&id, vec!["alice".into(), "123456".into()]).unwrap();
        });

        let answers = prompter.prompt(
            "ignored",
            "Enter both",
            &prompts(&[("Login: ", true), ("OTP: ", false)]),
        );
        responder.join().unwrap();

        assert_eq!(answers, ["alice", "123456"]);
        assert!(prompter.given_up.is_none());
        let events = events.lock().unwrap();
        assert_eq!(events[0]["kind"], "auth_prompt");
        assert_eq!(events[0]["host"], "host:22");
        assert_eq!(events[0]["username"], "me");
        assert_eq!(events[0]["instructions"], "Enter both");
        assert_eq!(events[0]["prompts"][0]["text"], "Login: ");
        assert_eq!(events[0]["prompts"][0]["echo"], true);
        assert_eq!(events[0]["prompts"][1]["echo"], false);
        assert_eq!(events[1]["kind"], "auth_prompt_closed");
        assert_eq!(events[1]["prompt_id"], events[0]["prompt_id"]);
    }

    #[test]
    fn answers_never_reach_the_pane() {
        let (mut prompter, events) = prompter(Duration::from_secs(5));
        let watcher = events.clone();
        let responder = thread::spawn(move || {
            let id = wait_for_prompt(&watcher);
            answer(&id, vec!["hunter2-secret".into()]).unwrap();
        });
        prompter.prompt("", "", &prompts(&[("OTP: ", false)]));
        responder.join().unwrap();
        let sent = serde_json::to_string(&*events.lock().unwrap()).unwrap();
        assert!(!sent.contains("hunter2-secret"));
    }

    #[test]
    fn refuses_the_wrong_number_of_answers_and_keeps_waiting() {
        let (mut prompter, events) = prompter(Duration::from_secs(5));
        let watcher = events.clone();
        let responder = thread::spawn(move || {
            let id = wait_for_prompt(&watcher);
            let refused = answer(&id, vec![]).unwrap_err();
            assert!(refused.contains("asked for 1 answers"));
            let oversized = answer(&id, vec!["x".repeat(MAX_ANSWER_BYTES + 1)]).unwrap_err();
            assert!(oversized.contains("too long"));
            answer(&id, vec!["ok".into()]).unwrap();
        });
        let answers = prompter.prompt("", "", &prompts(&[("OTP: ", false)]));
        responder.join().unwrap();
        assert_eq!(answers, ["ok"]);
    }

    #[test]
    fn cancel_ends_the_exchange_with_blank_answers() {
        let (mut prompter, events) = prompter(Duration::from_secs(5));
        let watcher = events.clone();
        let responder = thread::spawn(move || cancel(&wait_for_prompt(&watcher)));
        let answers = prompter.prompt("", "", &prompts(&[("OTP: ", false)]));
        responder.join().unwrap();

        assert_eq!(answers, [""]);
        assert_eq!(prompter.given_up, Some(CANCELLED));
        // The server may ask again before it sees the socket close: nothing
        // more reaches the pane.
        let count = events.lock().unwrap().len();
        assert_eq!(prompter.prompt("", "", &prompts(&[("OTP: ", false)])), [""]);
        assert_eq!(events.lock().unwrap().len(), count);
    }

    #[test]
    fn stops_waiting_after_the_timeout_and_forgets_the_prompt() {
        let (mut prompter, events) = prompter(Duration::from_millis(20));
        let answers = prompter.prompt("", "", &prompts(&[("OTP: ", false)]));
        assert_eq!(answers, [""]);
        assert_eq!(prompter.given_up, Some(TIMED_OUT));
        let id = events.lock().unwrap()[0]["prompt_id"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(answer(&id, vec!["late".into()])
            .unwrap_err()
            .contains("no longer waiting"));
        assert_eq!(events.lock().unwrap().len(), 2);
    }

    #[test]
    fn a_cancelled_attempt_ends_a_waiting_prompt_and_closes_it() {
        let (mut prompter, events) = prompter(Duration::from_secs(60));
        let flag = Arc::new(AtomicBool::new(false));
        prompter.cancelled = Some(flag.clone());
        let watcher = events.clone();
        let canceller = thread::spawn(move || {
            let id = wait_for_prompt(&watcher);
            flag.store(true, Ordering::SeqCst);
            id
        });

        let started = Instant::now();
        let answers = prompter.prompt("", "", &prompts(&[("OTP: ", false)]));
        let id = canceller.join().unwrap();

        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(answers, [""]);
        assert_eq!(prompter.given_up, Some(CANCELLED));
        assert!(!PENDING.contains_key(&id));
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1]["kind"], "auth_prompt_closed");
        assert_eq!(events[1]["prompt_id"], id.as_str());
    }

    #[test]
    fn a_cancelled_attempt_asks_nothing() {
        let (mut prompter, events) = prompter(Duration::from_secs(60));
        prompter.cancelled = Some(Arc::new(AtomicBool::new(true)));
        assert_eq!(prompter.prompt("", "", &prompts(&[("OTP: ", false)])), [""]);
        assert_eq!(prompter.given_up, Some(CANCELLED));
        assert!(events.lock().unwrap().is_empty());
    }

    #[test]
    fn an_attempt_still_wanted_can_be_answered() {
        let (mut prompter, events) = prompter(Duration::from_secs(5));
        prompter.cancelled = Some(Arc::new(AtomicBool::new(false)));
        let watcher = events.clone();
        let responder = thread::spawn(move || {
            answer(&wait_for_prompt(&watcher), vec!["ok".into()]).unwrap();
        });
        assert_eq!(
            prompter.prompt("", "", &prompts(&[("OTP: ", false)])),
            ["ok"]
        );
        responder.join().unwrap();
        assert!(prompter.asked);
        assert!(prompter.given_up.is_none());
    }

    /// Whatever ends a prompt ends the reconnect too: asking again would have
    /// the pane nagging someone who already left, and each round can count
    /// against the account.
    #[test]
    fn giving_up_is_an_auth_failure_that_is_not_retried() {
        for reason in [CANCELLED, TIMED_OUT] {
            assert!(reason.to_lowercase().contains("auth"), "{reason}");
            assert!(!crate::reconnect::is_retryable_connect_error(reason));
        }
    }

    #[test]
    fn a_round_without_questions_is_not_asking() {
        let (mut prompter, _events) = prompter(Duration::from_secs(5));
        assert!(prompter.prompt("", "Nothing to ask.", &[]).is_empty());
        assert!(!prompter.asked);
    }

    #[test]
    fn a_round_without_questions_carries_its_text_to_the_next_one() {
        let (mut prompter, events) = prompter(Duration::from_secs(5));
        assert!(prompter
            .prompt("", "Your code expires soon.\n", &[])
            .is_empty());
        assert!(events.lock().unwrap().is_empty());

        let watcher = events.clone();
        let responder = thread::spawn(move || {
            let id = wait_for_prompt(&watcher);
            answer(&id, vec!["1".into()]).unwrap();
        });
        prompter.prompt("", "Enter it.", &prompts(&[("OTP: ", false)]));
        responder.join().unwrap();
        assert_eq!(
            events.lock().unwrap()[0]["instructions"],
            "Your code expires soon.\nEnter it."
        );
    }

    #[test]
    fn strips_control_characters_from_server_text() {
        assert_eq!(
            printable("\u{1b}[31mPass\u{7}word:\r\n\tnext"),
            "[31mPassword:\n\tnext"
        );
        assert_eq!(
            printable(&"x".repeat(MAX_TEXT_CHARS + 5)).len(),
            MAX_TEXT_CHARS
        );
    }

    #[test]
    fn answering_or_cancelling_an_unknown_prompt_is_harmless() {
        assert!(answer("no-such-prompt", vec![]).is_err());
        cancel("no-such-prompt");
    }

    #[test]
    fn a_scope_lasts_as_long_as_its_guard_and_only_on_its_thread() {
        assert!(!has_pane());
        let scope = PromptScope::install(Scope {
            sink: Arc::new(|_| {}),
            cancelled: None,
        });
        assert!(has_pane());
        assert!(!thread::spawn(has_pane).join().unwrap());
        drop(scope);
        assert!(!has_pane());
    }
}

/// Runs against a real server, so a plain `cargo test` skips it. Needs
/// `server-e` from `docker/docker-compose.yml` (keyboard-interactive only):
///
/// ```text
/// SSIX_LIVE_KBDINT_SSH=127.0.0.1:2205 SSIX_LIVE_KBDINT_USER=usere \
/// SSIX_LIVE_KBDINT_PASSWORD=passe cargo test live_keyboard -- --ignored --test-threads=1
/// ```
#[cfg(test)]
mod live {
    use super::*;
    use crate::ssh::{connect_endpoint, open_authenticated_session_over_stream, AuthMethod};
    use crate::storage::test_support::with_isolated_data_dir;
    use std::sync::Mutex;
    use std::thread;

    struct Target {
        host: String,
        port: u16,
        username: String,
        password: String,
    }

    /// The server to talk to, or `None` to skip: CI only starts `server-a`
    /// for the live tests, and the E2E suite covers this path on `server-e`.
    fn target() -> Option<Target> {
        let addr = std::env::var("SSIX_LIVE_KBDINT_SSH").ok()?;
        let (host, port) = addr.rsplit_once(':').expect("host:port");
        Some(Target {
            host: host.to_string(),
            port: port.parse().expect("port"),
            username: std::env::var("SSIX_LIVE_KBDINT_USER").ok()?,
            password: std::env::var("SSIX_LIVE_KBDINT_PASSWORD").ok()?,
        })
    }

    /// Connect with a credential whose password the server's password method
    /// would never see, answering each prompt with `respond`.
    fn connect(
        target: &Target,
        respond: impl Fn(&str) + Send + Sync + 'static,
    ) -> (Result<Session, String>, Vec<serde_json::Value>) {
        connect_with_password(target, "not-the-password", respond)
    }

    fn connect_with_password(
        target: &Target,
        saved_password: &str,
        respond: impl Fn(&str) + Send + Sync + 'static,
    ) -> (Result<Session, String>, Vec<serde_json::Value>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink_events = events.clone();
        let sink: Sink = Arc::new(move |json: String| {
            let event: serde_json::Value = serde_json::from_str(&json).unwrap();
            if event["kind"] == "auth_prompt" {
                let id = event["prompt_id"].as_str().unwrap().to_string();
                respond(&id);
            }
            sink_events.lock().unwrap().push(event);
        });
        let endpoint = Endpoint {
            host: target.host.clone(),
            port: target.port,
            username: target.username.clone(),
            auth: AuthMethod::Password(saved_password.into()),
            proxy_command: None,
        };
        let mut result = None;
        with_isolated_data_dir(|| {
            let _scope = PromptScope::install(Scope {
                sink,
                cancelled: None,
            });
            let tcp = connect_endpoint(&endpoint, 0).expect("tcp connect");
            result = Some(open_authenticated_session_over_stream(
                tcp, &endpoint, 0, None,
            ));
        });
        let sent = events.lock().unwrap().clone();
        (result.unwrap(), sent)
    }

    #[test]
    #[ignore = "needs a keyboard-interactive server (SSIX_LIVE_KBDINT_SSH)"]
    fn live_keyboard_interactive_answered_in_the_pane() {
        let Some(target) = target() else { return };
        let password = target.password.clone();
        let (session, events) = connect(&target, move |id| {
            let (id, password) = (id.to_string(), password.clone());
            thread::spawn(move || answer(&id, vec![password]).unwrap());
        });
        let session = session.expect("authenticated");
        assert!(session.authenticated());
        let prompt = &events[0];
        assert_eq!(prompt["kind"], "auth_prompt");
        assert_eq!(prompt["prompts"][0]["echo"], false);
        assert!(prompt["prompts"][0]["text"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .contains("password"));
        assert_eq!(events[1]["kind"], "auth_prompt_closed");
    }

    #[test]
    #[ignore = "needs a keyboard-interactive server (SSIX_LIVE_KBDINT_SSH)"]
    fn live_keyboard_interactive_wrong_answer_fails() {
        let Some(target) = target() else { return };
        let (session, _) = connect(&target, |id| {
            let id = id.to_string();
            thread::spawn(move || answer(&id, vec!["wrong".into()]).unwrap());
        });
        let error = session.err().expect("refused");
        assert!(
            error.contains("Keyboard-interactive auth failed"),
            "{error}"
        );
        assert!(!crate::reconnect::is_retryable_connect_error(&error));
    }

    #[test]
    #[ignore = "needs a keyboard-interactive server (SSIX_LIVE_KBDINT_SSH)"]
    fn live_keyboard_interactive_cancel_ends_at_once() {
        let Some(target) = target() else { return };
        let started = std::time::Instant::now();
        let (session, _) = connect(&target, |id| {
            let id = id.to_string();
            thread::spawn(move || cancel(&id));
        });
        assert_eq!(session.err().as_deref(), Some(CANCELLED));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    /// SCP, script runs and forwards have no pane to ask in.
    #[test]
    #[ignore = "needs a keyboard-interactive server (SSIX_LIVE_KBDINT_SSH)"]
    fn live_keyboard_interactive_without_a_pane_says_why() {
        let Some(target) = target() else { return };
        let endpoint = Endpoint {
            host: target.host.clone(),
            port: target.port,
            username: target.username.clone(),
            auth: AuthMethod::Password(target.password.clone()),
            proxy_command: None,
        };
        let mut result = None;
        with_isolated_data_dir(|| {
            let tcp = connect_endpoint(&endpoint, 0).expect("tcp connect");
            result = Some(open_authenticated_session_over_stream(
                tcp, &endpoint, 0, None,
            ));
        });
        let error = result.unwrap().err().expect("refused");
        assert!(
            error.contains("does not accept password"),
            "the saved password must not be tried: {error}"
        );
        assert!(error.contains("only a terminal pane"), "{error}");
    }

    /// The shape of a real 2FA login: a first factor the server accepts only
    /// partially, then its prompt. `server-e` does not do this by default, so
    /// this needs a second container from its image, off by default in CI:
    ///
    /// ```text
    /// docker run -d --rm --name ssix-2fa -p 2316:22 <server-e image> /usr/sbin/sshd.pam -D -e \
    ///   -o PasswordAuthentication=yes -o AuthenticationMethods=password,keyboard-interactive
    /// SSIX_LIVE_2FA_SSH=127.0.0.1:2316 cargo test live_keyboard_interactive_as_second -- \
    ///   --ignored --test-threads=1
    /// ```
    #[test]
    #[ignore = "needs a two-factor server (SSIX_LIVE_2FA_SSH)"]
    fn live_keyboard_interactive_as_second_factor() {
        let Ok(addr) = std::env::var("SSIX_LIVE_2FA_SSH") else {
            return;
        };
        let (host, port) = addr.rsplit_once(':').expect("host:port");
        let target = Target {
            host: host.to_string(),
            port: port.parse().expect("port"),
            username: "usere".to_string(),
            password: "passe".to_string(),
        };

        // The right first factor leads to the prompt, then to a login.
        let (session, events) = connect_with_password(&target, &target.password, |id| {
            let id = id.to_string();
            thread::spawn(move || answer(&id, vec!["passe".into()]).unwrap());
        });
        assert!(session.expect("authenticated").authenticated());
        assert_eq!(events[0]["kind"], "auth_prompt");

        // A wrong first factor leads nowhere: the server does not offer the
        // second step, so the pane is never asked and the password's own
        // error comes back.
        let (session, events) = connect(&target, |_| panic!("no prompt expected"));
        let error = session.err().expect("refused");
        assert!(error.contains("Password auth failed"), "{error}");
        assert!(events.is_empty());
    }
}
