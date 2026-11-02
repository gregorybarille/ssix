//! Session logs: what a shell session prints, appended to a private file as
//! it arrives (like `script(1)`, so the file keeps the remote's escape
//! sequences). Only remote output is written, never keystrokes; a remote
//! that echoes a secret still puts it in the log, as
//! `docs/session-resilience.md` warns.
//!
//! A log grows for as long as the session lasts, so it is one file held open
//! for appending. `storage::atomic_write` replaces a whole file at once and
//! cannot serve here.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Default log folder, under `storage::data_dir()`.
const DEFAULT_DIR_NAME: &str = "session-logs";
/// Longest connection name kept in a file name, in characters.
const MAX_NAME_CHARS: usize = 64;
/// Characters of the session id that keep two logs of one instant apart.
const SESSION_ID_CHARS: usize = 8;

fn default_log_dir() -> PathBuf {
    crate::storage::data_dir().join(DEFAULT_DIR_NAME)
}

/// Which log a session opens once its shell is up, so a connection that
/// fails leaves no empty file behind.
#[derive(Clone, Debug)]
pub struct SessionLogPlan {
    /// `AppSettings::session_log_dir` when set; `None` is the default folder.
    pub custom_dir: Option<PathBuf>,
    pub connection_name: String,
    pub session_id: String,
}

impl SessionLogPlan {
    /// A plan for this session, or `None` when logging is off. A connection's
    /// `log_session` overrides `session_log_enabled` in the settings.
    pub fn resolve(
        connection: &crate::models::Connection,
        settings: &crate::models::AppSettings,
        session_id: &str,
    ) -> Option<Self> {
        if !connection
            .log_session
            .unwrap_or(settings.session_log_enabled)
        {
            return None;
        }
        Some(Self {
            custom_dir: settings
                .session_log_dir
                .as_deref()
                .map(str::trim)
                .filter(|dir| !dir.is_empty())
                .map(PathBuf::from),
            connection_name: connection.name.clone(),
            session_id: session_id.to_string(),
        })
    }
}

/// A connection name as a single, harmless file name component: letters,
/// digits, `-`, `_` and `.` stay and the rest becomes `_`, so no name can
/// leave the log folder or hide the file.
fn safe_file_stem(connection_name: &str) -> String {
    let cleaned: String = connection_name
        .chars()
        .take(MAX_NAME_CHARS)
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(['.', '_', '-']);
    if trimmed.is_empty() {
        "session".to_string()
    } else {
        trimmed.to_string()
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Create `dir` and its missing parents, readable only by this user.
#[cfg(unix)]
fn create_private_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)
}

/// The default folder holds nothing but logs, so one that exists with looser
/// permissions is tightened. A folder the user picked is theirs to manage:
/// each file in it is still private.
#[cfg(unix)]
fn tighten_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn tighten_dir(_dir: &Path) -> io::Result<()> {
    Ok(())
}

