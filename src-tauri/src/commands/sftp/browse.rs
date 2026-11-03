//! Browsing: list, mkdir, rename, delete and chmod, on either side.
//!
//! A remote pane holds one session, owned by a thread of its own; commands
//! reach it through an mpsc queue like a shell's `SessionHandle`, and the
//! thread keeps the session alive while it idles. Every command names its
//! side with a `PaneTarget`.

use super::{
    call_error, check_remote_path, is_local_root, is_not_found, join_remote, path_string,
    permission_bits, refuse_forward, remote_name, remote_parent, validate_name, FileEntry,
    FileKind, FileListing, MAX_DEPTH, SESSION_LOST,
};
use crate::commands::blocking;
use crate::commands::ssh::{connect_session, find_connection};
use crate::logs::log_local;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use ssh2::{ErrorCode, FileStat, Session, Sftp};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::LazyLock;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
#[cfg(test)]
use ts_rs::TS;

/// Rows one pane shows; a folder with more says so.
pub const LISTING_LIMIT: usize = 10_000;
/// How long one SFTP call may take on a browsing session.
const CALL_TIMEOUT_MS: u32 = 30_000;
/// `LIBSSH2_ERROR_FILE`: ssh2's "no more entries" from `File::readdir`.
const LIBSSH2_ERROR_FILE: i32 = -16;

/// What a remote pane needs to start.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct SftpSessionInfo {
    pub session_id: String,
    /// The folder to open first: the connection's `remote_path` if it is a
    /// folder, otherwise the login folder.
    pub start_path: String,
    /// `user@host:port`, with the jump host if there is one.
    pub label: String,
}

/// The side a command acts on. A remote one cannot be built without its
/// session, so a missing session is a refused call and never means this
/// computer. Mirrored in `src/types/index.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "side", rename_all = "snake_case")]
pub enum PaneTarget {
    Local,
    Remote { session_id: String },
}

struct Browser {
    session: Session,
    sftp: Sftp,
    /// The login folder, which `~` and relative paths resolve against.
    home: String,
}

/// Returns whether the session is gone, which ends the worker.
type Job = Box<dyn FnOnce(&Browser) -> bool + Send>;

static SESSIONS: LazyLock<DashMap<String, Sender<Job>>> = LazyLock::new(DashMap::new);

fn lost() -> String {
    format!("{}\nThe connection to the server was lost.", SESSION_LOST)
}

/// Run `f` on the thread that owns session `session_id`, and wait for it.
fn with_browser<T, F>(session_id: &str, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Browser) -> Result<T, String> + Send + 'static,
{
    let sender = SESSIONS
        .get(session_id)
        .map(|entry| entry.value().clone())
        .ok_or_else(lost)?;
    let (reply, answer) = mpsc::channel();
    let job: Job = Box::new(move |browser| {
        let result = f(browser);
        let gone = matches!(&result, Err(e) if e.starts_with(SESSION_LOST));
        let _ = reply.send(result);
        gone
    });
    sender.send(job).map_err(|_| lost())?;
    answer.recv().map_err(|_| lost())?
}

