//! Local backups of the SSIX data directory, in the manner of HelixNotes:
//! timestamped ZIP archives in `<data_dir>/backups`, published by an atomic
//! rename only once complete, pruned automatically, and restored only
//! after every file in the archive has been checked.
//!
//! An archive holds `manifest.json` (format, app version, reason and a
//! SHA-256 per file) plus `data.json`, `secrets.json` and `known_hosts` as
//! they were on disk. `secrets.json` keeps passwords and private keys in
//! clear, as it does in the data directory, so archives are written 0600
//! inside a 0700 directory and never leave the machine.

use std::collections::HashSet;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(test)]
use ts_rs::TS;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// Bumped when the archive layout changes; newer archives are refused.
const FORMAT: u32 = 1;
const PREFIX: &str = "ssix-backup-";
const MANIFEST: &str = "manifest.json";
/// The files a backup holds, in archive order. `data.json` is required.
const FILES: [&str; 3] = ["data.json", "secrets.json", "known_hosts"];
/// File names with their contents, in `FILES` order.
type Files = Vec<(String, Vec<u8>)>;

/// Largest file read back from an archive; the real files are far smaller,
/// so anything bigger is a damaged or hostile archive.
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// First automatic check after launch, then the interval between checks.
const SCHEDULER_START_DELAY: Duration = Duration::from_secs(60);
const SCHEDULER_PERIOD: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "snake_case")]
pub enum BackupReason {
    Manual,
    Automatic,
    /// Taken by a restore just before it replaces the live files.
    BeforeRestore,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct ManifestFile {
    name: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Manifest {
    format: u32,
    app_version: String,
    /// Unix time in milliseconds.
    created_at: u64,
    reason: BackupReason,
    files: Vec<ManifestFile>,
}

/// One archive in the backups folder, as the Settings list shows it.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct BackupInfo {
    /// File name, which is also the id passed to restore and delete.
    pub name: String,
    /// Unix time in milliseconds; the file's mtime when it has no manifest.
    #[cfg_attr(test, ts(type = "number"))]
    pub created_at: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub size: u64,
    pub reason: Option<BackupReason>,
    pub files: Vec<String>,
    /// Why the archive cannot be restored, when it cannot.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct BackupList {
    pub dir: String,
    /// Newest first.
    pub backups: Vec<BackupInfo>,
}

pub fn backups_dir() -> PathBuf {
    crate::storage::data_dir().join("backups")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

/// `YYYYMMDD-HHMMSS-mmm` in UTC, so names sort in creation order.
fn timestamp(ms: u64) -> String {
    let secs = ms / 1000;
    let (h, m, s) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}-{:03}",
        year,
        month,
        day,
        h,
        m,
        s,
        ms % 1000
    )
}

/// A name `list` produced: no path parts, so it cannot point outside the
/// backups folder.
fn check_name(name: &str) -> Result<(), String> {
    let plain = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.');
    if plain && name.starts_with(PREFIX) && name.ends_with(".zip") && !name.contains("..") {
        Ok(())
    } else {
        Err(format!("{:?} is not an SSIX backup", name))
    }
}

/// Run `f` while every file a backup covers is locked, so the copy is
/// consistent and a restore never interleaves with a save. The order
/// (data, secrets, known_hosts) matches the order other code nests them.
fn with_files_locked<T>(f: impl FnOnce() -> T) -> T {
    crate::storage::with_data_file_locked(|| {
        crate::keychain::with_secrets_file_locked(|| crate::known_hosts::with_known_hosts_locked(f))
    })
}

/// The files present in the data directory now. Call with the files locked.
fn read_live_files() -> Result<Files, String> {
    let dir = crate::storage::data_dir();
    let mut files = Vec::new();
    for name in FILES {
        match fs::read(dir.join(name)) {
            Ok(bytes) => files.push((name.to_string(), bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Could not read {}: {}", name, e)),
        }
    }
    Ok(files)
}

fn has_data(files: &[(String, Vec<u8>)]) -> bool {
    files.iter().any(|(name, _)| name == "data.json")
}

fn manifest_files(files: &[(String, Vec<u8>)]) -> Vec<ManifestFile> {
    files
        .iter()
        .map(|(name, bytes)| ManifestFile {
            name: name.clone(),
            size: bytes.len() as u64,
            sha256: sha256_hex(bytes),
        })
        .collect()
}

#[cfg(unix)]
fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {}", dir.display(), e))?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("Could not protect {}: {}", dir.display(), e))
}

#[cfg(not(unix))]
fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {}", dir.display(), e))
}

