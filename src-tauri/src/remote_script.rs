//! Run a script on an authenticated session.
//!
//! The interpreter (`sh -s`, `python3 -`, ...) runs on the remote host and
//! the script body is written to its standard input, so the script never
//! touches the remote filesystem and needs no quoting. Output is collected
//! from both streams until the remote side closes the channel.
//!
//! On a POSIX host the interpreter is started through a POSIX `sh` that
//! first prints a line with the run's marker and its PID on stdout (taken
//! out of the output; a login shell may print lines before it). sshd starts
//! every session in a new process group led by that process, so the PID
//! names the group the script and everything it started belong to.
//!
//! On Windows the command line is read by cmd or PowerShell, whichever is
//! the server's default shell, so it carries only plain words: PowerShell
//! with a fixed `-EncodedCommand` bootstrap. stdin carries a prelude, which
//! puts PowerShell in a new job object and starts a thread watching for the
//! run's stop file, and then the body. Its errors are stripped of the
//! colour codes PowerShell 7 adds.
//!
//! The session runs non-blocking for the whole run: the setup timeout of a
//! blocking session would cut off any script that is quiet for 15 s, and
//! writing the body while reading output keeps a script that prints before
//! it has read all of its input from stalling on a full window.
//!
//! A run that is cancelled or reaches the time limit is stopped, given
//! `STOP_GRACE` to exit, and then its channel is closed. Closing the channel
//! alone would leave the script running, and libssh2 cannot send the SSH
//! `signal` request on a channel that has already started. So on POSIX
//! `kill -s TERM -<group>` runs on a second channel of the same session; a
//! stop asked for before the PID line arrived waits for it. On Windows a
//! second session's `taskkill` is refused ("Access denied"), so the stop
//! is cooperative: a second channel creates the run's stop file in
//! `%TEMP%`, and the prelude's thread terminates the job, ending the script
//! and everything it started at once.
//!
//! The exit status is only read once the server has closed the channel,
//! since it sends the status just before closing; a run whose channel did
//! not close has none.

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

/// How long a stopped script gets to exit before the channel is closed on
/// it. Windows needs a few seconds to list and stop the processes.
const STOP_GRACE: Duration = Duration::from_secs(5);

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
    /// signal, cancelled or stopped at the time limit, or the server sent
    /// none.
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
    /// How the script ended, for the result card and the log: `exit 3`,
    /// `killed by SIGTERM`, `cancelled`, ...
    pub end: String,
}

impl ScriptResult {
    /// The result of a run cancelled before the script started.
    pub fn cancelled_before_start() -> Self {
        Self {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: None,
            exit_signal: None,
            duration_ms: 0,
            truncated: false,
            timed_out: false,
            cancelled: true,
            end: String::new(),
        }
        .with_end()
    }

    fn with_end(mut self) -> Self {
        self.end = describe_end(&self);
        self
    }
}

fn describe_end(result: &ScriptResult) -> String {
    if result.cancelled {
        return "cancelled".to_string();
    }
    if result.timed_out {
        return "stopped at the time limit".to_string();
    }
    match (&result.exit_signal, result.exit_code) {
        (Some(signal), _) => format!("killed by SIG{}", signal),
        (None, Some(code)) => format!("exit {}", code),
        (None, None) => "no exit status".to_string(),
    }
}

/// Longest PID, in digits, after the marker.
const PID_DIGITS_MAX: usize = 10;

