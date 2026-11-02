pub mod auth;
pub mod backup;
pub mod connections;
pub mod credentials;
pub mod git_sync;
pub mod import_config;
pub mod scp;
pub mod screenshot;
pub mod scripts;
pub mod settings;
pub mod sftp;
pub mod snippets;
pub mod ssh;
pub mod ssh_keygen;

/// Run a blocking command body on the blocking thread pool.
///
/// Synchronous Tauri commands run on the main (UI) thread; anything that
/// does file I/O with fsync, spawns a subprocess or talks to the network
/// must go through here so the window never freezes while it works.
pub(crate) async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("Background task failed: {}", e))?
}

/// Longest name a saved script or snippet may have.
const ITEM_NAME_MAX_CHARS: usize = 128;

/// The trimmed name of a saved item, or why it cannot be used: it is required,
/// limited in length and unique among `existing` (`(id, name)` pairs), which
/// may hold the item itself (`own_id`). `kind` starts the messages ("Script").
pub(crate) fn check_item_name<'a>(
    kind: &str,
    name: &str,
    mut existing: impl Iterator<Item = (&'a str, &'a str)>,
    own_id: Option<&str>,
) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(format!("{} name is required", kind));
    }
    if name.chars().count() > ITEM_NAME_MAX_CHARS {
        return Err(format!(
            "{} name must be {} characters or fewer",
            kind, ITEM_NAME_MAX_CHARS
        ));
    }
    if existing.any(|(id, other)| other == name && Some(id) != own_id) {
        return Err(format!(
            "A {} named \"{}\" already exists",
            kind.to_lowercase(),
            name
        ));
    }
    Ok(name.to_string())
}
