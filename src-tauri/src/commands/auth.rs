//! Answers to the keyboard-interactive prompts a terminal pane shows (see
//! `crate::auth_prompt`). Neither command logs or stores what it is given.

use crate::auth_prompt;

/// Hand the answers to the connection waiting on `prompt_id`, one per field.
#[tauri::command]
pub fn ssh_auth_answer(prompt_id: String, answers: Vec<String>) -> Result<(), String> {
    auth_prompt::answer(&prompt_id, answers)
}

/// Give up on the connection waiting on `prompt_id`. A prompt that already
/// ended is not an error: closing a pane may race with its timeout.
#[tauri::command]
pub fn ssh_auth_cancel(prompt_id: String) {
    auth_prompt::cancel(&prompt_id);
}
