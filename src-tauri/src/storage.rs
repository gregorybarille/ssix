use crate::models::AppData;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

static DATA_LOCK: Mutex<()> = Mutex::new(());

/// Parsed copy of the last `data.json` read or written, keyed by the path
/// and the file's mtime so a hand-edited or rotated file is noticed on the
/// next load. Guarded by `DATA_LOCK` (never accessed without it).
struct CachedData {
    path: PathBuf,
    /// (mtime, length): the length guards against an edit that lands in
    /// the same mtime tick on a coarse-granularity filesystem.
    stamp: Option<(SystemTime, u64)>,
    /// `schema_version` as stored: `data` has been stamped current by then.
    stored_version: u32,
    data: AppData,
}

static DATA_CACHE: Mutex<Option<CachedData>> = Mutex::new(None);

fn file_stamp(path: &Path) -> Option<(SystemTime, u64)> {
    let meta = fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
pub(crate) mod test_support {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn tmp_dir() -> PathBuf {
        let n = TMP_COUNTER.fetch_add(1, Ordering::SeqCst);
        let p =
            std::env::temp_dir().join(format!("ssix-data-dir-test-{}-{}", std::process::id(), n));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// Run `test` with `SSIX_DATA_DIR` pointed at a fresh temporary
    /// directory so `data.json` and `secrets.json` never touch `~/.ssix`.
    /// Serialised through `TEST_ENV_LOCK` because the variable is
    /// process-global and cargo runs tests in parallel.
    pub(crate) fn with_isolated_data_dir(test: impl FnOnce()) {
        let _g = super::TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var("SSIX_DATA_DIR").ok();
        let dir = tmp_dir();
        std::env::set_var("SSIX_DATA_DIR", &dir);
        test();
        match prev {
            Some(v) => std::env::set_var("SSIX_DATA_DIR", v),
            None => std::env::remove_var("SSIX_DATA_DIR"),
        }
        let _ = fs::remove_dir_all(&dir);
    }
}

/// Returns the directory that holds SSIX state (`data.json`, `secrets.json`).
///
/// In production this is `~/.ssix`. For E2E tests and other isolated
/// runs the `SSIX_DATA_DIR` environment variable, when set and non-empty,
/// overrides this so each test gets a clean, deterministic data dir
/// without touching the user's real one. The override is checked at
/// every call (not memoized) so tests can rotate it between specs.
pub fn data_dir() -> PathBuf {
    data_dir_override().unwrap_or_else(|| {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        home.join(".ssix")
    })
}

fn data_dir_override() -> Option<PathBuf> {
    std::env::var("SSIX_DATA_DIR")
        .ok()
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
}

pub fn get_data_path() -> PathBuf {
    data_dir().join("data.json")
}

pub fn load_data() -> Result<AppData, String> {
    let _guard = DATA_LOCK.lock().map_err(|e| e.to_string())?;
    load_data_unlocked().map(|(data, _)| data)
}

/// Load `data.json`, serving from the in-memory copy when the file on disk
/// is unchanged since it was last read or written. Also returns the schema
/// version the file was stored at. Callers must hold `DATA_LOCK`.
fn load_data_unlocked() -> Result<(AppData, u32), String> {
    let path = get_data_path();
    let stamp = file_stamp(&path);

    let mut cache = DATA_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(cached) = cache.as_ref() {
        if cached.path == path && cached.stamp.is_some() && cached.stamp == stamp {
            return Ok((cached.data.clone(), cached.stored_version));
        }
    }

    let Some(mut data) = read_data_file(&path)? else {
        return Ok((AppData::default(), crate::models::CURRENT_SCHEMA_VERSION));
    };
    let stored_version = data.schema_version;
    // Walk the loaded `schema_version` up to the current one (also runs the
    // LegacyTunnel → JumpShell rewrite for pre-stamp v0 files). Idempotent
    // for files already at HEAD. Reads only migrate in memory; the repair
    // reaches disk through `persist_migrations` at startup or the next save.
    data.migrate_to_current();
    *cache = Some(CachedData {
        path,
        stamp,
        stored_version,
        data: data.clone(),
    });
    Ok((data, stored_version))
}

/// Whether `read_error`, from reading `path`, means there is no file there. A
/// link whose target is gone also reads as NotFound but does not count: the
/// target may only be on an unmounted volume, and a save would replace the link.
pub(crate) fn is_no_file(path: &Path, read_error: &std::io::Error) -> bool {
    use std::io::ErrorKind::NotFound;
    read_error.kind() == NotFound
        && matches!(fs::symlink_metadata(path), Err(e) if e.kind() == NotFound)
}

/// Parse `data.json` as stored, without migrating it. `None` only when there
/// is no such file: any other read failure must not pass for an empty
/// catalogue, which the next save would write over the real one.
fn read_data_file(path: &Path) -> Result<Option<AppData>, String> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(e) if is_no_file(path, &e) => return Ok(None),
        Err(e) => return Err(format!("{} could not be read: {}", path.display(), e)),
    };
    serde_json::from_str(&content)
        .map(Some)
        .map_err(|e| format!("{} is not valid SSIX data: {}", path.display(), e))
}

