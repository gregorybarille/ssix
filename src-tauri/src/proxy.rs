//! `ProxyCommand` support: reach the first hop through a local command's
//! stdin/stdout instead of a direct TCP connection, as OpenSSH does. The
//! "Through WSL" preset (`wsl.exe -e nc %h %p`) uses it to reach hosts that
//! only a WSL distribution can see.
//!
//! `ssh2` needs a socket, so the command is bridged to a loopback
//! connection: one thread copies the socket to the child's stdin, another
//! the child's stdout to the socket, and a third logs its stderr. The child
//! and whatever it started are killed when the SSH session closes its end.

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::thread;

use crate::ssh::Endpoint;
use crate::ssh_config::expand_tokens;
use crate::ssh_debug::SshDebug;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Characters a host or user name may contain to be put in a command line
/// as-is. Anything else (spaces, quotes, `;`, `$`…) is refused rather than
/// quoted, so a name can never change what the command does.
fn is_shell_safe(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '@'))
}

/// Check a template's `%` tokens without expanding it.
pub fn validate(template: &str) -> Result<(), String> {
    if template.trim().is_empty() {
        return Err("Proxy command is empty".to_string());
    }
    expand(template, "h", 22, "u").map(|_| ())
}

/// Expand OpenSSH's tokens: `%h` host, `%p` port, `%r` user, `%%` a `%`.
pub fn expand(template: &str, host: &str, port: u16, user: &str) -> Result<String, String> {
    expand_tokens(template, |token| {
        let (name, value) = match token {
            Some('h') => ("host", host.to_string()),
            Some('p') => ("port", port.to_string()),
            Some('r') => ("user", user.to_string()),
            Some(other) => {
                return Err(format!(
                    "Unknown token %{} in proxy command (use %h, %p, %r or %%)",
                    other
                ))
            }
            None => return Err("Proxy command ends with a lone %".to_string()),
        };
        if !is_shell_safe(&value) {
            return Err(format!(
                "The {} {:?} cannot be passed to a proxy command",
                name, value
            ));
        }
        Ok(value)
    })
}

/// A proxy command's `PATH` on macOS. An app started from Finder gets launchd's
/// short one, without Homebrew, so a command that works in Terminal is not found.
/// What is there stays first, so this never changes which program a name means.
fn path_with_homebrew(path: Option<OsString>) -> OsString {
    let mut path = path
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| "/usr/bin:/bin:/usr/sbin:/sbin".into());
    path.push(":/opt/homebrew/bin:/usr/local/bin");
    path
}

#[cfg(unix)]
fn shell(command: &str) -> Command {
    use std::os::unix::process::CommandExt;
    let mut cmd = Command::new("/bin/sh");
    // Its own group, so `kill_tree` reaches a pipeline as well as the shell.
    cmd.arg("-c").arg(command).process_group(0);
    cmd
}

