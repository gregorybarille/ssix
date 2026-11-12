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
//!
//! These commands return only when the copy is over, so `scp_stop` finds one by
//! its connection: `COPIES` holds at most one per connection.

use crate::commands::blocking;
use crate::commands::scripts::connect_unless_cancelled;
use crate::commands::sftp::browse::{absolute_remote, check_local_path, expand_local};
use crate::commands::sftp::transfer::{
    copy_stream, download_unattended, file_mode, limit_tidying, local_target, upload_unattended,
    with_finish_limit, write_partial, Copied, Stop, CALL_TIMEOUT_MS,
};
use crate::commands::sftp::{join_remote, remote_parent, temp_name, SESSION_LOST};
use crate::commands::ssh::{find_connection, ConnectedSession};
use crate::commands::ssh_keygen::shell_single_quote;
use crate::models::Connection;
use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use ssh2::{Channel, Sftp};
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

#[cfg(all(test, unix))]
mod live_tests;

static COPIES: LazyLock<DashMap<String, Arc<AtomicBool>>> = LazyLock::new(DashMap::new);

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
    /// Set when a stop ended the copy: what to tell the user. `bytes` and
    /// `entries` then say how far it got.
    pub stopped: Option<String>,
}

/// A copy's place in `COPIES`, given up however the copy ends.
struct RunningCopy {
    connection_id: String,
    stop: Arc<AtomicBool>,
}

impl RunningCopy {
    fn begin(connection_id: &str) -> Result<Self, String> {
        match COPIES.entry(connection_id.to_string()) {
            Entry::Occupied(_) => {
                Err("A transfer on this connection is already running".to_string())
            }
            Entry::Vacant(place) => {
                let stop = Arc::new(AtomicBool::new(false));
                place.insert(stop.clone());
                Ok(Self {
                    connection_id: connection_id.to_string(),
                    stop,
                })
            }
        }
    }

