//! Uploads and downloads for the Files view.
//!
//! `sftp_start_transfer` returns the transfer's id at once and works on a
//! thread of its own, with a session of its own, so browsing stays free.
//! Everything after that arrives as `TransferEvent`s on a `Channel`.
//!
//! Files stream through a fixed buffer, and a transfer only ever writes to a
//! temporary name next to its target, renamed into place once complete. So
//! a failed or cancelled copy leaves the target as it was, on either side.
//! (`storage::atomic_write` gives the same guarantee but takes the whole file
//! in memory; `write_partial` is its streaming counterpart.)

use super::browse::{
    check_local_path, local_entry_name, local_path_string, missing_or, read_remote_dir,
    remote_entry_name,
};
use super::{
    call_error, check_remote_path, join_remote, path_string, refuse_forward, remote_parent,
    safe_local_name, temp_name, validate_name, MAX_DEPTH,
};
use crate::commands::blocking;
use crate::commands::scripts::connect_unless_cancelled;
use crate::commands::ssh::find_connection;
use crate::logs::log_local;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use ssh2::{FileStat, OpenFlags, OpenType, Sftp};
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
#[cfg(test)]
use ts_rs::TS;

/// Transfers running at once; the rest wait their turn. Each holds an SSH
/// connection, and servers limit those (`MaxStartups`).
const MAX_ACTIVE: usize = 3;
const CHUNK_BYTES: usize = 128 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
/// How often a transfer that is waiting or connecting checks for its cancel.
const CANCEL_POLL: Duration = Duration::from_millis(100);
/// How long one SFTP call may take during a transfer. A cancel waits for the
/// call in progress, so a stalled link can hold it up this long.
const CALL_TIMEOUT_MS: u32 = 60_000;

static ACTIVE: AtomicUsize = AtomicUsize::new(0);
static TRANSFERS: LazyLock<DashMap<String, Arc<AtomicBool>>> = LazyLock::new(DashMap::new);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TransferInput {
    pub connection_id: String,
    pub direction: TransferDirection,
    /// The file or folder to copy, a full path on the source side.
    pub source: String,
    /// The folder it lands in, a full path on the target side.
    pub target_dir: String,
    /// Replace what is already there; without this the transfer asks first.
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TransferEvent {
    Progress {
        id: String,
        #[cfg_attr(test, ts(type = "number"))]
        bytes_done: u64,
        #[cfg_attr(test, ts(type = "number"))]
        bytes_total: u64,
        #[cfg_attr(test, ts(type = "number"))]
        files_done: u64,
        #[cfg_attr(test, ts(type = "number"))]
        files_total: u64,
        /// The file being copied, relative to the transferred entry.
        current: String,
    },
    Done {
        id: String,
        #[cfg_attr(test, ts(type = "number"))]
        bytes: u64,
        #[cfg_attr(test, ts(type = "number"))]
        files: u64,
        /// Entries left out of a folder: symlinks, sockets, unusable names.
        #[cfg_attr(test, ts(type = "number"))]
        skipped: u64,
        target: String,
    },
    Cancelled {
        id: String,
    },
    /// Something already has the target's name and `overwrite` was not set.
    /// Nothing was written; start the transfer again with `overwrite` to
    /// replace it.
    Conflict {
        id: String,
        target: String,
        target_is_dir: bool,
    },
    Failed {
        id: String,
        error: String,
    },
}

/// Where events go: the `Channel` in the app, a collector in tests.
pub type Emit = Arc<dyn Fn(TransferEvent) + Send + Sync>;

/// Why a copy stopped before its end.
#[derive(Debug, PartialEq)]
pub(super) enum Stop {
    Cancelled,
    Conflict { target: String, target_is_dir: bool },
    Failed(String),
}

impl From<String> for Stop {
    fn from(error: String) -> Self {
        Stop::Failed(error)
    }
}

impl Stop {
    /// For a caller with no use for the difference: its copies cannot be
    /// cancelled and never ask about a conflict.
    pub(super) fn into_message(self) -> String {
        match self {
            Stop::Failed(error) => error,
            Stop::Cancelled => "Cancelled".to_string(),
            Stop::Conflict { target, .. } => format!("{} already exists", target),
        }
    }
}

/// Start a transfer. A refused request fails here; once it is running, its
/// outcome arrives on `on_event`.
#[tauri::command]
pub async fn sftp_start_transfer(
    input: TransferInput,
    on_event: Channel<TransferEvent>,
) -> Result<String, String> {
    let emit: Emit = Arc::new(move |event| {
        let _ = on_event.send(event);
    });
    blocking(move || start_transfer(input, emit)).await
}

/// The two paths are full paths on their own sides, so a mistake cannot
/// land relative to wherever the app or the login happens to be.
fn validate_input(input: &TransferInput) -> Result<(), String> {
    let (local, remote) = match input.direction {
        TransferDirection::Upload => (&input.source, &input.target_dir),
        TransferDirection::Download => (&input.target_dir, &input.source),
    };
    check_local_path(local)?;
    check_remote_path(remote)
}

pub(super) fn start_transfer(input: TransferInput, emit: Emit) -> Result<String, String> {
    validate_input(&input)?;
    let (_, conn) = find_connection(&input.connection_id)?;
    refuse_forward(&conn)?;
    let id = uuid::Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    TRANSFERS.insert(id.clone(), cancel.clone());
    {
        let id = id.clone();
        thread::spawn(move || run_transfer(id, input, cancel, emit));
    }
    Ok(id)
}

/// Ask a transfer to stop. Asking about one that has ended is not an error:
/// it may have ended while the request was on its way.
#[tauri::command]
pub fn sftp_cancel_transfer(id: String) {
    if let Some(flag) = TRANSFERS.get(&id) {
        flag.store(true, Ordering::SeqCst);
    }
}

/// One of the `MAX_ACTIVE` places, given back when dropped.
struct Slot;
impl Drop for Slot {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Wait for a place, or `None` once cancelled.
fn wait_for_slot(cancel: &AtomicBool) -> Option<Slot> {
    loop {
        if cancel.load(Ordering::SeqCst) {
            return None;
        }
        let claimed = ACTIVE.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |active| {
            (active < MAX_ACTIVE).then_some(active + 1)
        });
        if claimed.is_ok() {
            return Some(Slot);
        }
        thread::sleep(CANCEL_POLL);
    }
}

fn run_transfer(id: String, input: TransferInput, cancel: Arc<AtomicBool>, emit: Emit) {
    let mut run = Run::new(&id, &cancel, emit.clone());
    let outcome = copy_with_a_session(&input, &mut run);
    let (bytes, files, skipped) = (run.bytes_done, run.files_done, run.skipped);
    TRANSFERS.remove(&id);
    let event = match outcome {
        Ok(target) => {
            log_local(
                "info",
                "sftp",
                format!(
                    "{}: {} file(s), {} bytes, to {}",
                    input.source, files, bytes, target
                ),
            );
            TransferEvent::Done {
                id,
                bytes,
                files,
                skipped,
                target,
            }
        }
        Err(Stop::Cancelled) => TransferEvent::Cancelled { id },
        Err(Stop::Conflict {
            target,
            target_is_dir,
        }) => TransferEvent::Conflict {
            id,
            target,
            target_is_dir,
        },
        Err(Stop::Failed(error)) => {
            log_local("error", "sftp", format!("{}: {}", input.source, error));
            TransferEvent::Failed { id, error }
        }
    };
    emit(event);
}

fn copy_with_a_session(input: &TransferInput, run: &mut Run<'_>) -> Result<String, Stop> {
    let _slot = wait_for_slot(run.cancel).ok_or(Stop::Cancelled)?;
    let (data, conn) = find_connection(&input.connection_id)?;
    let cancel = run.cancel;
    let ssh = connect_unless_cancelled(data, conn, "Transferring files", &|| {
        cancel.load(Ordering::SeqCst)
    })?
    .ok_or(Stop::Cancelled)?;
    ssh.session.set_timeout(CALL_TIMEOUT_MS);
    let sftp = ssh
        .session
        .sftp()
        .map_err(|e| format!("The server does not offer SFTP: {}", e.message()))?;
    match input.direction {
        TransferDirection::Upload => run_upload(&sftp, input, run),
        TransferDirection::Download => run_download(&sftp, input, run),
    }
}

/// A transfer's counters and the way to report them.
struct Run<'a> {
    id: &'a str,
    cancel: &'a AtomicBool,
    emit: Emit,
    bytes_done: u64,
    bytes_total: u64,
    files_done: u64,
    files_total: u64,
    skipped: u64,
    current: String,
    last_report: Option<Instant>,
}