fn run_worker(browser: Browser, jobs: Receiver<Job>, session_id: String, keepalive: u16) {
    browser.session.set_keepalive(false, u32::from(keepalive));
    let tick = (keepalive > 0).then(|| Duration::from_secs(u64::from(keepalive)));
    loop {
        let job = match tick {
            Some(tick) => match jobs.recv_timeout(tick) {
                Ok(job) => job,
                Err(RecvTimeoutError::Timeout) => {
                    if browser.session.keepalive_send().is_err() {
                        break;
                    }
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => break,
            },
            None => match jobs.recv() {
                Ok(job) => job,
                Err(_) => break,
            },
        };
        if job(&browser) {
            break;
        }
    }
    SESSIONS.remove(&session_id);
    let Browser { session, sftp, .. } = browser;
    drop(sftp);
    let _ = session.disconnect(None, "Files view closed", None);
}

/// Open the session behind a remote pane.
#[tauri::command]
pub async fn sftp_connect(connection_id: String) -> Result<SftpSessionInfo, String> {
    blocking(move || sftp_connect_sync(&connection_id)).await
}

pub(super) fn sftp_connect_sync(connection_id: &str) -> Result<SftpSessionInfo, String> {
    let (data, conn) = find_connection(connection_id)?;
    refuse_forward(&conn)?;
    let ssh = connect_session(&data, &conn, "Browsing files")?;
    ssh.session.set_timeout(CALL_TIMEOUT_MS);
    let sftp = ssh
        .session
        .sftp()
        .map_err(|e| format!("The server does not offer SFTP: {}", e.message()))?;
    let home = sftp
        .realpath(Path::new("."))
        .map_err(|e| {
            call_error(
                "Could not find the login folder of",
                &ssh.destination_label,
                &e,
            )
        })
        .and_then(path_string)?;
    let start_path = start_folder(&sftp, &home, conn.remote_path.as_deref());

    let session_id = uuid::Uuid::new_v4().to_string();
    let (sender, jobs) = mpsc::channel();
    SESSIONS.insert(session_id.clone(), sender);
    let keepalive = conn
        .keepalive_interval
        .unwrap_or(data.settings.keepalive_interval);
    let browser = Browser {
        session: ssh.session,
        sftp,
        home,
    };
    {
        let session_id = session_id.clone();
        thread::spawn(move || run_worker(browser, jobs, session_id, keepalive));
    }
    log_local(
        "info",
        "sftp",
        format!("Browsing {} ({})", ssh.destination_label, conn.name),
    );
    Ok(SftpSessionInfo {
        session_id,
        start_path,
        label: ssh.destination_label,
    })
}

/// A stored `remote_path` that is not a folder (any more) is no reason to
/// refuse the session: the pane opens on the login folder instead.
fn start_folder(sftp: &Sftp, home: &str, remote_path: Option<&str>) -> String {
    remote_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(|path| absolute_remote(home, path))
        .and_then(|path| {
            let is_dir = sftp.stat(Path::new(&path)).ok()?.is_dir();
            let real = sftp.realpath(Path::new(&path)).ok()?;
            is_dir.then(|| path_string(real).ok()).flatten()
        })
        .unwrap_or_else(|| home.to_string())
}

/// End a remote pane's session. Transfers have their own and carry on.
#[tauri::command]
pub fn sftp_disconnect(session_id: String) {
    // The worker ends when the last sender goes.
    SESSIONS.remove(&session_id);
}

/// The home folder, where the local pane opens.
#[tauri::command]
pub fn sftp_local_home() -> Result<String, String> {
    dirs::home_dir()
        .and_then(|home| home.to_str().map(str::to_string))
        .ok_or_else(|| "Could not find your home folder".to_string())
}

#[tauri::command]
pub async fn sftp_list(target: PaneTarget, path: String) -> Result<FileListing, String> {
    blocking(move || match target {
        PaneTarget::Remote { session_id } => {
            with_browser(&session_id, move |b| list_remote(&b.sftp, &b.home, &path))
        }
        PaneTarget::Local => list_local(&path),
    })
    .await
}

#[tauri::command]
pub async fn sftp_mkdir(target: PaneTarget, dir: String, name: String) -> Result<String, String> {
    blocking(move || match target {
        PaneTarget::Remote { session_id } => {
            with_browser(&session_id, move |b| mkdir_remote(&b.sftp, &dir, &name))
        }
        PaneTarget::Local => mkdir_local(&dir, &name),
    })
    .await
}

#[tauri::command]
pub async fn sftp_rename(
    target: PaneTarget,
    path: String,
    new_name: String,
) -> Result<String, String> {
    blocking(move || match target {
        PaneTarget::Remote { session_id } => with_browser(&session_id, move |b| {
            rename_remote(&b.sftp, &path, &new_name)
        }),
        PaneTarget::Local => rename_local(&path, &new_name),
    })
    .await
}

/// Delete one entry, a folder with everything in it. Symlinks are removed,
/// never followed.
#[tauri::command]
pub async fn sftp_delete(target: PaneTarget, path: String) -> Result<(), String> {
    blocking(move || match target {
        PaneTarget::Remote { session_id } => {
            with_browser(&session_id, move |b| delete_remote(&b.sftp, &b.home, &path))
        }
        PaneTarget::Local => delete_local(&path),
    })
    .await
}

#[tauri::command]
pub async fn sftp_chmod(target: PaneTarget, path: String, mode: u32) -> Result<(), String> {
    blocking(move || {
        validate_mode(mode)?;
        match target {
            PaneTarget::Remote { session_id } => {
                with_browser(&session_id, move |b| chmod_remote(&b.sftp, &path, mode))
            }
            PaneTarget::Local => chmod_local(&path, mode),
        }
    })
    .await
}

/// `chmod` takes the permission bits and nothing else.
fn validate_mode(mode: u32) -> Result<(), String> {
    if mode > 0o7777 {
        return Err(format!("{:o} is not a valid file mode", mode));
    }
    Ok(())
}

fn sort_entries(entries: &mut [FileEntry]) {
    let folder_first = |e: &FileEntry| !(e.kind == FileKind::Dir || e.target_is_dir);
    entries.sort_by(|a, b| {
        folder_first(a)
            .cmp(&folder_first(b))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
}

fn finish_listing(
    path: String,
    parent: Option<String>,
    mut entries: Vec<FileEntry>,
    omitted: u32,
) -> FileListing {
    sort_entries(&mut entries);
    let truncated = entries.len() > LISTING_LIMIT;
    entries.truncate(LISTING_LIMIT);
    FileListing {
        path,
        parent,
        entries,
        omitted,
        truncated,
    }
}

// ---------------------------------------------------------------------
// Remote side
// ---------------------------------------------------------------------

/// What the user typed or a connection stores, as a full path.
pub(super) fn absolute_remote(home: &str, path: &str) -> String {
    if path.is_empty() || path == "~" {
        home.to_string()
    } else if let Some(rest) = path.strip_prefix("~/") {
        join_remote(home, rest)
    } else if path.starts_with('/') {
        path.to_string()
    } else {
        join_remote(home, path)
    }
}

/// One folder's raw names, without `.` and `..`. Unlike `Sftp::readdir` this
/// does not join them to the folder, so a name a server made up (`../x`,
/// `/etc/passwd`) can be seen for what it is.
pub(super) fn read_remote_dir(
    sftp: &Sftp,
    dir: &str,
) -> Result<Vec<(PathBuf, FileStat)>, ssh2::Error> {
    let mut handle = sftp.opendir(Path::new(dir))?;
    let mut entries = Vec::new();
    loop {
        match handle.readdir() {
            Ok((name, stat)) => {
                if name != Path::new(".") && name != Path::new("..") {
                    entries.push((name, stat));
                }
            }
            Err(e) if e.code() == ErrorCode::Session(LIBSSH2_ERROR_FILE) => return Ok(entries),
            Err(e) => return Err(e),
        }
    }
}

fn remote_kind(stat: &FileStat) -> FileKind {
    let kind = stat.file_type();
    if kind.is_dir() {
        FileKind::Dir
    } else if kind.is_symlink() {
        FileKind::Symlink
    } else if kind.is_file() {
        FileKind::File
    } else {
        FileKind::Other
    }
}

pub(super) fn list_remote(sftp: &Sftp, home: &str, path: &str) -> Result<FileListing, String> {
    let requested = absolute_remote(home, path);
    let dir = sftp
        .realpath(Path::new(&requested))
        .map_err(|e| call_error("Could not open", &requested, &e))
        .and_then(path_string)?;
    let raw = read_remote_dir(sftp, &dir).map_err(|e| call_error("Could not open", &dir, &e))?;

    let mut entries = Vec::with_capacity(raw.len());
    let mut omitted = 0;
    for (name, stat) in raw {
        // A name that is not UTF-8 could not be sent back to name a file,
        // and a name with `/` is not one a real server has.
        let Some(name) = name.to_str().filter(|n| validate_name(n).is_ok()) else {
            omitted += 1;
            continue;
        };
        let path = join_remote(&dir, name);
        let kind = remote_kind(&stat);
        let target_is_dir = kind == FileKind::Symlink
            && sftp
                .stat(Path::new(&path))
                .map(|target| target.is_dir())
                .unwrap_or(false);
        entries.push(FileEntry {
            name: name.to_string(),
            path,
            kind,
            target_is_dir,
            size: stat.size,
            modified: stat.mtime,
            mode: stat.perm.map(permission_bits),
        });
    }
    let parent = remote_parent(&dir);
    Ok(finish_listing(dir, parent, entries, omitted))
}

fn mkdir_remote(sftp: &Sftp, dir: &str, name: &str) -> Result<String, String> {
    check_remote_path(dir)?;
    validate_name(name)?;
    let path = join_remote(dir, name);
    if sftp.lstat(Path::new(&path)).is_ok() {
        return Err(format!("{} already exists", name));
    }
    sftp.mkdir(Path::new(&path), 0o755)
        .map_err(|e| call_error("Could not create", &path, &e))?;
    Ok(path)
}

fn rename_remote(sftp: &Sftp, path: &str, new_name: &str) -> Result<String, String> {
    check_remote_path(path)?;
    validate_name(new_name)?;
    let dir = remote_parent(path).ok_or_else(|| "The root cannot be renamed".to_string())?;
    let target = join_remote(&dir, new_name);
    if sftp.lstat(Path::new(&target)).is_ok() {
        return Err(format!("{} already exists", new_name));
    }
    sftp.rename(Path::new(path), Path::new(&target), None)
        .map_err(|e| call_error("Could not rename", path, &e))?;
    Ok(target)
}

fn delete_remote(sftp: &Sftp, home: &str, path: &str) -> Result<(), String> {
    check_remote_path(path)?;
    let target = path.trim_end_matches('/');
    if target.is_empty() {
        return Err("The root folder cannot be deleted".to_string());
    }
    if holds_remote_home(target, home) || holds_remote_home(&above_resolved(sftp, target)?, home) {
        return Err(
            "Your login folder, and the folders that hold it, cannot be deleted".to_string(),
        );
    }
    delete_remote_tree(sftp, target, 0)
}

/// Whether `target` is `home` or a folder above it, component by component.
fn holds_remote_home(target: &str, home: &str) -> bool {
    let (target, home) = (target.trim_end_matches('/'), home.trim_end_matches('/'));
    home.strip_prefix(target)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

/// `target` with the symlinks above it resolved. `target` itself is not
/// followed: a link is removed, and what it points to stays.
fn above_resolved(sftp: &Sftp, target: &str) -> Result<String, String> {
    let (Some(parent), Some(name)) = (remote_parent(target), remote_name(target)) else {
        return Ok(target.to_string());
    };
    let real = sftp
        .realpath(Path::new(&parent))
        .map_err(|e| call_error("Could not read", &parent, &e))
        .and_then(path_string)?;
    Ok(join_remote(&real, name))
}

/// Depth first, with an `lstat` of its own for every entry rather than
/// trusting the attributes `readdir` sent: a server that reports a symlink's
/// target there must not get its target's contents deleted.
pub(super) fn delete_remote_tree(sftp: &Sftp, path: &str, depth: usize) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err(format!("{} is nested too deeply to delete", path));
    }
    let stat = sftp
        .lstat(Path::new(path))
        .map_err(|e| call_error("Could not read", path, &e))?;
    if !stat.is_dir() {
        // A symlink lands here: the link goes and what it points to stays.
        return sftp
            .unlink(Path::new(path))
            .map_err(|e| call_error("Could not delete", path, &e));
    }
    let children =
        read_remote_dir(sftp, path).map_err(|e| call_error("Could not read", path, &e))?;
    for (name, _) in children {
        let name = name
            .to_str()
            .filter(|n| validate_name(n).is_ok())
            .ok_or_else(|| format!("{} holds a name that cannot be deleted from here", path))?;
        delete_remote_tree(sftp, &join_remote(path, name), depth + 1)?;
    }
    sftp.rmdir(Path::new(path))
        .map_err(|e| call_error("Could not delete", path, &e))
}

fn chmod_remote(sftp: &Sftp, path: &str, mode: u32) -> Result<(), String> {
    check_remote_path(path)?;
    let stat = sftp
        .lstat(Path::new(path))
        .map_err(|e| call_error("Could not read", path, &e))?;
    // SFTP's setstat follows a link, which would change the target's mode.
    if stat.file_type().is_symlink() {
        return Err(symlink_chmod_refusal(path));
    }
    let change = FileStat {
        size: None,
        uid: None,
        gid: None,
        perm: Some(mode),
        atime: None,
        mtime: None,
    };
    sftp.setstat(Path::new(path), change)
        .map_err(|e| call_error("Could not change the permissions of", path, &e))
}

fn symlink_chmod_refusal(path: &str) -> String {
    format!(
        "{} is a symbolic link. Change the permissions of what it points to instead.",
        path
    )
}

// ---------------------------------------------------------------------
// Local side
// ---------------------------------------------------------------------

pub(super) fn local_path_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| format!("{} is not valid UTF-8", path.display()))
}

