mod commands;
mod keychain;
mod known_hosts;
mod logs;
mod models;
mod proxy;
mod ssh;
mod ssh_debug;
mod storage;

use ssh::SshState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SshState::new())
        .setup(|app| {
            logs::init(app.handle().clone());
            // Write any load-time repair once, off the UI thread.
            tauri::async_runtime::spawn_blocking(|| {
                if let Err(e) = storage::persist_migrations() {
                    logs::log_local(
                        "warn",
                        "migration",
                        format!("Could not save the repaired data: {e}"),
                    );
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::credentials::get_credentials,
            commands::credentials::get_credential_secrets,
            commands::credentials::add_credential,
            commands::credentials::update_credential,
            commands::credentials::delete_credential,
            commands::connections::get_connections,
            commands::connections::add_connection,
            commands::connections::update_connection,
            commands::connections::delete_connection,
            commands::connections::clone_connection,
            commands::connections::get_orphan_private_credential,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::git_sync::git_sync_status,
            commands::git_sync::git_sync_export_snapshot,
            commands::git_sync::git_sync_diff,
            commands::git_sync::git_sync_fetch,
            commands::git_sync::git_sync_pull,
            commands::git_sync::git_sync_push,
            commands::git_sync::git_sync_commit,
            commands::git_sync::git_sync_run,
            commands::ssh::ssh_connect,
            commands::ssh::ssh_write,
            commands::ssh::ssh_resize,
            commands::ssh::ssh_disconnect,
            commands::ssh::ssh_forget_host_key,
            commands::scp::scp_upload,
            commands::scp::scp_download,
            commands::ssh_keygen::generate_ssh_key,
            commands::ssh_keygen::ssh_install_public_key_by_credential,
            commands::screenshot::take_screenshot,
            logs::get_logs,
            logs::clear_logs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