impl<'a> Run<'a> {
    fn new(id: &'a str, cancel: &'a AtomicBool, emit: Emit) -> Self {
        Self {
            id,
            cancel,
            emit,
            bytes_done: 0,
            bytes_total: 0,
            files_done: 0,
            files_total: 0,
            skipped: 0,
            current: String::new(),
            last_report: None,
        }
    }

    fn check(&self) -> Result<(), Stop> {
        if self.cancel.load(Ordering::SeqCst) {
            Err(Stop::Cancelled)
        } else {
            Ok(())
        }
    }

    fn begin(&mut self, plan: &Plan) {
        self.bytes_total = plan.bytes;
        self.files_total = plan.files;
        self.skipped = plan.skipped;
        self.report();
    }

    fn report(&mut self) {
        self.last_report = Some(Instant::now());
        (self.emit)(TransferEvent::Progress {
            id: self.id.to_string(),
            bytes_done: self.bytes_done,
            bytes_total: self.bytes_total,
            files_done: self.files_done,
            files_total: self.files_total,
            current: self.current.clone(),
        });
    }

    fn on_chunk(&mut self, bytes: usize) -> Result<(), Stop> {
        self.bytes_done += bytes as u64;
        let due = self
            .last_report
            .is_none_or(|last| last.elapsed() >= PROGRESS_INTERVAL);
        if due {
            self.report();
        }
        self.check()
    }

    fn start_file(&mut self, rel: &str) {
        self.current = rel.to_string();
        self.report();
    }

    fn finish_file(&mut self) {
        self.files_done += 1;
        self.report();
    }
}

/// Copy `source` to `target` in fixed-size chunks, calling `on_chunk` after
/// each, which stops the copy by returning an error.
pub(super) fn copy_stream(
    source: &mut dyn Read,
    target: &mut dyn Write,
    on_chunk: &mut dyn FnMut(usize) -> Result<(), Stop>,
) -> Result<(), Stop> {
    let mut buffer = vec![0u8; CHUNK_BYTES];
    loop {
        let read = match source.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(read) => read,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(Stop::Failed(format!("Reading failed: {}", e))),
        };
        target
            .write_all(&buffer[..read])
            .map_err(|e| Stop::Failed(format!("Writing failed: {}", e)))?;
        on_chunk(read)?;
    }
}

// ---------------------------------------------------------------------
// What to copy
// ---------------------------------------------------------------------

/// `rel` is the `/`-joined path below the transferred entry: empty for the
/// entry itself. Every component has passed a name check.
#[derive(Debug, PartialEq)]
enum PlanItem {
    Dir { rel: String, mode: Option<u32> },
    File { rel: String, mode: Option<u32> },
}

/// Walked before anything is written, so progress has totals to report and
/// the walk's failures cost nothing.
#[derive(Debug, Default)]
struct Plan {
    items: Vec<PlanItem>,
    bytes: u64,
    files: u64,
    skipped: u64,
}

impl Plan {
    fn add_file(&mut self, rel: String, size: u64, mode: Option<u32>) {
        self.items.push(PlanItem::File { rel, mode });
        self.bytes += size;
        self.files += 1;
    }
}

fn join_rel(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", rel, name)
    }
}

fn local_under(root: &Path, rel: &str) -> PathBuf {
    if rel.is_empty() {
        return root.to_path_buf();
    }
    rel.split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

fn remote_under(root: &str, rel: &str) -> String {
    if rel.is_empty() {
        root.to_string()
    } else {
        join_remote(root, rel)
    }
}

fn file_mode(meta: &fs::Metadata) -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Some(meta.permissions().mode())
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        None
    }
}

/// The mode a new folder starts with: the source's, plus what its owner needs
/// to fill it, as `scp -r` does for a read-only source. The system's umask
/// still applies, so a copy is never more open than this machine allows.
fn new_folder_mode(source: u32) -> u32 {
    (source & 0o777) | 0o700
}

/// A source mode whose owner bits `new_folder_mode` had to add.
fn lacks_owner_bits(source: Option<u32>) -> Option<u32> {
    source.filter(|mode| mode & 0o700 != 0o700)
}

/// A filled folder's final mode: the source's owner bits, with the group and
/// other bits its creation left.
fn sealed_folder_mode(created: u32, source: u32) -> u32 {
    super::permission_bits(created) & !(0o700 & !source)
}

