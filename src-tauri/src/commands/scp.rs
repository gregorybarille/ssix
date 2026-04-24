//! SCP / SFTP file-transfer commands.
//!
//! Audit-4 Phase 5a: extracted from `commands/ssh.rs` (which had grown to
//! ~700 lines mixing PTY shell sessions, port-forward bookkeeping, and
//! file-transfer plumbing). The split is purely organisational — the wire
//! commands (`scp_upload`, `scp_download`) and their input/output shapes
//! are unchanged, so the frontend `invoke()` calls in
//! `src/store/useFileTransferStore.ts` continue to work unmodified.
//!
//! The shared helpers `find_connection` and `resolve_credential` live in
//! `commands/ssh.rs` and are re-exported as `pub(super)` so this module
//! can use them without duplicating logic. We intentionally keep the
//! gateway-bridging helper (`bridge_via_gateway`) here rather than in
//! `ssh.rs` because it is only used by SCP — `ssh_connect` for
//! jump-shell builds its own bridge through `start_jump_shell` in the
//! lower-level `crate::ssh` module.

use crate::commands::ssh::{find_connection, resolve_credential};
use crate::models::{Connection, ConnectionKind};
use crate::ssh::{
    forward_bidi, open_authenticated_session, open_authenticated_session_over_stream,
    open_gateway_session, AuthMethod,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, Barrier, Mutex};
use std::thread;

#[derive(Debug, Deserialize)]
pub struct ScpUploadInput {
    pub connection_id: String,
    pub local_path: String,
    pub remote_path: Option<String>,
    #[serde(default)]
    pub recursive: bool,
}

#[derive(Debug, Deserialize)]
pub struct ScpDownloadInput {
    pub connection_id: String,
    pub remote_path: String,
    pub local_path: String,
    #[serde(default)]
    pub recursive: bool,
}

#[derive(Debug, Serialize)]
pub struct ScpResult {
    pub local_path: String,
    pub remote_path: String,
    pub bytes: u64,
    pub entries: Option<u64>,
}

#[tauri::command]
pub fn scp_upload(input: ScpUploadInput) -> Result<ScpResult, String> {
    let (data, conn) = find_connection(&input.connection_id)?;

    if matches!(conn.kind, ConnectionKind::PortForward { .. }) {
        return Err("SCP is not available for port-forward connections".to_string());
    }

    let mut ssh = connect_file_transfer_session(&data, &conn)?;
    let local = Path::new(&input.local_path);
    let (remote, bytes, entries) = if local.is_dir() {
        if !input.recursive {
            return Err("Uploading a directory requires the recursive option".to_string());
        }
        let base_name = local
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Local directory name is invalid".to_string())?;
        let target_path = resolve_remote_target_path(
            input.remote_path.as_deref().or(conn.remote_path.as_deref()),
            base_name,
        );
        let stats = upload_directory(&mut ssh, local, &target_path)?;
        (target_path, stats.bytes, Some(stats.entries))
    } else {
        let file_name = local
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Local file name is invalid".to_string())?;
        let target_path = resolve_remote_target_path(
            input.remote_path.as_deref().or(conn.remote_path.as_deref()),
            file_name,
        );
        let bytes = fs::read(&input.local_path).map_err(|e| e.to_string())?;
        let remote = upload_bytes(&mut ssh, &target_path, &bytes)?;
        (remote, bytes.len() as u64, Some(1))
    };

    Ok(ScpResult {
        local_path: input.local_path,
        remote_path: remote,
        bytes,
        entries,
    })
}

#[tauri::command]
pub fn scp_download(input: ScpDownloadInput) -> Result<ScpResult, String> {
    let (data, conn) = find_connection(&input.connection_id)?;

    if matches!(conn.kind, ConnectionKind::PortForward { .. }) {
        return Err("SCP is not available for port-forward connections".to_string());
    }

    let remote_path = resolve_download_remote_path(&conn, &input.remote_path);
    let mut ssh = connect_file_transfer_session(&data, &conn)?;
    let sftp = ssh
        .session
        .sftp()
        .map_err(|e| format!("Failed to open SFTP session: {}", e))?;
    let stat = sftp
        .stat(Path::new(&remote_path))
        .map_err(|e| format!("Failed to stat {}: {}", remote_path, e))?;
    let (bytes, entries) = if stat.is_dir() {
        if !input.recursive {
            return Err("Downloading a directory requires the recursive option".to_string());
        }
        let stats = download_directory(&mut ssh, &remote_path, Path::new(&input.local_path))?;
        (stats.bytes, Some(stats.entries))
    } else {
        let (bytes, size) = download_bytes(&mut ssh, &remote_path)?;
        if let Some(parent) = Path::new(&input.local_path).parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // Audit-3 P2#13: route SCP downloads through the atomic
        // writer so a process crash mid-transfer cannot leave a
        // half-written file at the destination path. Without this,
        // a partial download would silently overwrite a previously
        // good local file. No mode is forced — local file
        // permissions follow the user's umask via the temp file.
        crate::storage::atomic_write(Path::new(&input.local_path), &bytes, None)
            .map_err(|e| e.to_string())?;
        (size, Some(1))
    };

    Ok(ScpResult {
        local_path: input.local_path,
        remote_path,
        bytes,
        entries,
    })
}