/// `fs::canonicalize` for showing to a person: Windows' version returns
/// `\\?\C:\...`, which is the same folder written in a way nobody reads.
fn canonical_local(path: &Path) -> std::io::Result<PathBuf> {
    let canonical = fs::canonicalize(path)?;
    if cfg!(windows) {
        if let Some(plain) = canonical
            .to_str()
            .and_then(|text| text.strip_prefix(r"\\?\"))
            .filter(|plain| !plain.starts_with("UNC\\"))
        {
            return Ok(PathBuf::from(plain));
        }
    }
    Ok(canonical)
}

fn expand_local(path: &str) -> Result<PathBuf, String> {
    let home = || dirs::home_dir().ok_or_else(|| "Could not find your home folder".to_string());
    if path.is_empty() || path == "~" {
        return home();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return Ok(home()?.join(rest));
    }
    Ok(PathBuf::from(path))
}

fn local_mode(meta: &fs::Metadata) -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Some(permission_bits(meta.permissions().mode()))
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        None
    }
}

fn local_mtime(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|time: SystemTime| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_secs())
}

pub(super) fn list_local(path: &str) -> Result<FileListing, String> {
    let requested = expand_local(path)?;
    let dir = canonical_local(&requested)
        .map_err(|e| format!("Could not open {}: {}", requested.display(), e))?;
    let read =
        fs::read_dir(&dir).map_err(|e| format!("Could not open {}: {}", dir.display(), e))?;

    let mut entries = Vec::new();
    let mut omitted = 0;
    for entry in read {
        let entry = entry.map_err(|e| format!("Could not read {}: {}", dir.display(), e))?;
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str().map(str::to_string) else {
            omitted += 1;
            continue;
        };
        let child = entry.path();
        let Ok(path) = local_path_string(&child) else {
            omitted += 1;
            continue;
        };
        // `DirEntry::metadata` describes a symlink itself, not its target.
        // An entry that vanished since the folder was read is simply gone.
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let file_type = meta.file_type();
        let kind = if file_type.is_dir() {
            FileKind::Dir
        } else if file_type.is_symlink() {
            FileKind::Symlink
        } else if file_type.is_file() {
            FileKind::File
        } else {
            FileKind::Other
        };
        entries.push(FileEntry {
            name,
            path,
            kind,
            target_is_dir: kind == FileKind::Symlink && child.is_dir(),
            size: Some(meta.len()),
            modified: local_mtime(&meta),
            mode: local_mode(&meta),
        });
    }
    let parent = dir.parent().map(local_path_string).transpose()?;
    Ok(finish_listing(
        local_path_string(&dir)?,
        parent,
        entries,
        omitted,
    ))
}

