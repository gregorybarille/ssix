//! Run a script on an authenticated session.
//!
//! The interpreter (`sh -s`, `python3 -`, ...) runs on the remote host and
//! the script body is written to its standard input, so the script never
//! touches the remote filesystem and needs no quoting. Output is collected
//! from both streams until the remote side closes the channel.
//!
//! On a POSIX host the interpreter is started through a POSIX `sh` that
//! first prints its PID on stdout (held back from the output). sshd starts
//! every session in a new process group led by that process, so the PID
//! names the group the script and everything it started belong to.
//!
//! On Windows the command line is read by cmd or PowerShell, whichever is
//! the server's default shell, so it carries only plain words: PowerShell
//! with a fixed `-EncodedCommand` bootstrap that prints its PID, reads the
//! body from stdin and runs it. Its errors are stripped of the colour codes
//! PowerShell 7 adds.
//!
//! The session runs non-blocking for the whole run: the setup timeout of a
//! blocking session would cut off any script that is quiet for 15 s, and
//! writing the body while reading output keeps a script that prints before
//! it has read all of its input from stalling on a full window.
//!
//! A run that is cancelled or reaches the time limit runs
//! `kill -s TERM -<group>` (or `taskkill /T /F /PID <pid>` on Windows) on a
//! second channel of the same session, waits briefly for the script to
//! exit, and then closes the channel. Closing the channel alone would leave
//! the script running, and libssh2 cannot send the SSH `signal` request on
//! a channel that has already started.

use crate::models::ScriptPlatform;
use crate::ssh::{close_channel, is_eagain, wake};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
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

/// Runs a Windows script: prints PowerShell's PID, then reads the body
/// from stdin as UTF-8 and runs it. The exit status is the script's `exit`,
/// else the last program's exit code; an uncaught error exits 1.
/// Written for Windows PowerShell 5.1 as well as PowerShell 7.
const POWERSHELL_BOOTSTRAP: &str = r#"$ProgressPreference = 'SilentlyContinue'
if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }
$utf8 = New-Object Text.UTF8Encoding -ArgumentList $false
try { [Console]::OutputEncoding = $utf8 } catch {}
$OutputEncoding = $utf8
[Console]::Out.WriteLine($PID)
[Console]::Out.Flush()
$body = (New-Object IO.StreamReader -ArgumentList ([Console]::OpenStandardInput()), $utf8).ReadToEnd()
$global:LASTEXITCODE = 0
& ([ScriptBlock]::Create($body))
exit $LASTEXITCODE
"#;

/// The command that starts the script, printing first the PID to stop it
/// by. On POSIX `sh` prints its PID, which leads the session's process
/// group, then runs the interpreter.
fn wrapped_command(platform: ScriptPlatform, interpreter: &str) -> String {
    match platform {
        ScriptPlatform::Posix => format!(
            "exec sh -c 'echo $$; {}'",
            interpreter.replace('\'', r"'\''")
        ),
        ScriptPlatform::Windows => {
            let utf16: Vec<u8> = POWERSHELL_BOOTSTRAP
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect();
            format!(
                "{} -NoProfile -NonInteractive -InputFormat Text -OutputFormat Text -EncodedCommand {}",
                interpreter,
                STANDARD.encode(utf16)
            )
        }
    }
}

/// The command that stops the script whose wrapper printed `pid`, and
/// everything it started.
fn stop_command(platform: ScriptPlatform, pid: u32) -> String {
    match platform {
        ScriptPlatform::Posix => format!("kill -s TERM -{}", pid),
        ScriptPlatform::Windows => format!("taskkill /T /F /PID {}", pid),
    }
}