/// Every folder of a walk starts here: the walk may be cancelled, or too deep.
fn enter_folder(
    dir: impl std::fmt::Display,
    cancel: &AtomicBool,
    depth: usize,
) -> Result<(), Stop> {
    if cancel.load(Ordering::SeqCst) {
        return Err(Stop::Cancelled);
    }
    if depth > MAX_DEPTH {
        return Err(Stop::Failed(format!(
            "{} is nested too deeply to transfer",
            dir
        )));
    }
    Ok(())
}

/// The entry the user picked is followed if it is a symlink, as `scp` does.
/// Inside a folder symlinks are skipped: following them could leave the
/// tree or go round in a loop.
fn plan_local(root: &Path, cancel: &AtomicBool) -> Result<Plan, Stop> {
    let meta =
        fs::metadata(root).map_err(|e| format!("Could not read {}: {}", root.display(), e))?;
    let mut plan = Plan::default();
    if meta.is_file() {
        plan.add_file(String::new(), meta.len(), file_mode(&meta));
    } else if meta.is_dir() {
        plan.items.push(PlanItem::Dir {
            rel: String::new(),
            mode: file_mode(&meta),
        });
        walk_local(root, "", &mut plan, cancel, 0)?;
    } else {
        return Err(Stop::Failed(format!(
            "{} is neither a file nor a folder",
            root.display()
        )));
    }
    Ok(plan)
}

