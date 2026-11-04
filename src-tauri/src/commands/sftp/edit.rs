//! Edit in place: a remote file is copied to a private temporary folder and
//! opened in the system's text editor. The user uploads when ready.
//!
//! The copy records what the server held when it was taken. Uploading checks
//! that first: if the file has changed since, or is gone, the upload stops
//! and the frontend asks, and only an upload with `force` replaces it.
//!
//! Temporary copies live in `<data dir>/edit-cache/<id>/`: the folders are
//! `0700` and the copy `0600` (on Windows the data dir sits in the user's
//! profile, which only that user can read). Closing an edit removes its
//! folder, so does quitting the app, and a copy a crash left behind goes at
//! a later launch.

use super::browse::missing_or;
use super::transfer::{
    commit_upload, copy_stream, discard_upload, stage_upload, RemoteTarget, Stop,
};
use super::{
    call_error, check_remote_path, path_string, refuse_forward, remote_name, safe_local_name,
    same_stamp,
};
use crate::commands::blocking;
use crate::commands::ssh::{connect_session, find_connection};
use crate::logs::log_local;
use crate::storage::data_dir;
use dashmap::DashMap;
use serde::Serialize;
use sha2::{Digest, Sha256};
use ssh2::{FileStat, Session, Sftp};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::LazyLock;
use std::thread;
use std::time::{Duration, Instant, SystemTime};
#[cfg(test)]
use ts_rs::TS;

/// Editing is for files a text editor can open; anything bigger is a
/// transfer, which shows progress and can be cancelled.
const MAX_BYTES: u64 = 32 * 1024 * 1024;
const CALL_TIMEOUT_MS: u32 = 60_000;
/// A leftover copy older than this is a crash's: other running instances of
/// the app can hold younger ones in use.
const STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
/// How long an editor launcher gets to report that it found no editor.
const LAUNCH_WAIT: Duration = Duration::from_secs(2);

/// An open edit, as the panel shows it.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct EditSession {
    pub edit_id: String,
    pub name: String,
    pub remote_path: String,
    /// The private copy to change.
    pub temp_path: String,
    #[cfg_attr(test, ts(type = "number"))]
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct EditStatus {
    /// The copy differs from what was last read from or written to the server.
    pub modified: bool,
    /// The editor deleted or moved the copy.
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum EditSaveOutcome {
    Saved {
        #[cfg_attr(test, ts(type = "number"))]
        size: u64,
    },
    /// The server's file is not what was downloaded. Nothing was written.
    RemoteChanged {
        /// It is gone rather than changed.
        deleted: bool,
        #[cfg_attr(test, ts(type = "number | null"))]
        size: Option<u64>,
        #[cfg_attr(test, ts(type = "number | null"))]
        modified: Option<u64>,
    },
}

type Digest256 = [u8; 32];

#[derive(Clone)]
struct EditRecord {
    connection_id: String,
    remote_path: String,
    folder: PathBuf,
    copy: PathBuf,
    /// What the server held when last read or written.
    remote_stat: FileStat,
    remote_digest: Digest256,
    /// The copy's size and time when `copy_differs` was worked out, so an
    /// unchanged copy is not hashed again on every poll.
    seen: Option<(u64, Option<SystemTime>)>,
    copy_differs: bool,
}

static EDITS: LazyLock<DashMap<String, EditRecord>> = LazyLock::new(DashMap::new);

fn edit_root() -> PathBuf {
    data_dir().join("edit-cache")
}

fn record(edit_id: &str) -> Result<EditRecord, String> {
    EDITS
        .get(edit_id)
        .map(|entry| entry.value().clone())
        .ok_or_else(|| "This edit is no longer open".to_string())
}

/// A folder only this user can read. A pre-existing one is tightened too,
/// since what matters is what the copies land in.
fn make_private_dir(path: &Path) -> Result<(), String> {
    let fail = |e: io::Error| format!("Could not create {}: {}", path.display(), e);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .map_err(fail)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(fail)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(path).map_err(fail)
    }
}