fn info_from(name: String, size: u64, manifest: &Manifest) -> BackupInfo {
    BackupInfo {
        name,
        created_at: manifest.created_at,
        size,
        reason: Some(manifest.reason),
        files: manifest.files.iter().map(|f| f.name.clone()).collect(),
        error: None,
    }
}

/// Zip `files` into `dir` under a fresh name. The archive is built in
/// memory and written with `atomic_write`, so a half-written backup is
/// never visible under its final name.
fn write_archive(
    dir: &Path,
    files: &[(String, Vec<u8>)],
    reason: BackupReason,
    created_at: u64,
) -> Result<BackupInfo, String> {
    ensure_private_dir(dir)?;
    let manifest = Manifest {
        format: FORMAT,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        created_at,
        reason,
        files: manifest_files(files),
    };
    let zip_err = |e: zip::result::ZipError| format!("Could not build the backup: {}", e);
    let io_err = |e: std::io::Error| format!("Could not build the backup: {}", e);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o600);
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file(MANIFEST, options).map_err(zip_err)?;
    let manifest_json = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    zip.write_all(&manifest_json).map_err(io_err)?;
    for (name, bytes) in files {
        zip.start_file(name.as_str(), options).map_err(zip_err)?;
        zip.write_all(bytes).map_err(io_err)?;
    }
    let bytes = zip.finish().map_err(zip_err)?.into_inner();

    let stamp = timestamp(created_at);
    let mut name = format!("{}{}.zip", PREFIX, stamp);
    let mut n = 2;
    while dir.join(&name).exists() {
        name = format!("{}{}-{}.zip", PREFIX, stamp, n);
        n += 1;
    }
    crate::storage::atomic_write(&dir.join(&name), &bytes, Some(0o600))?;
    Ok(info_from(name, bytes.len() as u64, &manifest))
}

/// Read one archive entry, refusing anything implausibly large.
fn read_entry(zip: &mut ZipArchive<fs::File>, name: &str) -> Result<Vec<u8>, String> {
    let entry = zip
        .by_name(name)
        .map_err(|e| format!("{} is missing: {}", name, e))?;
    if entry.size() > MAX_FILE_BYTES {
        return Err(format!("{} is too large", name));
    }
    let mut bytes = Vec::new();
    entry
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("{} is unreadable: {}", name, e))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(format!("{} is too large", name));
    }
    Ok(bytes)
}

fn open_zip(path: &Path) -> Result<ZipArchive<fs::File>, String> {
    let file = fs::File::open(path).map_err(|e| format!("Could not open the backup: {}", e))?;
    ZipArchive::new(file).map_err(|e| format!("Not a readable ZIP archive: {}", e))
}

fn read_manifest(zip: &mut ZipArchive<fs::File>) -> Result<Manifest, String> {
    let manifest: Manifest = serde_json::from_slice(&read_entry(zip, MANIFEST)?)
        .map_err(|e| format!("The manifest is invalid: {}", e))?;
    if manifest.format > FORMAT {
        return Err("This backup was made by a newer version of SSIX".to_string());
    }
    Ok(manifest)
}

/// Every check a restore needs before it touches a live file: only the
/// expected entries, each listed once with a matching size and SHA-256,
/// and contents that SSIX can load.
fn read_verified(path: &Path) -> Result<Files, String> {
    let mut zip = open_zip(path)?;
    let manifest = read_manifest(&mut zip)?;

    let mut listed = HashSet::new();
    for file in &manifest.files {
        if !FILES.contains(&file.name.as_str()) {
            return Err(format!(
                "The manifest lists an unexpected file {:?}",
                file.name
            ));
        }
        if !listed.insert(file.name.as_str()) {
            return Err(format!("The manifest lists {} twice", file.name));
        }
    }
    if !listed.contains("data.json") {
        return Err("The backup has no data.json".to_string());
    }
    for name in zip.file_names() {
        let name = name.map_err(|e| format!("An entry name is unreadable: {}", e))?;
        if name != MANIFEST && !listed.contains(name.as_ref()) {
            return Err(format!("The archive holds an unexpected file {:?}", name));
        }
    }

    let mut files = Vec::new();
    for file in &manifest.files {
        let bytes = read_entry(&mut zip, &file.name)?;
        if bytes.len() as u64 != file.size || sha256_hex(&bytes) != file.sha256 {
            return Err(format!("{} does not match its checksum", file.name));
        }
        files.push((file.name.clone(), bytes));
    }

    for (name, bytes) in &files {
        let parsed = match name.as_str() {
            "data.json" => serde_json::from_slice::<crate::models::AppData>(bytes)
                .map(|_| ())
                .map_err(|e| e.to_string()),
            "secrets.json" => {
                serde_json::from_slice::<std::collections::HashMap<String, String>>(bytes)
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            }
            _ => std::str::from_utf8(bytes)
                .map(|_| ())
                .map_err(|e| e.to_string()),
        };
        parsed.map_err(|e| format!("{} in the backup is not usable: {}", name, e))?;
    }
    Ok(files)
}

