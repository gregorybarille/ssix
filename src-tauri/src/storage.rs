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
    if let Ok(override_dir) = std::env::var("SSIX_DATA_DIR") {
        if !override_dir.is_empty() {
            return PathBuf::from(override_dir);
        }
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".ssix")
}

pub fn get_data_path() -> PathBuf {
    data_dir().join("data.json")
}

pub fn load_data() -> Result<AppData, String> {
    let _guard = DATA_LOCK.lock().map_err(|e| e.to_string())?;
    load_data_unlocked()
}

/// Load `data.json`, serving from the in-memory copy when the file on disk
/// is unchanged since it was last read or written. Callers must hold
/// `DATA_LOCK`.
fn load_data_unlocked() -> Result<AppData, String> {
    let path = get_data_path();
    if !path.exists() {
        return Ok(AppData::default());
    }
    let stamp = file_stamp(&path);

    let mut cache = DATA_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(cached) = cache.as_ref() {
        if cached.path == path && cached.stamp.is_some() && cached.stamp == stamp {
            return Ok(cached.data.clone());
        }
    }

    let content = fs::read_to_string(&path)
        .map_err(|e| format!("{} could not be read: {}", path.display(), e))?;
    let mut data: AppData = serde_json::from_str(&content)
        .map_err(|e| format!("{} is not valid SSIX data: {}", path.display(), e))?;
    // Walk the loaded `schema_version` up to the current one (also runs the
    // LegacyTunnel → JumpShell rewrite for pre-stamp v0 files). Idempotent
    // for files already at HEAD.
    if data.migrate_to_current() {
        // Save the repair so it runs, and is logged, once rather than on
        // every load. The save refreshes the cache, which needs its lock.
        drop(cache);
        if let Err(e) = save_data_unlocked(&data) {
            crate::logs::log_local(
                "warn",
                "migration",
                format!("Could not save the migrated data: {e}"),
            );
        }
        return Ok(data);
    }
    *cache = Some(CachedData {
        path,
        stamp,
        data: data.clone(),
    });
    Ok(data)
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
/// The temp file is best-effort cleaned up on the error path; if the
/// process dies before that, the next successful `atomic_write` will
/// overwrite the same temp filename (per-call randomness from the
/// process id + nanosecond timestamp keeps collisions vanishingly
/// rare).
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
    atomic_write(&path, content.as_bytes(), None)?;
    let mut cache = DATA_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *cache = Some(CachedData {
        stamp: file_stamp(&path),
        path,
        data: data.clone(),
    });
    Ok(())
}

/// Execute a read-modify-write transaction against AppData under one lock.
pub fn with_data_mut<R, F>(mutator: F) -> Result<R, String>
where
    F: FnOnce(&mut AppData) -> Result<R, String>,
{
    let _guard = DATA_LOCK.lock().map_err(|e| e.to_string())?;
    let mut data = load_data_unlocked()?;
    let result = mutator(&mut data)?;
    save_data_unlocked(&data)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A load that repairs the data (here: a reference to a deleted
    /// credential) saves the repair, so it is not redone on every load.
    #[test]
    fn load_saves_a_migration_repair() {
        test_support::with_isolated_data_dir(|| {
            let path = get_data_path();
            let mut data = AppData::default();
            data.connections.push(crate::models::Connection::new(
                "web".into(),
                "h".into(),
                22,
                Some("deleted-credential".into()),
                crate::models::ConnectionKind::Direct,
            ));
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, serde_json::to_string(&data).unwrap()).unwrap();

            assert_eq!(load_data().unwrap().connections[0].credential_id, None);
            let on_disk = fs::read_to_string(&path).unwrap();
            assert!(!on_disk.contains("deleted-credential"), "{on_disk}");
            // A clean file is not rewritten.
            let stamp = file_stamp(&path);
            let _ = load_data().unwrap();
            assert_eq!(file_stamp(&path), stamp);
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
        let _g = TEST_ENV_LOCK.lock().unwrap();
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
        let _g = TEST_ENV_LOCK.lock().unwrap();
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