/// A full path as a listing reports it, as `check_remote_path` is for the
/// remote side.
pub(super) fn check_local_path(path: &str) -> Result<(), String> {
    let target = Path::new(path);
    let has_dots = target.components().any(|part| {
        matches!(
            part,
            std::path::Component::CurDir | std::path::Component::ParentDir
        )
    });
    if !target.is_absolute() || has_dots {
        return Err(format!("{} is not a full path", path));
    }
    Ok(())
}

fn mkdir_local(dir: &str, name: &str) -> Result<String, String> {
    check_local_path(dir)?;
    validate_local_name(name)?;
    let path = Path::new(dir).join(name);
    if fs::symlink_metadata(&path).is_ok() {
        return Err(format!("{} already exists", name));
    }
    fs::create_dir(&path).map_err(|e| format!("Could not create {}: {}", path.display(), e))?;
    local_path_string(&path)
}

fn validate_local_name(name: &str) -> Result<(), String> {
    validate_name(name)?;
    if !super::safe_local_name(name) {
        return Err(format!("\"{}\" is not a valid name on this system", name));
    }
    Ok(())
}

/// Whether `a` and `b` are one directory entry, which a case-only rename on
/// a case-insensitive disk looks like: that target "exists" but is the source.
fn same_entry(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (fs::symlink_metadata(a), fs::symlink_metadata(b)) {
            (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        match (a.to_str(), b.to_str()) {
            (Some(x), Some(y)) => x.eq_ignore_ascii_case(y),
            _ => false,
        }
    }
}

fn rename_local(path: &str, new_name: &str) -> Result<String, String> {
    check_local_path(path)?;
    validate_local_name(new_name)?;
    let source = Path::new(path);
    let dir = source
        .parent()
        .ok_or_else(|| "The root cannot be renamed".to_string())?;
    let target = dir.join(new_name);
    if fs::symlink_metadata(&target).is_ok() && !same_entry(source, &target) {
        return Err(format!("{} already exists", new_name));
    }
    fs::rename(source, &target).map_err(|e| format!("Could not rename {}: {}", path, e))?;
    local_path_string(&target)
}

/// Whether deleting `target` would take `home` with it: `target` is that
/// folder or one above it, however either path is spelled. A symlink named by
/// `target` is only removed, so its own target does not count.
fn holds_local_home(target: &Path, home: &Path) -> bool {
    let resolved = match (target.parent(), target.file_name()) {
        (Some(parent), Some(name)) => canonical_local(parent)
            .map(|real| real.join(name))
            .unwrap_or_else(|_| target.to_path_buf()),
        _ => target.to_path_buf(),
    };
    let real_home = canonical_local(home).unwrap_or_else(|_| home.to_path_buf());
    let reaches = |home: &Path| {
        home.ancestors()
            .any(|above| above == target || above == resolved || same_entry(above, &resolved))
    };
    reaches(home) || reaches(&real_home)
}

fn delete_local(path: &str) -> Result<(), String> {
    delete_local_keeping(path, dirs::home_dir().as_deref())
}

/// `fs::remove_dir_all` removes a symlink it meets and never follows it.
fn delete_local_keeping(path: &str, home: Option<&Path>) -> Result<(), String> {
    check_local_path(path)?;
    let target = Path::new(path);
    if is_local_root(target) {
        return Err("The root folder cannot be deleted".to_string());
    }
    if home.is_some_and(|home| holds_local_home(target, home)) {
        return Err(
            "Your home folder, and the folders that hold it, cannot be deleted".to_string(),
        );
    }
    let meta =
        fs::symlink_metadata(target).map_err(|e| format!("Could not read {}: {}", path, e))?;
    if meta.is_dir() {
        fs::remove_dir_all(target)
    } else {
        fs::remove_file(target)
    }
    .map_err(|e| format!("Could not delete {}: {}", path, e))
}

fn chmod_local(path: &str, mode: u32) -> Result<(), String> {
    check_local_path(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta =
            fs::symlink_metadata(path).map_err(|e| format!("Could not read {}: {}", path, e))?;
        if meta.file_type().is_symlink() {
            return Err(symlink_chmod_refusal(path));
        }
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .map_err(|e| format!("Could not change the permissions of {}: {}", path, e))
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode, symlink_chmod_refusal);
        Err("This system has no file modes to change".to_string())
    }
}

