use crate::models::AppSettings;
use crate::storage::{load_data, save_data};

#[tauri::command]
pub fn get_settings() -> Result<AppSettings, String> {
    let data = load_data()?;
    Ok(data.settings)
}

#[tauri::command]
pub fn save_settings(settings: AppSettings) -> Result<AppSettings, String> {
    let mut data = load_data()?;
    data.settings = settings.clone();
    save_data(&data)?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use crate::models::AppSettings;

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
}
