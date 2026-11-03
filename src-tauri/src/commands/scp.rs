//! SCP / SFTP file-transfer commands.
//!
//! Audit-4 Phase 5a: extracted from `commands/ssh.rs` (which had grown to
//! ~700 lines mixing PTY shell sessions, port-forward bookkeeping, and
//! file-transfer plumbing). The wire commands (`scp_upload`, `scp_download`)
//! are what `ScpDialog` and the bulk action call.
//!
//! The shared helpers `find_connection` and `connect_session` live in
//! `commands/ssh.rs`; a jump host connection is bridged by
//! `crate::ssh::bridge_via_jump_host`, the same code path the jump host
//! terminal uses.
//!
//! The copying itself is the Files view's (`commands/sftp/transfer.rs`).
//! Only servers with no SFTP subsystem take the legacy `scp` path here.

use crate::commands::blocking;
use crate::commands::sftp::transfer::{
    copy_stream, download_unattended, file_mode, local_target, upload_unattended, write_partial,
    Stop, CALL_TIMEOUT_MS,
};
use crate::commands::sftp::{join_remote, remote_parent, temp_name, SESSION_LOST};
use crate::commands::ssh::{connect_session, find_connection, ConnectedSession};
use crate::commands::ssh_keygen::shell_single_quote;
use crate::models::Connection;
use serde::{Deserialize, Serialize};
use ssh2::{Channel, Sftp};
use std::fs;
use std::io::{Read, Write};
use std::path::Path;

#[cfg(all(test, unix))]
mod live_tests;

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

const TEARDOWN_TIMEOUT_MS: u32 = 1_000;

/// Forwards (`ssh -L`, `-R`, `-D`) open no shell on a host, so there is
/// nothing to copy files to or from.
fn refuse_forward(conn: &Connection) -> Result<(), String> {
    if conn.kind.is_forward() {
        return Err("SCP is not available for port-forward connections".to_string());
    }
    Ok(())
}

/// A session for one copy. Copies go chunk by chunk, so this limit is on one
/// chunk over a stalled link and not on how long a whole copy may take.
fn connect_for_copy(connection_id: &str) -> Result<(ConnectedSession, Connection), String> {
    let (data, conn) = find_connection(connection_id)?;
    refuse_forward(&conn)?;
    let ssh = connect_session(&data, &conn, "SCP")?;
    ssh.session.set_timeout(CALL_TIMEOUT_MS);
    Ok((ssh, conn))
}

/// The Files view reads `SESSION_LOST` to reconnect. This dialog only shows
/// the message, so it goes without the marker.
fn copy_error(stop: Stop, destination: &str) -> String {
    let message = stop.into_message();
    let message = message
        .strip_prefix(SESSION_LOST)
        .map_or(message.as_str(), str::trim_start);
    format!("{} ({})", message, destination)
}

/// Closing a session on a dead link waits out its timeout at every step, and
/// the copy has failed by now, so the error should not wait for that.
fn copy_failed(stop: Stop, ssh: &ConnectedSession) -> String {
    ssh.session.set_timeout(TEARDOWN_TIMEOUT_MS);
    copy_error(stop, &ssh.destination_label)
}

#[tauri::command]
pub async fn scp_upload(input: ScpUploadInput) -> Result<ScpResult, String> {
    blocking(move || scp_upload_sync(input)).await
}

