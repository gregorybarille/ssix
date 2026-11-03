//! The Files view's backend: a browser over the local disk and one
//! connection's SFTP server (see `docs/sftp.md`).
//!
//! - `browse`: listing and file operations, on one long-lived session per
//!   open remote pane, owned by its own thread.
//! - `transfer`: uploads and downloads, from a queue, on sessions of their own
//!   so a long copy never holds up browsing.
//! - `edit`: edit in place through a private temporary copy.
//!
//! Every session comes from `commands::ssh::connect_session`, so a jump host
//! and host-key verification apply as they do to a terminal.

use crate::models::Connection;
use serde::Serialize;
use ssh2::{ErrorCode, FileStat};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
#[cfg(test)]
use ts_rs::TS;

pub mod browse;
pub mod edit;
pub mod transfer;

#[cfg(test)]
pub(crate) mod live_tests;

/// Starts the message of an error that ended the session, the way
/// `HOST_KEY_MISMATCH` starts a refused host key. Mirrored in `src/lib/sftp.ts`.
pub(crate) const SESSION_LOST: &str = "SFTP_SESSION_LOST";

/// How deep a recursive walk goes. A real tree never gets near it; a server
/// inventing folders forever would otherwise overflow the stack.
pub(crate) const MAX_DEPTH: usize = 128;

/// Starts the name of every temporary file on either side of a transfer.
const TEMP_PREFIX: &str = ".ssix-part-";

const NAME_MAX_BYTES: usize = 255;

// `LIBSSH2_FX_*`: ssh2 reports these as `ErrorCode::SFTP` but does not name them.
const FX_NO_SUCH_FILE: i32 = 2;
const FX_NO_SUCH_PATH: i32 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    File,
    Dir,
    Symlink,
    Other,
}

/// One row of a pane.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: FileKind,
    /// A symlink to a folder, which opens like a folder.
    pub target_is_dir: bool,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub size: Option<u64>,
    /// Seconds since the Unix epoch.
    #[cfg_attr(test, ts(type = "number | null"))]
    pub modified: Option<u64>,
    /// The permission bits (`0o7777`), when the system has them.
    pub mode: Option<u32>,
}

/// The contents of one folder, folders first and then by name.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct FileListing {
    /// The folder's full path with symlinks resolved.
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<FileEntry>,
    /// Entries left out because their name cannot be represented safely.
    pub omitted: u32,
    /// The folder holds more than `browse::LISTING_LIMIT` entries.
    pub truncated: bool,
}

/// Forwards (`ssh -L`, `-R`, `-D`) open no session on a host's files.
fn refuse_forward(conn: &Connection) -> Result<(), String> {
    if conn.kind.is_forward() {
        return Err("Browsing files is not available for port-forward connections".to_string());
    }
    Ok(())
}

/// The message for a failed SFTP call. Only an SFTP status code leaves the
/// session usable; anything else is the transport failing.
pub(crate) fn call_error(action: &str, path: &str, e: &ssh2::Error) -> String {
    match e.code() {
        ErrorCode::SFTP(_) => format!("{} {}: {}", action, path, e.message()),
        ErrorCode::Session(_) => format!(
            "{}\nThe connection to the server was lost ({} {}: {})",
            SESSION_LOST,
            action.to_lowercase(),
            path,
            e.message()
        ),
    }
}

pub(crate) fn is_not_found(e: &ssh2::Error) -> bool {
    matches!(
        e.code(),
        ErrorCode::SFTP(FX_NO_SUCH_FILE) | ErrorCode::SFTP(FX_NO_SUCH_PATH)
    )
}

/// Whether `name` is one path component, on any system the other end may
/// run: this is the check that keeps a typed name, or one a server sends,
/// from reaching outside its folder.
pub(crate) fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("A name is required".to_string());
    }
    if name == "." || name == ".." {
        return Err(format!("\"{}\" is not a valid name", name));
    }
    if name.len() > NAME_MAX_BYTES {
        return Err(format!(
            "A name must be {} bytes or shorter",
            NAME_MAX_BYTES
        ));
    }
    if name.chars().any(|c| c == '/' || c.is_control()) {
        return Err("A name cannot contain / or control characters".to_string());
    }
    Ok(())
}

/// What Windows cannot store or would read as something else: a name with
/// `\` or `:` would land outside its folder or in an alternate stream.
fn is_safe_windows_name(name: &str) -> bool {
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = name.split('.').next().unwrap_or(name);
    !name.chars().any(|c| "\\:*?\"<>|".contains(c))
        && !name.ends_with(['.', ' '])
        && !RESERVED.iter().any(|r| stem.eq_ignore_ascii_case(r))
}

/// Whether a name from a server may become a file on this machine.
pub(crate) fn safe_local_name(name: &str) -> bool {
    validate_name(name).is_ok() && (!cfg!(windows) || is_safe_windows_name(name))
}

