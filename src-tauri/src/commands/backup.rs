//! Local backups of `~/.ssix` (see `crate::backup`).

use crate::backup::{self, BackupInfo, BackupList, BackupReason};
use crate::commands::blocking;

#[tauri::command]
pub async fn list_backups() -> Result<BackupList, String> {
    blocking(backup::list).await
}

#[tauri::command]
pub async fn create_backup() -> Result<BackupInfo, String> {
    blocking(|| backup::create(BackupReason::Manual)).await
}

/// Returns the backup of the files the restore replaced, when there were
/// any.
#[tauri::command]
pub async fn restore_backup(name: String) -> Result<Option<BackupInfo>, String> {
    blocking(move || backup::restore(&name)).await
}

#[tauri::command]
pub async fn delete_backup(name: String) -> Result<(), String> {
    blocking(move || backup::delete(&name)).await
}