fn describe(path: &Path, name: String) -> BackupInfo {
    let meta = fs::metadata(path).ok();
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    match open_zip(path).and_then(|mut zip| read_manifest(&mut zip)) {
        Ok(manifest) => info_from(name, size, &manifest),
        Err(error) => BackupInfo {
            name,
            created_at: meta
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            size,
            reason: None,
            files: Vec::new(),
            error: Some(error),
        },
    }
}

fn list_in(dir: &Path) -> Result<Vec<BackupInfo>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Could not read {}: {}", dir.display(), e)),
    };
    let mut backups: Vec<BackupInfo> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            check_name(&name).ok()?;
            Some(describe(&entry.path(), name))
        })
        .collect();
    backups.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.name.cmp(&a.name)));
    Ok(backups)
}

pub fn list() -> Result<BackupList, String> {
    let dir = backups_dir();
    Ok(BackupList {
        backups: list_in(&dir)?,
        dir: dir.display().to_string(),
    })
}

/// Back up the data directory now.
pub fn create(reason: BackupReason) -> Result<BackupInfo, String> {
    let files = with_files_locked(read_live_files)?;
    if !has_data(&files) {
        return Err("There is nothing to back up yet".to_string());
    }
    write_archive(&backups_dir(), &files, reason, now_ms())
}

/// Replace the live files with the archive's, after checking all of it.
/// The current files are backed up first; that backup is returned. A file
/// the archive does not hold is removed, so the result is exactly the
/// state that was backed up.
pub fn restore(name: &str) -> Result<Option<BackupInfo>, String> {
    check_name(name)?;
    let dir = backups_dir();
    let files = read_verified(&dir.join(name))?;
    let data_dir = crate::storage::data_dir();
    with_files_locked(|| {
        let live = read_live_files()?;
        let safety = if has_data(&live) {
            Some(write_archive(
                &dir,
                &live,
                BackupReason::BeforeRestore,
                now_ms(),
            )?)
        } else {
            None
        };
        let keep_note = |e: String| match &safety {
            Some(b) => format!("{} The previous files are in {}.", e, b.name),
            None => e,
        };
        for target in FILES {
            let path = data_dir.join(target);
            match files.iter().find(|(name, _)| name == target) {
                Some((_, bytes)) => {
                    let mode = (target != "data.json").then_some(0o600);
                    crate::storage::atomic_write(&path, bytes, mode).map_err(keep_note)?;
                }
                None => match fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(keep_note(format!("Could not remove {}: {}", target, e))),
                },
            }
        }
        Ok(safety)
    })
}

pub fn delete(name: &str) -> Result<(), String> {
    check_name(name)?;
    fs::remove_file(backups_dir().join(name))
        .map_err(|e| format!("Could not delete {}: {}", name, e))
}

/// Delete the oldest automatic backups beyond `keep` from `backups`, the
/// folder's listing newest first; manual and before-restore backups are
/// left for the user to delete.
fn prune(dir: &Path, backups: Vec<BackupInfo>, keep: usize) -> Result<Vec<String>, String> {
    let removed: Vec<String> = backups
        .into_iter()
        .filter(|b| b.reason == Some(BackupReason::Automatic))
        .skip(keep.max(1))
        .map(|b| b.name)
        .collect();
    for name in &removed {
        fs::remove_file(dir.join(name)).map_err(|e| format!("Could not delete {}: {}", name, e))?;
    }
    Ok(removed)
}

fn is_due(now: u64, latest: Option<u64>, interval_hours: u32) -> bool {
    let interval = u64::from(interval_hours.max(1)) * 3_600_000;
    latest.is_none_or(|t| now.saturating_sub(t) >= interval)
}