/// A name no file has yet: temporary files live next to their target, so
/// finishing them is an atomic rename on the same filesystem.
pub(crate) fn temp_name() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    format!(
        "{}{}-{}",
        TEMP_PREFIX,
        uuid::Uuid::new_v4().simple(),
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

/// Remote paths are `/`-joined strings on every client: `Path::join` would
/// use `\` on Windows.
pub(crate) fn join_remote(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{}{}", dir, name)
    } else {
        format!("{}/{}", dir, name)
    }
}

/// The folder holding `path`, or `None` for the root.
pub(crate) fn remote_parent(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        None => None,
        Some(0) => Some("/".to_string()),
        Some(i) => Some(trimmed[..i].to_string()),
    }
}

/// The last component of `path`, or `None` for the root.
pub(crate) fn remote_name(path: &str) -> Option<&str> {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit('/').next() {
        Some("") | None => None,
        Some(name) => Some(name),
    }
}

/// The server's idea of `path` as a string; ssh2 hands back a `PathBuf`.
pub(crate) fn path_string(path: PathBuf) -> Result<String, String> {
    path.into_os_string()
        .into_string()
        .map_err(|_| "The server returned a path that is not valid UTF-8".to_string())
}

/// A full path as every listing reports it: absolute and with no `.` or
/// `..`. Anything else cannot have come from a listing, so a command that
/// changes something refuses it instead of guessing what it means.
pub(crate) fn check_remote_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') {
        return Err(format!("{} is not a full path", path));
    }
    if path.contains('\0') || path.split('/').any(|part| part == "." || part == "..") {
        return Err(format!("{} is not a valid path", path));
    }
    Ok(())
}

/// Whether two stats differ the way a change on the server would show.
pub(crate) fn same_stamp(a: &FileStat, b: &FileStat) -> bool {
    a.size == b.size && a.mtime == b.mtime
}

/// The permission bits of a mode as a server or the OS reports it.
pub(crate) fn permission_bits(mode: u32) -> u32 {
    mode & 0o7777
}

/// Whether `path` names a filesystem root, with nothing above it.
pub(crate) fn is_local_root(path: &Path) -> bool {
    path.parent().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_must_be_one_path_component() {
        for ok in [
            "a.txt",
            ".hidden",
            "with space",
            "ünï",
            "..three",
            "a\\b",
            &"n".repeat(255),
        ] {
            assert!(validate_name(ok).is_ok(), "{}", ok);
        }
        for bad in [
            "",
            ".",
            "..",
            "a/b",
            "/etc/passwd",
            "../up",
            "nul\0byte",
            "line\nfeed",
            &"n".repeat(256),
        ] {
            assert!(validate_name(bad).is_err(), "{:?}", bad);
        }
    }

    #[test]
    fn windows_names_refuse_what_would_leave_their_folder() {
        for bad in [
            "..\\up", "C:evil", "a:b", "CON", "con.txt", "nul", "lpt1.log", "end.", "end ",
        ] {
            assert!(!is_safe_windows_name(bad), "{}", bad);
        }
        for ok in ["a.txt", "console", "com10", "lpt", "a b.txt"] {
            assert!(is_safe_windows_name(ok), "{}", ok);
        }
    }

    #[test]
    fn remote_paths_split_on_slash() {
        assert_eq!(join_remote("/a", "b"), "/a/b");
        assert_eq!(join_remote("/", "b"), "/b");
        assert_eq!(remote_parent("/a/b"), Some("/a".to_string()));
        assert_eq!(remote_parent("/a/b/"), Some("/a".to_string()));
        assert_eq!(remote_parent("/a"), Some("/".to_string()));
        assert_eq!(remote_parent("/"), None);
        assert_eq!(remote_name("/a/b"), Some("b"));
        assert_eq!(remote_name("/a/b/"), Some("b"));
        assert_eq!(remote_name("/"), None);
    }

    #[test]
    fn paths_that_did_not_come_from_a_listing_are_refused() {
        for ok in ["/", "/a", "/a/b.txt", "/C:/Users/me", "/a/..b/c."] {
            assert!(check_remote_path(ok).is_ok(), "{}", ok);
        }
        for bad in ["", "relative", "~/x", "/a/../b", "/a/./b", "/a/..", "/a\0b"] {
            assert!(check_remote_path(bad).is_err(), "{:?}", bad);
        }
    }

    #[test]
    fn temp_names_are_unique_and_hidden() {
        let (a, b) = (temp_name(), temp_name());
        assert_ne!(a, b);
        assert!(a.starts_with(".ssix-part-"), "{}", a);
        assert!(validate_name(&a).is_ok());
    }

    #[test]
    fn only_transport_errors_report_a_lost_session() {
        let sftp = ssh2::Error::new(ErrorCode::SFTP(FX_NO_SUCH_FILE), "no such file");
        assert_eq!(
            call_error("Could not open", "/x", &sftp),
            "Could not open /x: no such file"
        );
        assert!(is_not_found(&sftp));

        let transport = ssh2::Error::new(ErrorCode::Session(-13), "socket disconnect");
        let message = call_error("Could not open", "/x", &transport);
        assert!(message.starts_with(SESSION_LOST), "{}", message);
        assert!(!is_not_found(&transport));
    }
}