/// `text` without SGR colour sequences (`ESC [ ... m`).
fn strip_colours(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("\x1b[") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let params = after
            .find(|c: char| !(c.is_ascii_digit() || c == ';'))
            .unwrap_or(after.len());
        if after[params..].starts_with('m') {
            rest = &after[params + 1..];
        } else {
            out.push('\x1b');
            rest = &rest[start + 1..];
        }
    }
    out.push_str(rest);
    out
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
    platform: ScriptPlatform,
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
        .exec(&wrapped_command(platform, interpreter))
        .map_err(|e| format!("Failed to start {}: {}", interpreter, e))?;

    session.set_blocking(false);
    let pumped = pump(
        session,
        platform,
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
    let (mut stdout_text, mut stderr_text) = (stdout.text(), stderr.text());
    if platform == ScriptPlatform::Windows {
        stdout_text = strip_colours(&stdout_text);
        stderr_text = strip_colours(&stderr_text);
    }
    Ok(ScriptResult {
        stdout: stdout_text,
        stderr: stderr_text,
        exit_code,
        exit_signal,
        duration_ms: started.elapsed().as_millis() as u64,
        truncated: stdout.truncated || stderr.truncated,
        timed_out: stop == Some(Stop::TimedOut),
        cancelled: stop == Some(Stop::Cancelled),
    })
}

/// Run `command` on a second channel to stop the script. Best effort: if
/// it fails, the script's channel is closed on it anyway.
fn stop_script(session: &Session, command: &str) {
    session.set_blocking(true);
    let _ = (|| -> Result<(), ssh2::Error> {
        let mut channel = session.channel_session()?;
        channel.exec(command)?;
        channel.send_eof()?;
        channel.wait_close()
    })();
    session.set_blocking(false);
}

/// Feed `input` to the channel and collect both output streams until the
/// remote side sends EOF. At `deadline`, or once `cancelled` returns true,
/// the script is stopped (`stop_command`) and gets `STOP_GRACE` to exit.
/// Returns stdout, stderr and why the run was stopped, if it was.
fn pump(
    session: &Session,
    platform: ScriptPlatform,
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
                // Without the PID there is nothing to stop: close now.
                give_up = now;
                if let Some(pid) = stdout.pid {
                    stop_script(session, &stop_command(platform, pid));
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
        let posix = |i| wrapped_command(ScriptPlatform::Posix, i);
        assert_eq!(posix("sh -s"), "exec sh -c 'echo $$; sh -s'");
        assert_eq!(
            posix("sudo -u 'app user' sh -s"),
            r"exec sh -c 'echo $$; sudo -u '\''app user'\'' sh -s'"
        );
    }

    /// The Windows command is plain words, short enough for cmd's 8191
    /// character limit, and carries the bootstrap as UTF-16LE base64.
    #[test]
    fn windows_command_encodes_the_bootstrap() {
        let command = wrapped_command(ScriptPlatform::Windows, "pwsh");
        let (head, encoded) = command.rsplit_once(' ').unwrap();
        assert_eq!(
            head,
            "pwsh -NoProfile -NonInteractive -InputFormat Text -OutputFormat Text -EncodedCommand"
        );
        assert!(command.len() < 8191, "{} characters", command.len());
        assert!(!command.contains(['"', '\'', '&', '|', '<', '>', '^', '%']));
        let bytes = STANDARD.decode(encoded).unwrap();
        let units: Vec<u16> = bytes
            .chunks(2)
            .map(|p| u16::from_le_bytes([p[0], p[1]]))
            .collect();
        assert_eq!(String::from_utf16(&units).unwrap(), POWERSHELL_BOOTSTRAP);
    }

    #[test]
    fn stop_command_fits_the_platform() {
        assert_eq!(stop_command(ScriptPlatform::Posix, 42), "kill -s TERM -42");
        assert_eq!(
            stop_command(ScriptPlatform::Windows, 42),
            "taskkill /T /F /PID 42"
        );
    }

    #[test]
    fn strip_colours_removes_sgr_only() {
        assert_eq!(
            strip_colours("\x1b[31;1mGet-Item: \x1b[31;1mnope\x1b[0m\n"),
            "Get-Item: nope\n"
        );
        // Other escapes, and a lone ESC, are left alone.
        assert_eq!(strip_colours("a\x1b[2Jb\x1b"), "a\x1b[2Jb\x1b");
        assert_eq!(strip_colours("plain"), "plain");
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