/// Created fresh, readable and writable by this user only.
fn create_private_file(path: &Path) -> io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// A fresh SFTP channel, which keeps its session alive for as long as it lives,
/// and that session, for its call limits.
pub(super) fn open_sftp(connection_id: &str) -> Result<(Session, Sftp), String> {
    let (data, conn) = find_connection(connection_id)?;
    refuse_forward(&conn)?;
    let ssh = connect_session(&data, &conn, "Editing files")?;
    ssh.session.set_timeout(CALL_TIMEOUT_MS);
    let sftp = ssh
        .session
        .sftp()
        .map_err(|e| format!("The server does not offer SFTP: {}", e.message()))?;
    Ok((ssh.session, sftp))
}

/// Hashes what passes through a reader.
struct HashingReader<'a> {
    inner: &'a mut dyn Read,
    hasher: Sha256,
}

impl Read for HashingReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.hasher.update(&buf[..n]);
        Ok(n)
    }
}

fn digest_of(source: &mut dyn Read) -> Result<Digest256, Stop> {
    let mut hashing = HashingReader {
        inner: source,
        hasher: Sha256::new(),
    };
    copy_stream(&mut hashing, &mut io::sink(), &mut |_| Ok(()))?;
    Ok(hashing.hasher.finalize().into())
}

fn local_digest(path: &Path) -> Result<Digest256, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("Could not read the copy: {}", e))?;
    digest_of(&mut file).map_err(Stop::into_message)
}

/// Copy `remote_path` to a private folder.
#[tauri::command]
pub async fn sftp_edit_open(
    connection_id: String,
    remote_path: String,
) -> Result<EditSession, String> {
    blocking(move || edit_open(&connection_id, &remote_path)).await
}

pub(super) fn edit_open(connection_id: &str, remote_path: &str) -> Result<EditSession, String> {
    check_remote_path(remote_path)?;
    let (_session, sftp) = open_sftp(connection_id)?;
    // Through a symlink the real file is what gets replaced on save.
    let real = sftp
        .realpath(Path::new(remote_path))
        .map_err(|e| call_error("Could not read", remote_path, &e))
        .and_then(path_string)?;
    let stat = sftp
        .stat(Path::new(&real))
        .map_err(|e| call_error("Could not read", &real, &e))?;
    if !stat.is_file() {
        return Err(format!("{} is not a file", remote_path));
    }
    if stat.size.unwrap_or(0) > MAX_BYTES {
        return Err(too_large(remote_path));
    }

    let name = remote_name(&real)
        .filter(|name| safe_local_name(name))
        .unwrap_or("file")
        .to_string();
    let edit_id = uuid::Uuid::new_v4().to_string();
    let folder = edit_root().join(&edit_id);
    let copy = folder.join(&name);
    let temp_path = copy
        .to_str()
        .ok_or_else(|| "The data folder's path is not valid UTF-8".to_string())?
        .to_string();

    make_private_dir(&edit_root())?;
    make_private_dir(&folder)?;
    let (digest, written) = fetch_copy(&sftp, &real, &copy).inspect_err(|_| {
        let _ = fs::remove_dir_all(&folder);
    })?;
    EDITS.insert(
        edit_id.clone(),
        EditRecord {
            connection_id: connection_id.to_string(),
            remote_path: real.clone(),
            folder,
            copy,
            remote_stat: stat,
            remote_digest: digest,
            seen: None,
            copy_differs: false,
        },
    );
    Ok(EditSession {
        edit_id,
        name,
        remote_path: real,
        temp_path,
        size: written,
    })
}

fn too_large(remote_path: &str) -> String {
    format!(
        "{} is too large to edit in place (the limit is {} MiB). Download it instead.",
        remote_path,
        MAX_BYTES / (1024 * 1024)
    )
}

