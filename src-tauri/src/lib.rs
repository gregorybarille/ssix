mod commands;
mod storage;
mod models;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::credentials::get_credentials,
            commands::credentials::add_credential,
            commands::credentials::update_credential,
            commands::credentials::delete_credential,
            commands::connections::get_connections,
            commands::connections::add_connection,
            commands::connections::update_connection,
            commands::connections::delete_connection,
            commands::connections::clone_connection,
            commands::connections::search_connections,
            commands::settings::get_settings,
            commands::settings::save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
