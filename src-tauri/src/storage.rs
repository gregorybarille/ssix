use crate::models::AppData;
use std::path::PathBuf;
use std::fs;

pub fn get_data_path() -> PathBuf {
    let home = dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".ssx").join("data.json")
}

pub fn load_data() -> Result<AppData, String> {
    let path = get_data_path();
    if !path.exists() {
        return Ok(AppData::default());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

pub fn save_data(data: &AppData) -> Result<(), String> {
    let path = get_data_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