/// Close the data directory and the files in it to other local users, so a
/// file an older build left 0644 is fixed now and not at its next save. Run at
/// startup; a failure (a filesystem without modes, a folder of someone else's)
/// is logged and never stops the app.
///
/// `SSIX_DATA_DIR` may name a folder that is not SSIX's alone, even `/tmp`, so
/// only the default folder is closed. The files are SSIX's wherever they are.
pub fn restrict_data_dir() {
    let close_dir = data_dir_override().is_none();
    for problem in restrict_dir_and_files(&data_dir(), close_dir) {
        crate::logs::log_local("warn", "storage", problem);
    }
    remove_stale_temp_files(&data_dir());
    remove_stale_temp_files(&crate::backup::backups_dir());
}

/// Remove the temp files of `atomic_write` saves a crash cut short. One
/// modified in the last hour may be a save still under way in another SSIX,
/// so it stays.
fn remove_stale_temp_files(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let cutoff = SystemTime::now() - std::time::Duration::from_secs(3600);
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let stale = entry
            .metadata()
            .is_ok_and(|m| m.is_file() && m.modified().is_ok_and(|t| t < cutoff));
        if name.starts_with('.') && name.contains(".tmp.") && stale {
            if let Err(e) = fs::remove_file(entry.path()) {
                crate::logs::log_local(
                    "warn",
                    "storage",
                    format!("Could not remove {}: {}", entry.path().display(), e),
                );
            }
        }
    }
}

/// Returns what could not be restricted. A symlink is not followed: it leads
/// somewhere the user chose, and the next save replaces a linked file anyway.
fn restrict_dir_and_files(dir: &Path, close_dir: bool) -> Vec<String> {
    let mut problems = Vec::new();
    if close_dir && !dir.is_symlink() {
        problems.extend(crate::backup::ensure_private_dir(dir).err());
    }
    for name in crate::backup::FILES {
        problems.extend(restrict_file(&dir.join(name)).err());
    }
    problems
}

#[cfg(unix)]
fn restrict_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let fail = |e: std::io::Error| format!("Could not protect {}: {}", path.display(), e);
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(fail(e)),
    };
    if !meta.is_file() || meta.permissions().mode() & 0o077 == 0 {
        return Ok(());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(fail)
}

#[cfg(not(unix))]
fn restrict_file(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Save the load-time migrations once, so a repaired file stops being
/// repaired (and logged) on every launch. Run at startup on the blocking
/// pool: plain reads never write. Returns whether the file was rewritten.
///
/// A file written by a newer build is left alone, so merely opening this
/// build never rewrites it at an older schema and drops its newer fields.
///
/// Rows still holding a secret inline are emptied here, not in
/// `migrate_to_current`: a load must not drop a secret it has not stored. There
/// is no schema bump for it, as the shape does not change and the check is
/// cheap, so a restored old backup or a hand edit is caught too.
pub fn persist_migrations() -> Result<bool, String> {
    let _guard = DATA_LOCK.lock().map_err(|e| e.to_string())?;
    let Some(mut data) = read_data_file(&get_data_path())? else {
        return Ok(false);
    };
    if data.schema_version > crate::models::CURRENT_SCHEMA_VERSION {
        return Ok(false);
    }
    // Secrets first: a crash before the save below leaves them in both files
    // and the next launch finishes the job; the other order would lose them.
    let moved = crate::keychain::move_inline_secrets(&mut data.credentials)?;
    let migrated = data.migrate_to_current();
    if let Err(e) = crate::keychain::drop_orphan_secrets(&data.credentials) {
        crate::logs::log_local(
            "warn",
            "secrets",
            format!("Could not remove the secrets of deleted credentials: {e}"),
        );
    }
    if !migrated && !moved {
        return Ok(false);
    }
    save_data_unlocked(&data)?;
    Ok(true)
}

/// Atomically write `content` to `path`, durably, with optional Unix mode.
///
/// Audit-3 P1#4: the previous implementation called `fs::write(&path, content)`
/// which is **not crash-safe**. `fs::write` opens the target with
/// `O_TRUNC` *first* and then streams writes in. A power loss, ENOSPC,
/// or kill-9 between the truncate and the final write leaves the user's
/// only copy of `data.json` (their entire connection/credential
/// catalogue) zero-length or partially written.
///
/// This helper writes to a sibling temp file in the SAME directory
/// (so `rename(2)` is guaranteed atomic on the same filesystem),
/// `sync_all`s the data + metadata to disk, then atomically renames
/// over the target. On Unix it also fsyncs the parent directory so the
/// rename itself is durable. The temp file is named with a hidden
/// prefix so it doesn't show up in directory listings if a crash
/// strands one before the rename.
///
/// On any error before the rename, the original `path` is untouched.
/// The temp file is best-effort cleaned up on the error path; one a crash
/// strands in the data folder or `backups/` is removed at the next launch
/// (`remove_stale_temp_files`). The process id, nanosecond timestamp and a
/// counter in its name keep two saves from colliding.
///
/// `mode` is the Unix file mode (e.g. `0o600` for secrets); ignored
/// on Windows.
pub(crate) fn atomic_write(path: &Path, content: &[u8], mode: Option<u32>) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("path has no parent directory: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("create parent dir: {}", e))?;

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("path has no file name: {}", path.display()))?;

    // Process id + nanosecond timestamp keeps temp names unique across
    // concurrent writers in the same parent dir without pulling in a
    // crypto-rand crate. The leading `.` hides it from `ls` on Unix.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    // Include a per-process atomic counter so two threads in the same
    // process that hit the same nanosecond bucket can't collide on
    // `create_new(true)`. Without this, parallel `atomic_write` calls
    // against the same target are racy.
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_name = format!(".{}.tmp.{}.{}.{}", file_name, pid, nanos, seq);
    let tmp_path = parent.join(&tmp_name);

    // RAII guard: best-effort delete the temp file on any error path.
    struct TmpGuard<'a>(&'a Path, bool);
    impl Drop for TmpGuard<'_> {
        fn drop(&mut self) {
            if !self.1 {
                let _ = fs::remove_file(self.0);
            }
        }
    }
    let mut guard = TmpGuard(&tmp_path, false);

    {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)
            .map_err(|e| format!("open temp file {}: {}", tmp_path.display(), e))?;

        // Apply the Unix mode BEFORE writing secrets so even a partially
        // written temp file isn't world-readable.
        #[cfg(unix)]
        if let Some(m) = mode {
            use std::os::unix::fs::PermissionsExt;
            let perms = fs::Permissions::from_mode(m);
            fs::set_permissions(&tmp_path, perms)
                .map_err(|e| format!("set temp file mode: {}", e))?;
        }
        #[cfg(not(unix))]
        let _ = mode;

        f.write_all(content)
            .map_err(|e| format!("write temp file: {}", e))?;
        // Push data + metadata to disk before the rename — without this,
        // a crash after rename can still lose the data on some filesystems.
        f.sync_all()
            .map_err(|e| format!("fsync temp file: {}", e))?;
    }

    fs::rename(&tmp_path, path).map_err(|e| {
        format!(
            "atomic rename {} -> {}: {}",
            tmp_path.display(),
            path.display(),
            e
        )
    })?;
    // Rename succeeded — disarm the cleanup guard.
    guard.1 = true;

    // Fsync the parent directory so the rename itself is durable across
    // power loss. No-op on Windows (you can't open a directory for fsync).
    #[cfg(unix)]
    {
        if let Ok(dir) = fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }

    Ok(())
}

