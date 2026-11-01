use crate::commands::blocking;
use crate::commands::git_sync::{validate_git_branch, validate_git_remote};
use crate::models::AppSettings;
use crate::storage::{load_data, with_data_mut};

#[tauri::command]
pub fn get_settings() -> Result<AppSettings, String> {
    let data = load_data()?;
    Ok(data.settings)
}

#[tauri::command]
pub async fn save_settings(settings: AppSettings) -> Result<AppSettings, String> {
    blocking(move || save_settings_sync(settings)).await
}

/// 0 turns keepalive off, as with OpenSSH's `ServerAliveInterval`.
pub(crate) fn validate_keepalive_interval(seconds: u16) -> Result<(), String> {
    if seconds > 3600 {
        return Err("Keepalive interval must be at most 3600 seconds (0 turns it off)".to_string());
    }
    Ok(())
}

fn save_settings_sync(settings: AppSettings) -> Result<AppSettings, String> {
    validate_git_remote(&settings.git_sync_remote)?;
    validate_keepalive_interval(settings.keepalive_interval)?;
    if !(1..=20).contains(&settings.reconnect_max_attempts) {
        return Err("Reconnect attempts must be between 1 and 20".to_string());
    }
    if !(1..=720).contains(&settings.backup_interval_hours) {
        return Err("Backup interval must be between 1 and 720 hours".to_string());
    }
    if !(1..=100).contains(&settings.backup_keep) {
        return Err("Keep between 1 and 100 automatic backups".to_string());
    }
    if let Some(branch) = settings.git_sync_branch.as_deref() {
        if !branch.trim().is_empty() {
            validate_git_branch(branch)?;
        }
    }
    with_data_mut(|data| {
        data.settings = settings.clone();
        Ok(())
    })?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_settings() {
        let settings = AppSettings::default();
        assert_eq!(settings.font_size, 14);
        assert_eq!(settings.color_scheme, "blue");
        assert_eq!(settings.theme, "dark");
    }

    #[test]
    fn test_settings_serialize() {
        let settings = AppSettings::default();
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("font_size"));
        assert!(json.contains("color_scheme"));
    }

    #[test]
    fn save_settings_bounds_the_backup_schedule() {
        for (hours, keep) in [(0, 10), (721, 10), (24, 0), (24, 101)] {
            let s = AppSettings {
                backup_interval_hours: hours,
                backup_keep: keep,
                ..AppSettings::default()
            };
            assert!(save_settings_sync(s).is_err(), "{hours}h keep {keep}");
        }
    }

    #[test]
    fn save_settings_bounds_keepalive_and_reconnect() {
        for (keepalive_interval, reconnect_max_attempts) in [(3601, 5), (30, 0), (30, 21)] {
            let s = AppSettings {
                keepalive_interval,
                reconnect_max_attempts,
                ..AppSettings::default()
            };
            assert!(
                save_settings_sync(s).is_err(),
                "keepalive {keepalive_interval} attempts {reconnect_max_attempts}"
            );
        }
        assert!(validate_keepalive_interval(0).is_ok());
        assert!(validate_keepalive_interval(3600).is_ok());
    }

    /// A remote or branch that git would parse as an option must never be
    /// persisted: it would be passed to `git fetch`/`push` verbatim.
    #[test]
    fn save_settings_rejects_option_like_git_names() {
        let s = AppSettings {
            git_sync_remote: "--upload-pack=touch /tmp/pwned".into(),
            ..AppSettings::default()
        };
        let err = save_settings_sync(s).unwrap_err();
        assert!(err.contains("Git remote"), "got: {}", err);

        let s = AppSettings {
            git_sync_branch: Some("-feature".into()),
            ..AppSettings::default()
        };
        let err = save_settings_sync(s).unwrap_err();
        assert!(err.contains("Git branch"), "got: {}", err);
    }

    /// URL remotes are valid `git fetch` arguments and must keep working.
    #[test]
    fn save_settings_accepts_url_remotes() {
        for remote in ["git@github.com:me/cfg.git", "https://github.com/me/cfg.git"] {
            assert!(
                validate_git_remote(remote).is_ok(),
                "{} should be accepted",
                remote
            );
        }
    }
}
