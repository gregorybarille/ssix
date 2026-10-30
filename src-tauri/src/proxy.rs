//! `ProxyCommand` support: reach the first hop through a local command's
//! stdin/stdout instead of a direct TCP connection, as OpenSSH does. The
//! "Through WSL" preset (`wsl.exe -e nc %h %p`) uses it to reach hosts that
//! only a WSL distribution can see.
//!
//! `ssh2` needs a socket, so the command is bridged to a loopback
//! connection: one thread copies the socket to the child's stdin, another
//! the child's stdout to the socket, and a third logs its stderr. The child
//! is killed when the SSH session closes its end.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::thread;

use crate::ssh::Endpoint;
use crate::ssh_debug::SshDebug;

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
    let mut out = String::with_capacity(template.len());
    let mut chars = template.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        let (name, value) = match chars.next() {
            Some('h') => ("host", host.to_string()),
            Some('p') => ("port", port.to_string()),
            Some('r') => ("user", user.to_string()),
            Some('%') => {
                out.push('%');
                continue;
            }
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
        out.push_str(&value);
    }
    Ok(out)
}

#[cfg(unix)]
fn shell(command: &str) -> Command {
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c").arg(command);
    cmd
}

#[cfg(windows)]
fn shell(command: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = Command::new("cmd.exe");
    // `/S /C "…"` makes cmd take the line verbatim, whatever its quotes.
    cmd.raw_arg(format!("/S /C \"{}\"", command))
        .creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// A connected loopback pair whose far end is accepted from our own
/// connect only: another local process racing to the ephemeral port is
/// turned away.
fn loopback_pair() -> Result<(TcpStream, TcpStream), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind a loopback port for the proxy: {}", e))?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("local_addr() failed: {}", e))?;
    let near = TcpStream::connect(addr)
        .map_err(|e| format!("Failed to connect the proxy bridge: {}", e))?;
    let near_addr = near
        .local_addr()
        .map_err(|e| format!("local_addr() failed: {}", e))?;
    loop {
        let (far, peer) = listener
            .accept()
            .map_err(|e| format!("Failed to accept the proxy bridge: {}", e))?;
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
    let mut child = shell(&command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Proxy command {:?} failed to start: {}", command, e))?;
    let (near, far) = match loopback_pair() {
        Ok(pair) => pair,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
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
        let _ = child.kill();
        return;
    };
    let Ok(mut to_socket) = far.try_clone() else {
        let _ = child.kill();
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
        let _ = child.kill();
        let _ = child.wait();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[cfg(unix)]
    #[test]
    fn bridges_the_command_stdio_to_a_socket() {
        let endpoint = Endpoint {
            host: "localhost".into(),
            port: 22,
            username: "me".into(),
            auth: crate::ssh::AuthMethod::Password(String::new()),
            proxy_command: None,
        };
        // `cat` echoes what the SSH side writes.
        let mut sock = connect("cat", &endpoint, &SshDebug::new(0, "t")).unwrap();
        sock.write_all(b"ping").unwrap();
        let mut got = [0u8; 4];
        sock.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"ping");
    }

    #[cfg(unix)]
    #[test]
    fn a_command_that_exits_closes_the_socket() {
        let endpoint = Endpoint {
            host: "localhost".into(),
            port: 22,
            username: "me".into(),
            auth: crate::ssh::AuthMethod::Password(String::new()),
            proxy_command: None,
        };
        let mut sock = connect("printf SSH-2.0-x", &endpoint, &SshDebug::new(0, "t")).unwrap();
        let mut got = String::new();
        sock.read_to_string(&mut got).unwrap();
        assert_eq!(got, "SSH-2.0-x");
    }
}