#[cfg(windows)]
fn shell(command: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new("cmd.exe");
    // `/S /C "…"` makes cmd take the line verbatim, whatever its quotes.
    cmd.raw_arg(format!("/S /C \"{}\"", command))
        .creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Kill the group `shell` made. `spawn` fails if the group could not be made, so
/// its id is the child's pid: never ours, and no one else's until `stop` reaps the
/// child. A group already gone only makes `kill` return an error, ignored here.
/// The guard is because 0 would mean our own group and -1 every process.
#[cfg(unix)]
fn kill_tree(child: &Child) {
    if let Ok(pid @ 2..) = libc::pid_t::try_from(child.id()) {
        // SAFETY: `kill` takes plain integers and touches no memory of ours.
        unsafe { libc::kill(-pid, libc::SIGKILL) };
    }
}

/// Killing `cmd.exe` alone would leave "Through WSL"'s `wsl.exe` and `nc` running.
/// The handle `child` holds keeps the pid from going to anyone else.
#[cfg(windows)]
fn kill_tree(child: &Child) {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &child.id().to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

/// End the command and what it started. Reaping comes last, as `kill_tree` needs.
fn stop(mut child: Child) {
    kill_tree(&child);
    let _ = child.kill();
    let _ = child.wait();
}

/// A connected loopback pair whose far end is accepted from our own
/// connect only: another local process racing to the ephemeral port is
/// turned away.
pub(crate) fn loopback_pair() -> Result<(TcpStream, TcpStream), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind a loopback port: {}", e))?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("local_addr() failed: {}", e))?;
    let near = TcpStream::connect(addr)
        .map_err(|e| format!("Failed to connect a loopback pair: {}", e))?;
    let near_addr = near
        .local_addr()
        .map_err(|e| format!("local_addr() failed: {}", e))?;
    loop {
        let (far, peer) = listener
            .accept()
            .map_err(|e| format!("Failed to accept a loopback pair: {}", e))?;
        if peer == near_addr {
            return Ok((near, far));
        }
    }
}

/// Start `endpoint`'s proxy command and return the socket `ssh2` talks to.
pub(crate) fn connect(
    template: &str,
    endpoint: &Endpoint,
    debug: &SshDebug,
) -> Result<TcpStream, String> {
    let command = expand(template, &endpoint.host, endpoint.port, &endpoint.username)?;
    debug.at(1, || format!("Executing proxy command: {}", command));
    let mut cmd = shell(&command);
    if cfg!(target_os = "macos") {
        cmd.env("PATH", path_with_homebrew(std::env::var_os("PATH")));
    }
    let child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Proxy command {:?} failed to start: {}", command, e))?;
    let (near, far) = match loopback_pair() {
        Ok(pair) => pair,
        Err(e) => {
            stop(child);
            return Err(e);
        }
    };
    pump(child, far, endpoint.addr());
    Ok(near)
}

fn pump(mut child: Child, far: TcpStream, addr: String) {
    let (Some(mut stdin), Some(mut stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        stop(child);
        return;
    };
    let Ok(mut to_socket) = far.try_clone() else {
        stop(child);
        return;
    };

    // Child stdout → socket. When the command exits, the SSH side sees EOF.
    thread::spawn(move || {
        let mut buf = [0u8; 32 * 1024];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if to_socket.write_all(&buf[..n]).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = to_socket.shutdown(Shutdown::Write);
    });

    // Child stderr → Logs view, where "connection refused" and the like
    // explain an otherwise bare handshake failure.
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                crate::logs::log_local("warn", "proxy", format!("[{}] {}", addr, line));
            }
        }
    });

    // Socket → child stdin; owns the child and ends it once the SSH session
    // has closed its side.
    thread::spawn(move || {
        let mut from_socket = far;
        let mut buf = [0u8; 32 * 1024];
        loop {
            match from_socket.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if stdin.write_all(&buf[..n]).is_err() {
                        break;
                    }
                }
            }
        }
        drop(stdin);
        let _ = from_socket.shutdown(Shutdown::Both);
        stop(child);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_loopback_pair_is_connected_and_leaves_no_port_open() {
        let (mut near, mut far) = loopback_pair().unwrap();
        near.write_all(b"x").unwrap();
        let mut got = [0u8; 1];
        far.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"x");
        // A process another test is starting can hold the listener for a moment.
        let port = near.peer_addr().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while TcpStream::connect(port).is_ok() && std::time::Instant::now() < deadline {
            thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(TcpStream::connect(port).is_err());
    }

    #[test]
    fn expands_openssh_tokens() {
        assert_eq!(
            expand("wsl.exe -e nc %h %p", "10.0.0.5", 2222, "me").unwrap(),
            "wsl.exe -e nc 10.0.0.5 2222"
        );
        assert_eq!(
            expand("echo %r@%h 100%%", "box", 22, "root").unwrap(),
            "echo root@box 100%"
        );
    }

    #[test]
    fn refuses_unknown_tokens_and_a_trailing_percent() {
        assert!(expand("nc %x", "h", 22, "u").unwrap_err().contains("%x"));
        assert!(expand("nc %", "h", 22, "u").is_err());
        assert!(validate("  ").is_err());
        assert!(validate("nc %h %p").is_ok());
    }

    #[test]
    fn refuses_names_that_could_change_the_command() {
        assert!(expand("nc %h %p", "box; rm -rf ~", 22, "u").is_err());
        assert!(expand("nc %h %p", "$(id)", 22, "u").is_err());
        assert!(expand("ssh %r@%h", "box", 22, "a b").is_err());
        // Brackets are shell globs; a bare IPv6 literal is fine.
        assert!(expand("nc %h %p", "[::1]", 22, "u").is_err());
        assert!(expand("nc %h %p", "::1", 22, "u").is_ok());
    }

    #[test]
    fn homebrew_comes_after_the_path_already_there() {
        assert_eq!(
            path_with_homebrew(Some("/first:/usr/bin".into())),
            OsString::from("/first:/usr/bin:/opt/homebrew/bin:/usr/local/bin")
        );
        // Homebrew alone would lose the system's own tools.
        for missing in [None, Some(OsString::new())] {
            assert_eq!(
                path_with_homebrew(missing),
                OsString::from("/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin")
            );
        }
    }

    #[cfg(unix)]
    fn endpoint() -> Endpoint {
        Endpoint {
            host: "localhost".into(),
            port: 22,
            username: "me".into(),
            auth: crate::ssh::AuthMethod::Password(String::new()),
            proxy_command: None,
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_proxy_command_runs_with_homebrew_on_its_path() {
        let mut sock = connect("echo \"$PATH\"", &endpoint(), &SshDebug::new(0, "t")).unwrap();
        let mut got = String::new();
        sock.read_to_string(&mut got).unwrap();
        assert!(got.contains("/opt/homebrew/bin:/usr/local/bin"), "{got}");
    }

    #[cfg(unix)]
    #[test]
    fn closing_the_socket_ends_all_of_a_compound_command() {
        // A pipeline, so the shell cannot `exec` its way out, and it says who `sleep` is.
        let sock = connect(
            "{ sleep 300 & echo $!; wait; } | cat",
            &endpoint(),
            &SshDebug::new(0, "t"),
        )
        .unwrap();
        sock.set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .unwrap();
        let mut line = String::new();
        BufReader::new(&sock).read_line(&mut line).unwrap();
        let sleep: libc::pid_t = line.trim().parse().unwrap();
        // SAFETY: signal 0 only asks whether the process exists.
        let alive = || unsafe { libc::kill(sleep, 0) } == 0;
        assert!(alive());
        drop(sock);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while alive() && std::time::Instant::now() < deadline {
            thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(!alive(), "sleep {sleep} outlived the session");
    }

    #[cfg(windows)]
    #[test]
    fn closing_the_socket_ends_what_cmd_started() {
        // `cmd` stays as the parent, as it does for the "Through WSL" preset.
        let sock = connect(
            "powershell -NoProfile -Command \"Write-Output $PID; Start-Sleep 300\"",
            &endpoint(),
            &SshDebug::new(0, "t"),
        )
        .unwrap();
        sock.set_read_timeout(Some(std::time::Duration::from_secs(60)))
            .unwrap();
        let mut line = String::new();
        BufReader::new(&sock).read_line(&mut line).unwrap();
        let pid: u32 = line.trim().parse().unwrap();
        let alive = || {
            let output = Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH"])
                .output()
                .unwrap();
            String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
        };
        assert!(alive());
        drop(sock);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while alive() && std::time::Instant::now() < deadline {
            thread::sleep(std::time::Duration::from_millis(200));
        }
        assert!(!alive(), "powershell {pid} outlived the session");
    }

    /// If this reached the wrong group, the test run itself would die.
    #[cfg(unix)]
    #[test]
    fn stopping_a_command_that_already_exited_is_harmless() {
        let mut child = shell("exit 0").stdout(Stdio::piped()).spawn().unwrap();
        // End of its output, and it is left unreaped, as `pump` leaves it.
        let mut output = Vec::new();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_end(&mut output)
            .unwrap();
        stop(child);
    }

    #[cfg(unix)]
    #[test]
    fn bridges_the_command_stdio_to_a_socket() {
        // `cat` echoes what the SSH side writes.
        let mut sock = connect("cat", &endpoint(), &SshDebug::new(0, "t")).unwrap();
        sock.write_all(b"ping").unwrap();
        let mut got = [0u8; 4];
        sock.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"ping");
    }

    #[cfg(unix)]
    #[test]
    fn a_command_that_exits_closes_the_socket() {
        let mut sock = connect("printf SSH-2.0-x", &endpoint(), &SshDebug::new(0, "t")).unwrap();
        let mut got = String::new();
        sock.read_to_string(&mut got).unwrap();
        assert_eq!(got, "SSH-2.0-x");
    }
}
