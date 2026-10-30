//! Run a script on an authenticated session.
//!
//! The interpreter (`sh -s`, `python3 -`, ...) is exec'd on the remote host
//! and the script body is written to its standard input, so the script never
//! touches the remote filesystem and needs no quoting. Output is collected
//! from both streams until the remote side closes the channel.
//!
//! The session runs non-blocking for the whole run: the setup timeout of a
//! blocking session would cut off any script that is quiet for 15 s, and
//! writing the body while reading output keeps a script that prints before
//! it has read all of its input from stalling on a full window.

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

/// Longest a script may run before the channel is closed on it.
pub const RUN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Longest the loop sleeps between checks when nothing happened.
const IDLE_WAIT: Duration = Duration::from_millis(100);

/// What one run of a script on one host produced.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct ScriptResult {
    pub stdout: String,
    pub stderr: String,
    /// The remote exit status; `None` when the script was killed by a
    /// signal or stopped at the time limit.
    pub exit_code: Option<i32>,
    /// The signal that ended the script, without the `SIG` prefix.
    pub exit_signal: Option<String>,
    #[cfg_attr(test, ts(type = "number"))]
    pub duration_ms: u64,
    /// Either stream went past `OUTPUT_CAP` and was cut there.
    pub truncated: bool,
    /// The script was still running at `RUN_TIMEOUT` and was stopped.
    pub timed_out: bool,
}

/// One output stream, kept up to `OUTPUT_CAP` bytes.
#[derive(Default)]
struct Capture {
    bytes: Vec<u8>,
    truncated: bool,
}

impl Capture {
    fn push(&mut self, chunk: &[u8]) {
        let room = OUTPUT_CAP.saturating_sub(self.bytes.len());
        let take = room.min(chunk.len());
        self.bytes.extend_from_slice(&chunk[..take]);
        if take < chunk.len() {
            self.truncated = true;
        }
    }

    fn text(&self) -> String {
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

/// Run `body` through `interpreter` on `session`, stopping it at `timeout`.
pub fn run(
    session: &Session,
    interpreter: &str,
    body: &str,
    timeout: Duration,
) -> Result<ScriptResult, String> {
    let started = Instant::now();
    let mut channel = session
        .channel_session()
        .map_err(|e| format!("Failed to open a channel: {}", e))?;
    channel
        .exec(interpreter)
        .map_err(|e| format!("Failed to start {}: {}", interpreter, e))?;

    session.set_blocking(false);
    let pumped = pump(session, &mut channel, body.as_bytes(), started + timeout);
    let (stdout, stderr, timed_out) = match pumped {
        Ok(out) => out,
        Err(e) => {
            close_channel(&mut channel);
            session.set_blocking(true);
            return Err(e);
        }
    };
    close_channel(&mut channel);
    session.set_blocking(true);

    let exit_signal = channel
        .exit_signal()
        .ok()
        .and_then(|s| s.exit_signal)
        .filter(|s| !s.is_empty());
    let exit_code = if timed_out || exit_signal.is_some() {
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
        timed_out,
    })
}

/// Feed `input` to the channel and collect both output streams until the
/// remote side sends EOF or `deadline` passes. Returns stdout, stderr and
/// whether the deadline was hit.
fn pump(
    session: &Session,
    channel: &mut Channel,
    mut input: &[u8],
    deadline: Instant,
) -> Result<(Capture, Capture, bool), String> {
    let fds = [wake::fd_of(session)];
    let mut stdout = Capture::default();
    let mut stderr = Capture::default();
    let mut buf = vec![0u8; 32 * 1024];
    let mut eof_sent = false;

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
            return Ok((stdout, stderr, false));
        }
        let now = Instant::now();
        if now >= deadline {
            return Ok((stdout, stderr, true));
        }
        if !progressed {
            wake::wait_readable(&fds, IDLE_WAIT.min(deadline - now));
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