/// Runs a Windows script. stdin holds, as UTF-8, the length of
/// `POWERSHELL_PRELUDE` in UTF-16 units on one line, the prelude, then the
/// body. The prelude runs first; the body then runs as a script block. The
/// exit status is the script's `exit`, else the last program's exit code;
/// an uncaught error exits 1.
/// Written for Windows PowerShell 5.1 as well as PowerShell 7.
const POWERSHELL_BOOTSTRAP: &str = r#"$ProgressPreference = 'SilentlyContinue'
if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }
$utf8 = New-Object Text.UTF8Encoding -ArgumentList $false
try { [Console]::OutputEncoding = $utf8 } catch {}
$OutputEncoding = $utf8
$all = (New-Object IO.StreamReader -ArgumentList ([Console]::OpenStandardInput()), $utf8).ReadToEnd()
$at = $all.IndexOf([char]10)
$size = [int]$all.Substring(0, $at)
& ([ScriptBlock]::Create($all.Substring($at + 1, $size))) ([IO.Path]::Combine($env:TEMP, 'STOP_FILE'))
$global:LASTEXITCODE = 0
& ([ScriptBlock]::Create($all.Substring($at + 1 + $size)))
exit $LASTEXITCODE
"#;

/// Puts the script's PowerShell in a new job object, so every process the
/// script starts is in it too, and starts a thread that waits for the run's
/// stop file and then terminates the job: the script and all it started
/// stop at once. Where the job cannot be joined, only PowerShell is
/// stopped.
const POWERSHELL_PRELUDE: &str = r##"param($stop)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SsixJob {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    static IntPtr job;

    public static bool Join() {
        job = CreateJobObjectW(IntPtr.Zero, null);
        return job != IntPtr.Zero && AssignProcessToJobObject(job, GetCurrentProcess());
    }

    public static void Terminate() {
        TerminateJobObject(job, 1);
    }
}
'@
$joined = [SsixJob]::Join()
$watch = [PowerShell]::Create()
$null = $watch.AddScript({
    param($stop, $job, $joined)
    # Without this the process waits for the thread after the script ends.
    [Threading.Thread]::CurrentThread.IsBackground = $true
    while (-not [IO.File]::Exists($stop)) { [Threading.Thread]::Sleep(200) }
    try { [IO.File]::Delete($stop) } catch {}
    if ($joined) { $job::Terminate() }
    [Diagnostics.Process]::GetCurrentProcess().Kill()
}).AddArgument($stop).AddArgument([SsixJob]).AddArgument($joined)
$null = $watch.BeginInvoke()
"##;

/// What is written to the script's stdin: on Windows the prelude goes
/// first, as `POWERSHELL_BOOTSTRAP` reads it.
fn script_input(platform: ScriptPlatform, body: &str) -> String {
    match platform {
        ScriptPlatform::Posix => body.to_string(),
        ScriptPlatform::Windows => format!(
            "{}\n{}{}",
            POWERSHELL_PRELUDE.encode_utf16().count(),
            POWERSHELL_PRELUDE,
            body
        ),
    }
}

/// The file in the remote user's `%TEMP%` that stops Windows run `run_id`.
fn stop_file(run_id: &str) -> String {
    format!("ssix-{}.stop", run_id)
}

/// `interpreter` running `script` given as `-EncodedCommand`: plain words
/// that cmd and PowerShell both pass through unchanged.
fn encoded_powershell(interpreter: &str, flags: &str, script: &str) -> String {
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    format!(
        "{} -NoProfile -NonInteractive {}-EncodedCommand {}",
        interpreter,
        flags,
        STANDARD.encode(utf16)
    )
}

/// What the POSIX wrapper prints before its PID: unique to run `run_id`, so
/// no output of the script or the login shell is taken for it.
fn pid_marker(run_id: &str) -> String {
    format!("ssix-pid-{} ", run_id)
}

/// The command that starts the script. On POSIX `sh` prints its PID after
/// the run's marker (the PID leads the session's process group and is what
/// a stop signals), then runs the interpreter. `run_id` names the Windows
/// stop file.
fn wrapped_command(platform: ScriptPlatform, interpreter: &str, run_id: &str) -> String {
    match platform {
        ScriptPlatform::Posix => format!(
            "exec sh -c 'echo {}$$; {}'",
            pid_marker(run_id),
            interpreter.replace('\'', r"'\''")
        ),
        ScriptPlatform::Windows => encoded_powershell(
            interpreter,
            "-InputFormat Text -OutputFormat Text ",
            &POWERSHELL_BOOTSTRAP.replace("STOP_FILE", &stop_file(run_id)),
        ),
    }
}

