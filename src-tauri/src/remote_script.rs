//! Run a script on an authenticated session.
//!
//! The interpreter (`sh -s`, `python3 -`, ...) runs on the remote host and
//! the script body is written to its standard input, so the script never
//! touches the remote filesystem and needs no quoting. Output is collected
//! from both streams until the remote side closes the channel.
//!
//! The interpreter is started through a POSIX `sh` that first prints its
//! PID on stdout (held back from the output). sshd starts every session in
//! a new process group led by that process, so the PID names the group the
//! script and everything it started belong to.
//!
//! The session runs non-blocking for the whole run: the setup timeout of a
//! blocking session would cut off any script that is quiet for 15 s, and
//! writing the body while reading output keeps a script that prints before
//! it has read all of its input from stalling on a full window.
//!
//! A run that is cancelled or reaches the time limit runs
//! `kill -s TERM -<group>` on a second channel of the same session, waits
//! briefly for the script to exit, and then closes the channel. Closing the
//! channel alone would leave the script running, and libssh2 cannot send
//! the SSH `signal` request on a channel that has already started.

use crate::ssh::{close_channel, is_eagain, wake};
use serde::Serialize;
use ssh2::{Channel, Session};
use std::io::{self, Read, Write};
use std::time::{Duration, Instant};
#[cfg(test)]
use ts_rs::TS;

/// Output kept per stream. The rest is still read, so the remote side never
/// blocks on a full window, and dropped.
pub const OUTPUT_CAP: usize = 1024 * 1024;

/// Longest a script may run before it is stopped.
pub const RUN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Longest the loop sleeps between checks when nothing happened. Also the
/// longest a cancel waits to be noticed.
const IDLE_WAIT: Duration = Duration::from_millis(100);

/// How long a stopped script gets to exit after SIGTERM before the channel
/// is closed on it.
const STOP_GRACE: Duration = Duration::from_secs(2);

/// Why a run ended before the script finished on its own.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Stop {
    TimedOut,
    Cancelled,
}

/// What one run of a script on one host produced.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct ScriptResult {
    pub stdout: String,
    pub stderr: String,
    /// The remote exit status; `None` when the script was killed by a
    /// signal, cancelled or stopped at the time limit.
    pub exit_code: Option<i32>,
    /// The signal that ended the script, without the `SIG` prefix.
    pub exit_signal: Option<String>,
    #[cfg_attr(test, ts(type = "number"))]
    pub duration_ms: u64,
    /// Either stream went past `OUTPUT_CAP` and was cut there.
    pub truncated: bool,
    /// The script was still running at `RUN_TIMEOUT` and was stopped.
    pub timed_out: bool,
    /// The user cancelled the run before the script finished.
    pub cancelled: bool,
}

/// Longest first line still taken for a PID.
const PID_LINE_MAX: usize = 20;

/// The command that starts `interpreter`: `sh` prints its PID, which leads
/// the session's process group, then runs the interpreter.
fn wrapped_command(interpreter: &str) -> String {
    format!(
        "exec sh -c 'echo $$; {}'",
        interpreter.replace('\'', r"'\''")
    )
}

/// One output stream, kept up to `OUTPUT_CAP` bytes.
#[derive(Default)]
struct Capture {
    bytes: Vec<u8>,
    truncated: bool,
    /// The first line while it is held back to be read as a PID.
    pid_line: Option<Vec<u8>>,
    pid: Option<u32>,
}

