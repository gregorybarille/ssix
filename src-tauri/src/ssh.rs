use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use ssh2::Session;
use tauri::{AppHandle, Emitter};

pub enum AuthMethod {
    Password(String),
    Key {
        path: String,
        passphrase: Option<String>,
    },
}

pub enum SessionMsg {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Disconnect,
}

pub struct SshState {
    pub sessions: Mutex<HashMap<String, Sender<SessionMsg>>>,
}

impl SshState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

pub fn start_ssh_session(
    host: String,
    port: u16,
    username: String,
    auth: AuthMethod,
    app_handle: AppHandle,
    session_id: String,
) -> Result<Sender<SessionMsg>, String> {
    // Perform TCP connect, SSH handshake, auth, and PTY/shell setup synchronously
    // so that any connection error is returned directly to the caller rather than
    // being lost in a race between the background thread emitting an event and the
    // frontend registering its listener.
    let (session, channel) = open_shell(&host, port, &username, &auth)?;

    let (tx, rx): (Sender<SessionMsg>, Receiver<SessionMsg>) = mpsc::channel();
    let sid = session_id.clone();

    thread::spawn(move || {
        // Keep `session` alive for the lifetime of the thread so the channel
        // remains valid.  The session is intentionally held here even though
        // it is not used directly — dropping it would invalidate `channel`.
        let _session = session;
        let result = run_io_loop(channel, &app_handle, &sid, rx);
        if let Err(e) = &result {
            let _ = app_handle.emit(&format!("ssh-error-{}", sid), e.clone());
        }
        let _ = app_handle.emit(&format!("ssh-closed-{}", sid), ());
    });

    Ok(tx)
}

/// Opens a TCP connection, performs the SSH handshake + authentication, requests a
/// PTY and starts a shell.  Returns the session and the ready-to-use channel on
/// success, or a descriptive error string on failure.  Everything here runs on the
/// caller's thread so errors surface synchronously.
fn open_shell(
    host: &str,
    port: u16,
    username: &str,
    auth: &AuthMethod,
) -> Result<(Session, ssh2::Channel), String> {
    let addr = format!("{}:{}", host, port);
    let tcp = TcpStream::connect(&addr)
        .map_err(|e| format!("TCP connect to {} failed: {}", addr, e))?;
    tcp.set_nonblocking(false).ok();

    let mut session =
        Session::new().map_err(|e| format!("SSH session create failed: {}", e))?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|e| format!("SSH handshake failed: {}", e))?;

    match auth {
        AuthMethod::Password(pw) => {
            session
                .userauth_password(username, pw)
                .map_err(|e| format!("Password auth failed: {}", e))?;
        }
        AuthMethod::Key { path, passphrase } => {
            session
                .userauth_pubkey_file(username, None, Path::new(path), passphrase.as_deref())
                .map_err(|e| format!("Key auth failed: {}", e))?;
        }
    }

    if !session.authenticated() {
        return Err("Authentication failed".to_string());
    }

    let mut channel = session
        .channel_session()
        .map_err(|e| format!("Channel open failed: {}", e))?;

    channel
        .request_pty("xterm-256color", None, Some((80, 24, 0, 0)))
        .map_err(|e| format!("PTY request failed: {}", e))?;

    channel
        .shell()
        .map_err(|e| format!("Shell request failed: {}", e))?;

    session.set_blocking(false);

    Ok((session, channel))
}

fn run_io_loop(
    mut channel: ssh2::Channel,
    app_handle: &AppHandle,
    session_id: &str,
    rx: Receiver<SessionMsg>,
) -> Result<(), String> {
    let output_event = format!("ssh-output-{}", session_id);
    let mut buf = [0u8; 8192];

    loop {
        let mut got_data = false;

        // Read stdout
        match channel.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let _ = app_handle.emit(&output_event, &buf[..n]);
                got_data = true;
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => break,
        }

        // Read stderr
        match channel.stderr().read(&mut buf) {
            Ok(n) if n > 0 => {
                let _ = app_handle.emit(&output_event, &buf[..n]);
                got_data = true;
            }
            _ => {}
        }

        // Process commands from frontend
        loop {
            match rx.try_recv() {
                Ok(SessionMsg::Write(data)) => {
                    let _ = channel.write_all(&data);
                    let _ = channel.flush();
                }
                Ok(SessionMsg::Resize { cols, rows }) => {
                    let _ = channel.request_pty_size(cols, rows, None, None);
                }
                Ok(SessionMsg::Disconnect) => {
                    let _ = channel.close();
                    let _ = channel.wait_close();
                    return Ok(());
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    let _ = channel.close();
                    let _ = channel.wait_close();
                    return Ok(());
                }
            }
        }

        if channel.eof() {
            break;
        }

        if !got_data {
            thread::sleep(Duration::from_millis(10));
        }
    }

    let _ = channel.close();
    let _ = channel.wait_close();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ssh_state_new() {
        let state = SshState::new();
        let sessions = state.sessions.lock().unwrap();
        assert!(sessions.is_empty());
    }

    #[test]
    fn test_ssh_state_insert_and_remove() {
        let state = SshState::new();
        let (tx, _rx) = mpsc::channel::<SessionMsg>();

        {
            let mut sessions = state.sessions.lock().unwrap();
            sessions.insert("test-session".to_string(), tx);
            assert_eq!(sessions.len(), 1);
            assert!(sessions.contains_key("test-session"));
        }

        {
            let mut sessions = state.sessions.lock().unwrap();
            sessions.remove("test-session");
            assert!(sessions.is_empty());
        }
    }

    #[test]
    fn test_session_msg_send_receive() {
        let (tx, rx) = mpsc::channel::<SessionMsg>();

        tx.send(SessionMsg::Write(b"hello".to_vec())).unwrap();
        tx.send(SessionMsg::Resize { cols: 80, rows: 24 }).unwrap();
        tx.send(SessionMsg::Disconnect).unwrap();

        match rx.recv().unwrap() {
            SessionMsg::Write(data) => assert_eq!(data, b"hello"),
            _ => panic!("expected Write"),
        }

        match rx.recv().unwrap() {
            SessionMsg::Resize { cols, rows } => {
                assert_eq!(cols, 80);
                assert_eq!(rows, 24);
            }
            _ => panic!("expected Resize"),
        }

        match rx.recv().unwrap() {
            SessionMsg::Disconnect => {}
            _ => panic!("expected Disconnect"),
        }
    }

    #[test]
    fn test_sender_disconnect_detection() {
        let (tx, rx) = mpsc::channel::<SessionMsg>();
        drop(tx);
        assert!(rx.try_recv().is_err());
    }
}