struct ConnectedSession {
    session: ssh2::Session,
    destination_label: String,
}

struct TransferStats {
    bytes: u64,
    entries: u64,
}

fn connect_file_transfer_session(
    data: &crate::models::AppData,
    conn: &Connection,
) -> Result<ConnectedSession, String> {
    match &conn.kind {
        ConnectionKind::Direct => {
            let cred_id = conn
                .credential_id
                .as_ref()
                .ok_or_else(|| "No credential configured for this connection".to_string())?;
            let (username, auth) = resolve_credential(&data.credentials, cred_id)?;
            let session = open_authenticated_session(
                &conn.host,
                conn.port,
                &username,
                &auth,
                conn.verbosity,
                &conn.extra_args,
            )?;
            Ok(ConnectedSession {
                session,
                destination_label: format!("{}@{}:{}", username, conn.host, conn.port),
            })
        }
        ConnectionKind::JumpShell {
            gateway_host,
            gateway_port,
            gateway_credential_id,
            destination_host,
            destination_port,
        } => {
            let dest_cred_id = conn.credential_id.as_ref().ok_or_else(|| {
                "Jump-shell connection requires a destination credential".to_string()
            })?;
            let (gw_user, gw_auth) = resolve_credential(&data.credentials, gateway_credential_id)?;
            let (dest_user, dest_auth) = resolve_credential(&data.credentials, dest_cred_id)?;
            let stream = bridge_via_gateway(
                gateway_host,
                *gateway_port,
                &gw_user,
                &gw_auth,
                destination_host,
                *destination_port,
            )?;
            let session = open_authenticated_session_over_stream(
                stream,
                &dest_user,
                &dest_auth,
                conn.verbosity,
                &conn.extra_args,
            )?;
            Ok(ConnectedSession {
                session,
                destination_label: format!(
                    "{}@{}:{} via {}:{}",
                    dest_user, destination_host, destination_port, gateway_host, gateway_port
                ),
            })
        }
        ConnectionKind::PortForward { .. } | ConnectionKind::LegacyTunnel { .. } => {
            Err("SCP is only available for direct and jump-shell connections".to_string())
        }
    }
}

fn bridge_via_gateway(
    gateway_host: &str,
    gateway_port: u16,
    gateway_user: &str,
    gateway_auth: &AuthMethod,
    destination_host: &str,
    destination_port: u16,
) -> Result<TcpStream, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind ephemeral loopback port: {}", e))?;
    let local_addr = listener
        .local_addr()
        .map_err(|e| format!("local_addr() failed: {}", e))?;
    let gateway_session = open_gateway_session(gateway_host, gateway_port, gateway_user, gateway_auth)?;
    let gateway_session = Arc::new(Mutex::new(gateway_session));
    let barrier = Arc::new(Barrier::new(2));
    let forward_err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    listener.set_nonblocking(false).ok();

    {
        let gateway_session = Arc::clone(&gateway_session);
        let barrier = Arc::clone(&barrier);
        let forward_err = Arc::clone(&forward_err);
        let destination_host = destination_host.to_string();
        thread::spawn(move || {
            match listener.accept() {
                Ok((local_stream, peer)) => {
                    let chan_result = {
                        let sess = crate::ssh::lock_recover(&gateway_session);
                        sess.channel_direct_tcpip(
                            &destination_host,
                            destination_port,
                            Some((&peer.ip().to_string(), peer.port())),
                        )
                    };
                    match chan_result {
                        Ok(channel) => {
                            crate::ssh::lock_recover(&gateway_session).set_blocking(false);
                            barrier.wait();
                            forward_bidi(local_stream, channel);
                        }
                        Err(e) => {
                            *crate::ssh::lock_recover(&forward_err) =
                                Some(format!("channel_direct_tcpip failed: {}", e));
                            let _ = local_stream.shutdown(std::net::Shutdown::Both);
                            barrier.wait();
                        }
                    }
                }
                Err(e) => {
                    *crate::ssh::lock_recover(&forward_err) = Some(format!("accept() failed: {}", e));
                    barrier.wait();
                }
            }
        });
    }

    let connect_result = TcpStream::connect(("127.0.0.1", local_addr.port()))
        .map_err(|e| format!("Failed to connect inner SSH session: {}", e));

    // Mirror the H5 fix from start_jump_shell: if TcpStream::connect() failed
    // the spawned forwarder is still blocked in listener.accept() and will
    // never reach barrier.wait(). Do a best-effort self-connect so accept()
    // wakes up and the thread can exit, then return the real error without
    // touching the barrier (which would deadlock the main thread).
    let stream = match connect_result {
        Ok(s) => s,
        Err(e) => {
            let _ = TcpStream::connect(("127.0.0.1", local_addr.port()));
            return Err(e);
        }
    };
    barrier.wait();
    if let Some(err) = crate::ssh::lock_recover(&forward_err).take() {
        return Err(format!("Destination connect via gateway failed: {}", err));
    }
    Ok(stream)
}

