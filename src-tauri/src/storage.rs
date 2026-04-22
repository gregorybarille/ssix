use crate::models::AppData;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

static DATA_LOCK: Mutex<()> = Mutex::new(());

pub fn get_data_path() -> PathBuf {
    let home = dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".ssx").join("data.json")
}

pub fn load_data() -> Result<AppData, String> {
    let _guard = DATA_LOCK.lock().map_err(|e| e.to_string())?;
    load_data_unlocked()
}

fn load_data_unlocked() -> Result<AppData, String> {
    let path = get_data_path();
    if !path.exists() {
        return Ok(AppData::default());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut data: AppData = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    data.migrate_legacy_kinds();
    Ok(data)
}

pub fn save_data(data: &AppData) -> Result<(), String> {
    let _guard = DATA_LOCK.lock().map_err(|e| e.to_string())?;
    save_data_unlocked(data)
}

fn save_data_unlocked(data: &AppData) -> Result<(), String> {
    let path = get_data_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())?;
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