impl Capture {
    /// A stream whose first line is the PID printed by `wrapped_command`.
    fn with_pid_line() -> Self {
        Self {
            pid_line: Some(Vec::new()),
            ..Self::default()
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        let Some(line) = self.pid_line.as_mut() else {
            return self.keep(chunk);
        };
        match chunk.iter().position(|&b| b == b'\n') {
            Some(end) => {
                line.extend_from_slice(&chunk[..end]);
                let line = self.pid_line.take().unwrap_or_default();
                self.pid = std::str::from_utf8(&line)
                    .ok()
                    .and_then(|l| l.trim().parse().ok());
                if self.pid.is_none() {
                    // Not our PID line: it is output.
                    self.keep(&line);
                    self.keep(b"\n");
                }
                self.keep(&chunk[end + 1..]);
            }
            None => {
                line.extend_from_slice(chunk);
                if line.len() > PID_LINE_MAX {
                    self.release_pid_line();
                }
            }
        }
    }

    /// Give a held-back first line to the output.
    fn release_pid_line(&mut self) {
        if let Some(line) = self.pid_line.take() {
            self.keep(&line);
        }
    }

    fn keep(&mut self, chunk: &[u8]) {
        let room = OUTPUT_CAP.saturating_sub(self.bytes.len());
        let take = room.min(chunk.len());
        self.bytes.extend_from_slice(&chunk[..take]);
        if take < chunk.len() {
            self.truncated = true;
        }
    }

    fn text(&mut self) -> String {
        self.release_pid_line();
        String::from_utf8_lossy(&self.bytes).into_owned()
    }
}

/// Read everything `stream` has buffered into `capture`. Returns whether
/// any bytes arrived.
fn drain(stream: &mut impl Read, capture: &mut Capture, buf: &mut [u8]) -> Result<bool, String> {
    let mut got = false;
    loop {
        match stream.read(buf) {
            Ok(0) => return Ok(got),
            Ok(n) => {
                capture.push(&buf[..n]);
                got = true;
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(got),
            Err(e) => return Err(format!("Failed to read the script output: {}", e)),
        }
    }
}

/// Run `body` through `interpreter` on `session`. The script is stopped at
/// `timeout`, or as soon as `cancelled` returns true.
pub fn run(
    session: &Session,
    interpreter: &str,
    body: &str,
    timeout: Duration,
    cancelled: &dyn Fn() -> bool,
) -> Result<ScriptResult, String> {
    let started = Instant::now();
    // Connecting can take a while; a run cancelled meanwhile never starts.
    if cancelled() {
        return Ok(ScriptResult {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: None,
            exit_signal: None,
            duration_ms: 0,
            truncated: false,
            timed_out: false,
            cancelled: true,
        });
    }
    let mut channel = session
        .channel_session()
        .map_err(|e| format!("Failed to open a channel: {}", e))?;
    channel
        .exec(&wrapped_command(interpreter))
        .map_err(|e| format!("Failed to start {}: {}", interpreter, e))?;

    session.set_blocking(false);
    let pumped = pump(
        session,
        &mut channel,
        body.as_bytes(),
        started + timeout,
        cancelled,
    );
    close_channel(&mut channel);
    session.set_blocking(true);
    let (mut stdout, mut stderr, stop) = pumped?;

    let exit_signal = channel
        .exit_signal()
        .ok()
        .and_then(|s| s.exit_signal)
        .filter(|s| !s.is_empty());
    let exit_code = if stop.is_some() || exit_signal.is_some() {
        None
    } else {
        channel.exit_status().ok()
    };
    Ok(ScriptResult {
        stdout: stdout.text(),
        stderr: stderr.text(),
        exit_code,
        exit_signal,
        duration_ms: started.elapsed().as_millis() as u64,
        truncated: stdout.truncated || stderr.truncated,
        timed_out: stop == Some(Stop::TimedOut),
        cancelled: stop == Some(Stop::Cancelled),
    })
}

/// Send SIGTERM to process group `group` from a second channel. Best
/// effort: if it fails, the script's channel is closed on it anyway.
fn kill_group(session: &Session, group: u32) {
    session.set_blocking(true);
    let _ = (|| -> Result<(), ssh2::Error> {
        let mut channel = session.channel_session()?;
        channel.exec(&format!("kill -s TERM -{}", group))?;
        channel.send_eof()?;
        channel.wait_close()
    })();
    session.set_blocking(false);
}

/// Feed `input` to the channel and collect both output streams until the
/// remote side sends EOF. At `deadline`, or once `cancelled` returns true,
/// the script's process group gets SIGTERM and `STOP_GRACE` to exit.
/// Returns stdout, stderr and why the run was stopped, if it was.
fn pump(
    session: &Session,
    channel: &mut Channel,
    mut input: &[u8],
    deadline: Instant,
    cancelled: &dyn Fn() -> bool,
) -> Result<(Capture, Capture, Option<Stop>), String> {
    let fds = [wake::fd_of(session)];
    let mut stdout = Capture::with_pid_line();
    let mut stderr = Capture::default();
    let mut buf = vec![0u8; 32 * 1024];
    let mut eof_sent = false;
    let mut stop = None;
    let mut give_up = deadline;

    loop {
        let mut progressed = false;

        if !input.is_empty() {
            match channel.write(input) {
                Ok(n) => {
                    input = &input[n..];
                    progressed |= n > 0;
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                // The interpreter exited or closed its input without
                // reading all of it; what it printed still counts.
                Err(_) => {
                    input = &[];
                    eof_sent = true;
                }
            }
        }
        if input.is_empty() && !eof_sent {
            match channel.send_eof() {
                Ok(()) => {
                    eof_sent = true;
                    progressed = true;
                }
                Err(e) if is_eagain(&e) => {}
                Err(_) => eof_sent = true,
            }
        }

        progressed |= drain(channel, &mut stdout, &mut buf)?;
        progressed |= drain(&mut channel.stderr(), &mut stderr, &mut buf)?;

        if channel.eof() {
            // EOF follows the last data packet, so one more pass picks up
            // anything that arrived with it.
            drain(channel, &mut stdout, &mut buf)?;
            drain(&mut channel.stderr(), &mut stderr, &mut buf)?;
            return Ok((stdout, stderr, stop));
        }
        let now = Instant::now();
        if stop.is_none() {
            stop = if cancelled() {
                Some(Stop::Cancelled)
            } else if now >= deadline {
                Some(Stop::TimedOut)
            } else {
                None
            };
            if stop.is_some() {
                // Without the group there is nothing to signal: close now.
                give_up = now;
                if let Some(group) = stdout.pid {
                    kill_group(session, group);
                    give_up = Instant::now() + STOP_GRACE;
                }
                continue;
            }
        } else if now >= give_up {
            return Ok((stdout, stderr, stop));
        }
        if !progressed {
            wake::wait_readable(&fds, IDLE_WAIT.min(give_up.saturating_duration_since(now)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_keeps_output_up_to_the_cap() {
        let mut c = Capture::default();
        c.push(&vec![b'a'; OUTPUT_CAP - 2]);
        assert!(!c.truncated);
        c.push(b"bcde");
        assert_eq!(c.bytes.len(), OUTPUT_CAP);
        assert!(c.truncated);
        assert!(c.text().ends_with("aabc"));
        c.push(b"more");
        assert_eq!(c.bytes.len(), OUTPUT_CAP);
    }

    #[test]
    fn capture_takes_the_pid_line_out_of_the_output() {
        let mut c = Capture::with_pid_line();
        c.push(b"12");
        c.push(b"34\nhello\n");
        assert_eq!(c.pid, Some(1234));
        assert_eq!(c.text(), "hello\n");

        // A first line that is not a PID stays in the output.
        let mut c = Capture::with_pid_line();
        c.push(b"sh: not found\nmore");
        assert_eq!(c.pid, None);
        assert_eq!(c.text(), "sh: not found\nmore");

        // So does a long first line, and one that never ends.
        let mut c = Capture::with_pid_line();
        c.push(&[b'x'; PID_LINE_MAX + 1]);
        c.push(b"y");
        assert_eq!(c.text().len(), PID_LINE_MAX + 2);
        let mut c = Capture::with_pid_line();
        c.push(b"42");
        assert_eq!(c.text(), "42");
    }

    #[test]
    fn wrapped_command_quotes_the_interpreter() {
        assert_eq!(wrapped_command("sh -s"), "exec sh -c 'echo $$; sh -s'");
        assert_eq!(
            wrapped_command("sudo -u 'app user' sh -s"),
            r"exec sh -c 'echo $$; sudo -u '\''app user'\'' sh -s'"
        );
    }

    #[test]
    fn capture_text_replaces_invalid_utf8() {
        let mut c = Capture::default();
        c.push(b"ok \xff");
        assert_eq!(c.text(), "ok \u{fffd}");
    }

    /// `drain` reads until the stream would block and reports whether it
    /// got anything.
    #[test]
    fn drain_stops_on_would_block() {
        struct Chunks(Vec<io::Result<Vec<u8>>>);
        impl Read for Chunks {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                match self.0.remove(0) {
                    Ok(bytes) => {
                        buf[..bytes.len()].copy_from_slice(&bytes);
                        Ok(bytes.len())
                    }
                    Err(e) => Err(e),
                }
            }
        }
        let mut buf = [0u8; 16];
        let mut c = Capture::default();
        let mut s = Chunks(vec![
            Ok(b"he".to_vec()),
            Ok(b"llo".to_vec()),
            Err(io::ErrorKind::WouldBlock.into()),
        ]);
        assert!(drain(&mut s, &mut c, &mut buf).unwrap());
        assert_eq!(c.text(), "hello");

        let mut idle = Chunks(vec![Err(io::ErrorKind::WouldBlock.into())]);
        assert!(!drain(&mut idle, &mut c, &mut buf).unwrap());

        let mut broken = Chunks(vec![Err(io::ErrorKind::ConnectionReset.into())]);
        assert!(drain(&mut broken, &mut c, &mut buf).is_err());
    }
}
