mod agent;
mod auth_prompt;
mod backup;
mod commands;
mod forwards;
mod keychain;
mod known_hosts;
mod libssh2_ext;
mod login_wait;
mod logs;
mod models;
mod proxy;
mod reconnect;
mod remote_script;
mod session_log;
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
            backup::spawn_scheduler();
            tauri::async_runtime::spawn_blocking(commands::sftp::edit::purge_stale_copies);
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
            commands::backup::list_backups,
            commands::backup::create_backup,
            commands::backup::restore_backup,
            commands::backup::delete_backup,
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
            commands::scripts::get_scripts,
            commands::scripts::add_script,
            commands::scripts::update_script,
            commands::scripts::delete_script,
            commands::scripts::begin_script_run,
            commands::scripts::cancel_script_run,
            commands::scripts::run_script,
            commands::ssh_keygen::generate_ssh_key,
            commands::ssh_keygen::ssh_install_public_key_by_credential,
            commands::screenshot::take_screenshot,
            logs::get_logs,
            logs::clear_logs,
            // Roadmap streams append their commands under their anchor
            // (see docs/roadmap.md); keep each block together.
            // roadmap:auth
            commands::auth::ssh_auth_answer,
            commands::auth::ssh_auth_cancel,
            // roadmap:resilience
            commands::ssh::ssh_reconnect,
            commands::ssh::ssh_cancel_reconnect,
            // roadmap:forwards
            // roadmap:sftp
            commands::sftp::browse::sftp_connect,
            commands::sftp::browse::sftp_disconnect,
            commands::sftp::browse::sftp_local_home,
            commands::sftp::browse::sftp_list,
            commands::sftp::browse::sftp_mkdir,
            commands::sftp::browse::sftp_rename,
            commands::sftp::browse::sftp_delete,
            commands::sftp::browse::sftp_chmod,
            commands::sftp::transfer::sftp_start_transfer,
            commands::sftp::transfer::sftp_cancel_transfer,
            commands::sftp::edit::sftp_edit_open,
            commands::sftp::edit::sftp_edit_status,
            commands::sftp::edit::sftp_edit_launch,
            commands::sftp::edit::sftp_edit_save,
            commands::sftp::edit::sftp_edit_close,
            // roadmap:snippets
            commands::snippets::get_snippets,
            commands::snippets::add_snippet,
            commands::snippets::update_snippet,
            commands::snippets::delete_snippet,
            // roadmap:import
            // roadmap:terminal-ux
            // roadmap:folders
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                commands::sftp::edit::remove_open_copies();
            }
        });
}