fn upload_bytes(
    ssh: &mut ConnectedSession,
    remote_path: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let mut remote = ssh
        .session
        .scp_send(Path::new(remote_path), 0o644, bytes.len() as u64, None)
        .map_err(|e| format!("SCP upload to {} failed ({}): {}", remote_path, ssh.destination_label, e))?;
    remote.write_all(bytes).map_err(|e| e.to_string())?;
    remote.send_eof().ok();
    remote.wait_eof().ok();
    remote.close().ok();
    remote.wait_close().ok();
    Ok(remote_path.to_string())
}

fn download_bytes(
    ssh: &mut ConnectedSession,
    remote_path: &str,
) -> Result<(Vec<u8>, u64), String> {
    let (mut remote, stat) = ssh
        .session
        .scp_recv(Path::new(remote_path))
        .map_err(|e| format!("SCP download from {} failed ({}): {}", remote_path, ssh.destination_label, e))?;
    let mut bytes = Vec::new();
    remote.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    remote.send_eof().ok();
    remote.wait_eof().ok();
    remote.close().ok();
    remote.wait_close().ok();
    Ok((bytes, stat.size()))
}

fn upload_directory(
    ssh: &mut ConnectedSession,
    local_path: &Path,
    remote_path: &str,
) -> Result<TransferStats, String> {
    ensure_remote_dir(ssh, remote_path)?;
    let mut stats = TransferStats { bytes: 0, entries: 0 };
    for entry in fs::read_dir(local_path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let child_local = entry.path();
        let child_name = entry.file_name();
        let child_name = child_name.to_string_lossy();
        let child_remote = format!("{}/{}", remote_path.trim_end_matches('/'), child_name);
        if child_local.is_dir() {
            let child_stats = upload_directory(ssh, &child_local, &child_remote)?;
            stats.bytes += child_stats.bytes;
            stats.entries += child_stats.entries;
        } else {
            let bytes = fs::read(&child_local).map_err(|e| e.to_string())?;
            upload_bytes(ssh, &child_remote, &bytes)?;
            stats.bytes += bytes.len() as u64;
            stats.entries += 1;
        }
    }
    Ok(stats)
}

fn download_directory(
    ssh: &mut ConnectedSession,
    remote_path: &str,
    local_path: &Path,
) -> Result<TransferStats, String> {
    fs::create_dir_all(local_path).map_err(|e| e.to_string())?;
    let sftp = ssh.session.sftp().map_err(|e| format!("Failed to open SFTP session: {}", e))?;
    let mut stats = TransferStats { bytes: 0, entries: 0 };
    for (path, stat) in sftp.readdir(Path::new(remote_path)).map_err(|e| e.to_string())? {
        let name = match path.file_name().and_then(|name| name.to_str()) {
            Some(".") | Some("..") | None => continue,
            Some(name) => name,
        };
        let child_remote = format!("{}/{}", remote_path.trim_end_matches('/'), name);
        let child_local = local_path.join(name);
        if stat.is_dir() {
            let child_stats = download_directory(ssh, &child_remote, &child_local)?;
            stats.bytes += child_stats.bytes;
            stats.entries += child_stats.entries;
        } else {
            let (bytes, size) = download_bytes(ssh, &child_remote)?;
            if let Some(parent) = child_local.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            // Audit-3 P2#13: same crash-safety as the single-file
            // SCP download path above. Recursive transfers are even
            // more vulnerable because a crash partway through writes
            // the partial child to disk while the parent counter
            // continues incrementing — leaving a corrupt directory
            // tree that's hard to detect.
            crate::storage::atomic_write(&child_local, &bytes, None)
                .map_err(|e| e.to_string())?;
            stats.bytes += size;
            stats.entries += 1;
        }
    }
    Ok(stats)
}