/// Take an automatic backup when one is due and something changed since
/// the newest backup. Returns the backup taken, if any.
fn run_due(dir: &Path, now: u64) -> Result<Option<BackupInfo>, String> {
    let settings = crate::storage::load_data()?.settings;
    if !settings.backup_enabled {
        return Ok(None);
    }
    let backups = list_in(dir)?;
    let newest = backups.iter().find(|b| b.error.is_none());
    if !is_due(
        now,
        newest.as_ref().map(|b| b.created_at),
        settings.backup_interval_hours,
    ) {
        return Ok(None);
    }
    let files = with_files_locked(read_live_files)?;
    if !has_data(&files) {
        return Ok(None);
    }
    if let Some(newest) = newest {
        let unchanged = open_zip(&dir.join(&newest.name))
            .and_then(|mut zip| read_manifest(&mut zip))
            .map(|m| m.files == manifest_files(&files))
            .unwrap_or(false);
        if unchanged {
            return Ok(None);
        }
    }
    let info = write_archive(dir, &files, BackupReason::Automatic, now)?;
    // Being due means `now` is past every backup, so the new one leads.
    let backups = std::iter::once(info.clone()).chain(backups).collect();
    prune(dir, backups, settings.backup_keep as usize)?;
    Ok(Some(info))
}

