//! Uploads and downloads for the Files view, and through `upload_unattended`
//! and `download_unattended` for the SCP dialog.
//!
//! `sftp_start_transfer` returns the transfer's id at once and adds it to a
//! queue, which costs it no thread. At most `MAX_ACTIVE` workers take from the
//! queue, each on a thread and a session of its own, so browsing stays free and
//! a session never crosses threads. A worker keeps its session for the next
//! transfer on the same connection, as long as the last one ended cleanly.
//! Everything after the start arrives as `TransferEvent`s on a `Channel`.
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
use crate::commands::ssh::{find_connection, ConnectedSession};
use crate::login_wait::connection_failed;
use crate::logs::log_local;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use ssh2::{FileStat, OpenFlags, OpenType, Session, Sftp};
use std::collections::VecDeque;
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
#[cfg(test)]
use ts_rs::TS;

/// Transfers running at once; the rest wait in `QUEUE`. Each holds an SSH
/// connection, and servers limit those (`MaxStartups`).
pub(super) const MAX_ACTIVE: usize = 3;
const CHUNK_BYTES: usize = 128 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
/// How long one SFTP call may take during a transfer. A link that cannot move a
/// chunk in this time (about 35 kbit/s) counts as dead. A cancel waits for the
/// call in progress, so a stalled link can hold it up this long.
pub(crate) const CALL_TIMEOUT_MS: u32 = 30_000;
/// For the calls that end a file, since a server can be slow to flush a big one.
const FINISH_TIMEOUT_MS: u32 = 60_000;
/// For each call that tidies up once the link has died, which cannot succeed.
const TIDY_TIMEOUT_MS: u32 = 2_000;

static TRANSFERS: LazyLock<DashMap<String, Arc<AtomicBool>>> = LazyLock::new(DashMap::new);
static QUEUE: LazyLock<Mutex<WorkQueue<Queued>>> = LazyLock::new(|| Mutex::new(WorkQueue::new()));
/// Logins made for transfers, for the test that queued ones share them.
#[cfg(test)]
pub(super) static LOGINS: AtomicUsize = AtomicUsize::new(0);

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
pub(crate) enum Stop {
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
    /// For a caller with no use for the difference: its copies are not
    /// cancelled at this point and never ask about a conflict.
    pub(crate) fn into_message(self) -> String {
        match self {
            Stop::Failed(error) => error,
            Stop::Cancelled => "Cancelled".to_string(),
            Stop::Conflict { target, .. } => format!("{} already exists", target),
        }
    }