fn fetch_copy(sftp: &Sftp, remote_path: &str, copy: &Path) -> Result<(Digest256, u64), String> {
    let mut remote = sftp
        .open(Path::new(remote_path))
        .map_err(|e| call_error("Could not read", remote_path, &e))?;
    fill_copy(&mut remote, copy, MAX_BYTES, &|| too_large(remote_path))
}

/// Write `source` to a new private `copy`, up to `limit` bytes. A server may
/// report no size or a wrong one, so the limit holds as the bytes arrive, and
/// a copy that stops short does not stay.
fn fill_copy(
    source: &mut dyn Read,
    copy: &Path,
    limit: u64,
    over_limit: &dyn Fn() -> String,
) -> Result<(Digest256, u64), String> {
    let mut file =
        create_private_file(copy).map_err(|e| format!("Could not create the copy: {}", e))?;
    let mut hashing = HashingReader {
        inner: source,
        hasher: Sha256::new(),
    };
    let mut written = 0u64;
    let filled = copy_stream(&mut hashing, &mut file, &mut |n| {
        written += n as u64;
        if written > limit {
            return Err(Stop::Failed(over_limit()));
        }
        Ok(())
    })
    .map_err(Stop::into_message)
    .and_then(|()| {
        file.flush()
            .map_err(|e| format!("Could not write the copy: {}", e))
    });
    drop(file);
    if let Err(error) = filled {
        let _ = fs::remove_file(copy);
        return Err(error);
    }
    Ok((hashing.hasher.finalize().into(), written))
}

/// Whether the copy differs from what the server held. Polled by the panel.
#[tauri::command]
pub async fn sftp_edit_status(edit_id: String) -> Result<EditStatus, String> {
    blocking(move || edit_status(&edit_id)).await
}

pub(super) fn edit_status(edit_id: &str) -> Result<EditStatus, String> {
    let rec = record(edit_id)?;
    let Ok(meta) = fs::metadata(&rec.copy) else {
        return Ok(EditStatus {
            modified: false,
            missing: true,
        });
    };
    let stamp = (meta.len(), meta.modified().ok());
    if rec.seen == Some(stamp) {
        return Ok(EditStatus {
            modified: rec.copy_differs,
            missing: false,
        });
    }
    let differs = local_digest(&rec.copy)? != rec.remote_digest;
    if let Some(mut entry) = EDITS.get_mut(edit_id) {
        entry.seen = Some(stamp);
        entry.copy_differs = differs;
    }
    Ok(EditStatus {
        modified: differs,
        missing: false,
    })
}

/// Open the copy in the system's text editor. Never a program that would
/// run it: a server chooses this file's name and contents.
#[tauri::command]
pub async fn sftp_edit_launch(edit_id: String) -> Result<(), String> {
    blocking(move || {
        let rec = record(&edit_id)?;
        launch_editor(editor_command(&rec.copy), &rec.copy)
    })
    .await
}

fn editor_command(path: &Path) -> Command {
    #[cfg(target_os = "macos")]
    {
        // `-t`: the default text editor, whatever the file's type.
        let mut command = Command::new("open");
        command.arg("-t").arg(path);
        command
    }
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("notepad.exe");
        command.arg(path);
        command
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // The copy is not executable (0600), so desktop launchers will not
        // run it even for a type they would normally execute.
        let mut command = Command::new("xdg-open");
        command.arg(path);
        command
    }
}

fn launch_editor(mut command: Command, copy: &Path) -> Result<(), String> {
    let manual = |why: String| {
        format!(
            "Could not open an editor ({}). Open the copy yourself: {}",
            why,
            copy.display()
        )
    };
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| manual(e.to_string()))?;
    let deadline = Instant::now() + LAUNCH_WAIT;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(manual(status.to_string())),
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(manual(e.to_string())),
        }
    }
    // Still running, so it is the editor itself. Something must reap it.
    thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Upload the copy. Without `force`, a server file that is no longer the
/// one downloaded comes back as `RemoteChanged` and stays as it is.
#[tauri::command]
pub async fn sftp_edit_save(edit_id: String, force: bool) -> Result<EditSaveOutcome, String> {
    blocking(move || edit_save(&edit_id, force)).await
}