fn walk_local(
    dir: &Path,
    rel: &str,
    plan: &mut Plan,
    cancel: &AtomicBool,
    depth: usize,
) -> Result<(), Stop> {
    enter_folder(dir.display(), cancel, depth)?;
    let entries =
        fs::read_dir(dir).map_err(|e| format!("Could not read {}: {}", dir.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Could not read {}: {}", dir.display(), e))?;
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str().filter(|n| validate_name(n).is_ok()) else {
            plan.skipped += 1;
            continue;
        };
        // `DirEntry::metadata` describes a symlink itself.
        let meta = entry
            .metadata()
            .map_err(|e| format!("Could not read {}: {}", entry.path().display(), e))?;
        let child = join_rel(rel, name);
        if meta.is_dir() {
            plan.items.push(PlanItem::Dir {
                rel: child.clone(),
                mode: file_mode(&meta),
            });
            walk_local(&entry.path(), &child, plan, cancel, depth + 1)?;
        } else if meta.is_file() {
            plan.add_file(child, meta.len(), file_mode(&meta));
        } else {
            plan.skipped += 1;
        }
    }
    Ok(())
}

fn plan_remote(sftp: &Sftp, root: &str, cancel: &AtomicBool) -> Result<Plan, Stop> {
    let stat = sftp
        .stat(Path::new(root))
        .map_err(|e| call_error("Could not read", root, &e))?;
    let mut plan = Plan::default();
    if stat.is_file() {
        plan.add_file(String::new(), stat.size.unwrap_or(0), stat.perm);
    } else if stat.is_dir() {
        plan.items.push(PlanItem::Dir {
            rel: String::new(),
            mode: stat.perm,
        });
        walk_remote(sftp, root, "", &mut plan, cancel, 0)?;
    } else {
        return Err(Stop::Failed(format!(
            "{} is neither a file nor a folder",
            root
        )));
    }
    Ok(plan)
}

fn walk_remote(
    sftp: &Sftp,
    dir: &str,
    rel: &str,
    plan: &mut Plan,
    cancel: &AtomicBool,
    depth: usize,
) -> Result<(), Stop> {
    enter_folder(dir, cancel, depth)?;
    let entries = read_remote_dir(sftp, dir).map_err(|e| call_error("Could not read", dir, &e))?;
    for (name, stat) in entries {
        // These names become files on this machine, so one a server made up
        // to reach outside the target folder stops here.
        let Some(name) = name.to_str().filter(|n| safe_local_name(n)) else {
            plan.skipped += 1;
            continue;
        };
        let child = join_rel(rel, name);
        if stat.is_dir() {
            plan.items.push(PlanItem::Dir {
                rel: child.clone(),
                mode: stat.perm,
            });
            walk_remote(
                sftp,
                &join_remote(dir, name),
                &child,
                plan,
                cancel,
                depth + 1,
            )?;
        } else if stat.is_file() {
            plan.add_file(child, stat.size.unwrap_or(0), stat.perm);
        } else {
            plan.skipped += 1;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------

fn run_upload(sftp: &Sftp, input: &TransferInput, run: &mut Run<'_>) -> Result<String, Stop> {
    let source = Path::new(&input.source);
    let name = local_entry_name(source)?;
    validate_name(name)?;
    let target = join_remote(&input.target_dir, name);
    let plan = plan_local(source, run.cancel)?;

    if let Some(existing) = missing_or(sftp.lstat(Path::new(&target)))
        .map_err(|e| call_error("Could not read", &target, &e))?
    {
        if !input.overwrite {
            return Err(Stop::Conflict {
                target,
                target_is_dir: existing.is_dir(),
            });
        }
    }

    run.begin(&plan);
    let mut to_seal = Vec::new();
    for item in &plan.items {
        run.check()?;
        match item {
            PlanItem::Dir { rel, mode } => {
                let path = remote_under(&target, rel);
                if ensure_remote_dir(sftp, &path, *mode)? {
                    to_seal.extend(lacks_owner_bits(*mode).map(|source| (path, source)));
                }
            }
            PlanItem::File { rel, mode } => {
                run.start_file(rel);
                let mut file = fs::File::open(local_under(source, rel))
                    .map_err(|e| format!("Could not read {}: {}", input.source, e))?;
                let destination = RemoteTarget::resolve(sftp, &remote_under(&target, rel))?;
                let staged = stage_upload(sftp, &mut file, &destination, *mode, &mut |n| {
                    run.on_chunk(n)
                })?;
                commit_upload(sftp, &staged, &destination)?;
                run.finish_file();
            }
        }
    }
    // Deepest first: a parent that loses its owner's access would block the rest.
    for (path, source) in to_seal.iter().rev() {
        seal_remote_dir(sftp, path, *source)?;
    }
    Ok(target)
}

/// Make sure a folder is there, and say whether it had to be created. One
/// that exists keeps its mode, as a replaced file does.
fn ensure_remote_dir(sftp: &Sftp, path: &str, mode: Option<u32>) -> Result<bool, String> {
    match missing_or(sftp.stat(Path::new(path)))
        .map_err(|e| call_error("Could not read", path, &e))?
    {
        Some(stat) if stat.is_dir() => Ok(false),
        Some(_) => Err(format!("{} is in the way of a folder", path)),
        None => sftp
            .mkdir(Path::new(path), mode.map_or(0o755, new_folder_mode) as i32)
            .map(|()| true)
            .map_err(|e| call_error("Could not create", path, &e)),
    }
}

fn seal_remote_dir(sftp: &Sftp, path: &str, source: u32) -> Result<(), String> {
    let created = sftp
        .stat(Path::new(path))
        .map_err(|e| call_error("Could not read", path, &e))?
        .perm
        .unwrap_or_else(|| new_folder_mode(source));
    let change = FileStat {
        size: None,
        uid: None,
        gid: None,
        perm: Some(sealed_folder_mode(created, source)),
        atime: None,
        mtime: None,
    };
    sftp.setstat(Path::new(path), change)
        .map_err(|e| call_error("Could not set the permissions of", path, &e))
}

/// Where an upload's bytes finally go, and what is there now.
pub(super) struct RemoteTarget {
    pub(super) path: String,
    pub(super) existing: Option<FileStat>,
}

impl RemoteTarget {
    /// A symlink at `remote` is written through, as `scp` would: renaming
    /// over it would replace the link with a regular file.
    pub(super) fn resolve(sftp: &Sftp, remote: &str) -> Result<Self, String> {
        let stat = missing_or(sftp.lstat(Path::new(remote)))
            .map_err(|e| call_error("Could not read", remote, &e))?;
        match stat {
            Some(stat) if stat.file_type().is_symlink() => {
                let real = sftp
                    .realpath(Path::new(remote))
                    .map_err(|e| call_error("Could not follow", remote, &e))
                    .and_then(path_string)?;
                let existing = missing_or(sftp.stat(Path::new(&real)))
                    .map_err(|e| call_error("Could not read", &real, &e))?;
                if existing.as_ref().is_some_and(FileStat::is_dir) {
                    return Err(format!("{} is a folder", remote));
                }
                Ok(Self {
                    path: real,
                    existing,
                })
            }
            Some(stat) if stat.is_dir() => Err(format!("{} is a folder", remote)),
            existing => Ok(Self {
                path: remote.to_string(),
                existing,
            }),
        }
    }
}

/// Copy `source` to a new temporary name beside the target and return that
/// name. If this fails, the temporary file is gone and the target untouched.
pub(super) fn stage_upload(
    sftp: &Sftp,
    source: &mut dyn Read,
    target: &RemoteTarget,
    mode: Option<u32>,
    on_chunk: &mut dyn FnMut(usize) -> Result<(), Stop>,
) -> Result<String, Stop> {
    let dir = remote_parent(&target.path)
        .ok_or_else(|| Stop::Failed(format!("{} has no folder to write in", target.path)))?;
    let staged = join_remote(&dir, &temp_name());
    // A new file takes the source's mode. One replacing another gets the
    // old file's mode in `commit_upload`, and stays private until then.
    let open_mode = match &target.existing {
        Some(_) => 0o600,
        None => mode.unwrap_or(0o644) & 0o777,
    };
    let mut remote = sftp
        .open_mode(
            Path::new(&staged),
            OpenFlags::WRITE | OpenFlags::EXCLUSIVE,
            open_mode as i32,
            OpenType::File,
        )
        .map_err(|e| call_error("Could not create a temporary file in", &dir, &e))?;
    let written = copy_stream(source, &mut remote, on_chunk).and_then(|()| {
        // Durable before it can replace anything. Not every server has the
        // extension; a failing connection shows in the close below.
        let _ = remote.fsync();
        remote
            .close()
            .map_err(|e| Stop::Failed(call_error("Could not finish writing", &target.path, &e)))
    });
    drop(remote);
    if let Err(stop) = written {
        let _ = sftp.unlink(Path::new(&staged));
        return Err(stop);
    }
    Ok(staged)
}

/// Put a staged file in place, keeping the replaced file's permissions and,
/// where the server allows it, its owner.
pub(super) fn commit_upload(sftp: &Sftp, staged: &str, target: &RemoteTarget) -> Result<(), Stop> {
    if let Err(error) = keep_attributes(sftp, staged, target) {
        discard_upload(sftp, staged);
        return Err(Stop::Failed(error));
    }
    place_staged(sftp, staged, &target.path).map_err(Stop::Failed)
}

/// Replace `target` with `staged`, removing `staged` only if it is not the
/// one copy left of the new content with the target's name empty.
fn place_staged(calls: &dyn ReplaceCalls, staged: &str, target: &str) -> Result<(), String> {
    match replace_remote(calls, staged, target) {
        Ok(()) => Ok(()),
        Err(ReplaceFailure::Untouched(error)) => {
            let _ = calls.unlink(staged);
            Err(error)
        }
        Err(ReplaceFailure::Stranded(error)) => Err(error),
    }
}

/// Removes a staged file that will not be committed.
pub(super) fn discard_upload(sftp: &Sftp, staged: &str) {
    let _ = sftp.unlink(Path::new(staged));
}

fn keep_attributes(sftp: &Sftp, staged: &str, target: &RemoteTarget) -> Result<(), String> {
    let Some(existing) = &target.existing else {
        return Ok(());
    };
    let attributes = |uid, gid, perm| FileStat {
        size: None,
        uid,
        gid,
        perm,
        atime: None,
        mtime: None,
    };
    // Owner first, since changing it clears setuid. Only root may give a
    // file away, so failing here is normal for a shared file.
    if existing.uid.is_some() && existing.gid.is_some() {
        let _ = sftp.setstat(
            Path::new(staged),
            attributes(existing.uid, existing.gid, None),
        );
    }
    if let Some(perm) = existing.perm {
        sftp.setstat(
            Path::new(staged),
            attributes(None, None, Some(super::permission_bits(perm))),
        )
        .map_err(|e| call_error("Could not keep the permissions of", &target.path, &e))?;
    }
    Ok(())
}

/// How a replace that failed left things on the server.
#[derive(Debug, PartialEq)]
enum ReplaceFailure {
    /// The target is as it was, so the staged copy is of no further use.
    Untouched(String),
    /// The target's name is empty: the old file is aside and the new one
    /// still staged. Neither may be removed, and the message names both.
    Stranded(String),
}

/// The calls a replace makes, so a test can refuse any of them.
trait ReplaceCalls {
    fn rename(&self, from: &str, to: &str) -> Result<(), ssh2::Error>;
    fn exists(&self, path: &str) -> Result<bool, ssh2::Error>;
    fn unlink(&self, path: &str) -> Result<(), ssh2::Error>;
}

impl ReplaceCalls for Sftp {
    fn rename(&self, from: &str, to: &str) -> Result<(), ssh2::Error> {
        Sftp::rename(self, Path::new(from), Path::new(to), None)
    }

    fn exists(&self, path: &str) -> Result<bool, ssh2::Error> {
        missing_or(self.lstat(Path::new(path))).map(|stat| stat.is_some())
    }

    fn unlink(&self, path: &str) -> Result<(), ssh2::Error> {
        Sftp::unlink(self, Path::new(path))
    }
}

/// Rename `staged` onto `target`. SFTP's rename refuses an existing target
/// on OpenSSH, whose atomic `posix-rename` extension ssh2 does not expose,
/// so the old file moves aside for a moment and moves back if that fails.
fn replace_remote(
    calls: &dyn ReplaceCalls,
    staged: &str,
    target: &str,
) -> Result<(), ReplaceFailure> {
    let untouched =
        |action: &str, e: &ssh2::Error| ReplaceFailure::Untouched(call_error(action, target, e));
    let first_try = match calls.rename(staged, target) {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    let exists = calls
        .exists(target)
        .map_err(|e| untouched("Could not read", &e))?;
    if !exists {
        return Err(untouched("Could not write", &first_try));
    }
    let dir = remote_parent(target)
        .ok_or_else(|| ReplaceFailure::Untouched(format!("{} has no folder", target)))?;
    let aside = join_remote(&dir, &temp_name());
    calls
        .rename(target, &aside)
        .map_err(|e| untouched("Could not replace", &e))?;
    if let Err(e) = calls.rename(staged, target) {
        return Err(match calls.rename(&aside, target) {
            Ok(()) => untouched("Could not replace", &e),
            Err(restore) => ReplaceFailure::Stranded(format!(
                "{}. Putting the old file back failed too ({}): it is now {}, and the new copy is {}",
                call_error("Could not replace", target, &e),
                restore.message(),
                aside,
                staged
            )),
        });
    }
    if let Err(e) = calls.unlink(&aside) {
        log_local(
            "warn",
            "sftp",
            format!("Could not remove the old copy {}: {}", aside, e.message()),
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------

fn run_download(sftp: &Sftp, input: &TransferInput, run: &mut Run<'_>) -> Result<String, Stop> {
    let name = remote_entry_name(&input.source)?;
    if !safe_local_name(name) {
        return Err(Stop::Failed(format!(
            "\"{}\" is not a valid file name on this system",
            name
        )));
    }
    let target = Path::new(&input.target_dir).join(name);
    let target_text = local_path_string(&target)?;
    let plan = plan_remote(sftp, &input.source, run.cancel)?;

    if fs::symlink_metadata(&target).is_ok() && !input.overwrite {
        return Err(Stop::Conflict {
            target_is_dir: target.is_dir(),
            target: target_text,
        });
    }

    run.begin(&plan);
    let mut to_seal = Vec::new();
    for item in &plan.items {
        run.check()?;
        match item {
            PlanItem::Dir { rel, mode } => {
                let path = local_under(&target, rel);
                if ensure_local_dir(&path, *mode)? {
                    to_seal.extend(lacks_owner_bits(*mode).map(|source| (path, source)));
                }
            }
            PlanItem::File { rel, mode } => {
                run.start_file(rel);
                let remote_path = remote_under(&input.source, rel);
                let mut remote = sftp
                    .open(Path::new(&remote_path))
                    .map_err(|e| call_error("Could not read", &remote_path, &e))?;
                let destination = local_target(&local_under(&target, rel))?;
                write_partial(&destination, *mode, |file| {
                    copy_stream(&mut remote, file, &mut |n| run.on_chunk(n))
                })?;
                run.finish_file();
            }
        }
    }
    // Deepest first: a parent that loses its owner's access would block the rest.
    for (path, source) in to_seal.iter().rev() {
        seal_local_dir(path, *source)?;
    }
    Ok(target_text)
}

/// Make sure a folder is there, and say whether it had to be created. One
/// that exists keeps its mode, as a replaced file does.
fn ensure_local_dir(path: &Path, mode: Option<u32>) -> Result<bool, String> {
    if path.is_dir() {
        return Ok(false);
    }
    if fs::symlink_metadata(path).is_ok() {
        return Err(format!("{} is in the way of a folder", path.display()));
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(new_folder_mode(mode));
    }
    #[cfg(not(unix))]
    let _ = mode;
    builder
        .create(path)
        .map(|()| true)
        .map_err(|e| format!("Could not create {}: {}", path.display(), e))
}

fn seal_local_dir(path: &Path, source: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let fail = |e: std::io::Error| {
            format!("Could not set the permissions of {}: {}", path.display(), e)
        };
        let created = fs::metadata(path).map_err(fail)?.permissions().mode();
        let sealed = sealed_folder_mode(created, source);
        fs::set_permissions(path, fs::Permissions::from_mode(sealed)).map_err(fail)
    }
    #[cfg(not(unix))]
    {
        let _ = (path, source);
        Ok(())
    }
}

/// Where a download's bytes finally go. A symlink is written through, as
/// `scp` would; a folder in the way is an error, not something to replace.
fn local_target(path: &Path) -> Result<PathBuf, String> {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return Ok(path.to_path_buf());
    };
    if meta.is_dir() || (meta.file_type().is_symlink() && path.is_dir()) {
        return Err(format!("{} is a folder", path.display()));
    }
    if meta.file_type().is_symlink() {
        return fs::canonicalize(path)
            .map_err(|e| format!("Could not follow {}: {}", path.display(), e));
    }
    Ok(path.to_path_buf())
}

/// Removes the file unless told the file has reached its final name.
struct RemoveUnlessKept<'a> {
    path: &'a Path,
    keep: bool,
}

impl Drop for RemoveUnlessKept<'_> {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_file(self.path);
        }
    }
}

/// Fill a temporary file beside `target` through `fill`, then rename it into
/// place: `target` is either what it was or the whole new file, never part
/// of one. `mode` applies to a new file; one being replaced keeps its own,
/// so a private file stays private.
pub(super) fn write_partial<F>(target: &Path, mode: Option<u32>, fill: F) -> Result<(), Stop>
where
    F: FnOnce(&mut fs::File) -> Result<(), Stop>,
{
    let dir = target
        .parent()
        .ok_or_else(|| Stop::Failed(format!("{} has no folder", target.display())))?;
    let staged = dir.join(temp_name());
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode & 0o777);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let mut file = options
        .open(&staged)
        .map_err(|e| format!("Could not write in {}: {}", dir.display(), e))?;
    let mut guard = RemoveUnlessKept {
        path: &staged,
        keep: false,
    };

    if let Ok(existing) = fs::metadata(target) {
        fs::set_permissions(&staged, existing.permissions()).map_err(|e| {
            format!(
                "Could not keep the permissions of {}: {}",
                target.display(),
                e
            )
        })?;
    }
    fill(&mut file)?;
    file.sync_all()
        .map_err(|e| format!("Could not finish writing {}: {}", target.display(), e))?;
    drop(file);
    fs::rename(&staged, target)
        .map_err(|e| format!("Could not write {}: {}", target.display(), e))?;
    guard.keep = true;
    // The rename itself survives a power cut only once the folder is synced.
    #[cfg(unix)]
    if let Ok(folder) = fs::File::open(dir) {
        let _ = folder.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::browse::{save_forward, TempDir};
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeSet;
    use std::io::{self, Cursor};
    use std::sync::Mutex;

    /// A reader that fails after a first chunk of data, like a dropped link.
    struct FailsAfter(Cursor<Vec<u8>>);
    impl Read for FailsAfter {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            match self.0.read(buf)? {
                0 => Err(io::Error::other("connection lost")),
                n => Ok(n),
            }
        }
    }

    fn entries_of(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_str().unwrap().to_string())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_finished_copy_arrives_whole_under_its_name() {
        let tmp = TempDir::new("whole");
        let target = tmp.0.join("out.bin");
        let data = vec![7u8; CHUNK_BYTES * 2 + 5];
        let mut chunks = 0;
        write_partial(&target, None, |file| {
            let mut source = Cursor::new(data.clone());
            copy_stream(&mut source, file, &mut |_| {
                chunks += 1;
                Ok(())
            })
        })
        .unwrap();
        assert_eq!(fs::read(&target).unwrap(), data);
        assert_eq!(chunks, 3, "the file must go through in chunks");
        assert_eq!(entries_of(&tmp.0), ["out.bin"]);
    }

    #[test]
    fn a_failed_copy_leaves_nothing_under_the_final_name() {
        let tmp = TempDir::new("failed");
        let target = tmp.0.join("out.bin");
        let result = write_partial(&target, None, |file| {
            let mut source = FailsAfter(Cursor::new(vec![1u8; 1024]));
            copy_stream(&mut source, file, &mut |_| Ok(()))
        });
        assert!(matches!(result, Err(Stop::Failed(ref e)) if e.contains("connection lost")));
        assert!(!target.exists());
        assert!(entries_of(&tmp.0).is_empty(), "{:?}", entries_of(&tmp.0));
    }

    #[test]
    fn a_cancelled_copy_keeps_the_old_file_and_no_partial_one() {
        let tmp = TempDir::new("cancel");
        let target = tmp.0.join("out.bin");
        fs::write(&target, "previous").unwrap();
        let result = write_partial(&target, None, |file| {
            let mut source = Cursor::new(vec![1u8; CHUNK_BYTES * 3]);
            copy_stream(&mut source, file, &mut |_| Err(Stop::Cancelled))
        });
        assert_eq!(result, Err(Stop::Cancelled));
        assert_eq!(fs::read_to_string(&target).unwrap(), "previous");
        assert_eq!(entries_of(&tmp.0), ["out.bin"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_replaced_file_keeps_its_mode_and_a_new_one_takes_the_sources() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new("mode");
        let private = tmp.0.join("private");
        fs::write(&private, "old").unwrap();
        fs::set_permissions(&private, fs::Permissions::from_mode(0o600)).unwrap();
        write_partial(&private, Some(0o644), |file| {
            file.write_all(b"new")
                .map_err(|e| Stop::Failed(e.to_string()))
        })
        .unwrap();
        assert_eq!(fs::read_to_string(&private).unwrap(), "new");
        let mode = fs::metadata(&private).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "a private file must stay private");

        let fresh = tmp.0.join("fresh");
        write_partial(&fresh, Some(0o100600), |_| Ok(())).unwrap();
        let mode = fs::metadata(&fresh).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn a_download_writes_through_a_symlink_and_never_over_a_folder() {
        use std::os::unix::fs::symlink;
        let tmp = TempDir::new("targets");
        fs::write(tmp.0.join("real"), "x").unwrap();
        symlink(tmp.0.join("real"), tmp.0.join("link")).unwrap();
        assert_eq!(
            local_target(&tmp.0.join("link")).unwrap(),
            tmp.0.join("real")
        );
        assert_eq!(local_target(&tmp.0.join("new")).unwrap(), tmp.0.join("new"));

        fs::create_dir(tmp.0.join("dir")).unwrap();
        symlink(tmp.0.join("dir"), tmp.0.join("dirlink")).unwrap();
        assert!(local_target(&tmp.0.join("dir")).is_err());
        assert!(local_target(&tmp.0.join("dirlink")).is_err());
    }

    /// A server whose renames refuse an existing target, like OpenSSH's, and
    /// refuse the calls a test lists, counted from zero.
    struct ScriptedServer {
        files: RefCell<BTreeSet<String>>,
        refused_renames: Vec<usize>,
        renames: Cell<usize>,
    }

    impl ScriptedServer {
        fn new(files: &[&str], refused_renames: &[usize]) -> Self {
            Self {
                files: RefCell::new(files.iter().map(|f| f.to_string()).collect()),
                refused_renames: refused_renames.to_vec(),
                renames: Cell::new(0),
            }
        }

        fn files(&self) -> Vec<String> {
            self.files.borrow().iter().cloned().collect()
        }
    }

    impl ReplaceCalls for ScriptedServer {
        fn rename(&self, from: &str, to: &str) -> Result<(), ssh2::Error> {
            let call = self.renames.replace(self.renames.get() + 1);
            let refused = ssh2::Error::new(ssh2::ErrorCode::SFTP(4), "refused");
            if self.refused_renames.contains(&call) {
                return Err(refused);
            }
            let mut files = self.files.borrow_mut();
            if files.contains(to) || !files.remove(from) {
                return Err(refused);
            }
            files.insert(to.to_string());
            Ok(())
        }

        fn exists(&self, path: &str) -> Result<bool, ssh2::Error> {
            Ok(self.files.borrow().contains(path))
        }

        fn unlink(&self, path: &str) -> Result<(), ssh2::Error> {
            self.files.borrow_mut().remove(path);
            Ok(())
        }
    }

    const STAGED: &str = "/d/.ssix-part-new";
    const TARGET: &str = "/d/f.txt";

    #[test]
    fn replacing_moves_the_old_file_aside_and_removes_it() {
        let server = ScriptedServer::new(&[STAGED, TARGET], &[]);
        place_staged(&server, STAGED, TARGET).unwrap();
        assert_eq!(server.files(), [TARGET]);
    }

    #[test]
    fn a_new_target_needs_one_rename() {
        let server = ScriptedServer::new(&[STAGED], &[]);
        place_staged(&server, STAGED, TARGET).unwrap();
        assert_eq!(server.files(), [TARGET]);
        assert_eq!(server.renames.get(), 1);
    }

    #[test]
    fn a_target_that_cannot_move_aside_stays_and_the_new_copy_goes() {
        // Rename 0 meets the existing target; rename 1 is the move aside.
        let server = ScriptedServer::new(&[STAGED, TARGET], &[1]);
        let err = place_staged(&server, STAGED, TARGET).unwrap_err();
        assert!(err.contains("Could not replace"), "{}", err);
        assert_eq!(server.files(), [TARGET]);
    }

    #[test]
    fn a_failed_replace_puts_the_old_file_back_and_removes_the_new_copy() {
        let server = ScriptedServer::new(&[STAGED, TARGET], &[2]);
        let err = place_staged(&server, STAGED, TARGET).unwrap_err();
        assert!(err.contains("Could not replace"), "{}", err);
        assert!(!err.contains("failed too"), "{}", err);
        assert_eq!(server.files(), [TARGET]);
    }

    #[test]
    fn a_failed_rollback_says_where_both_copies_are_and_removes_neither() {
        let server = ScriptedServer::new(&[STAGED, TARGET], &[2, 3]);
        let err = place_staged(&server, STAGED, TARGET).unwrap_err();

        let files = server.files();
        assert_eq!(files.len(), 2, "{:?}", files);
        assert!(files.contains(&STAGED.to_string()), "{:?}", files);
        assert!(!files.contains(&TARGET.to_string()), "{:?}", files);
        let aside = files.iter().find(|f| *f != STAGED).unwrap();
        assert!(err.contains("failed too"), "{}", err);
        assert!(err.contains(aside.as_str()), "{}", err);
        assert!(err.contains(STAGED), "{}", err);
    }

    #[test]
    fn a_folder_plan_lists_parents_first_with_totals() {
        let tmp = TempDir::new("plan");
        let root = tmp.0.join("tree");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("a.txt"), "aaa").unwrap();
        fs::write(root.join("sub/b.txt"), "bb").unwrap();
        let plan = plan_local(&root, &AtomicBool::new(false)).unwrap();
        assert_eq!(plan.files, 2);
        assert_eq!(plan.bytes, 5);
        assert!(matches!(&plan.items[0], PlanItem::Dir { rel, .. } if rel.is_empty()));
        let position = |rel: &str| {
            plan.items.iter().position(|item| match item {
                PlanItem::Dir { rel: r, .. } | PlanItem::File { rel: r, .. } => r == rel,
            })
        };
        assert!(position("sub") < position("sub/b.txt"));
        assert!(position("a.txt").is_some());
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_plan_skips_symlinks_but_follows_the_picked_one() {
        use std::os::unix::fs::symlink;
        let tmp = TempDir::new("planlinks");
        let root = tmp.0.join("tree");
        fs::create_dir_all(tmp.0.join("outside")).unwrap();
        fs::write(tmp.0.join("outside/secret"), "s").unwrap();
        fs::create_dir(&root).unwrap();
        fs::write(root.join("a"), "a").unwrap();
        symlink(tmp.0.join("outside"), root.join("escape")).unwrap();
        symlink(&root, root.join("loop")).unwrap();

        let plan = plan_local(&root, &AtomicBool::new(false)).unwrap();
        assert_eq!(plan.files, 1);
        assert_eq!(plan.skipped, 2);

        symlink(tmp.0.join("outside/secret"), tmp.0.join("picked")).unwrap();
        let plan = plan_local(&tmp.0.join("picked"), &AtomicBool::new(false)).unwrap();
        assert_eq!(plan.files, 1, "the entry the user picked is followed");
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_plan_carries_each_folders_mode() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new("planmodes");
        let root = tmp.0.join("tree");
        fs::create_dir_all(root.join("private")).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o750)).unwrap();
        fs::set_permissions(root.join("private"), fs::Permissions::from_mode(0o700)).unwrap();

        let plan = plan_local(&root, &AtomicBool::new(false)).unwrap();
        let mode_of = |wanted: &str| {
            plan.items.iter().find_map(|item| match item {
                PlanItem::Dir { rel, mode } if rel == wanted => *mode,
                _ => None,
            })
        };
        assert_eq!(mode_of("").map(|m| m & 0o777), Some(0o750));
        assert_eq!(mode_of("private").map(|m| m & 0o777), Some(0o700));
    }

    #[test]
    fn a_new_folder_can_be_filled_and_ends_with_the_sources_owner_bits() {
        // The file-type bits a server reports do not reach the new mode.
        assert_eq!(new_folder_mode(0o040700), 0o700);
        assert_eq!(new_folder_mode(0o755), 0o755);
        assert_eq!(new_folder_mode(0o500), 0o700);

        assert_eq!(lacks_owner_bits(Some(0o755)), None);
        assert_eq!(lacks_owner_bits(Some(0o040700)), None);
        assert_eq!(lacks_owner_bits(Some(0o555)), Some(0o555));
        assert_eq!(lacks_owner_bits(None), None);

        assert_eq!(sealed_folder_mode(0o700, 0o500), 0o500);
        assert_eq!(sealed_folder_mode(0o040755, 0o555), 0o555);
        // Group and other stay as creating it left them, after the umask.
        assert_eq!(sealed_folder_mode(0o755, 0o577), 0o555);
    }

    #[cfg(unix)]
    #[test]
    fn a_new_local_folder_keeps_a_private_mode_and_an_existing_one_is_left_alone() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new("foldermodes");
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;

        let private = tmp.0.join("private");
        assert!(ensure_local_dir(&private, Some(0o040700)).unwrap());
        assert_eq!(mode(&private), 0o700);

        // Fillable until sealed, then what the source was.
        let sealed = tmp.0.join("sealed");
        assert!(ensure_local_dir(&sealed, Some(0o500)).unwrap());
        assert_eq!(mode(&sealed), 0o700);
        fs::write(sealed.join("f"), "x").unwrap();
        seal_local_dir(&sealed, 0o500).unwrap();
        assert_eq!(mode(&sealed), 0o500);
        fs::set_permissions(&sealed, fs::Permissions::from_mode(0o700)).unwrap();

        fs::set_permissions(&private, fs::Permissions::from_mode(0o750)).unwrap();
        assert!(!ensure_local_dir(&private, Some(0o700)).unwrap());
        assert_eq!(mode(&private), 0o750, "a merge keeps the folder's own mode");
    }

    #[test]
    fn a_plan_stops_when_cancelled() {
        let tmp = TempDir::new("plancancel");
        let cancelled = AtomicBool::new(true);
        assert_eq!(plan_local(&tmp.0, &cancelled).unwrap_err(), Stop::Cancelled);
    }

    #[test]
    fn relative_paths_build_both_sides() {
        assert_eq!(join_rel("", "a"), "a");
        assert_eq!(join_rel("a", "b"), "a/b");
        assert_eq!(remote_under("/t", ""), "/t");
        assert_eq!(remote_under("/t", "a/b"), "/t/a/b");
        assert_eq!(local_under(Path::new("/t"), ""), Path::new("/t"));
        assert_eq!(
            local_under(Path::new("/t"), "a/b"),
            Path::new("/t").join("a").join("b")
        );
    }

    fn collector() -> (Emit, Arc<Mutex<Vec<TransferEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let emit: Emit = Arc::new(move |event| sink.lock().unwrap().push(event));
        (emit, events)
    }

    #[test]
    fn progress_is_throttled_but_always_counts() {
        let (emit, events) = collector();
        let cancel = AtomicBool::new(false);
        let mut run = Run::new("t", &cancel, emit);
        run.begin(&Plan {
            bytes: 100,
            files: 1,
            ..Plan::default()
        });
        for _ in 0..50 {
            run.on_chunk(1).unwrap();
        }
        assert_eq!(run.bytes_done, 50);
        let reports = events.lock().unwrap().len();
        assert!(reports < 10, "{} reports for 50 quick chunks", reports);
        run.finish_file();
        assert_eq!(
            events.lock().unwrap().last(),
            Some(&TransferEvent::Progress {
                id: "t".to_string(),
                bytes_done: 50,
                bytes_total: 100,
                files_done: 1,
                files_total: 1,
                current: String::new(),
            })
        );
    }

    #[test]
    fn a_cancel_stops_at_the_next_chunk() {
        let (emit, _) = collector();
        let cancel = AtomicBool::new(false);
        let mut run = Run::new("t", &cancel, emit);
        assert!(run.on_chunk(1).is_ok());
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(run.on_chunk(1), Err(Stop::Cancelled));
    }

    #[test]
    fn at_most_max_active_transfers_run_and_a_waiter_can_cancel() {
        // The counter is shared with any transfer another test has running,
        // so this only asserts what holds either way.
        let cancel = AtomicBool::new(false);
        let held: Vec<Slot> = (0..MAX_ACTIVE)
            .map(|_| wait_for_slot(&cancel).unwrap())
            .collect();
        assert!(ACTIVE.load(Ordering::SeqCst) >= MAX_ACTIVE);

        let waiter = thread::spawn(|| {
            let cancel = AtomicBool::new(true);
            wait_for_slot(&cancel).is_none()
        });
        assert!(waiter.join().unwrap(), "a cancelled waiter must give up");
        drop(held);
    }

    #[test]
    fn a_cancel_while_connecting_ends_at_once() {
        crate::storage::test_support::with_isolated_data_dir(|| {
            // Accepts connections (into the backlog) but never speaks SSH.
            let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = silent.local_addr().unwrap().port();
            let cred = crate::models::Credential::new(
                "c".into(),
                "u".into(),
                crate::models::CredentialKind::Password {
                    password: "p".into(),
                },
            );
            let conn = crate::models::Connection::new(
                "silent".into(),
                "127.0.0.1".into(),
                port,
                Some(cred.id.clone()),
                crate::models::ConnectionKind::Direct,
            );
            let connection_id = conn.id.clone();
            crate::storage::with_data_mut(|data| {
                data.credentials.push(cred);
                data.connections.push(conn);
                Ok(())
            })
            .unwrap();

            let (emit, events) = collector();
            let tmp = TempDir::new("connecting");
            let started = Instant::now();
            let id = start_transfer(
                TransferInput {
                    connection_id,
                    direction: TransferDirection::Download,
                    source: "/some/file".into(),
                    target_dir: tmp.0.to_str().unwrap().into(),
                    overwrite: false,
                },
                emit,
            )
            .unwrap();
            thread::sleep(Duration::from_millis(200));
            sftp_cancel_transfer(id.clone());
            while events.lock().unwrap().is_empty() {
                assert!(
                    started.elapsed() < Duration::from_secs(5),
                    "cancel took too long"
                );
                thread::sleep(Duration::from_millis(20));
            }
            assert_eq!(
                events.lock().unwrap().last(),
                Some(&TransferEvent::Cancelled { id })
            );
            assert!(entries_of(&tmp.0).is_empty());
        });
    }

    #[test]
    fn a_transfer_refuses_a_forward_before_it_starts() {
        crate::storage::test_support::with_isolated_data_dir(|| {
            let connection_id = save_forward(crate::models::ConnectionKind::PortForward {
                gateway_host: "gw".into(),
                gateway_port: 22,
                gateway_credential_id: "c".into(),
                local_port: 8080,
                destination_host: "db".into(),
                destination_port: 5432,
            });
            let (emit, events) = collector();
            let err = start_transfer(
                TransferInput {
                    connection_id,
                    direction: TransferDirection::Upload,
                    source: "/a".into(),
                    target_dir: "/b".into(),
                    overwrite: false,
                },
                emit,
            )
            .unwrap_err();
            assert!(err.contains("not available"), "{}", err);
            assert!(events.lock().unwrap().is_empty());
        });
    }
}