fn scp_upload_sync(input: ScpUploadInput) -> Result<ScpResult, String> {
    let (ssh, conn) = connect_for_copy(&input.connection_id)?;
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
        let sftp = ssh
            .session
            .sftp()
            .map_err(|e| format!("Failed to open SFTP session: {}", e))?;
        ensure_remote_parents(&sftp, &target_path)?;
        let (bytes, files) = upload_unattended(&sftp, local, &target_path)
            .map_err(|stop| copy_failed(stop, &ssh))?;
        (target_path, bytes, Some(files))
    } else {
        let file_name = local
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Local file name is invalid".to_string())?;
        let target_path = resolve_remote_target_path(
            input.remote_path.as_deref().or(conn.remote_path.as_deref()),
            file_name,
        );
        // SFTP first: this is what OpenSSH's `scp` itself has done since 9.0.
        let bytes = match ssh.session.sftp() {
            Ok(sftp) => {
                upload_unattended(&sftp, local, &target_path)
                    .map_err(|stop| copy_failed(stop, &ssh))?
                    .0
            }
            // No SFTP subsystem: some embedded sshd builds, or it is turned off.
            Err(sftp_err) => upload_file_scp(&ssh, local, &target_path).map_err(|scp_err| {
                format!(
                    "Upload to {} failed via both transports ({}). SFTP: {}. SCP: {}",
                    target_path, ssh.destination_label, sftp_err, scp_err
                )
            })?,
        };
        (target_path, bytes, Some(1))
    };

    Ok(ScpResult {
        local_path: input.local_path,
        remote_path: remote,
        bytes,
        entries,
    })
}

#[tauri::command]
pub async fn scp_download(input: ScpDownloadInput) -> Result<ScpResult, String> {
    blocking(move || scp_download_sync(input)).await
}

fn scp_download_sync(input: ScpDownloadInput) -> Result<ScpResult, String> {
    let (ssh, conn) = connect_for_copy(&input.connection_id)?;
    let remote_path = resolve_download_remote_path(&conn, &input.remote_path);
    let local = Path::new(&input.local_path);
    let (bytes, entries) = match ssh.session.sftp() {
        Ok(sftp) => {
            let stat = sftp
                .stat(Path::new(&remote_path))
                .map_err(|e| format!("Failed to stat {}: {}", remote_path, e))?;
            if stat.is_dir() && !input.recursive {
                return Err("Downloading a directory requires the recursive option".to_string());
            }
            create_local_parent(local)?;
            let (bytes, files) = download_unattended(&sftp, &remote_path, local)
                .map_err(|stop| copy_failed(stop, &ssh))?;
            (bytes, Some(files))
        }
        // Only SFTP can list a folder, so without it a single file is all that can come.
        Err(sftp_err) => {
            let bytes = download_file_scp(&ssh, &remote_path, local).map_err(|scp_err| {
                format!(
                    "Download from {} failed via both transports ({}). SFTP: {}. SCP: {}",
                    remote_path, ssh.destination_label, sftp_err, scp_err
                )
            })?;
            (bytes, Some(1))
        }
    };

    Ok(ScpResult {
        local_path: input.local_path,
        remote_path,
        bytes,
        entries,
    })
}