/// `create_new` refuses an existing path, so a symlink planted under the
/// name cannot redirect the log.
fn create_private_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.append(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// An open session log.
pub struct SessionLog {
    file: File,
    path: PathBuf,
}

impl SessionLog {
    /// Create the session's log file, and the folder it goes in if needed.
    pub fn create(plan: &SessionLogPlan) -> Result<Self, String> {
        let dir = match &plan.custom_dir {
            Some(dir) => dir.clone(),
            None => default_log_dir(),
        };
        let fail = |what: &str, path: &Path, e: io::Error| {
            format!("Could not {} {}: {}", what, path.display(), e)
        };
        create_private_dir(&dir).map_err(|e| fail("create the log folder", &dir, e))?;
        if plan.custom_dir.is_none() {
            tighten_dir(&dir).map_err(|e| fail("protect the log folder", &dir, e))?;
        }
        let id: String = plan.session_id.chars().take(SESSION_ID_CHARS).collect();
        let path = dir.join(format!(
            "{}_{}_{}.log",
            safe_file_stem(&plan.connection_name),
            crate::backup::timestamp(now_ms()),
            safe_file_stem(&id),
        ));
        let file = create_private_file(&path).map_err(|e| fail("create", &path, e))?;
        Ok(Self { file, path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Append shell output as it came.
    pub fn append(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.file.write_all(bytes)
    }

    /// Append a line of SSIX's own, set apart from the shell's output.
    pub fn note(&mut self, text: &str) -> io::Result<()> {
        let line = format!(
            "\r\n[SSIX {}] {}\r\n",
            crate::backup::timestamp(now_ms()),
            text
        );
        self.file.write_all(line.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AppSettings, Connection, ConnectionKind};
    use crate::storage::test_support::with_isolated_data_dir;

    fn plan(name: &str) -> SessionLogPlan {
        SessionLogPlan {
            custom_dir: None,
            connection_name: name.to_string(),
            session_id: "0123456789abcdef".to_string(),
        }
    }

    fn connection(log_session: Option<bool>) -> Connection {
        Connection {
            log_session,
            ..Connection::new(
                "web".to_string(),
                "web.example".to_string(),
                22,
                None,
                ConnectionKind::Direct,
            )
        }
    }

    #[test]
    fn a_connection_overrides_the_setting() {
        let on = AppSettings {
            session_log_enabled: true,
            ..AppSettings::default()
        };
        let off = AppSettings::default();
        let resolved = |c: Option<bool>, s: &AppSettings| {
            SessionLogPlan::resolve(&connection(c), s, "id").is_some()
        };
        assert!(resolved(None, &on));
        assert!(!resolved(None, &off));
        assert!(resolved(Some(true), &off));
        assert!(!resolved(Some(false), &on));
    }

    #[test]
    fn a_blank_folder_setting_means_the_default() {
        let settings = AppSettings {
            session_log_enabled: true,
            session_log_dir: Some("  ".to_string()),
            ..AppSettings::default()
        };
        let plan = SessionLogPlan::resolve(&connection(None), &settings, "id").unwrap();
        assert_eq!(plan.custom_dir, None);
    }

    #[test]
    fn file_names_cannot_escape_or_hide() {
        for (name, stem) in [
            ("web-01", "web-01"),
            ("prod.eu_1", "prod.eu_1"),
            ("../../etc/passwd", "etc_passwd"),
            ("..\\..\\windows\\system32", "windows_system32"),
            ("a/b c", "a_b_c"),
            ("nul\0byte", "nul_byte"),
            (".hidden", "hidden"),
            ("...", "session"),
            ("///", "session"),
            ("", "session"),
            ("東京", "東京"),
        ] {
            assert_eq!(safe_file_stem(name), stem, "{name:?}");
        }
        assert_eq!(safe_file_stem(&"x".repeat(500)).len(), MAX_NAME_CHARS);
    }

    #[test]
    fn logs_stay_inside_the_default_folder_under_the_data_dir() {
        with_isolated_data_dir(|| {
            let log = SessionLog::create(&plan("../../outside")).unwrap();
            let dir = crate::storage::data_dir().join("session-logs");
            assert_eq!(log.path().parent(), Some(dir.as_path()));
            let file_name = log.path().file_name().unwrap().to_str().unwrap();
            assert!(file_name.starts_with("outside_"), "{file_name}");
            assert!(file_name.ends_with("_01234567.log"), "{file_name}");
        });
    }

    #[test]
    fn output_and_notes_are_appended_in_order() {
        with_isolated_data_dir(|| {
            let mut log = SessionLog::create(&plan("web")).unwrap();
            log.append(b"first ").unwrap();
            log.append(b"second").unwrap();
            log.note("Reconnected").unwrap();
            log.append(b"third").unwrap();
            let text = fs::read_to_string(log.path()).unwrap();
            assert!(text.starts_with("first second\r\n[SSIX "), "{text}");
            assert!(text.ends_with("] Reconnected\r\nthird"), "{text}");
        });
    }

    #[test]
    fn a_custom_folder_is_created_when_missing() {
        with_isolated_data_dir(|| {
            let dir = crate::storage::data_dir().join("custom").join("nested");
            let mut custom = plan("web");
            custom.custom_dir = Some(dir.clone());
            let log = SessionLog::create(&custom).unwrap();
            assert_eq!(log.path().parent(), Some(dir.as_path()));
        });
    }

    #[test]
    fn creating_a_log_reports_an_unusable_folder() {
        with_isolated_data_dir(|| {
            let blocked = crate::storage::data_dir().join("a-file");
            fs::create_dir_all(crate::storage::data_dir()).unwrap();
            fs::write(&blocked, b"not a folder").unwrap();
            let mut custom = plan("web");
            custom.custom_dir = Some(blocked);
            let error = SessionLog::create(&custom).err().unwrap();
            assert!(error.contains("Could not create the log folder"), "{error}");
        });
    }

    #[cfg(unix)]
    mod unix {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn mode(path: &Path) -> u32 {
            fs::metadata(path).unwrap().permissions().mode() & 0o777
        }

        #[test]
        fn folder_and_files_are_private() {
            with_isolated_data_dir(|| {
                let log = SessionLog::create(&plan("web")).unwrap();
                assert_eq!(mode(log.path().parent().unwrap()), 0o700);
                assert_eq!(mode(log.path()), 0o600);
            });
        }

        #[test]
        fn a_loose_default_folder_is_tightened() {
            with_isolated_data_dir(|| {
                let dir = crate::storage::data_dir().join("session-logs");
                fs::create_dir_all(&dir).unwrap();
                fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
                SessionLog::create(&plan("web")).unwrap();
                assert_eq!(mode(&dir), 0o700);
            });
        }

        #[test]
        fn a_folder_the_user_picked_keeps_its_permissions() {
            with_isolated_data_dir(|| {
                let dir = crate::storage::data_dir().join("mine");
                fs::create_dir_all(&dir).unwrap();
                fs::set_permissions(&dir, fs::Permissions::from_mode(0o750)).unwrap();
                let mut custom = plan("web");
                custom.custom_dir = Some(dir.clone());
                let log = SessionLog::create(&custom).unwrap();
                assert_eq!(mode(&dir), 0o750);
                assert_eq!(mode(log.path()), 0o600);
            });
        }

        #[test]
        fn a_planted_symlink_is_not_followed() {
            with_isolated_data_dir(|| {
                let dir = crate::storage::data_dir();
                fs::create_dir_all(&dir).unwrap();
                let target = dir.join("target");
                fs::write(&target, b"untouched").unwrap();
                let link = dir.join("link.log");
                std::os::unix::fs::symlink(&target, &link).unwrap();
                assert!(create_private_file(&link).is_err());
                assert_eq!(fs::read(&target).unwrap(), b"untouched");
            });
        }
    }
}