/// Check for a due automatic backup shortly after launch and then every
/// few minutes, for the life of the app.
pub fn spawn_scheduler() {
    thread::spawn(|| {
        thread::sleep(SCHEDULER_START_DELAY);
        loop {
            match run_due(&backups_dir(), now_ms()) {
                Ok(Some(info)) => crate::logs::log_local(
                    "info",
                    "backup",
                    format!("automatic backup {} created", info.name),
                ),
                Ok(None) => {}
                Err(e) => crate::logs::log_local(
                    "warn",
                    "backup",
                    format!("automatic backup failed: {}", e),
                ),
            }
            thread::sleep(SCHEDULER_PERIOD);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::with_isolated_data_dir;

    fn write_live(name: &str, content: &str) {
        let dir = crate::storage::data_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(name), content).unwrap();
    }

    fn live(name: &str) -> Option<String> {
        fs::read_to_string(crate::storage::data_dir().join(name)).ok()
    }

    fn data_json(font_size: u8) -> String {
        let mut data = crate::models::AppData::default();
        data.settings.font_size = font_size;
        serde_json::to_string(&data).unwrap()
    }

    #[test]
    fn timestamps_are_utc_and_sortable() {
        assert_eq!(timestamp(0), "19700101-000000-000");
        // 2026-10-30T15:45:12.345Z
        assert_eq!(timestamp(1_793_375_112_345), "20261030-154512-345");
        assert_eq!(timestamp(951_782_400_000), "20000229-000000-000");
    }

    #[test]
    fn names_outside_the_backups_folder_are_refused() {
        assert!(check_name("ssix-backup-20261030-154512-345.zip").is_ok());
        assert!(check_name("../data.json").is_err());
        assert!(check_name("ssix-backup-../../x.zip").is_err());
        assert!(check_name("ssix-backup-a/b.zip").is_err());
        assert!(check_name("other.zip").is_err());
    }

    #[test]
    fn backup_then_restore_brings_every_file_back() {
        with_isolated_data_dir(|| {
            write_live("data.json", &data_json(15));
            write_live("secrets.json", r#"{"c1":"pw"}"#);
            write_live("known_hosts", "host ssh-ed25519 AAAA\n");
            let backup = create(BackupReason::Manual).unwrap();
            assert_eq!(
                backup.files,
                vec!["data.json", "secrets.json", "known_hosts"]
            );

            write_live("data.json", &data_json(20));
            write_live("secrets.json", r#"{"c1":"changed"}"#);
            fs::remove_file(crate::storage::data_dir().join("known_hosts")).unwrap();

            let safety = restore(&backup.name).unwrap().unwrap();
            assert_eq!(safety.reason, Some(BackupReason::BeforeRestore));
            assert_eq!(crate::storage::load_data().unwrap().settings.font_size, 15);
            assert_eq!(live("secrets.json").unwrap(), r#"{"c1":"pw"}"#);
            assert_eq!(live("known_hosts").unwrap(), "host ssh-ed25519 AAAA\n");

            // The state the restore replaced is kept and restorable.
            restore(&safety.name).unwrap();
            assert_eq!(crate::storage::load_data().unwrap().settings.font_size, 20);
            assert_eq!(live("known_hosts"), None);
        });
    }

    #[cfg(unix)]
    #[test]
    fn archives_are_private() {
        use std::os::unix::fs::PermissionsExt;
        with_isolated_data_dir(|| {
            write_live("data.json", &data_json(14));
            let backup = create(BackupReason::Manual).unwrap();
            let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&backups_dir().join(&backup.name)), 0o600);
            assert_eq!(mode(&backups_dir()), 0o700);
        });
    }

    #[test]
    fn nothing_to_back_up_before_the_first_save() {
        with_isolated_data_dir(|| {
            assert!(create(BackupReason::Manual).is_err());
        });
    }

    type Edit = Box<dyn FnOnce(&mut Manifest, &mut Files)>;

    fn rewrite(path: &Path, edit: Edit) {
        let mut zip = open_zip(path).unwrap();
        let mut manifest = read_manifest(&mut zip).unwrap();
        let mut files: Files = manifest
            .files
            .iter()
            .map(|f| (f.name.clone(), read_entry(&mut zip, &f.name).unwrap()))
            .collect();
        edit(&mut manifest, &mut files);
        let options = SimpleFileOptions::default();
        let mut out = ZipWriter::new(Cursor::new(Vec::new()));
        out.start_file(MANIFEST, options).unwrap();
        out.write_all(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();
        for (name, bytes) in &files {
            out.start_file(name.as_str(), options).unwrap();
            out.write_all(bytes).unwrap();
        }
        fs::write(path, out.finish().unwrap().into_inner()).unwrap();
    }

    #[test]
    fn a_damaged_or_foreign_archive_is_refused_before_anything_changes() {
        with_isolated_data_dir(|| {
            write_live("data.json", &data_json(15));
            let cases: Vec<(&str, Edit)> = vec![
                ("checksum", Box::new(|_, files| files[0].1.push(b' '))),
                (
                    "unexpected file",
                    Box::new(|_, files| files.push(("../evil".into(), b"x".to_vec()))),
                ),
                ("newer version", Box::new(|m, _| m.format = FORMAT + 1)),
                (
                    "not usable",
                    Box::new(|m, files| {
                        files[0].1 = b"not json".to_vec();
                        m.files[0].size = 8;
                        m.files[0].sha256 = sha256_hex(b"not json");
                    }),
                ),
            ];
            for (expected, edit) in cases {
                let backup = create(BackupReason::Manual).unwrap();
                rewrite(&backups_dir().join(&backup.name), edit);
                write_live("data.json", &data_json(30));
                let err = restore(&backup.name).unwrap_err();
                assert!(err.contains(expected), "{expected}: {err}");
                assert_eq!(crate::storage::load_data().unwrap().settings.font_size, 30);
                write_live("data.json", &data_json(15));
            }
        });
    }

    #[test]
    fn automatic_backups_wait_for_the_interval_and_a_change() {
        with_isolated_data_dir(|| {
            let dir = backups_dir();
            write_live("data.json", &data_json(15));
            let hour = 3_600_000;
            let t0 = 1_793_375_112_345;
            assert!(run_due(&dir, t0).unwrap().is_some());
            // Due again only after 24 h, and only if something changed.
            assert!(run_due(&dir, t0 + hour).unwrap().is_none());
            assert!(run_due(&dir, t0 + 25 * hour).unwrap().is_none());
            write_live("data.json", &data_json(16));
            assert!(run_due(&dir, t0 + 26 * hour).unwrap().is_some());
        });
    }

    #[test]
    fn retention_only_prunes_automatic_backups() {
        with_isolated_data_dir(|| {
            let dir = backups_dir();
            let files = vec![("data.json".to_string(), data_json(14).into_bytes())];
            let manual = write_archive(&dir, &files, BackupReason::Manual, 1_000).unwrap();
            for i in 0..4 {
                write_archive(&dir, &files, BackupReason::Automatic, 2_000 + i).unwrap();
            }
            let removed = prune(&dir, list_in(&dir).unwrap(), 2).unwrap();
            assert_eq!(removed.len(), 2);
            let left = list_in(&dir).unwrap();
            assert_eq!(left.len(), 3);
            assert!(left.iter().any(|b| b.name == manual.name));
            assert_eq!(left[0].created_at, 2_003);
        });
    }

    #[test]
    fn a_disabled_schedule_takes_no_backup() {
        with_isolated_data_dir(|| {
            let mut data = crate::models::AppData::default();
            data.settings.backup_enabled = false;
            write_live("data.json", &serde_json::to_string(&data).unwrap());
            assert!(run_due(&backups_dir(), 1_000).unwrap().is_none());
        });
    }

    #[test]
    fn an_unreadable_file_is_listed_with_its_error() {
        with_isolated_data_dir(|| {
            fs::create_dir_all(backups_dir()).unwrap();
            fs::write(backups_dir().join("ssix-backup-broken.zip"), b"nope").unwrap();
            fs::write(backups_dir().join("notes.txt"), b"ignored").unwrap();
            let list = list().unwrap();
            assert_eq!(list.backups.len(), 1);
            assert!(list.backups[0].error.is_some());
        });
    }
}