fn create_local_parent(local: &Path) -> Result<(), String> {
    match local.parent() {
        Some(parent) => fs::create_dir_all(parent).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// Legacy `scp` can write only under the name it is given and has no rename,
/// so the new copy goes to a temporary name and the server's shell moves it
/// into place.
fn upload_file_scp(ssh: &ConnectedSession, local: &Path, target: &str) -> Result<u64, String> {
    let file =
        fs::File::open(local).map_err(|e| format!("Could not read {}: {}", local.display(), e))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("Could not read {}: {}", local.display(), e))?;
    let size = meta.len();
    let dir =
        remote_parent(target).ok_or_else(|| format!("{} has no folder to write in", target))?;
    let staged = join_remote(&dir, &temp_name());
    // A replaced file keeps its mode, as on SFTP. An `scp -f` header says what
    // it is with no shell involved; dropping the channel stops the rest coming.
    let replaced_mode = ssh
        .session
        .scp_recv(Path::new(target))
        .ok()
        .map(|(_, stat)| stat.mode() & 0o777);
    let mode = replaced_mode.unwrap_or(file_mode(&meta).unwrap_or(0o644) as i32 & 0o777);

    let result = send_staged(ssh, file, &staged, mode, size)
        .and_then(|()| run_remote(ssh, &place_staged_command(&staged, target, replaced_mode)));
    if let Err(error) = result {
        let _ = run_remote(ssh, &format!("rm -f -- {}", shell_single_quote(&staged)));
        return Err(format!(
            "SCP upload to {} failed ({}): {}",
            target, ssh.destination_label, error
        ));
    }
    Ok(size)
}

/// `mv` would put the file inside a folder, and replace a symlink instead of
/// writing through it as SFTP does, so both are refused. `chmod` is for a
/// replaced mode the server's umask took bits from while the copy arrived.
fn place_staged_command(staged: &str, target: &str, replaced_mode: Option<i32>) -> String {
    let (staged, target) = (shell_single_quote(staged), shell_single_quote(target));
    let chmod = replaced_mode.map_or(String::new(), |mode| {
        format!("chmod {:o} -- {} && ", mode, staged)
    });
    format!(
        "test ! -d {target} && test ! -L {target} && {chmod}mv -f -- {staged} {target}",
        target = target,
        chmod = chmod,
        staged = staged
    )
}

fn send_staged(
    ssh: &ConnectedSession,
    file: fs::File,
    staged: &str,
    mode: i32,
    size: u64,
) -> Result<(), String> {
    let mut channel = ssh
        .session
        .scp_send(Path::new(staged), mode, size, None)
        .map_err(|e| e.to_string())?;
    let mut sent = 0;
    copy_stream(&mut file.take(size), &mut channel, &mut |n| {
        sent += n as u64;
        Ok(())
    })
    .map_err(Stop::into_message)?;
    if sent != size {
        return Err("The file shrank while it was being sent".to_string());
    }
    // The protocol's "file complete". Without it `scp -t` reports a lost
    // connection and exits 1, though the bytes have landed.
    channel.write_all(b"\0").map_err(|e| e.to_string())?;
    check_scp_exit(&mut channel)
}

fn download_file_scp(
    ssh: &ConnectedSession,
    remote_path: &str,
    local: &Path,
) -> Result<u64, String> {
    let fail = |error: String| {
        format!(
            "SCP download from {} failed ({}): {}",
            remote_path, ssh.destination_label, error
        )
    };
    let (mut channel, stat) = ssh
        .session
        .scp_recv(Path::new(remote_path))
        .map_err(|e| fail(e.to_string()))?;
    let size = stat.size();
    create_local_parent(local).map_err(&fail)?;
    let target = local_target(local).map_err(&fail)?;
    write_partial(&target, Some(stat.mode() as u32), |file| {
        let mut received = 0;
        // ssh2 stops reading this channel at the size in the header.
        copy_stream(&mut channel, file, &mut |n| {
            received += n as u64;
            Ok(())
        })?;
        if received != size {
            return Err(Stop::Failed(format!(
                "The connection ended after {} of {} bytes",
                received, size
            )));
        }
        // Without this `scp -f` waits for the answer, then exits 1.
        channel.write_all(b"\0").map_err(|e| e.to_string())?;
        check_scp_exit(&mut channel).map_err(Stop::Failed)
    })
    .map_err(|stop| fail(stop.into_message()))?;
    Ok(size)
}

/// Close the channel and return how the remote command exited.
fn finish_channel(channel: &mut Channel) -> Result<i32, String> {
    channel
        .send_eof()
        .and_then(|()| channel.wait_eof())
        .and_then(|()| channel.close())
        .and_then(|()| channel.wait_close())
        .and_then(|()| channel.exit_status())
        .map_err(|e| e.to_string())
}

/// A failing `scp` often shows only here. Ignoring this once gave phantom
/// "Transferred N bytes" successes for files that never landed.
fn check_scp_exit(channel: &mut Channel) -> Result<(), String> {
    match finish_channel(channel)? {
        0 => Ok(()),
        exit => Err(format!(
            "remote scp exited with status {} (is the `scp` binary installed on the remote host?)",
            exit
        )),
    }
}

fn run_remote(ssh: &ConnectedSession, command: &str) -> Result<(), String> {
    let mut channel = ssh.session.channel_session().map_err(|e| e.to_string())?;
    channel.exec(command).map_err(|e| e.to_string())?;
    let mut errors = String::new();
    let _ = channel.stderr().read_to_string(&mut errors);
    match finish_channel(&mut channel)? {
        0 => Ok(()),
        exit => Err(format!(
            "Could not put the new copy in place, exit status {}: {}",
            exit,
            errors.trim()
        )),
    }
}

/// The folders above `remote_path`. The folder itself is left to the copy,
/// which gives it the source's mode.
fn ensure_remote_parents(sftp: &Sftp, remote_path: &str) -> Result<(), String> {
    let home_dir = sftp
        .realpath(Path::new("."))
        .map_err(|e| format!("Failed to resolve remote home directory: {}", e))?;
    let home_dir = home_dir
        .to_str()
        .ok_or_else(|| "Remote home directory contains invalid UTF-8".to_string())?;

    let mut dirs = directory_creation_sequence(remote_path, home_dir);
    dirs.pop();
    for dir in dirs {
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
    let mut segments = if trimmed.starts_with('/') || clean_home.is_empty() {
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
        format!(
            "{}{}",
            if cleaned.is_empty() { "./" } else { cleaned },
            file_name
        )
    } else {
        format!("{}/{}", cleaned, file_name)
    }
}

fn resolve_download_remote_path(conn: &Connection, remote_path: &str) -> String {
    let trimmed = remote_path.trim();
    if trimmed.starts_with('/') || trimmed.starts_with('~') {
        return trimmed.to_string();
    }
    match conn
        .remote_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
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
        assert_eq!(
            resolve_remote_target_path(Some("/tmp"), "file.txt"),
            "/tmp/file.txt"
        );
        assert_eq!(
            resolve_remote_target_path(Some("/tmp/"), "file.txt"),
            "/tmp/file.txt"
        );
    }

    #[test]
    fn test_resolve_download_remote_path_uses_connection_base() {
        let mut conn = Connection::new("n".into(), "h".into(), 22, None, ConnectionKind::Direct);
        conn.remote_path = Some("/srv/app".into());
        assert_eq!(
            resolve_download_remote_path(&conn, "logs/app.log"),
            "/srv/app/logs/app.log"
        );
    }

    #[test]
    fn test_resolve_download_remote_path_keeps_absolute_path() {
        let conn = Connection::new("n".into(), "h".into(), 22, None, ConnectionKind::Direct);
        assert_eq!(
            resolve_download_remote_path(&conn, "/var/log/syslog"),
            "/var/log/syslog"
        );
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

    #[test]
    fn a_copy_error_drops_the_files_views_marker_and_names_the_server() {
        let lost = Stop::Failed(format!("{}\nThe connection was lost", SESSION_LOST));
        assert_eq!(
            copy_error(lost, "u@h:22"),
            "The connection was lost (u@h:22)"
        );
        let refused = Stop::Failed("Could not read /x: denied".to_string());
        assert_eq!(
            copy_error(refused, "u@h:22"),
            "Could not read /x: denied (u@h:22)"
        );
    }

    #[test]
    fn placing_a_staged_copy_quotes_its_paths_and_keeps_a_replaced_mode() {
        assert_eq!(
            place_staged_command("/d/.t", "/d/it's", None),
            r"test ! -d '/d/it'\''s' && test ! -L '/d/it'\''s' && mv -f -- '/d/.t' '/d/it'\''s'"
        );
        assert_eq!(
            place_staged_command("/d/.t", "/d/f", Some(0o640)),
            "test ! -d '/d/f' && test ! -L '/d/f' && chmod 640 -- '/d/.t' && mv -f -- '/d/.t' '/d/f'"
        );
    }
}