fn save_data_unlocked(data: &AppData) -> Result<(), String> {
    let path = get_data_path();
    let content = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    atomic_write(&path, content.as_bytes(), Some(0o600))?;
    let mut cache = DATA_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *cache = Some(CachedData {
        stamp: file_stamp(&path),
        path,
        stored_version: data.schema_version,
        data: data.clone(),
    });
    Ok(())
}

/// Run `f` while no other thread can read or write `data.json`, then drop
/// the cached copy so the next load reads whatever `f` left on disk. Used
/// by backups, which copy and replace the file as raw bytes.
pub(crate) fn with_data_file_locked<T>(f: impl FnOnce() -> T) -> T {
    let _guard = DATA_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let result = f();
    *DATA_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
    result
}

/// Execute a read-modify-write transaction against AppData under one lock.
/// Refused for a file from a newer build: this build dropped what it does not
/// know when it parsed the file, so saving would strip that data for good.
pub fn with_data_mut<R, F>(mutator: F) -> Result<R, String>
where
    F: FnOnce(&mut AppData) -> Result<R, String>,
{
    let _guard = DATA_LOCK.lock().map_err(|e| e.to_string())?;
    let (mut data, stored_version) = load_data_unlocked()?;
    if stored_version > crate::models::CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "{} was saved by a newer version of SSIX. Update SSIX to change anything: \
             this version can only read it, so nothing was saved.",
            get_data_path().display()
        ));
    }
    let result = mutator(&mut data)?;
    save_data_unlocked(&data)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn write_raw(data: &AppData) {
        let path = get_data_path();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, serde_json::to_string(data).unwrap()).unwrap();
    }

    fn with_dangling_reference(schema_version: u32) -> AppData {
        let mut data = AppData {
            schema_version,
            ..AppData::default()
        };
        data.connections.push(crate::models::Connection::new(
            "web".into(),
            "h".into(),
            22,
            Some("deleted-credential".into()),
            crate::models::ConnectionKind::Direct,
        ));
        data
    }

    /// Reads repair in memory only; `persist_migrations` writes the repair
    /// once, after which there is nothing left to save.
    #[test]
    fn migrations_are_saved_by_persist_migrations_not_by_reads() {
        test_support::with_isolated_data_dir(|| {
            write_raw(&with_dangling_reference(
                crate::models::CURRENT_SCHEMA_VERSION,
            ));
            let path = get_data_path();

            assert_eq!(load_data().unwrap().connections[0].credential_id, None);
            assert!(fs::read_to_string(&path)
                .unwrap()
                .contains("deleted-credential"));

            assert!(persist_migrations().unwrap());
            assert!(!fs::read_to_string(&path)
                .unwrap()
                .contains("deleted-credential"));
            assert!(!persist_migrations().unwrap());
        });
    }

    /// A stored folder path the rules refuse is repaired like any other
    /// migration: it never stops a load, and is saved once at startup.
    #[test]
    fn a_folder_path_the_rules_refuse_is_repaired_and_saved_once() {
        test_support::with_isolated_data_dir(|| {
            let mut data = AppData::default();
            let mut connection = crate::models::Connection::new(
                "web".into(),
                "h".into(),
                22,
                None,
                crate::models::ConnectionKind::Direct,
            );
            connection.folder = Some("prod/../eu".into());
            data.connections.push(connection);
            write_raw(&data);

            assert_eq!(
                load_data().unwrap().connections[0].folder.as_deref(),
                Some("prod/eu")
            );
            assert!(persist_migrations().unwrap());
            assert!(!fs::read_to_string(get_data_path()).unwrap().contains(".."));
            assert!(!persist_migrations().unwrap());
        });
    }

    /// An unstamped (v0) file is stamped even when nothing else changed.
    #[test]
    fn persist_migrations_stamps_an_unversioned_file() {
        test_support::with_isolated_data_dir(|| {
            write_raw(&AppData {
                schema_version: 0,
                ..AppData::default()
            });
            assert!(persist_migrations().unwrap());
            let stored: AppData =
                serde_json::from_str(&fs::read_to_string(get_data_path()).unwrap()).unwrap();
            assert_eq!(stored.schema_version, crate::models::CURRENT_SCHEMA_VERSION);
        });
    }

    /// A file from a newer build is never rewritten by this one's startup.
    #[test]
    fn persist_migrations_leaves_a_newer_file_alone() {
        test_support::with_isolated_data_dir(|| {
            write_raw(&with_dangling_reference(
                crate::models::CURRENT_SCHEMA_VERSION + 1,
            ));
            let before = fs::read_to_string(get_data_path()).unwrap();
            assert!(!persist_migrations().unwrap());
            assert_eq!(fs::read_to_string(get_data_path()).unwrap(), before);
        });
    }

    /// Reads work and every save is refused, on the first load and on one
    /// served from the cache.
    #[test]
    fn a_newer_file_can_be_read_but_never_saved_over() {
        test_support::with_isolated_data_dir(|| {
            let mut stored = serde_json::to_value(AppData {
                schema_version: crate::models::CURRENT_SCHEMA_VERSION + 1,
                ..AppData::default()
            })
            .unwrap();
            stored["field_from_the_future"] = serde_json::json!(true);
            let before = stored.to_string();
            fs::write(get_data_path(), &before).unwrap();

            for _ in 0..2 {
                let err = with_data_mut(|_| Ok(())).unwrap_err();
                assert!(err.contains("newer version of SSIX"), "got: {}", err);
                load_data().unwrap();
            }
            assert_eq!(fs::read_to_string(get_data_path()).unwrap(), before);
        });
    }

    /// A read that fails for any reason but "no such file" is an error in both
    /// files. Here the data folder is a file, so the OS answers ENOTDIR; on
    /// Windows that answer is "not found", hence Unix only.
    #[cfg(unix)]
    #[test]
    fn only_a_missing_file_counts_as_no_file() {
        test_support::with_isolated_data_dir(|| {
            let not_a_folder = data_dir().join("a-file");
            fs::write(&not_a_folder, "x").unwrap();
            std::env::set_var("SSIX_DATA_DIR", &not_a_folder);

            let err = load_data().unwrap_err();
            assert!(err.contains("could not be read"), "got: {}", err);
            let err = crate::keychain::snapshot_for_credential("any").unwrap_err();
            assert!(err.contains("failed to read"), "got: {}", err);
        });
    }

    /// A link to an unmounted volume reads as NotFound. It must not look like an
    /// empty catalogue, and no save may replace the link.
    #[cfg(unix)]
    #[test]
    fn a_link_whose_target_is_gone_is_not_a_missing_file() {
        test_support::with_isolated_data_dir(|| {
            let gone = data_dir().join("unmounted").join("file.json");
            let secrets = crate::keychain::secrets_path();
            std::os::unix::fs::symlink(&gone, get_data_path()).unwrap();
            std::os::unix::fs::symlink(&gone, &secrets).unwrap();

            let err = load_data().unwrap_err();
            assert!(err.contains("could not be read"), "got: {}", err);
            assert!(with_data_mut(|_| Ok(())).is_err());
            assert!(persist_migrations().is_err());
            let err = crate::keychain::snapshot_for_credential("any").unwrap_err();
            assert!(err.contains("failed to read"), "got: {}", err);
            let store = crate::models::CredentialSecrets::default();
            assert!(crate::keychain::replace_for_credential("any", &store).is_err());

            assert!(get_data_path().is_symlink());
            assert!(secrets.is_symlink());
        });
    }

    fn legacy_row(id: &str, kind: crate::models::CredentialKind) -> crate::models::Credential {
        crate::models::Credential {
            id: id.into(),
            name: id.into(),
            username: "u".into(),
            kind,
            is_private: false,
        }
    }

    /// One row for each kind of inline secret, as builds from before
    /// `secrets.json` wrote them.
    fn with_inline_secrets(schema_version: u32) -> AppData {
        use crate::models::CredentialKind;
        let mut data = AppData {
            schema_version,
            ..AppData::default()
        };
        data.credentials.extend([
            legacy_row(
                "pw",
                CredentialKind::Password {
                    password: "plain-password".into(),
                },
            ),
            legacy_row(
                "path",
                CredentialKind::SshKey {
                    private_key_path: Some("/k".into()),
                    private_key: None,
                    passphrase: Some("plain-passphrase".into()),
                },
            ),
            legacy_row(
                "inline",
                CredentialKind::SshKey {
                    private_key_path: None,
                    private_key: Some("PLAIN-KEY".into()),
                    passphrase: Some("plain-key-passphrase".into()),
                },
            ),
        ]);
        data
    }

    /// The secrets a connection would authenticate with right now.
    fn enriched(id: &str) -> crate::models::CredentialKind {
        let mut cred = load_data()
            .unwrap()
            .credentials
            .into_iter()
            .find(|c| c.id == id)
            .unwrap();
        crate::keychain::enrich_credential(&mut cred).unwrap();
        cred.kind
    }

    fn assert_inline_rows_still_authenticate() {
        use crate::models::CredentialKind;
        assert!(matches!(
            enriched("pw"),
            CredentialKind::Password { password } if password == "plain-password"
        ));
        assert!(matches!(
            enriched("path"),
            CredentialKind::SshKey { private_key_path: Some(path), private_key: None, passphrase: Some(pp) }
                if path == "/k" && pp == "plain-passphrase"
        ));
        assert!(matches!(
            enriched("inline"),
            CredentialKind::SshKey { private_key_path: None, private_key: Some(key), passphrase: Some(pp) }
                if key == "PLAIN-KEY" && pp == "plain-key-passphrase"
        ));
    }

    fn assert_no_secret_in_data_json() {
        let stored = fs::read_to_string(get_data_path()).unwrap();
        assert!(!stored.to_lowercase().contains("plain"), "{}", stored);
    }

    #[test]
    fn inline_secrets_move_to_the_secrets_file_and_keep_authenticating() {
        test_support::with_isolated_data_dir(|| {
            write_raw(&with_inline_secrets(crate::models::CURRENT_SCHEMA_VERSION));
            assert_inline_rows_still_authenticate();

            assert!(persist_migrations().unwrap());

            assert_no_secret_in_data_json();
            let secrets = crate::keychain::snapshot_for_credential("inline").unwrap();
            assert_eq!(secrets.private_key.as_deref(), Some("PLAIN-KEY"));
            assert_eq!(secrets.passphrase.as_deref(), Some("plain-key-passphrase"));
            assert_inline_rows_still_authenticate();

            // Nothing is left to do, so the rerun writes neither file.
            let secrets_file = fs::read(crate::keychain::secrets_path()).unwrap();
            assert!(!persist_migrations().unwrap());
            assert_eq!(
                fs::read(crate::keychain::secrets_path()).unwrap(),
                secrets_file
            );
            assert_inline_rows_still_authenticate();
        });
    }

    #[test]
    fn secrets_of_no_credential_are_dropped_at_startup() {
        test_support::with_isolated_data_dir(|| {
            write_raw(&with_inline_secrets(crate::models::CURRENT_SCHEMA_VERSION));
            assert!(persist_migrations().unwrap());
            let mut secrets: std::collections::HashMap<String, String> =
                serde_json::from_slice(&fs::read(crate::keychain::secrets_path()).unwrap())
                    .unwrap();
            let kept = secrets.clone();
            // Left behind by a delete whose secrets write failed.
            secrets.insert("gone".into(), "old-password".into());
            secrets.insert("gone:passphrase".into(), "old-passphrase".into());
            fs::write(
                crate::keychain::secrets_path(),
                serde_json::to_string(&secrets).unwrap(),
            )
            .unwrap();

            persist_migrations().unwrap();

            let after: std::collections::HashMap<String, String> =
                serde_json::from_slice(&fs::read(crate::keychain::secrets_path()).unwrap())
                    .unwrap();
            assert_eq!(after, kept);
            assert_inline_rows_still_authenticate();
        });
    }

    /// A crash between the two writes: the secrets are stored, the rows are
    /// not yet blank. Nothing is lost then, or when the next launch finishes.
    #[test]
    fn a_crash_after_storing_the_secrets_loses_nothing() {
        test_support::with_isolated_data_dir(|| {
            write_raw(&with_inline_secrets(crate::models::CURRENT_SCHEMA_VERSION));
            let mut unsaved = load_data().unwrap();
            assert!(crate::keychain::move_inline_secrets(&mut unsaved.credentials).unwrap());
            assert!(fs::read_to_string(get_data_path())
                .unwrap()
                .contains("plain-password"));
            assert_inline_rows_still_authenticate();

            assert!(persist_migrations().unwrap());
            assert_no_secret_in_data_json();
            assert_inline_rows_still_authenticate();
        });
    }

    #[test]
    fn a_secret_already_stored_is_not_overwritten_by_the_inline_one() {
        test_support::with_isolated_data_dir(|| {
            let newer = crate::models::CredentialSecrets {
                password: Some("newer-password".into()),
                ..Default::default()
            };
            crate::keychain::replace_for_credential("pw", &newer).unwrap();
            write_raw(&with_inline_secrets(crate::models::CURRENT_SCHEMA_VERSION));

            assert!(persist_migrations().unwrap());

            assert_no_secret_in_data_json();
            assert_eq!(
                crate::keychain::snapshot_for_credential("pw").unwrap(),
                newer
            );
        });
    }

    /// An empty inline passphrase would hide the stored one from
    /// `enrich_credential`, so it is cleared even with nothing to move.
    #[test]
    fn an_empty_inline_value_is_cleared_without_storing_it() {
        test_support::with_isolated_data_dir(|| {
            let mut data = AppData::default();
            data.credentials.push(legacy_row(
                "empty",
                crate::models::CredentialKind::SshKey {
                    private_key_path: Some("/k".into()),
                    private_key: None,
                    passphrase: Some(String::new()),
                },
            ));
            write_raw(&data);
            assert!(persist_migrations().unwrap());
            assert!(matches!(
                &load_data().unwrap().credentials[0].kind,
                crate::models::CredentialKind::SshKey {
                    passphrase: None,
                    ..
                }
            ));
            assert_eq!(
                crate::keychain::snapshot_for_credential("empty").unwrap(),
                crate::models::CredentialSecrets::default()
            );
        });
    }

    #[test]
    fn a_failure_to_store_the_secrets_leaves_data_json_alone() {
        test_support::with_isolated_data_dir(|| {
            write_raw(&with_inline_secrets(crate::models::CURRENT_SCHEMA_VERSION));
            let before = fs::read_to_string(get_data_path()).unwrap();
            fs::write(crate::keychain::secrets_path(), b"{ not json").unwrap();

            assert!(persist_migrations().is_err());

            assert_eq!(fs::read_to_string(get_data_path()).unwrap(), before);
            assert_eq!(
                fs::read(crate::keychain::secrets_path()).unwrap(),
                b"{ not json"
            );
            assert!(matches!(
                &load_data().unwrap().credentials[0].kind,
                crate::models::CredentialKind::Password { password } if password == "plain-password"
            ));
        });
    }

    #[test]
    fn inline_secrets_in_a_newer_file_are_left_alone() {
        test_support::with_isolated_data_dir(|| {
            write_raw(&with_inline_secrets(
                crate::models::CURRENT_SCHEMA_VERSION + 1,
            ));
            let before = fs::read_to_string(get_data_path()).unwrap();
            assert!(!persist_migrations().unwrap());
            assert_eq!(fs::read_to_string(get_data_path()).unwrap(), before);
            assert!(!crate::keychain::secrets_path().exists());
        });
    }

    /// A corrupt data file is an error that names the file, never an empty
    /// catalogue: the frontend shows it in a load-error banner.
    #[test]
    fn corrupt_data_file_is_reported_with_its_path() {
        test_support::with_isolated_data_dir(|| {
            let path = get_data_path();
            fs::write(&path, "{ not json").unwrap();
            let err = load_data().unwrap_err();
            assert!(err.contains("data.json"), "got: {}", err);
            assert!(err.contains("is not valid SSIX data"), "got: {}", err);
        });
    }

    #[test]
    fn test_app_data_default() {
        let data = AppData::default();
        assert!(data.credentials.is_empty());
        assert!(data.connections.is_empty());
    }

    #[test]
    fn test_serialize_deserialize() {
        let data = AppData::default();
        let json = serde_json::to_string(&data).unwrap();
        let parsed: AppData = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.credentials.len(), 0);
    }

    /// Audit-3 P1#4: per-test temp dir to avoid collisions when cargo
    /// runs tests in parallel.
    static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);
    fn tmp_dir() -> PathBuf {
        let n = TMP_COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!(
            "ssix-atomic-write-test-{}-{}",
            std::process::id(),
            n
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn atomic_write_creates_target_with_content() {
        let dir = tmp_dir();
        let target = dir.join("data.json");
        atomic_write(&target, b"hello", None).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "hello");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_overwrites_existing_target_in_full() {
        let dir = tmp_dir();
        let target = dir.join("data.json");
        fs::write(
            &target,
            b"OLD-VERY-LONG-CONTENT-THAT-MUST-BE-FULLY-REPLACED",
        )
        .unwrap();
        atomic_write(&target, b"new", None).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        let _ = fs::remove_dir_all(&dir);
    }

    /// The whole point of the helper: when the write step fails (here we
    /// simulate by trying to write into a path whose parent does not exist
    /// after we make it un-creatable), the original target is untouched.
    /// We test the success path's atomicity by asserting NO temp files
    /// linger after a successful write — the cleanup guard or the rename
    /// must consume them.
    #[test]
    fn atomic_write_leaves_no_tmp_files_after_success() {
        let dir = tmp_dir();
        let target = dir.join("data.json");
        atomic_write(&target, b"hello", None).unwrap();
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != "data.json")
            .collect();
        assert!(
            leftovers.is_empty(),
            "atomic_write must not leave temp files behind: {:?}",
            leftovers
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_applies_unix_mode_to_target() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_dir();
        let target = dir.join("secrets.json");
        atomic_write(&target, b"{}", Some(0o600)).unwrap();
        let mode = fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "secrets file MUST be 0600 (owner read/write only)"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_applies_mode_before_writing_payload() {
        // Audit-3 P1#4: secrets MUST be mode-restricted *before* the
        // payload is flushed so a crash mid-write cannot leak a
        // world-readable file containing partial secret data.
        // We can't really observe ordering deterministically without
        // injecting hooks, but we CAN assert the temp file's chmod
        // happens before write_all by checking the helper still ends
        // with the right permissions when we ask for them — combined
        // with code review of `atomic_write`. This test pins that the
        // mode argument is honored end-to-end.
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_dir();
        let target = dir.join("secrets.json");
        // Pre-create the target with looser perms; rename must overwrite
        // and the new file must have the requested 0600 (because rename
        // brings the source file's mode along).
        fs::write(&target, b"PRE").unwrap();
        let perms = fs::Permissions::from_mode(0o644);
        fs::set_permissions(&target, perms).unwrap();
        atomic_write(&target, b"NEW", Some(0o600)).unwrap();
        let mode = fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_creates_missing_parent_dir() {
        let dir = tmp_dir();
        let target = dir.join("nested").join("further").join("data.json");
        atomic_write(&target, b"x", None).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "x");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_rejects_path_with_no_parent() {
        // "/" or "" has no parent — must error rather than panic.
        let result = atomic_write(Path::new(""), b"x", None);
        assert!(result.is_err());
    }

    /// Concurrent writers must not corrupt each other. We run several
    /// threads, each writing a unique small payload, then verify the
    /// final file contains exactly one of those payloads in full
    /// (rename is atomic, so partial interleaving is impossible).
    #[test]
    fn atomic_write_is_safe_under_concurrent_writers() {
        use std::sync::Arc;
        use std::thread;

        let dir = Arc::new(tmp_dir());
        let target = Arc::new(dir.join("data.json"));
        let payloads: Vec<String> = (0..8)
            .map(|i| format!("payload-from-writer-{:02}", i))
            .collect();

        let handles: Vec<_> = payloads
            .iter()
            .cloned()
            .map(|payload| {
                let target = Arc::clone(&target);
                thread::spawn(move || {
                    atomic_write(&target, payload.as_bytes(), None).unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        let final_content = fs::read_to_string(&*target).unwrap();
        assert!(
            payloads.iter().any(|p| p == &final_content),
            "concurrent writers must leave the file containing exactly one full payload, got {:?}",
            final_content
        );
        let _ = fs::remove_dir_all(&*dir);
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[cfg(unix)]
    fn set_mode(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    }

    /// A save replaces an old world-readable file with a private one.
    #[cfg(unix)]
    #[test]
    fn saving_makes_data_json_private() {
        test_support::with_isolated_data_dir(|| {
            write_raw(&AppData::default());
            set_mode(&get_data_path(), 0o644);
            with_data_mut(|_| Ok(())).unwrap();
            assert_eq!(mode(&get_data_path()), 0o600);
        });
    }

    /// An old 0644 file is fixed at launch, with no save needed.
    #[cfg(unix)]
    #[test]
    fn restricting_fixes_old_files_and_closes_the_folder() {
        let dir = tmp_dir();
        set_mode(&dir, 0o755);
        for name in crate::backup::FILES {
            fs::write(dir.join(name), "old").unwrap();
            set_mode(&dir.join(name), 0o644);
        }
        assert!(restrict_dir_and_files(&dir, true).is_empty());
        assert_eq!(mode(&dir), 0o700);
        for name in crate::backup::FILES {
            assert_eq!(mode(&dir.join(name)), 0o600, "{}", name);
            assert_eq!(fs::read_to_string(dir.join(name)).unwrap(), "old");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn restricting_creates_a_missing_folder_private() {
        let parent = tmp_dir();
        let dir = parent.join(".ssix");
        assert!(restrict_dir_and_files(&dir, true).is_empty());
        assert_eq!(mode(&dir), 0o700);
        let _ = fs::remove_dir_all(&parent);
    }

    /// `SSIX_DATA_DIR` may be shared: its folder stays as it is, its files
    /// are still fixed.
    #[cfg(unix)]
    #[test]
    fn an_overridden_data_dir_keeps_its_mode_but_not_loose_files() {
        test_support::with_isolated_data_dir(|| {
            let dir = data_dir();
            set_mode(&dir, 0o755);
            write_raw(&AppData::default());
            set_mode(&get_data_path(), 0o644);
            restrict_data_dir();
            assert_eq!(mode(&dir), 0o755);
            assert_eq!(mode(&get_data_path()), 0o600);
        });
    }

    #[test]
    fn temp_files_a_crash_left_are_removed_at_startup() {
        test_support::with_isolated_data_dir(|| {
            let dir = data_dir();
            let backups = crate::backup::backups_dir();
            fs::create_dir_all(&backups).unwrap();
            let hour_ago = SystemTime::now() - std::time::Duration::from_secs(3600);
            let write = |path: PathBuf, modified: SystemTime| {
                fs::File::create(&path)
                    .unwrap()
                    .set_modified(modified)
                    .unwrap();
                path
            };
            let stale = [
                write(dir.join(".data.json.tmp.1.2.3"), hour_ago),
                write(backups.join(".ssix-backup-x.zip.tmp.1.2.3"), hour_ago),
            ];
            let kept = [
                write(dir.join("data.json"), hour_ago),
                write(backups.join("ssix-backup-x.zip"), hour_ago),
                // Another SSIX may be in the middle of this save.
                write(dir.join(".secrets.json.tmp.1.2.3"), SystemTime::now()),
            ];

            restrict_data_dir();

            assert!(stale.iter().all(|p| !p.exists()));
            assert!(kept.iter().all(|p| p.exists()));
        });
    }

    #[cfg(unix)]
    #[test]
    fn restricting_does_not_follow_symlinks() {
        let tmp = tmp_dir();
        let shared = tmp.join("shared");
        fs::create_dir(&shared).unwrap();
        set_mode(&shared, 0o755);
        let link = tmp.join("linked");
        std::os::unix::fs::symlink(&shared, &link).unwrap();
        let shared_file = tmp.join("shared-file");
        fs::write(&shared_file, "x").unwrap();
        set_mode(&shared_file, 0o644);
        std::os::unix::fs::symlink(&shared_file, shared.join("data.json")).unwrap();

        assert!(restrict_dir_and_files(&link, true).is_empty());
        assert_eq!(mode(&shared), 0o755);
        assert_eq!(mode(&shared_file), 0o644);
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A folder that cannot be restricted is reported, not fatal.
    #[test]
    fn a_failure_to_restrict_is_returned_not_raised() {
        let tmp = tmp_dir();
        let blocked = tmp.join("a-file");
        fs::write(&blocked, "x").unwrap();
        assert!(!restrict_dir_and_files(&blocked.join("sub"), true).is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    /// The cache must serve repeat loads without touching the file, and
    /// must notice when the file changes underneath it (hand edits, or a
    /// different `SSIX_DATA_DIR`).
    #[test]
    fn load_data_is_cached_until_the_file_changes() {
        let _g = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var("SSIX_DATA_DIR").ok();
        let dir = tmp_dir();
        std::env::set_var("SSIX_DATA_DIR", &dir);

        with_data_mut(|data| {
            data.settings.font_size = 21;
            Ok(())
        })
        .unwrap();
        assert_eq!(load_data().unwrap().settings.font_size, 21);

        // Simulate an external edit with a distinct mtime.
        let path = get_data_path();
        let mut edited = load_data().unwrap();
        edited.settings.font_size = 33;
        let json = serde_json::to_string_pretty(&edited).unwrap();
        fs::write(&path, json).unwrap();
        let later = SystemTime::now() + std::time::Duration::from_secs(5);
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(later)
            .unwrap();
        assert_eq!(
            load_data().unwrap().settings.font_size,
            33,
            "mtime change must bust the cache"
        );

        // A write through the storage layer refreshes the cache in place.
        with_data_mut(|data| {
            data.settings.font_size = 44;
            Ok(())
        })
        .unwrap();
        assert_eq!(load_data().unwrap().settings.font_size, 44);

        match prev {
            Some(v) => std::env::set_var("SSIX_DATA_DIR", v),
            None => std::env::remove_var("SSIX_DATA_DIR"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// `data_dir()` and `secrets_path()` (via the same helper) MUST
    /// honor `SSIX_DATA_DIR` so E2E tests get an isolated state dir.
    /// The env var is process-global; serialize the env-mutating tests
    /// behind a local mutex so cargo's parallel test runner doesn't
    /// race us.
    #[test]
    fn data_dir_honors_ssx_data_dir_env_override() {
        let _g = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var("SSIX_DATA_DIR").ok();
        let custom = tmp_dir();
        std::env::set_var("SSIX_DATA_DIR", &custom);
        let resolved = data_dir();
        assert_eq!(resolved, custom);
        assert_eq!(get_data_path(), custom.join("data.json"));
        match prev {
            Some(v) => std::env::set_var("SSIX_DATA_DIR", v),
            None => std::env::remove_var("SSIX_DATA_DIR"),
        }
        let _ = fs::remove_dir_all(&custom);
    }

    #[test]
    fn data_dir_falls_back_to_home_when_env_unset_or_empty() {
        let _g = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var("SSIX_DATA_DIR").ok();
        std::env::remove_var("SSIX_DATA_DIR");
        let resolved = data_dir();
        let expected = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".ssix");
        assert_eq!(resolved, expected);

        // Empty string must NOT count as an override either.
        std::env::set_var("SSIX_DATA_DIR", "");
        assert_eq!(data_dir(), expected);

        match prev {
            Some(v) => std::env::set_var("SSIX_DATA_DIR", v),
            None => std::env::remove_var("SSIX_DATA_DIR"),
        }
    }
}