fn ensure_remote_dir(ssh: &ConnectedSession, remote_path: &str) -> Result<(), String> {
    let sftp = ssh.session.sftp().map_err(|e| format!("Failed to open SFTP session: {}", e))?;
    let home_dir = sftp
        .realpath(Path::new("."))
        .map_err(|e| format!("Failed to resolve remote home directory: {}", e))?;
    let home_dir = home_dir
        .to_str()
        .ok_or_else(|| "Remote home directory contains invalid UTF-8".to_string())?;

    for dir in directory_creation_sequence(remote_path, home_dir) {
        if sftp.stat(Path::new(&dir)).is_err() {
            sftp.mkdir(Path::new(&dir), 0o755)
                .map_err(|e| format!("Failed to create remote directory {}: {}", dir, e))?;
        }
    }
    Ok(())
}

fn directory_creation_sequence(remote_path: &str, home_dir: &str) -> Vec<String> {
    let trimmed = remote_path.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let clean_home = home_dir.trim_end_matches('/');
    let mut segments = if trimmed.starts_with('/') {
        Vec::new()
    } else if clean_home.is_empty() {
        Vec::new()
    } else {
        clean_home
            .split('/')
            .filter(|part| !part.is_empty())
            .map(ToString::to_string)
            .collect::<Vec<_>>()
    };

    let parts = if trimmed == "~" {
        ""
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix('/') {
        rest
    } else {
        trimmed
    };

    let mut out = Vec::new();
    for part in parts.split('/') {
        let part = part.trim();
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            if !segments.is_empty() {
                segments.pop();
            }
            continue;
        }
        segments.push(part.to_string());
        out.push(format!("/{}", segments.join("/")));
    }

    out
}

fn resolve_remote_target_path(base: Option<&str>, file_name: &str) -> String {
    let cleaned = base.unwrap_or(".").trim();
    if cleaned.is_empty() || cleaned.ends_with('/') {
        format!("{}{}", if cleaned.is_empty() { "./" } else { cleaned }, file_name)
    } else {
        format!("{}/{}", cleaned, file_name)
    }
}

fn resolve_download_remote_path(conn: &Connection, remote_path: &str) -> String {
    let trimmed = remote_path.trim();
    if trimmed.starts_with('/') || trimmed.starts_with('~') {
        return trimmed.to_string();
    }
    match conn.remote_path.as_deref().map(str::trim).filter(|path| !path.is_empty()) {
        Some(base) => format!("{}/{}", base.trim_end_matches('/'), trimmed),
        None => trimmed.to_string(),
    }
}

#[cfg(test)]
mod scp_tests {
    use super::*;
    use crate::models::{Connection, ConnectionKind};

    #[test]
    fn test_resolve_remote_target_path_appends_file_name() {
        assert_eq!(resolve_remote_target_path(Some("/tmp"), "file.txt"), "/tmp/file.txt");
        assert_eq!(resolve_remote_target_path(Some("/tmp/"), "file.txt"), "/tmp/file.txt");
    }

    #[test]
    fn test_resolve_download_remote_path_uses_connection_base() {
        let mut conn = Connection::new("n".into(), "h".into(), 22, None, ConnectionKind::Direct);
        conn.remote_path = Some("/srv/app".into());
        assert_eq!(resolve_download_remote_path(&conn, "logs/app.log"), "/srv/app/logs/app.log");
    }

    #[test]
    fn test_resolve_download_remote_path_keeps_absolute_path() {
        let conn = Connection::new("n".into(), "h".into(), 22, None, ConnectionKind::Direct);
        assert_eq!(resolve_download_remote_path(&conn, "/var/log/syslog"), "/var/log/syslog");
    }

    #[test]
    fn test_resolve_remote_target_path_defaults_to_current_directory() {
        assert_eq!(resolve_remote_target_path(None, "file.txt"), "./file.txt");
    }

    #[test]
    fn test_directory_creation_sequence_for_relative_path_uses_home_dir() {
        let dirs = directory_creation_sequence("logs/app", "/home/dev");
        assert_eq!(dirs, vec!["/home/dev/logs", "/home/dev/logs/app"]);
    }

    #[test]
    fn test_directory_creation_sequence_for_absolute_path_starts_at_root() {
        let dirs = directory_creation_sequence("/srv/releases", "/home/dev");
        assert_eq!(dirs, vec!["/srv", "/srv/releases"]);
    }

    #[test]
    fn test_directory_creation_sequence_for_tilde_path_uses_home_dir() {
        let dirs = directory_creation_sequence("~/deploy/current", "/home/dev");
        assert_eq!(dirs, vec!["/home/dev/deploy", "/home/dev/deploy/current"]);
    }
}