fn changed_outcome(current: Option<&FileStat>) -> EditSaveOutcome {
    EditSaveOutcome::RemoteChanged {
        deleted: current.is_none(),
        size: current.and_then(|stat| stat.size),
        modified: current.and_then(|stat| stat.mtime),
    }
}

/// Size and time say a file changed; the hash says it did not when both
/// happen to match, since SFTP times only have one-second resolution.
fn remote_differs(sftp: &Sftp, rec: &EditRecord, current: &FileStat) -> Result<bool, String> {
    if !same_stamp(current, &rec.remote_stat) {
        return Ok(true);
    }
    let mut remote = sftp
        .open(Path::new(&rec.remote_path))
        .map_err(|e| call_error("Could not read", &rec.remote_path, &e))?;
    let digest = digest_of(&mut remote).map_err(Stop::into_message)?;
    Ok(digest != rec.remote_digest)
}

pub(super) fn edit_save(edit_id: &str, force: bool) -> Result<EditSaveOutcome, String> {
    let rec = record(edit_id)?;
    let (session, sftp) = open_sftp(&rec.connection_id)?;
    let read_stat = |sftp: &Sftp| {
        missing_or(sftp.stat(Path::new(&rec.remote_path)))
            .map_err(|e| call_error("Could not read", &rec.remote_path, &e))
    };

    let current = read_stat(&sftp)?;
    if !force {
        let changed = match &current {
            Some(stat) => remote_differs(&sftp, &rec, stat)?,
            None => true,
        };
        if changed {
            return Ok(changed_outcome(current.as_ref()));
        }
    }

    let target = RemoteTarget {
        path: rec.remote_path.clone(),
        // A file deleted meanwhile comes back with the mode it had.
        existing: current.clone().or_else(|| Some(rec.remote_stat.clone())),
    };
    let mut file =
        fs::File::open(&rec.copy).map_err(|e| format!("Could not read the copy: {}", e))?;
    let mut hashing = HashingReader {
        inner: &mut file,
        hasher: Sha256::new(),
    };
    let staged = stage_upload(
        &session,
        &sftp,
        &mut hashing,
        &target,
        None,
        &mut |_| Ok(()),
    )
    .map_err(Stop::into_message)?;
    let digest: Digest256 = hashing.hasher.finalize().into();

    // The upload took a while; look once more just before replacing. A
    // change after this instant is the one window SFTP leaves open.
    if !force {
        let latest = read_stat(&sftp)?;
        let unchanged = match (&latest, &current) {
            (Some(latest), Some(current)) => same_stamp(latest, current),
            _ => false,
        };
        if !unchanged {
            discard_upload(&sftp, &staged);
            return Ok(changed_outcome(latest.as_ref()));
        }
    }
    commit_upload(&session, &sftp, &staged, &target).map_err(Stop::into_message)?;

    let saved = sftp
        .stat(Path::new(&rec.remote_path))
        .map_err(|e| call_error("Could not read", &rec.remote_path, &e))?;
    let size = saved.size.unwrap_or(0);
    if let Some(mut entry) = EDITS.get_mut(edit_id) {
        entry.remote_stat = saved;
        entry.remote_digest = digest;
        entry.seen = None;
    }
    log_local(
        "info",
        "sftp",
        format!("Saved {} bytes to {}", size, rec.remote_path),
    );
    Ok(EditSaveOutcome::Saved { size })
}

/// End an edit and remove its copy.
#[tauri::command]
pub async fn sftp_edit_close(edit_id: String) -> Result<(), String> {
    blocking(move || edit_close(&edit_id)).await
}

pub(super) fn edit_close(edit_id: &str) -> Result<(), String> {
    let Some((_, rec)) = EDITS.remove(edit_id) else {
        return Ok(());
    };
    remove_folder(&rec.folder)
}