/// The command, run on a second channel, that stops the script: SIGTERM to
/// its process group on POSIX (none until the group's PID is known), the
/// run's stop file on Windows. The Windows command removes the file itself
/// when nothing takes it within 2 s (the script had ended, or its watcher
/// never started), so none is left behind.
fn stop_command(
    platform: ScriptPlatform,
    interpreter: &str,
    run_id: &str,
    group: Option<u32>,
) -> Option<String> {
    match platform {
        ScriptPlatform::Posix => group.map(|g| format!("kill -s TERM -{}", g)),
        ScriptPlatform::Windows => Some(encoded_powershell(
            interpreter,
            "",
            &format!(
                "$f = [IO.Path]::Combine($env:TEMP, '{}'); [IO.File]::WriteAllText($f, ''); \
                 for ($i = 0; $i -lt 10 -and [IO.File]::Exists($f); $i++) {{ [Threading.Thread]::Sleep(200) }}; \
                 [IO.File]::Delete($f)",
                stop_file(run_id)
            ),
        )),
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
    /// The marker of the PID line while it is still awaited.
    marker: Option<Vec<u8>>,
    /// The start of a line that may turn out to be the PID line.
    pending: Vec<u8>,
    pid: Option<u32>,
}

impl Capture {
    /// A stream carrying the line `<marker><pid>` printed by
    /// `wrapped_command`, possibly after lines the login shell printed.
    fn with_pid_marker(marker: String) -> Self {
        Self {
            marker: Some(marker.into_bytes()),
            ..Self::default()
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        let Some(marker) = self.marker.clone() else {
            return self.keep(chunk);
        };
        self.pending.extend_from_slice(chunk);
        while let Some(end) = self.pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            let pid = line
                .strip_prefix(marker.as_slice())
                .and_then(|rest| std::str::from_utf8(rest).ok())
                .and_then(|rest| rest.trim().parse().ok());
            if pid.is_some() {
                self.pid = pid;
                self.marker = None;
                let rest = std::mem::take(&mut self.pending);
                return self.keep(&rest);
            }
            self.keep(&line);
        }
        // A partial line that cannot become the PID line is output now.
        let pending = &self.pending;
        let may_be_pid_line = pending.len() <= marker.len() + PID_DIGITS_MAX
            && (marker.starts_with(pending) || pending.starts_with(&marker));
        if !may_be_pid_line {
            let rest = std::mem::take(&mut self.pending);
            self.keep(&rest);
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
        let rest = std::mem::take(&mut self.pending);
        self.keep(&rest);
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
        return Ok(ScriptResult::cancelled_before_start());
    }
    let mut channel = session
        .channel_session()
        .map_err(|e| format!("Failed to open a channel: {}", e))?;
    let run_id = uuid::Uuid::new_v4().simple().to_string();
    let mut command = wrapped_command(platform, interpreter, &run_id);
    if platform == ScriptPlatform::Windows && default_shell_is_powershell(session) {
        // `powershell -c` turns a program's non-zero exit status into 1.
        command.push_str("; exit $LASTEXITCODE");
    }
    channel
        .exec(&command)
        .map_err(|e| format!("Failed to start {}: {}", interpreter, e))?;

    session.set_blocking(false);
    let input = script_input(platform, body);
    let stdout = match platform {
        ScriptPlatform::Posix => Capture::with_pid_marker(pid_marker(&run_id)),
        ScriptPlatform::Windows => Capture::default(),
    };
    let pumped = pump(
        session,
        stdout,
        &|group| stop_command(platform, interpreter, &run_id, group),
        &mut channel,
        input.as_bytes(),
        started + timeout,
        cancelled,
    );
    let closed = close_channel(&mut channel);
    session.set_blocking(true);
    let (mut stdout, mut stderr, stop) = pumped?;

    let exit_signal = channel
        .exit_signal()
        .ok()
        .and_then(|s| s.exit_signal)
        .filter(|s| !s.is_empty());
    // libssh2 reports 0 when no status arrived; it arrives before the close.
    let exit_code = if stop.is_some() || exit_signal.is_some() || !closed {
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
        end: String::new(),
    }
    .with_end())
}

/// Whether a Windows server runs commands through PowerShell rather than
/// cmd (its `DefaultShell`): cmd expands `%COMSPEC%`, PowerShell prints it
/// as is. Assumes cmd, the Windows default, when the probe fails.
fn default_shell_is_powershell(session: &Session) -> bool {
    (|| -> Result<String, ssh2::Error> {
        let mut channel = session.channel_session()?;
        channel.exec(SHELL_PROBE)?;
        channel.send_eof()?;
        let mut out = String::new();
        let _ = channel.read_to_string(&mut out);
        channel.wait_close()?;
        Ok(out)
    })()
    .map(|out| probe_says_powershell(&out))
    .unwrap_or(false)
}

const SHELL_PROBE: &str = "echo %COMSPEC%";

fn probe_says_powershell(out: &str) -> bool {
    out.contains("%COMSPEC%")
}

/// Run `command` on a second channel to stop the script. Best effort: if
/// it fails, the script's channel is closed on it anyway.
fn run_stop_command(session: &Session, command: &str) {
    session.set_blocking(true);
    let _ = (|| -> Result<(), ssh2::Error> {
        let mut channel = session.channel_session()?;
        channel.exec(command)?;
        channel.send_eof()?;
        channel.wait_close()
    })();
    session.set_blocking(false);
}

/// Feed `input` to the channel and collect both output streams, stdout
/// into `stdout`, until the remote side sends EOF. At `deadline`, or once
/// `cancelled` returns true, the script is stopped with `stop_command(pid)`,
/// given the PID the POSIX wrapper printed (waiting for it if it has not
/// arrived yet), and gets `STOP_GRACE` to exit.
/// Returns stdout, stderr and why the run was stopped, if it was.
fn pump(
    session: &Session,
    mut stdout: Capture,
    stop_command: &dyn Fn(Option<u32>) -> Option<String>,
    channel: &mut Channel,
    mut input: &[u8],
    deadline: Instant,
    cancelled: &dyn Fn() -> bool,
) -> Result<(Capture, Capture, Option<Stop>), String> {
    let fds = [wake::fd_of(session)];
    let mut stderr = Capture::default();
    let mut buf = vec![0u8; 32 * 1024];
    let mut eof_sent = false;
    let mut stop = None;
    let mut stop_sent = false;
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
                // Time for the PID to arrive, if it has not yet.
                give_up = now + STOP_GRACE;
            }
        }
        if stop.is_some() {
            if !stop_sent {
                if let Some(command) = stop_command(stdout.pid) {
                    run_stop_command(session, &command);
                    stop_sent = true;
                    give_up = Instant::now() + STOP_GRACE;
                    continue;
                }
            }
            if now >= give_up {
                return Ok((stdout, stderr, stop));
            }
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
        let marker = || Capture::with_pid_marker(pid_marker("r1"));
        let mut c = marker();
        c.push(b"ssix-pid-r");
        c.push(b"1 12");
        c.push(b"34\nhello\n");
        assert_eq!(c.pid, Some(1234));
        assert_eq!(c.text(), "hello\n");

        // Lines a login shell prints first stay in the output, and the
        // script's own output is never taken for the PID.
        let mut c = marker();
        c.push(b"Welcome\n42\nssix-pid-r1 77\nssix-pid-r1 88\n");
        assert_eq!(c.pid, Some(77));
        assert_eq!(c.text(), "Welcome\n42\nssix-pid-r1 88\n");

        // Without the PID line everything is output, the partial last line
        // as soon as it cannot become the PID line.
        let mut c = marker();
        c.push(b"sh: not found\nmore");
        assert_eq!(c.pid, None);
        assert_eq!(c.bytes, b"sh: not found\nmore");
        let mut c = marker();
        c.push(b"ssix-pid-r1 123456789012");
        assert_eq!(c.bytes.len(), 24);
        let mut c = marker();
        c.push(b"ssix-pid");
        assert!(c.bytes.is_empty());
        assert_eq!(c.text(), "ssix-pid");
    }

    #[test]
    fn wrapped_command_quotes_the_interpreter() {
        let posix = |i| wrapped_command(ScriptPlatform::Posix, i, "r1");
        assert_eq!(posix("sh -s"), "exec sh -c 'echo ssix-pid-r1 $$; sh -s'");
        assert_eq!(
            posix("sudo -u 'app user' sh -s"),
            r"exec sh -c 'echo ssix-pid-r1 $$; sudo -u '\''app user'\'' sh -s'"
        );
    }

    /// The Windows command is plain words, short enough for cmd's 8191
    /// character limit, and carries the bootstrap as UTF-16LE base64.
    #[test]
    fn windows_command_encodes_the_bootstrap() {
        let run_id = "0123abcd";
        let command = wrapped_command(ScriptPlatform::Windows, "pwsh", run_id);
        let (head, encoded) = command.rsplit_once(' ').unwrap();
        assert_eq!(
            head,
            "pwsh -NoProfile -NonInteractive -InputFormat Text -OutputFormat Text -EncodedCommand"
        );
        assert!(command.len() < 8191, "{} characters", command.len());
        assert!(!command.contains(['"', '\'', '&', '|', '<', '>', '^', '%']));
        assert_eq!(
            decode_utf16(encoded),
            POWERSHELL_BOOTSTRAP.replace("STOP_FILE", "ssix-0123abcd.stop")
        );
    }

    /// The script inside an `-EncodedCommand`.
    fn decode_utf16(encoded: &str) -> String {
        let bytes = STANDARD.decode(encoded).unwrap();
        let units: Vec<u16> = bytes
            .chunks(2)
            .map(|p| u16::from_le_bytes([p[0], p[1]]))
            .collect();
        String::from_utf16(&units).unwrap()
    }

    /// The bootstrap splits stdin by UTF-16 units, so a character outside
    /// the BMP counts twice.
    #[test]
    fn windows_input_leads_with_the_prelude() {
        assert_eq!(script_input(ScriptPlatform::Posix, "ls\n"), "ls\n");
        let input = script_input(ScriptPlatform::Windows, "Get-Date\n");
        let (size, rest) = input.split_once('\n').unwrap();
        let size: usize = size.parse().unwrap();
        let units: Vec<u16> = rest.encode_utf16().collect();
        assert_eq!(
            String::from_utf16(&units[..size]).unwrap(),
            POWERSHELL_PRELUDE
        );
        assert_eq!(String::from_utf16(&units[size..]).unwrap(), "Get-Date\n");
        assert!(!POWERSHELL_PRELUDE.is_ascii() || size == POWERSHELL_PRELUDE.len());
    }

    #[test]
    fn shell_probe_tells_cmd_from_powershell() {
        assert!(!probe_says_powershell("C:\\Windows\\system32\\cmd.exe\r\n"));
        assert!(probe_says_powershell("%COMSPEC%\r\n"));
        assert!(!probe_says_powershell(""));
    }

    #[test]
    fn stop_command_fits_the_platform() {
        assert_eq!(
            stop_command(ScriptPlatform::Posix, "sh -s", "r1", Some(42)).as_deref(),
            Some("kill -s TERM -42")
        );
        assert_eq!(
            stop_command(ScriptPlatform::Posix, "sh -s", "r1", None),
            None
        );
        let windows = stop_command(ScriptPlatform::Windows, "pwsh", "r1", None).unwrap();
        let (head, encoded) = windows.rsplit_once(' ').unwrap();
        assert_eq!(head, "pwsh -NoProfile -NonInteractive -EncodedCommand");
        assert!(decode_utf16(encoded).contains("'ssix-r1.stop'"));
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
    fn end_describes_each_ending() {
        let base = ScriptResult {
            exit_code: Some(3),
            duration_ms: 1,
            cancelled: false,
            ..ScriptResult::cancelled_before_start()
        };
        assert_eq!(describe_end(&base), "exit 3");
        let killed = ScriptResult {
            exit_code: None,
            exit_signal: Some("TERM".into()),
            ..base.clone()
        };
        assert_eq!(describe_end(&killed), "killed by SIGTERM");
        let stopped = ScriptResult {
            exit_code: None,
            timed_out: true,
            ..base.clone()
        };
        assert_eq!(describe_end(&stopped), "stopped at the time limit");
        let silent = ScriptResult {
            exit_code: None,
            ..base.clone()
        };
        assert_eq!(describe_end(&silent), "no exit status");
        assert_eq!(ScriptResult::cancelled_before_start().end, "cancelled");
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

/// Runs against a real SSH server, so a plain `cargo test` skips them.
/// Point them at one and run them one at a time:
///
/// ```text
/// SSIX_LIVE_SSH=127.0.0.1:2201 SSIX_LIVE_USER=usera SSIX_LIVE_PASSWORD=passa \
/// SSIX_LIVE_PLATFORM=posix cargo test live_ -- --ignored --test-threads=1
/// ```
///
/// CI runs them on the Linux test servers and on a Windows container
/// (`docker/windows-sshd`).
#[cfg(test)]
mod live {
    use super::*;
    use crate::ssh::{open_authenticated_session, AuthMethod, Endpoint};
    use crate::storage::test_support::with_isolated_data_dir;

    struct Target {
        endpoint: Endpoint,
        platform: ScriptPlatform,
    }

    impl Target {
        fn from_env() -> Self {
            let var = |name: &str| {
                std::env::var(name)
                    .unwrap_or_else(|_| panic!("{} is not set; see `remote_script::live`", name))
            };
            let addr = var("SSIX_LIVE_SSH");
            let (host, port) = addr.rsplit_once(':').expect("SSIX_LIVE_SSH is host:port");
            let platform = match var("SSIX_LIVE_PLATFORM").as_str() {
                "posix" => ScriptPlatform::Posix,
                "windows" => ScriptPlatform::Windows,
                other => panic!("SSIX_LIVE_PLATFORM is posix or windows, not {}", other),
            };
            Self {
                endpoint: Endpoint {
                    host: host.to_string(),
                    port: port.parse().expect("SSIX_LIVE_SSH port"),
                    username: var("SSIX_LIVE_USER"),
                    auth: AuthMethod::Password(var("SSIX_LIVE_PASSWORD")),
                    proxy_command: None,
                },
                platform,
            }
        }

        fn windows(&self) -> bool {
            self.platform == ScriptPlatform::Windows
        }

        /// The script for this target's platform.
        fn pick<'a>(&self, posix: &'a str, windows: &'a str) -> &'a str {
            if self.windows() {
                windows
            } else {
                posix
            }
        }

        /// Run `body` with the platform's default interpreter on a new session.
        fn run(&self, body: &str, timeout: Duration, cancelled: &dyn Fn() -> bool) -> ScriptResult {
            let mut result = None;
            with_isolated_data_dir(|| {
                let session = open_authenticated_session(&self.endpoint, 0, None)
                    .unwrap_or_else(|e| panic!("connect to {}: {}", self.endpoint.addr(), e));
                let interpreter = self.platform.default_interpreter();
                result = Some(
                    run(
                        &session,
                        self.platform,
                        interpreter,
                        body,
                        timeout,
                        cancelled,
                    )
                    .unwrap_or_else(|e| panic!("run: {}", e)),
                );
            });
            result.unwrap()
        }

        /// Run `body`, which should end well within a minute.
        fn run_to_end(&self, body: &str) -> ScriptResult {
            self.run(body, Duration::from_secs(60), &|| false)
        }
    }

    /// Windows ends lines with CRLF.
    fn lines(text: &str) -> String {
        text.replace("\r\n", "\n")
    }

    #[test]
    #[ignore]
    fn live_output_streams_and_exit_code() {
        let t = Target::from_env();
        let r = t.run_to_end(t.pick(
            "echo 'héllo ✓'\nfor i in 1 2; do\n  echo \"line $i\"\ndone\necho to-stderr >&2\nexit 3\n",
            "Write-Output 'héllo ✓'\nforeach ($i in 1..2) {\n  \"line $i\"\n}\n[Console]::Error.WriteLine('to-stderr')\nexit 3\n",
        ));
        assert_eq!(lines(&r.stdout), "héllo ✓\nline 1\nline 2\n", "{:?}", r);
        assert_eq!(lines(&r.stderr), "to-stderr\n", "{:?}", r);
        assert_eq!(r.exit_code, Some(3), "{:?}", r);
        assert!(!r.cancelled && !r.timed_out && !r.truncated, "{:?}", r);
    }

    #[test]
    #[ignore]
    fn live_exit_status_follows_programs_and_errors() {
        let t = Target::from_env();
        let r = t.run_to_end(t.pick("sh -c 'exit 5'\n", "cmd /c exit 5\n"));
        assert_eq!(
            r.exit_code,
            Some(5),
            "the last program's exit code: {:?}",
            r
        );

        let r = t.run_to_end(t.pick("echo boom >&2\nexit 1\n", "throw 'boom'\n"));
        assert_eq!(r.exit_code, Some(1), "an uncaught error: {:?}", r);
        assert!(r.stderr.contains("boom"), "{:?}", r);
        assert!(!r.stderr.contains('\x1b'), "colour codes left: {:?}", r);

        if t.windows() {
            let r = t.run_to_end("Write-Error 'soft'\nWrite-Output after\n");
            assert_eq!(r.exit_code, Some(0), "an error that does not stop: {:?}", r);
            assert!(r.stderr.contains("soft"), "{:?}", r);
            assert_eq!(lines(&r.stdout), "after\n", "{:?}", r);
        }
    }

    #[test]
    #[ignore]
    fn live_cancel_stops_the_script_and_what_it_started() {
        let t = Target::from_env();
        let start = Instant::now();
        let r = t.run(
            t.pick(
                "echo started\nsleep 30\necho finished\n",
                "Write-Output started\nping -n 30 127.0.0.1 | Out-Null\nWrite-Output finished\n",
            ),
            RUN_TIMEOUT,
            &|| start.elapsed() > Duration::from_secs(5),
        );
        assert!(r.cancelled, "{:?}", r);
        assert_eq!(r.exit_code, None, "{:?}", r);
        assert_eq!(lines(&r.stdout), "started\n", "{:?}", r);
        assert!(
            start.elapsed() < Duration::from_secs(12),
            "the cancel took {:?}: {:?}",
            start.elapsed(),
            r
        );

        let check = t.run_to_end(t.pick(
            "ps | grep -q '[s]leep 30' && exit 1\nexit 0\n",
            "if (Get-Process ping -ErrorAction SilentlyContinue) { exit 1 }\n\
             if (Get-ChildItem $env:TEMP -Filter 'ssix-*.stop') { exit 2 }\nexit 0\n",
        ));
        assert_eq!(
            check.exit_code,
            Some(0),
            "the script's child still runs (1) or its stop file is left (2): {:?}",
            check
        );
    }

    #[test]
    #[ignore]
    fn live_time_limit_stops_the_script() {
        let t = Target::from_env();
        let r = t.run(
            t.pick("sleep 31\n", "ping -n 31 127.0.0.1 | Out-Null\n"),
            Duration::from_secs(4),
            &|| false,
        );
        assert!(r.timed_out && !r.cancelled, "{:?}", r);
        assert_eq!(r.exit_code, None, "{:?}", r);
        assert!(r.duration_ms < 12_000, "{:?}", r);

        let check = t.run_to_end(t.pick(
            "ps | grep -q '[s]leep 31' && exit 1\nexit 0\n",
            "if (Get-Process ping -ErrorAction SilentlyContinue) { exit 1 }\nexit 0\n",
        ));
        assert_eq!(
            check.exit_code,
            Some(0),
            "the script still runs: {:?}",
            check
        );
    }
}