/// The file name of a local path, for a transfer's target name.
pub(super) fn local_entry_name(path: &Path) -> Result<&str, String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("{} has no usable file name", path.display()))
}

/// The file name of a remote path, for a transfer's target name.
pub(super) fn remote_entry_name(path: &str) -> Result<&str, String> {
    remote_name(path).ok_or_else(|| format!("{} has no file name", path))
}

/// Whether the file an error describes is simply absent.
pub(super) fn missing_or(
    sftp_result: Result<FileStat, ssh2::Error>,
) -> Result<Option<FileStat>, ssh2::Error> {
    match sftp_result {
        Ok(stat) => Ok(Some(stat)),
        Err(e) if is_not_found(&e) => Ok(None),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
pub(crate) use tests::{save_forward, TempDir};

#[cfg(test)]
mod tests {
    use super::*;

    /// Save a forward of this kind and return its id.
    pub(crate) fn save_forward(kind: crate::models::ConnectionKind) -> String {
        let forward = crate::models::Connection::new("fwd".into(), "h".into(), 22, None, kind);
        let id = forward.id.clone();
        crate::storage::with_data_mut(|data| {
            data.connections.push(forward);
            Ok(())
        })
        .unwrap();
        id
    }

    /// A fresh folder, removed when the test ends.
    pub(crate) struct TempDir(pub PathBuf);
    impl TempDir {
        pub(crate) fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "ssix-sftp-{}-{}",
                tag,
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&dir).unwrap();
            // macOS's temp dir sits behind a symlink, which listings resolve.
            Self(fs::canonicalize(dir).unwrap())
        }
        fn path(&self, name: &str) -> String {
            self.0.join(name).to_str().unwrap().to_string()
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn names(listing: &FileListing) -> Vec<&str> {
        listing.entries.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn local_listing_puts_folders_first_and_resolves_the_path() {
        let tmp = TempDir::new("list");
        fs::write(tmp.0.join("b.txt"), "bb").unwrap();
        fs::write(tmp.0.join("A.txt"), "a").unwrap();
        fs::create_dir(tmp.0.join("zdir")).unwrap();

        let dotted = format!("{}/zdir/..", tmp.0.display());
        let listing = list_local(&dotted).unwrap();
        assert_eq!(listing.path, tmp.0.to_str().unwrap());
        assert_eq!(names(&listing), ["zdir", "A.txt", "b.txt"]);
        assert_eq!(listing.parent.as_deref(), tmp.0.parent().unwrap().to_str());
        let file = &listing.entries[2];
        assert_eq!(file.kind, FileKind::File);
        assert_eq!(file.size, Some(2));
        assert_eq!(file.path, tmp.path("b.txt"));
        assert!(file.modified.is_some());
    }

    #[cfg(unix)]
    #[test]
    fn local_listing_reports_symlinks_as_links_and_where_they_lead() {
        use std::os::unix::fs::symlink;
        let tmp = TempDir::new("links");
        fs::create_dir(tmp.0.join("real")).unwrap();
        symlink(tmp.0.join("real"), tmp.0.join("to-dir")).unwrap();
        symlink(tmp.0.join("gone"), tmp.0.join("dangling")).unwrap();

        let listing = list_local(tmp.0.to_str().unwrap()).unwrap();
        let find = |name: &str| listing.entries.iter().find(|e| e.name == name).unwrap();
        assert_eq!(find("to-dir").kind, FileKind::Symlink);
        assert!(find("to-dir").target_is_dir);
        assert_eq!(find("dangling").kind, FileKind::Symlink);
        assert!(!find("dangling").target_is_dir);
    }

    #[test]
    fn local_listing_stops_at_the_limit_and_says_so() {
        let mut entries: Vec<FileEntry> = (0..LISTING_LIMIT + 5)
            .map(|i| FileEntry {
                name: format!("f{:06}", i),
                path: format!("/f{:06}", i),
                kind: FileKind::File,
                target_is_dir: false,
                size: None,
                modified: None,
                mode: None,
            })
            .collect();
        entries.reverse();
        let listing = finish_listing("/".into(), None, entries, 0);
        assert!(listing.truncated);
        assert_eq!(listing.entries.len(), LISTING_LIMIT);
        assert_eq!(listing.entries[0].name, "f000000");
    }

    #[test]
    fn a_missing_folder_is_an_error_not_an_empty_listing() {
        let tmp = TempDir::new("missing");
        let err = list_local(&tmp.path("nope")).unwrap_err();
        assert!(err.contains("Could not open"), "{}", err);
    }

    #[test]
    fn mkdir_and_rename_stay_inside_the_folder() {
        let tmp = TempDir::new("names");
        let dir = tmp.0.to_str().unwrap();
        let made = mkdir_local(dir, "sub").unwrap();
        assert!(Path::new(&made).is_dir());
        assert!(mkdir_local(dir, "sub")
            .unwrap_err()
            .contains("already exists"));
        for bad in ["../up", "a/b", "..", ""] {
            assert!(mkdir_local(dir, bad).is_err(), "{}", bad);
        }

        fs::write(tmp.0.join("a.txt"), "a").unwrap();
        fs::write(tmp.0.join("b.txt"), "b").unwrap();
        let err = rename_local(&tmp.path("a.txt"), "b.txt").unwrap_err();
        assert!(err.contains("already exists"), "{}", err);
        assert_eq!(fs::read_to_string(tmp.0.join("b.txt")).unwrap(), "b");
        assert!(rename_local(&tmp.path("a.txt"), "../c.txt").is_err());

        let renamed = rename_local(&tmp.path("a.txt"), "c.txt").unwrap();
        assert_eq!(renamed, tmp.path("c.txt"));
        assert_eq!(fs::read_to_string(tmp.0.join("c.txt")).unwrap(), "a");
    }

    #[cfg(unix)]
    #[test]
    fn local_delete_removes_a_link_and_keeps_what_it_points_to() {
        use std::os::unix::fs::symlink;
        let tmp = TempDir::new("delete");
        fs::create_dir(tmp.0.join("keep")).unwrap();
        fs::write(tmp.0.join("keep/sentinel"), "stay").unwrap();
        fs::create_dir(tmp.0.join("victim")).unwrap();
        fs::write(tmp.0.join("victim/file"), "gone").unwrap();
        symlink(tmp.0.join("keep"), tmp.0.join("victim/link")).unwrap();
        symlink(tmp.0.join("keep"), tmp.0.join("direct-link")).unwrap();

        delete_local(&tmp.path("victim")).unwrap();
        assert!(!tmp.0.join("victim").exists());
        assert_eq!(
            fs::read_to_string(tmp.0.join("keep/sentinel")).unwrap(),
            "stay"
        );

        delete_local(&tmp.path("direct-link")).unwrap();
        assert!(fs::symlink_metadata(tmp.0.join("direct-link")).is_err());
        assert_eq!(
            fs::read_to_string(tmp.0.join("keep/sentinel")).unwrap(),
            "stay"
        );
    }

    #[test]
    fn local_delete_refuses_what_it_should_never_touch() {
        for bad in ["relative/path", "/tmp/../etc"] {
            assert!(
                delete_local(bad).unwrap_err().contains("not a full path"),
                "{}",
                bad
            );
        }
        assert!(is_local_root(Path::new("/")));
    }

    /// A made-up home in a temporary tree: if this guard ever breaks, the
    /// test must not take the real one with it.
    #[test]
    fn local_delete_refuses_home_and_every_folder_above_it() {
        let tmp = TempDir::new("home");
        let home = tmp.0.join("users/me");
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("sentinel"), "stay").unwrap();
        fs::create_dir(tmp.0.join("users/me2")).unwrap();
        fs::create_dir(home.join("sub")).unwrap();

        for refused in [tmp.path("users/me"), tmp.path("users")] {
            let err = delete_local_keeping(&refused, Some(&home)).unwrap_err();
            assert!(err.contains("home folder"), "{}", err);
        }
        assert_eq!(fs::read_to_string(home.join("sentinel")).unwrap(), "stay");

        // A name that merely starts the same, and what is inside, can go.
        delete_local_keeping(&tmp.path("users/me2"), Some(&home)).unwrap();
        delete_local_keeping(&tmp.path("users/me/sub"), Some(&home)).unwrap();
        assert!(!home.join("sub").exists());
    }

    #[cfg(unix)]
    #[test]
    fn local_delete_sees_through_a_symlinked_home_and_a_symlinked_path() {
        use std::os::unix::fs::symlink;
        let tmp = TempDir::new("linkedhome");
        let real = tmp.0.join("data/me");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("sentinel"), "stay").unwrap();
        // $HOME names the link, and listings show the real folder.
        let linked = tmp.0.join("home-link");
        symlink(&real, &linked).unwrap();
        // A second way to reach the real folder.
        symlink(tmp.0.join("data"), tmp.0.join("alias")).unwrap();

        for refused in [
            tmp.path("data/me"),
            tmp.path("data"),
            tmp.path("home-link"),
            tmp.path("alias/me"),
        ] {
            let err = delete_local_keeping(&refused, Some(&linked)).unwrap_err();
            assert!(err.contains("home folder"), "{}: {}", refused, err);
        }
        assert_eq!(fs::read_to_string(real.join("sentinel")).unwrap(), "stay");

        // Another link to home is only a link: removing it costs nothing.
        symlink(&real, tmp.0.join("shortcut")).unwrap();
        delete_local_keeping(&tmp.path("shortcut"), Some(&linked)).unwrap();
        assert!(fs::symlink_metadata(tmp.0.join("shortcut")).is_err());
        assert_eq!(fs::read_to_string(real.join("sentinel")).unwrap(), "stay");
    }

    #[test]
    fn remote_delete_refuses_the_login_folder_and_every_folder_above_it() {
        for held in ["/home/me", "/home/me/", "/home", "/"] {
            assert!(holds_remote_home(held, "/home/me"), "{}", held);
        }
        for free in ["/home/me2", "/home/me/sub", "/ho", "/tmp", "/home/m"] {
            assert!(!holds_remote_home(free, "/home/me"), "{}", free);
        }
    }

    #[test]
    fn chmod_takes_permission_bits_only() {
        for ok in [0, 0o644, 0o755, 0o4755, 0o7777] {
            assert!(validate_mode(ok).is_ok(), "{:o}", ok);
        }
        for bad in [0o10000, 0o100644, u32::MAX] {
            assert!(validate_mode(bad).is_err(), "{:o}", bad);
        }
    }

    #[cfg(unix)]
    #[test]
    fn local_chmod_changes_the_file_and_refuses_a_link() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let tmp = TempDir::new("chmod");
        fs::write(tmp.0.join("f"), "x").unwrap();
        chmod_local(&tmp.path("f"), 0o640).unwrap();
        let mode = fs::metadata(tmp.0.join("f")).unwrap().permissions().mode();
        assert_eq!(mode & 0o7777, 0o640);

        symlink(tmp.0.join("f"), tmp.0.join("l")).unwrap();
        let err = chmod_local(&tmp.path("l"), 0o600).unwrap_err();
        assert!(err.contains("symbolic link"), "{}", err);
        let mode = fs::metadata(tmp.0.join("f")).unwrap().permissions().mode();
        assert_eq!(mode & 0o7777, 0o640, "the target must not change");
    }

    #[test]
    fn typed_remote_paths_resolve_against_the_login_folder() {
        assert_eq!(absolute_remote("/home/u", ""), "/home/u");
        assert_eq!(absolute_remote("/home/u", "~"), "/home/u");
        assert_eq!(absolute_remote("/home/u", "~/x"), "/home/u/x");
        assert_eq!(absolute_remote("/home/u", "x/y"), "/home/u/x/y");
        assert_eq!(absolute_remote("/home/u", "/etc"), "/etc");
    }

    #[test]
    fn a_session_that_is_gone_says_so() {
        let err = tauri::async_runtime::block_on(sftp_list(
            PaneTarget::Remote {
                session_id: "no-such-session".to_string(),
            },
            "/".to_string(),
        ))
        .unwrap_err();
        assert!(err.starts_with(SESSION_LOST), "{}", err);
    }

    #[test]
    fn a_remote_target_needs_a_session_and_nothing_defaults_to_this_computer() {
        use serde_json::{from_value, json};
        for refused in [
            json!({ "side": "remote" }),
            json!({ "side": "remote", "session_id": null }),
            json!({ "session_id": null }),
            json!({ "session_id": "s1" }),
            json!({}),
            json!(null),
        ] {
            assert!(
                from_value::<PaneTarget>(refused.clone()).is_err(),
                "{}",
                refused
            );
        }
        assert_eq!(
            from_value::<PaneTarget>(json!({ "side": "local" })).unwrap(),
            PaneTarget::Local
        );
        assert_eq!(
            from_value::<PaneTarget>(json!({ "side": "remote", "session_id": "s1" })).unwrap(),
            PaneTarget::Remote {
                session_id: "s1".to_string()
            }
        );
    }

    /// The same path exists on this computer: a remote command with no
    /// session behind it must fail, and leave that path as it is.
    #[test]
    fn a_remote_change_with_no_session_leaves_this_computer_alone() {
        use tauri::async_runtime::block_on;
        let tmp = TempDir::new("no-session");
        fs::create_dir(tmp.0.join("victim")).unwrap();
        fs::write(tmp.0.join("victim/sentinel"), "stay").unwrap();
        let dir = tmp.0.to_str().unwrap().to_string();
        let victim = tmp.path("victim");
        let target = || PaneTarget::Remote {
            session_id: "no-such-session".to_string(),
        };

        let refusals = [
            block_on(sftp_delete(target(), victim.clone())).unwrap_err(),
            block_on(sftp_rename(target(), victim.clone(), "moved".to_string())).unwrap_err(),
            block_on(sftp_mkdir(target(), dir, "made".to_string())).unwrap_err(),
            block_on(sftp_chmod(target(), victim, 0o700)).unwrap_err(),
        ];
        for err in refusals {
            assert!(err.starts_with(SESSION_LOST), "{}", err);
        }
        let left: Vec<_> = fs::read_dir(&tmp.0)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left, ["victim"]);
        assert_eq!(
            fs::read_to_string(tmp.0.join("victim/sentinel")).unwrap(),
            "stay"
        );
    }

    #[test]
    fn forwards_have_no_files_to_browse() {
        crate::storage::test_support::with_isolated_data_dir(|| {
            let id = save_forward(crate::models::ConnectionKind::DynamicForward {
                gateway_host: "gw".into(),
                gateway_port: 22,
                gateway_credential_id: "c".into(),
                bind_address: None,
                local_port: 1080,
            });
            let err = sftp_connect_sync(&id).unwrap_err();
            assert!(err.contains("not available"), "{}", err);
            assert_eq!(
                sftp_connect_sync("missing").unwrap_err(),
                "Connection not found"
            );
        });
    }
}