fn remove_folder(folder: &Path) -> Result<(), String> {
    match fs::remove_dir_all(folder) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!(
            "Could not remove the temporary copy in {}: {}",
            folder.display(),
            e
        )),
    }
}

/// Remove every copy this process has open: the app is quitting.
pub fn remove_open_copies() {
    for entry in EDITS.iter() {
        if let Err(e) = remove_folder(&entry.value().folder) {
            log_local("warn", "sftp", e);
        }
    }
    EDITS.clear();
}

/// Remove copies a crash left behind. Run at startup.
pub fn purge_stale_copies() {
    purge_older_than(STALE_AFTER);
}

fn purge_older_than(age: Duration) {
    let Ok(entries) = fs::read_dir(edit_root()) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|elapsed| elapsed >= age);
        if stale {
            if let Err(e) = remove_folder(&entry.path()) {
                log_local("warn", "sftp", e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::with_isolated_data_dir;

    fn open_record(contents: &str) -> String {
        let edit_id = uuid::Uuid::new_v4().to_string();
        let folder = edit_root().join(&edit_id);
        make_private_dir(&edit_root()).unwrap();
        make_private_dir(&folder).unwrap();
        let copy = folder.join("f.txt");
        let mut file = create_private_file(&copy).unwrap();
        file.write_all(contents.as_bytes()).unwrap();
        let digest = local_digest(&copy).unwrap();
        EDITS.insert(
            edit_id.clone(),
            EditRecord {
                connection_id: "c".to_string(),
                remote_path: "/r/f.txt".to_string(),
                folder,
                copy,
                remote_stat: FileStat {
                    size: Some(contents.len() as u64),
                    uid: None,
                    gid: None,
                    perm: None,
                    atime: None,
                    mtime: Some(1),
                },
                remote_digest: digest,
                seen: None,
                copy_differs: false,
            },
        );
        edit_id
    }

    #[test]
    fn status_notices_a_changed_copy_and_a_restored_one() {
        with_isolated_data_dir(|| {
            let id = open_record("one\n");
            let clean = EditStatus {
                modified: false,
                missing: false,
            };
            assert_eq!(edit_status(&id).unwrap(), clean);

            let copy = record(&id).unwrap().copy;
            fs::write(&copy, "two, longer\n").unwrap();
            assert!(edit_status(&id).unwrap().modified);
            fs::write(&copy, "one\n").unwrap();
            assert_eq!(edit_status(&id).unwrap(), clean, "same bytes, no change");

            fs::remove_file(&copy).unwrap();
            assert!(edit_status(&id).unwrap().missing);
            edit_close(&id).unwrap();
        });
    }

    #[test]
    fn an_editor_replacing_the_file_by_rename_counts_as_a_change() {
        with_isolated_data_dir(|| {
            let id = open_record("one\n");
            let rec = record(&id).unwrap();
            let replacement = rec.folder.join(".f.txt.swp");
            fs::write(&replacement, "saved by rename\n").unwrap();
            fs::rename(&replacement, &rec.copy).unwrap();
            assert!(edit_status(&id).unwrap().modified);
            edit_close(&id).unwrap();
        });
    }

    #[cfg(unix)]
    #[test]
    fn copies_are_private() {
        use std::os::unix::fs::PermissionsExt;
        with_isolated_data_dir(|| {
            // A loose folder from elsewhere gets tightened.
            fs::create_dir_all(edit_root()).unwrap();
            fs::set_permissions(edit_root(), fs::Permissions::from_mode(0o755)).unwrap();

            let id = open_record("secret\n");
            let rec = record(&id).unwrap();
            let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&edit_root()), 0o700);
            assert_eq!(mode(&rec.folder), 0o700);
            assert_eq!(mode(&rec.copy), 0o600);
            edit_close(&id).unwrap();
        });
    }

    #[test]
    fn closing_removes_the_copy_and_is_safe_to_repeat() {
        with_isolated_data_dir(|| {
            let id = open_record("x");
            let folder = record(&id).unwrap().folder;
            assert!(folder.exists());
            edit_close(&id).unwrap();
            assert!(!folder.exists());
            edit_close(&id).unwrap();
            assert_eq!(edit_status(&id).unwrap_err(), "This edit is no longer open");
        });
    }

    #[test]
    fn quitting_removes_open_copies() {
        with_isolated_data_dir(|| {
            let id = open_record("x");
            let folder = record(&id).unwrap().folder;
            remove_open_copies();
            assert!(!folder.exists());
            assert!(record(&id).is_err());
        });
    }

    #[test]
    fn startup_removes_only_stale_leftovers() {
        with_isolated_data_dir(|| {
            let id = open_record("in use");
            let folder = record(&id).unwrap().folder;
            purge_stale_copies();
            assert!(
                folder.exists(),
                "a young copy may belong to another instance"
            );

            thread::sleep(Duration::from_millis(20));
            purge_older_than(Duration::from_millis(1));
            assert!(!folder.exists());
            EDITS.remove(&id);
        });
    }

    #[test]
    fn a_missing_editor_says_where_the_copy_is() {
        let copy = Path::new("/tmp/copy.txt");
        let err = launch_editor(Command::new("/no/such/editor"), copy).unwrap_err();
        assert!(err.contains("/tmp/copy.txt"), "{}", err);
    }

    #[cfg(unix)]
    #[test]
    fn an_editor_launcher_that_fails_is_reported() {
        let err = launch_editor(Command::new("false"), Path::new("/tmp/copy.txt")).unwrap_err();
        assert!(err.contains("Could not open an editor"), "{}", err);
        assert!(launch_editor(Command::new("true"), Path::new("/tmp/copy.txt")).is_ok());
    }

    #[test]
    fn hashing_reads_everything() {
        let mut data = io::Cursor::new(vec![9u8; 300_000]);
        let via_stream = digest_of(&mut data).unwrap();
        let direct: Digest256 = Sha256::digest(vec![9u8; 300_000]).into();
        assert_eq!(via_stream, direct);
    }

    #[test]
    fn a_copy_over_the_limit_stops_and_is_removed() {
        with_isolated_data_dir(|| {
            make_private_dir(&edit_root()).unwrap();
            let copy = edit_root().join("over");
            // Bigger than one chunk, and than the limit: nothing said so first.
            let mut source = io::Cursor::new(vec![1u8; 300_000]);
            let err = fill_copy(&mut source, &copy, 1024, &|| "too large".to_string()).unwrap_err();
            assert_eq!(err, "too large");
            assert!(!copy.exists(), "the partial copy must go");
            assert!(
                source.position() < 300_000,
                "the copy must stop, not read to the end"
            );
        });
    }

    #[test]
    fn a_copy_of_exactly_the_limit_is_kept_whole() {
        with_isolated_data_dir(|| {
            make_private_dir(&edit_root()).unwrap();
            let copy = edit_root().join("exact");
            let mut source = io::Cursor::new(vec![2u8; 1024]);
            let (digest, written) =
                fill_copy(&mut source, &copy, 1024, &|| "too large".to_string()).unwrap();
            assert_eq!(written, 1024);
            assert_eq!(digest, local_digest(&copy).unwrap());
            assert_eq!(fs::read(&copy).unwrap(), vec![2u8; 1024]);
        });
    }

    #[test]
    fn a_failed_copy_is_removed() {
        with_isolated_data_dir(|| {
            make_private_dir(&edit_root()).unwrap();
            let copy = edit_root().join("broken");
            struct Broken;
            impl Read for Broken {
                fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                    Err(io::Error::other("connection lost"))
                }
            }
            let err = fill_copy(&mut Broken, &copy, 1024, &String::new).unwrap_err();
            assert!(err.contains("connection lost"), "{}", err);
            assert!(!copy.exists());
        });
    }

    #[test]
    fn opening_refuses_relative_paths_before_connecting() {
        let err = edit_open("whatever", "relative/file").unwrap_err();
        assert!(err.contains("not a full path"), "{}", err);
    }
}
