use crate::commands::blocking;
use crate::commands::git_sync::validate_git_name;
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

fn save_settings_sync(settings: AppSettings) -> Result<AppSettings, String> {
    validate_git_name(&settings.git_sync_remote, "Git remote")?;
    if let Some(branch) = settings.git_sync_branch.as_deref() {
        if !branch.trim().is_empty() {
            validate_git_name(branch, "Git branch")?;
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
}