    /// Reword a failure. Any other reason stays what it is.
    pub(crate) fn map_failed(self, reword: impl FnOnce(String) -> String) -> Self {
        match self {
            Stop::Failed(error) => Stop::Failed(reword(error)),
            other => other,
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
    let needs_worker = lock_queue().push(Queued {
        id: id.clone(),
        input,
        cancel,
        emit,
    });
    if needs_worker {
        thread::spawn(run_worker);
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
    // One still waiting has nothing to stop, so it ends here.
    let waiting = lock_queue().take(|item| item.id == id);
    if let Some(item) = waiting {
        TRANSFERS.remove(&item.id);
        (item.emit)(TransferEvent::Cancelled { id: item.id });
    }
}

/// What is waiting for a worker, oldest first, and how many workers there are.
/// A worker only ends when nothing is waiting, so all of them are busy.
struct WorkQueue<T> {
    waiting: VecDeque<T>,
    workers: usize,
}

impl<T> WorkQueue<T> {
    fn new() -> Self {
        Self {
            waiting: VecDeque::new(),
            workers: 0,
        }
    }

    /// Add an item. True means the caller must start a worker for it.
    fn push(&mut self, item: T) -> bool {
        self.waiting.push_back(item);
        self.claim_worker()
    }

    fn claim_worker(&mut self) -> bool {
        let room = self.workers < MAX_ACTIVE;
        if room {
            self.workers += 1;
        }
        room
    }

    /// The next item for a worker that is free. `None` ends that worker.
    fn next(&mut self) -> Option<T> {
        let item = self.waiting.pop_front();
        if item.is_none() {
            self.workers -= 1;
        }
        item
    }

    fn take(&mut self, matches: impl Fn(&T) -> bool) -> Option<T> {
        let position = self.waiting.iter().position(matches)?;
        self.waiting.remove(position)
    }
}

struct Queued {
    id: String,
    input: TransferInput,
    cancel: Arc<AtomicBool>,
    emit: Emit,
}

fn lock_queue() -> MutexGuard<'static, WorkQueue<Queued>> {
    QUEUE.lock().unwrap_or_else(|e| e.into_inner())
}

/// A worker's place, given back if a transfer panics: the queue must go on.
struct WorkerPlace {
    ended: bool,
}

impl Drop for WorkerPlace {
    fn drop(&mut self) {
        if self.ended {
            return;
        }
        let replace = {
            let mut queue = lock_queue();
            queue.workers -= 1;
            !queue.waiting.is_empty() && queue.claim_worker()
        };
        if replace {
            thread::spawn(run_worker);
        }
    }
}

fn run_worker() {
    let mut place = WorkerPlace { ended: false };
    let mut session = None;
    loop {
        let Some(item) = lock_queue().next() else {
            place.ended = true;
            return;
        };
        session = run_transfer(item, session);
    }
}

/// A session a worker holds between transfers. Only this worker's thread ever
/// touches it: libssh2 sessions are not safe to share.
struct TransferSession {
    connection_id: String,
    sftp: Sftp,
    /// Keeps the session open for `sftp`; dropped after it.
    ssh: ConnectedSession,
}

fn open_session(input: &TransferInput, cancel: &AtomicBool) -> Result<TransferSession, Stop> {
    let (data, conn) = find_connection(&input.connection_id)?;
    let ssh = connect_unless_cancelled(data, conn, "Transferring files", &|| {
        cancel.load(Ordering::SeqCst)
    })?
    .ok_or(Stop::Cancelled)?;
    #[cfg(test)]
    LOGINS.fetch_add(1, Ordering::SeqCst);
    ssh.session.set_timeout(CALL_TIMEOUT_MS);
    let sftp = ssh
        .session
        .sftp()
        .map_err(|e| format!("The server does not offer SFTP: {}", e.message()))?;
    Ok(TransferSession {
        connection_id: input.connection_id.clone(),
        sftp,
        ssh,
    })
}

/// Call after a failure, before anything tidies up or a session closes: on a
/// dead link each of those calls would wait out its whole limit. Any other
/// failure leaves the link working, so tidying keeps the time it needs.
pub(crate) fn limit_tidying(session: &Session) {
    if ssh2::Error::last_session_error(session).is_some_and(|e| connection_failed(&e)) {
        session.set_timeout(TIDY_TIMEOUT_MS);
    }
}

/// Run a call that ends a file under the longer limit.
pub(crate) fn with_finish_limit<T, E>(
    session: &Session,
    finish: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    let usual = session.timeout();
    session.set_timeout(FINISH_TIMEOUT_MS);
    let result = finish();
    session.set_timeout(usual);
    if result.is_err() {
        limit_tidying(session);
    }
    result
}

/// Run one transfer to its end and report how it went. Returns the session
/// if the next transfer may use it.
fn run_transfer(item: Queued, session: Option<TransferSession>) -> Option<TransferSession> {
    let Queued {
        id,
        input,
        cancel,
        emit,
    } = item;
    let mut run = Run::new(&id, &cancel, emit.clone());
    let (outcome, session) = copy_on_a_session(&input, &mut run, session);
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
    session
}

/// Copy on the session given, if it is for this connection, or on a new one.
/// A copy that stopped partway may have left its session in any state, so only
/// one that ended cleanly hands its session on.
fn copy_on_a_session(
    input: &TransferInput,
    run: &mut Run<'_>,
    previous: Option<TransferSession>,
) -> (Result<String, Stop>, Option<TransferSession>) {
    if let Err(stop) = run.check() {
        return (Err(stop), previous);
    }
    let reusable = previous.filter(|session| session.connection_id == input.connection_id);
    let session = match reusable {
        Some(session) => session,
        None => match open_session(input, run.cancel) {
            Ok(session) => session,
            Err(stop) => return (Err(stop), None),
        },
    };
    let outcome = match input.direction {
        TransferDirection::Upload => run_upload(&session.ssh.session, &session.sftp, input, run),
        TransferDirection::Download => {
            run_download(&session.ssh.session, &session.sftp, input, run)
        }
    };
    let clean = matches!(outcome, Ok(_) | Err(Stop::Conflict { .. }));
    if !clean {
        limit_tidying(&session.ssh.session);
    }
    (outcome, clean.then_some(session))
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
pub(crate) fn copy_stream(
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

pub(crate) fn file_mode(meta: &fs::Metadata) -> Option<u32> {
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

/// Go through a plan in order on either side: `ensure_dir` says where a folder
/// is and whether it had to be created, and `seal` gives a created folder its
/// final mode once everything is in.
fn carry_out<'a, P>(
    run: &mut Run<'a>,
    plan: &Plan,
    ensure_dir: impl Fn(&str, Option<u32>) -> Result<(P, bool), String>,
    mut copy_file: impl FnMut(&mut Run<'a>, &str, Option<u32>) -> Result<(), Stop>,
    seal: impl Fn(&P, u32) -> Result<(), String>,
) -> Result<(), Stop> {
    run.begin(plan);
    let mut to_seal = Vec::new();
    for item in &plan.items {
        run.check()?;
        match item {
            PlanItem::Dir { rel, mode } => {
                let (path, created) = ensure_dir(rel, *mode)?;
                if created {
                    to_seal.extend(lacks_owner_bits(*mode).map(|source| (path, source)));
                }
            }
            PlanItem::File { rel, mode } => {
                run.start_file(rel);
                copy_file(run, rel, *mode)?;
                run.finish_file();
            }
        }
    }
    // Deepest first: a parent that loses its owner's access would block the rest.
    for (path, source) in to_seal.iter().rev() {
        seal(path, *source)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------

fn run_upload(
    session: &Session,
    sftp: &Sftp,
    input: &TransferInput,
    run: &mut Run<'_>,
) -> Result<String, Stop> {
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

    upload_plan(session, sftp, source, &plan, &target, run)?;
    Ok(target)
}

fn upload_plan(
    session: &Session,
    sftp: &Sftp,
    source: &Path,
    plan: &Plan,
    target: &str,
    run: &mut Run<'_>,
) -> Result<(), Stop> {
    carry_out(
        run,
        plan,
        |rel, mode| {
            let path = remote_under(target, rel);
            let created = ensure_remote_dir(sftp, &path, mode)?;
            Ok((path, created))
        },
        |run, rel, mode| {
            let mut file = fs::File::open(local_under(source, rel))
                .map_err(|e| format!("Could not read {}: {}", source.display(), e))?;
            let destination = RemoteTarget::resolve(sftp, &remote_under(target, rel))?;
            let staged = stage_upload(session, sftp, &mut file, &destination, mode, &mut |n| {
                run.on_chunk(n)
            })?;
            commit_upload(session, sftp, &staged, &destination)
        },
        |path, source| seal_remote_dir(sftp, path, source),
    )
}

/// How far a copy got, whether or not it reached its end. `bytes` includes a
/// file it did not finish.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Copied {
    pub(crate) bytes: u64,
    pub(crate) files: u64,
}

/// A copy nobody watches, which `cancel` stops.
fn unattended(
    cancel: &AtomicBool,
    copy: impl FnOnce(&mut Run<'_>) -> Result<(), Stop>,
) -> (Copied, Result<(), Stop>) {
    let mut run = Run::new("", cancel, Arc::new(|_| {}));
    let ended = copy(&mut run);
    if run.skipped > 0 {
        log_local(
            "info",
            "scp",
            format!(
                "Left {} symlink(s) or special entries out of a folder",
                run.skipped
            ),
        );
    }
    let copied = Copied {
        bytes: run.bytes_done,
        files: run.files_done,
    };
    (copied, ended)
}

/// Upload `source` to exactly `target`, replacing what is there.
pub(crate) fn upload_unattended(
    session: &Session,
    sftp: &Sftp,
    source: &Path,
    target: &str,
    cancel: &AtomicBool,
) -> (Copied, Result<(), Stop>) {
    unattended(cancel, |run| {
        let plan = plan_local(source, run.cancel)?;
        upload_plan(session, sftp, source, &plan, target, run)
    })
}

/// Download `source` to exactly `target`, replacing what is there.
pub(crate) fn download_unattended(
    session: &Session,
    sftp: &Sftp,
    source: &str,
    target: &Path,
    cancel: &AtomicBool,
) -> (Copied, Result<(), Stop>) {
    unattended(cancel, |run| {
        let plan = plan_remote(sftp, source, run.cancel)?;
        download_plan(session, sftp, source, &plan, target, run)
    })
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
    session: &Session,
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
        with_finish_limit(session, || {
            // Durable before it can replace anything. Not every server has the
            // extension; a failing connection shows in the close below.
            let _ = remote.fsync();
            remote
                .close()
                .map_err(|e| Stop::Failed(call_error("Could not finish writing", &target.path, &e)))
        })
    });
    if let Err(stop) = written {
        limit_tidying(session);
        drop(remote);
        let _ = sftp.unlink(Path::new(&staged));
        return Err(stop);
    }
    Ok(staged)
}

/// Put a staged file in place, keeping the replaced file's permissions and,
/// where the server allows it, its owner.
pub(super) fn commit_upload(
    session: &Session,
    sftp: &Sftp,
    staged: &str,
    target: &RemoteTarget,
) -> Result<(), Stop> {
    if let Err(error) = keep_attributes(sftp, staged, target) {
        limit_tidying(session);
        discard_upload(sftp, staged);
        return Err(Stop::Failed(error));
    }
    let calls = SessionCalls { session, sftp };
    with_finish_limit(session, || place_staged(&calls, staged, &target.path)).map_err(Stop::Failed)
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

/// The real calls. A rename the link stopped is followed by more calls to undo it.
struct SessionCalls<'a> {
    session: &'a Session,
    sftp: &'a Sftp,
}

impl ReplaceCalls for SessionCalls<'_> {
    fn rename(&self, from: &str, to: &str) -> Result<(), ssh2::Error> {
        let renamed = self.sftp.rename(Path::new(from), Path::new(to), None);
        if renamed.is_err() {
            limit_tidying(self.session);
        }
        renamed
    }

    fn exists(&self, path: &str) -> Result<bool, ssh2::Error> {
        missing_or(self.sftp.lstat(Path::new(path))).map(|stat| stat.is_some())
    }

    fn unlink(&self, path: &str) -> Result<(), ssh2::Error> {
        self.sftp.unlink(Path::new(path))
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

fn run_download(
    session: &Session,
    sftp: &Sftp,
    input: &TransferInput,
    run: &mut Run<'_>,
) -> Result<String, Stop> {
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

    download_plan(session, sftp, &input.source, &plan, &target, run)?;
    Ok(target_text)
}

fn download_plan(
    session: &Session,
    sftp: &Sftp,
    source: &str,
    plan: &Plan,
    target: &Path,
    run: &mut Run<'_>,
) -> Result<(), Stop> {
    carry_out(
        run,
        plan,
        |rel, mode| {
            let path = local_under(target, rel);
            let created = ensure_local_dir(&path, mode)?;
            Ok((path, created))
        },
        |run, rel, mode| {
            let remote_path = remote_under(source, rel);
            let mut remote = sftp
                .open(Path::new(&remote_path))
                .map_err(|e| call_error("Could not read", &remote_path, &e))?;
            let destination = local_target(&local_under(target, rel))?;
            let written = write_partial(&destination, mode, |file| {
                copy_stream(&mut remote, file, &mut |n| run.on_chunk(n))
            });
            // Closing `remote` is the tidying here.
            if written.is_err() {
                limit_tidying(session);
            }
            written
        },
        |path, source| seal_local_dir(path, source),
    )
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
pub(crate) fn local_target(path: &Path) -> Result<PathBuf, String> {
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
pub(crate) fn write_partial<F>(target: &Path, mode: Option<u32>, fill: F) -> Result<(), Stop>
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
    fn thousands_waiting_start_no_more_workers_than_the_limit() {
        let mut queue = WorkQueue::new();
        let workers = (0..2_000).filter(|item| queue.push(*item)).count();
        assert_eq!(workers, MAX_ACTIVE);
        assert_eq!(queue.waiting.len(), 2_000);

        assert_eq!(queue.next(), Some(0), "oldest first");
        assert_eq!(queue.take(|item| *item == 7), Some(7));
        assert_eq!(queue.take(|item| *item == 7), None);
        assert_eq!(queue.workers, MAX_ACTIVE, "a busy worker stays counted");

        while queue.next().is_some() {}
        assert_eq!(queue.workers, MAX_ACTIVE - 1, "one worker has ended");
        for _ in 1..MAX_ACTIVE {
            assert_eq!(queue.next(), None);
        }
        assert_eq!(queue.workers, 0);
        assert!(queue.push(1), "with no workers left, a new one starts");
    }

    /// A saved connection to a server that accepts (into the backlog) but
    /// never speaks SSH. The listener must outlive the test's transfers.
    fn silent_connection() -> (std::net::TcpListener, String) {
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
        (silent, connection_id)
    }

    #[test]
    fn waiting_transfers_hold_no_worker_and_cancel_at_once() {
        crate::storage::test_support::with_isolated_data_dir(|| {
            let (_silent, connection_id) = silent_connection();
            let (emit, events) = collector();
            let tmp = TempDir::new("waiting");
            let count = MAX_ACTIVE + 40;
            let ids: Vec<String> = (0..count)
                .map(|i| {
                    start_transfer(
                        TransferInput {
                            connection_id: connection_id.clone(),
                            direction: TransferDirection::Download,
                            source: format!("/some/file{}", i),
                            target_dir: tmp.0.to_str().unwrap().into(),
                            overwrite: false,
                        },
                        emit.clone(),
                    )
                    .unwrap()
                })
                .collect();
            {
                let queue = lock_queue();
                assert!(queue.workers <= MAX_ACTIVE, "{} workers", queue.workers);
                assert!(queue.waiting.len() >= 40, "{}", queue.waiting.len());
            }

            let newest = ids.last().unwrap().clone();
            sftp_cancel_transfer(newest.clone());
            assert_eq!(
                events.lock().unwrap().last(),
                Some(&TransferEvent::Cancelled { id: newest }),
                "a waiting transfer has nothing to wait for"
            );

            for id in &ids {
                sftp_cancel_transfer(id.clone());
            }
            let started = Instant::now();
            while events.lock().unwrap().len() < count {
                assert!(
                    started.elapsed() < Duration::from_secs(5),
                    "cancel took too long"
                );
                thread::sleep(Duration::from_millis(20));
            }
            let events = events.lock().unwrap();
            assert_eq!(events.len(), count, "one end each: {:?}", events);
            assert!(events
                .iter()
                .all(|event| matches!(event, TransferEvent::Cancelled { .. })));
            assert!(lock_queue().waiting.is_empty());
        });
    }

    #[test]
    fn a_cancel_while_connecting_ends_at_once() {
        crate::storage::test_support::with_isolated_data_dir(|| {
            let (_silent, connection_id) = silent_connection();
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
                bind_address: None,
                local_port: 8080,
                destination_host: "db".into(),
                destination_port: 5432,
            });
            let (emit, events) = collector();
            let err = start_transfer(
                TransferInput {
                    connection_id,
                    direction: TransferDirection::Upload,
                    source: std::env::temp_dir().to_string_lossy().into_owned(),
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