    fn stop_asked(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    /// What a legacy `scp` copy calls after each chunk.
    fn check(&self) -> Result<(), Stop> {
        if self.stop_asked() {
            Err(Stop::Cancelled)
        } else {
            Ok(())
        }
    }
}

impl Drop for RunningCopy {
    fn drop(&mut self) {
        COPIES.remove(&self.connection_id);
    }
}

/// Ask the copy running on a connection to stop. It stops once the SFTP call in
/// progress returns, and its command then answers with `stopped` set. Asking when
/// none runs is not an error: it may have ended while the request was on its way.
#[tauri::command]
pub fn scp_stop(connection_id: String) -> Result<(), String> {
    if connection_id.trim().is_empty() {
        return Err("A connection id is required to stop a transfer".to_string());
    }
    if let Some(stop) = COPIES.get(&connection_id) {
        stop.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// Forwards (`ssh -L`, `-R`, `-D`) open no shell on a host, so there is
/// nothing to copy files to or from.
fn refuse_forward(conn: &Connection) -> Result<(), String> {
    if conn.kind.is_forward() {
        return Err("SCP is not available for port-forward connections".to_string());
    }
    Ok(())
}

/// A session for one copy, or `None` if it was stopped while connecting. Copies
/// go chunk by chunk, so this limit is on one chunk over a stalled link and not
/// on how long a whole copy may take.
fn connect_for_copy(copy: &RunningCopy) -> Result<Option<(ConnectedSession, Connection)>, String> {
    let (data, conn) = find_connection(&copy.connection_id)?;
    refuse_forward(&conn)?;
    let connected = connect_unless_cancelled(data, conn.clone(), "SCP", &|| copy.stop_asked())?;
    Ok(connected.map(|ssh| {
        ssh.session.set_timeout(CALL_TIMEOUT_MS);
        (ssh, conn)
    }))
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

/// The copy has failed, so the error should not wait for closing the session.
/// `limit_tidying` leaves a stop on a working link its usual limit.
fn copy_failed(stop: Stop, ssh: &ConnectedSession) -> Stop {
    limit_tidying(&ssh.session);
    match stop {
        Stop::Cancelled => Stop::Cancelled,
        failed => Stop::Failed(copy_error(failed, &ssh.destination_label)),
    }
}

fn stopped_message(copied: &Copied, failure: Option<&str>) -> String {
    let what_happened = match (copied.bytes, copied.files) {
        (0, 0) => "Transfer stopped before any file was copied.".to_string(),
        (bytes, 0) => format!(
            "Transfer stopped after {} bytes. The unfinished file was discarded, and what was at the target is unchanged.",
            bytes
        ),
        (bytes, 1) => format!(
            "Transfer stopped after {} bytes. The 1 finished file stays at the target, and any unfinished file was discarded.",
            bytes
        ),
        (bytes, files) => format!(
            "Transfer stopped after {} bytes. The {} finished files stay at the target, and any unfinished file was discarded.",
            bytes, files
        ),
    };
    match failure {
        None => what_happened,
        Some(error) => format!(
            "{} The copy also failed while stopping, so an upload's temporary .ssix-part file may remain on the server: {}",
            what_happened, error
        ),
    }
}

/// The command's answer for a copy that is over. Once a stop was asked for, a
/// failure is how it ended on a stalled link, so it is shown as part of the stop.
fn copy_ended(
    copy: &RunningCopy,
    local_path: String,
    remote_path: String,
    copied: Copied,
    ended: Result<(), Stop>,
) -> Result<ScpResult, String> {
    let stopped = match ended {
        Ok(()) => None,
        Err(Stop::Cancelled) => Some(stopped_message(&copied, None)),
        Err(Stop::Failed(error)) if copy.stop_asked() => {
            Some(stopped_message(&copied, Some(&error)))
        }
        Err(failed) => return Err(failed.into_message()),
    };
    Ok(ScpResult {
        local_path,
        remote_path,
        bytes: copied.bytes,
        entries: Some(copied.files),
        stopped,
    })
}

/// Copy one file over legacy `scp`, which `run` does, stopping when asked.
fn legacy_copy(
    copy: &RunningCopy,
    reword_failure: impl FnOnce(String) -> String,
    run: impl FnOnce(&mut dyn FnMut(usize) -> Result<(), Stop>) -> Result<u64, Stop>,
) -> (Copied, Result<(), Stop>) {
    let mut bytes = 0;
    let ended = run(&mut |n| {
        bytes += n as u64;
        copy.check()
    });
    let files = u64::from(ended.is_ok());
    (
        Copied { bytes, files },
        ended
            .map(|_| ())
            .map_err(|stop| stop.map_failed(reword_failure)),
    )
}

/// SFTP and legacy `scp` both read `~` as a plain name. Without SFTP nothing can
/// ask where the login folder is, but a command on the server starts in it.
fn expand_tilde(sftp: Option<&Sftp>, path: &str) -> Result<String, String> {
    if path != "~" && !path.starts_with("~/") {
        return Ok(path.to_string());
    }
    let home = sftp.map_or(Ok(".".to_string()), remote_home)?;
    Ok(absolute_remote(&home, path))
}

fn remote_home(sftp: &Sftp) -> Result<String, String> {
    sftp.realpath(Path::new("."))
        .map_err(|e| format!("Failed to resolve remote home directory: {}", e))?
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| "Remote home directory contains invalid UTF-8".to_string())
}

#[tauri::command]
pub async fn scp_upload(input: ScpUploadInput) -> Result<ScpResult, String> {
    // Before any wait, so that a stop finds it from the moment it can be asked for.
    let copy = RunningCopy::begin(&input.connection_id)?;
    blocking(move || scp_upload_sync(input, copy)).await
}

/// A local path as the Files view takes it: `~/` for the home folder, and
/// otherwise a full path, which cannot land in the folder the app runs in.
fn full_local_path(path: &str) -> Result<String, String> {
    let path = if path.starts_with('~') {
        expand_local(path)?.to_string_lossy().into_owned()
    } else {
        path.to_string()
    };
    check_local_path(&path)?;
    Ok(path)
}

fn scp_upload_sync(mut input: ScpUploadInput, copy: RunningCopy) -> Result<ScpResult, String> {
    input.local_path = full_local_path(&input.local_path)?;
    let requested = input.remote_path.clone().unwrap_or_default();
    let Some((ssh, conn)) = connect_for_copy(&copy)? else {
        let ended = Err(Stop::Cancelled);
        return copy_ended(&copy, input.local_path, requested, Copied::default(), ended);
    };
    let local = Path::new(&input.local_path);
    // SFTP first: this is what OpenSSH's `scp` itself has done since 9.0.
    let sftp = ssh.session.sftp();
    let base = input.remote_path.as_deref().or(conn.remote_path.as_deref());
    let target = upload_target(&ssh, sftp.as_ref(), local, base, input.recursive);
    let (remote, copied, ended) = match target {
        Err(stop) => (requested, Copied::default(), Err(stop)),
        Ok(target) => {
            let (copied, ended) = match &sftp {
                Ok(sftp) => {
                    let (copied, ended) =
                        upload_unattended(&ssh.session, sftp, local, &target, &copy.stop);
                    (copied, ended.map_err(|stop| copy_failed(stop, &ssh)))
                }
                // No SFTP subsystem: some embedded sshd builds, or it is turned off.
                Err(sftp_err) => legacy_copy(
                    &copy,
                    |scp_err| {
                        format!(
                            "Upload to {} failed via both transports ({}). SFTP: {}. SCP: {}",
                            target, ssh.destination_label, sftp_err, scp_err
                        )
                    },
                    |on_chunk| upload_file_scp(&ssh, local, &target, on_chunk),
                ),
            };
            (target, copied, ended)
        }
    };
    copy_ended(&copy, input.local_path, remote, copied, ended)
}

/// Where an upload lands. A folder needs SFTP, and the folders above it.
fn upload_target(
    ssh: &ConnectedSession,
    sftp: Result<&Sftp, &ssh2::Error>,
    local: &Path,
    base: Option<&str>,
    recursive: bool,
) -> Result<String, Stop> {
    let is_dir = local.is_dir();
    if is_dir && !recursive {
        return Err("Uploading a directory requires the recursive option"
            .to_string()
            .into());
    }
    let name = local
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            let kind = if is_dir { "directory" } else { "file" };
            format!("Local {} name is invalid", kind)
        })?;
    if let (true, Err(e)) = (is_dir, sftp) {
        return Err(format!("Failed to open SFTP session: {}", e).into());
    }
    expand_tilde(sftp.ok(), &resolve_remote_target_path(base, name))
        .and_then(|path| match sftp {
            Ok(sftp) if is_dir => ensure_remote_parents(sftp, &path).map(|()| path),
            _ => Ok(path),
        })
        .map_err(|e| copy_failed(Stop::Failed(e), ssh))
}

#[tauri::command]
pub async fn scp_download(input: ScpDownloadInput) -> Result<ScpResult, String> {
    // Before any wait, so that a stop finds it from the moment it can be asked for.
    let copy = RunningCopy::begin(&input.connection_id)?;
    blocking(move || scp_download_sync(input, copy)).await
}

fn scp_download_sync(mut input: ScpDownloadInput, copy: RunningCopy) -> Result<ScpResult, String> {
    input.local_path = full_local_path(&input.local_path)?;
    let Some((ssh, conn)) = connect_for_copy(&copy)? else {
        let ended = Err(Stop::Cancelled);
        return copy_ended(
            &copy,
            input.local_path,
            input.remote_path,
            Copied::default(),
            ended,
        );
    };
    let sftp = ssh.session.sftp();
    let local = Path::new(&input.local_path);
    let requested = resolve_download_remote_path(&conn, &input.remote_path);
    let (remote_path, copied, ended) = match expand_tilde(sftp.as_ref().ok(), &requested) {
        Err(e) => {
            let ended = Err(copy_failed(Stop::Failed(e), &ssh));
            (requested, Copied::default(), ended)
        }
        Ok(remote_path) => {
            let (copied, ended) = match &sftp {
                Ok(sftp) => {
                    download_over_sftp(&ssh, sftp, &remote_path, local, input.recursive, &copy)
                }
                // Only SFTP can list a folder, so without it a single file is all that can come.
                Err(sftp_err) => legacy_copy(
                    &copy,
                    |scp_err| {
                        format!(
                            "Download from {} failed via both transports ({}). SFTP: {}. SCP: {}",
                            remote_path, ssh.destination_label, sftp_err, scp_err
                        )
                    },
                    |on_chunk| download_file_scp(&ssh, &remote_path, local, on_chunk),
                ),
            };
            (remote_path, copied, ended)
        }
    };
    copy_ended(&copy, input.local_path, remote_path, copied, ended)
}

fn download_over_sftp(
    ssh: &ConnectedSession,
    sftp: &Sftp,
    remote_path: &str,
    local: &Path,
    recursive: bool,
    copy: &RunningCopy,
) -> (Copied, Result<(), Stop>) {
    let refused = |stop: Stop| (Copied::default(), Err(stop));
    let stat = match sftp.stat(Path::new(remote_path)) {
        Ok(stat) => stat,
        Err(e) => {
            let error = format!("Failed to stat {}: {}", remote_path, e);
            return refused(copy_failed(Stop::Failed(error), ssh));
        }
    };
    if stat.is_dir() && !recursive {
        return refused(Stop::Failed(
            "Downloading a directory requires the recursive option".to_string(),
        ));
    }
    if let Err(error) = create_local_parent(local) {
        return refused(Stop::Failed(error));
    }
    let (copied, ended) = download_unattended(&ssh.session, sftp, remote_path, local, &copy.stop);
    (copied, ended.map_err(|stop| copy_failed(stop, ssh)))
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
fn upload_file_scp(
    ssh: &ConnectedSession,
    local: &Path,
    target: &str,
    on_chunk: &mut dyn FnMut(usize) -> Result<(), Stop>,
) -> Result<u64, Stop> {
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

    let result = send_staged(ssh, file, &staged, mode, size, on_chunk).and_then(|()| {
        with_finish_limit(&ssh.session, || {
            run_remote(ssh, &place_staged_command(&staged, target, replaced_mode))
        })
        .map_err(Stop::Failed)
    });
    if let Err(stop) = result {
        limit_tidying(&ssh.session);
        let _ = run_remote(ssh, &format!("rm -f -- {}", shell_single_quote(&staged)));
        return Err(stop.map_failed(|error| {
            format!(
                "SCP upload to {} failed ({}): {}",
                target, ssh.destination_label, error
            )
        }));
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
    on_chunk: &mut dyn FnMut(usize) -> Result<(), Stop>,
) -> Result<(), Stop> {
    let mut channel = ssh
        .session
        .scp_send(Path::new(staged), mode, size, None)
        .map_err(|e| e.to_string())?;
    let mut sent = 0;
    copy_stream(&mut file.take(size), &mut channel, &mut |n| {
        sent += n as u64;
        on_chunk(n)
    })
    // Closing `channel` is tidying too.
    .inspect_err(|_| limit_tidying(&ssh.session))?;
    if sent != size {
        return Err("The file shrank while it was being sent".to_string().into());
    }
    // The protocol's "file complete". Without it `scp -t` reports a lost
    // connection and exits 1, though the bytes have landed.
    channel.write_all(b"\0").map_err(|e| e.to_string())?;
    with_finish_limit(&ssh.session, || check_scp_exit(&mut channel)).map_err(Stop::Failed)
}

fn download_file_scp(
    ssh: &ConnectedSession,
    remote_path: &str,
    local: &Path,
    on_chunk: &mut dyn FnMut(usize) -> Result<(), Stop>,
) -> Result<u64, Stop> {
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
    create_local_parent(local).map_err(fail)?;
    let target = local_target(local).map_err(fail)?;
    write_partial(&target, Some(stat.mode() as u32), |file| {
        let mut received = 0;
        // ssh2 stops reading this channel at the size in the header.
        copy_stream(&mut channel, file, &mut |n| {
            received += n as u64;
            on_chunk(n)
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
    .map_err(|stop| {
        limit_tidying(&ssh.session);
        stop.map_failed(fail)
    })?;
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
    let mut dirs = directory_creation_sequence(remote_path, &remote_home(sftp)?);
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

    let mut out = Vec::new();
    for part in trimmed.trim_start_matches('/').split('/') {
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
    use crate::models::{Connection, ConnectionKind, Credential, CredentialKind};
    use crate::storage::test_support::with_isolated_data_dir;
    use crate::storage::with_data_mut;
    use std::net::TcpListener;
    use std::thread;
    use std::time::{Duration, Instant};

    /// A full path on any system.
    fn temp_path(name: &str) -> String {
        std::env::temp_dir()
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    fn upload_input(connection_id: &str) -> ScpUploadInput {
        ScpUploadInput {
            connection_id: connection_id.to_string(),
            local_path: temp_path("some-file"),
            remote_path: Some("/tmp".to_string()),
            recursive: false,
        }
    }

    #[test]
    fn a_second_copy_on_a_connection_is_refused_until_the_first_ends() {
        let first = RunningCopy::begin("scp-test-second").unwrap();
        let refused = RunningCopy::begin("scp-test-second").err().unwrap();
        assert!(refused.contains("already running"), "{}", refused);
        // A copy of another connection has nothing to do with it.
        let other = RunningCopy::begin("scp-test-second-other").unwrap();
        drop(first);
        assert!(!COPIES.contains_key("scp-test-second"));
        assert!(COPIES.contains_key("scp-test-second-other"));
        RunningCopy::begin("scp-test-second").unwrap();
        drop(other);
    }

    #[test]
    fn a_stop_reaches_only_its_own_copy_and_never_a_later_one() {
        let stopped = RunningCopy::begin("scp-test-stop").unwrap();
        let other = RunningCopy::begin("scp-test-stop-other").unwrap();
        scp_stop("scp-test-stop".to_string()).unwrap();
        assert_eq!(stopped.check(), Err(Stop::Cancelled));
        assert_eq!(other.check(), Ok(()));
        drop(stopped);
        // Too late for that copy: not an error, and the next one is not stopped.
        scp_stop("scp-test-stop".to_string()).unwrap();
        let next = RunningCopy::begin("scp-test-stop").unwrap();
        assert_eq!(next.check(), Ok(()));
    }

    #[test]
    fn a_local_path_is_full_or_under_home() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(
            full_local_path("~/x").unwrap(),
            home.join("x").to_string_lossy()
        );
        assert_eq!(full_local_path(&temp_path("x")).unwrap(), temp_path("x"));
        assert_eq!(full_local_path("x").unwrap_err(), "x is not a full path");
        assert!(full_local_path("~other/x").is_err());
    }

    #[test]
    fn a_stop_needs_a_connection_id() {
        assert!(scp_stop(String::new()).is_err());
        assert!(scp_stop("  ".to_string()).is_err());
    }

    #[test]
    fn a_copy_that_fails_gives_up_its_place() {
        with_isolated_data_dir(|| {
            let id = "scp-test-unknown-connection";
            let copy = RunningCopy::begin(id).unwrap();
            assert!(COPIES.contains_key(id));
            scp_upload_sync(upload_input(id), copy).unwrap_err();
            assert!(!COPIES.contains_key(id));

            let copy = RunningCopy::begin(id).unwrap();
            let input = ScpDownloadInput {
                connection_id: id.to_string(),
                remote_path: "/tmp/f".to_string(),
                local_path: temp_path("some-file"),
                recursive: false,
            };
            scp_download_sync(input, copy).unwrap_err();
            assert!(!COPIES.contains_key(id));
        });
    }

    /// A server that takes the connection and never says a word.
    #[test]
    fn a_stop_while_connecting_ends_the_copy_at_once() {
        with_isolated_data_dir(|| {
            let silent = TcpListener::bind("127.0.0.1:0").unwrap();
            let cred = Credential::new(
                "c".to_string(),
                "u".to_string(),
                CredentialKind::Password {
                    password: "p".to_string(),
                },
            );
            let conn = Connection::new(
                "n".to_string(),
                "127.0.0.1".to_string(),
                silent.local_addr().unwrap().port(),
                Some(cred.id.clone()),
                ConnectionKind::Direct,
            );
            let id = conn.id.clone();
            with_data_mut(|data| {
                data.credentials.push(cred);
                data.connections.push(conn);
                Ok(())
            })
            .unwrap();

            let copy = RunningCopy::begin(&id).unwrap();
            let input = upload_input(&id);
            let running = thread::spawn(move || scp_upload_sync(input, copy));
            thread::sleep(Duration::from_millis(300));
            let asked = Instant::now();
            scp_stop(id.clone()).unwrap();
            let answer = running.join().unwrap().unwrap();

            assert!(asked.elapsed() < Duration::from_secs(5));
            assert_eq!(answer.bytes, 0);
            assert_eq!(answer.entries, Some(0));
            assert_eq!(
                answer.stopped.as_deref(),
                Some("Transfer stopped before any file was copied.")
            );
            assert!(!COPIES.contains_key(&id));
        });
    }

    #[test]
    fn a_stopped_copy_says_how_far_it_got_and_what_stays() {
        let say = |bytes, files| stopped_message(&Copied { bytes, files }, None);
        assert!(say(0, 0).contains("before any file"));
        assert!(say(5, 0).contains("after 5 bytes"));
        assert!(say(5, 0).contains("what was at the target is unchanged"));
        assert!(say(5, 1).contains("The 1 finished file stays"));
        assert!(say(5, 2).contains("The 2 finished files stay"));
    }

    #[test]
    fn a_failure_is_part_of_a_stop_only_once_one_was_asked_for() {
        let end = |copy: &RunningCopy, ended| {
            copy_ended(
                copy,
                "l".to_string(),
                "r".to_string(),
                Copied::default(),
                ended,
            )
        };
        let copy = RunningCopy::begin("scp-test-failure").unwrap();
        let failed = || Err(Stop::Failed("the link died".to_string()));
        assert_eq!(end(&copy, failed()).unwrap_err(), "the link died");
        assert_eq!(end(&copy, Ok(())).unwrap().stopped, None);

        scp_stop("scp-test-failure".to_string()).unwrap();
        let stopped = end(&copy, failed()).unwrap().stopped.unwrap();
        assert!(stopped.starts_with("Transfer stopped"), "{}", stopped);
        assert!(stopped.ends_with("the link died"), "{}", stopped);
    }

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
    fn without_sftp_a_tilde_is_where_a_command_starts() {
        assert_eq!(expand_tilde(None, "~/app/f").unwrap(), "./app/f");
        assert_eq!(expand_tilde(None, "~").unwrap(), ".");
        assert_eq!(expand_tilde(None, "/srv/f").unwrap(), "/srv/f");
        assert_eq!(expand_tilde(None, "~other/f").unwrap(), "~other/f");
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
