pub mod backup;
pub mod connections;
pub mod credentials;
pub mod git_sync;
pub mod scp;
pub mod screenshot;
pub mod scripts;
pub mod settings;
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
