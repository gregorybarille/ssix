//! Saved snippets: commands the user pastes into a terminal.
//!
//! The backend only stores them. Variables, the paste itself and what happens
//! to a snippet's newlines live in `src/lib/snippets.ts`. A command is kept
//! exactly as written, because Git Sync exports it that way too.

use crate::commands::connections::normalize_tags;
use crate::commands::{blocking, check_item_name};
use crate::models::Snippet;
use crate::storage::{load_data, with_data_mut};
use serde::Deserialize;
use uuid::Uuid;

const COMMAND_MAX_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
pub struct SnippetInput {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// Check `input` against the saved snippets (other than `own_id`) and return
/// it normalized: name trimmed, tags cleaned, command untouched.
fn check_snippet(
    snippets: &[Snippet],
    own_id: Option<&str>,
    input: SnippetInput,
) -> Result<SnippetInput, String> {
    let name = check_item_name(
        "Snippet",
        &input.name,
        snippets.iter().map(|s| (s.id.as_str(), s.name.as_str())),
        own_id,
    )?;
    if input.command.trim().is_empty() {
        return Err("Command is required".to_string());
    }
    if input.command.len() > COMMAND_MAX_BYTES {
        return Err(format!(
            "Command must be {} KiB or smaller",
            COMMAND_MAX_BYTES / 1024
        ));
    }
    Ok(SnippetInput {
        name,
        command: input.command,
        tags: normalize_tags(input.tags),
    })
}

#[tauri::command]
pub fn get_snippets() -> Result<Vec<Snippet>, String> {
    Ok(load_data()?.snippets)
}

#[tauri::command]
pub async fn add_snippet(input: SnippetInput) -> Result<Snippet, String> {
    blocking(move || add_snippet_sync(input)).await
}

fn add_snippet_sync(input: SnippetInput) -> Result<Snippet, String> {
    with_data_mut(|data| {
        let input = check_snippet(&data.snippets, None, input)?;
        let snippet = Snippet {
            id: Uuid::new_v4().to_string(),
            name: input.name,
            command: input.command,
            tags: input.tags,
        };
        data.snippets.push(snippet.clone());
        Ok(snippet)
    })
}

#[tauri::command]
pub async fn update_snippet(id: String, input: SnippetInput) -> Result<Snippet, String> {
    blocking(move || update_snippet_sync(id, input)).await
}

fn update_snippet_sync(id: String, input: SnippetInput) -> Result<Snippet, String> {
    with_data_mut(|data| {
        let input = check_snippet(&data.snippets, Some(&id), input)?;
        let snippet = data
            .snippets
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| "Snippet not found".to_string())?;
        snippet.name = input.name;
        snippet.command = input.command;
        snippet.tags = input.tags;
        Ok(snippet.clone())
    })
}

#[tauri::command]
pub async fn delete_snippet(id: String) -> Result<(), String> {
    blocking(move || delete_snippet_sync(id)).await
}

fn delete_snippet_sync(id: String) -> Result<(), String> {
    with_data_mut(|data| {
        data.snippets.retain(|s| s.id != id);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::with_isolated_data_dir;

    fn input(name: &str, command: &str) -> SnippetInput {
        SnippetInput {
            name: name.to_string(),
            command: command.to_string(),
            tags: Vec::new(),
        }
    }

    #[test]
    fn add_generates_an_id_and_persists() {
        with_isolated_data_dir(|| {
            let a = add_snippet_sync(input("a", "uptime")).unwrap();
            let b = add_snippet_sync(input("b", "uptime")).unwrap();
            assert!(Uuid::parse_str(&a.id).is_ok(), "got: {}", a.id);
            assert_ne!(a.id, b.id);
            assert_eq!(get_snippets().unwrap(), vec![a, b]);
        });
    }

    #[test]
    fn the_name_is_trimmed_and_the_command_kept_as_written() {
        with_isolated_data_dir(|| {
            let s = add_snippet_sync(input("  tail  ", "  tail -f {{file}}\nls\n")).unwrap();
            assert_eq!(s.name, "tail");
            assert_eq!(s.command, "  tail -f {{file}}\nls\n");
        });
    }

    #[test]
    fn tags_are_trimmed_and_deduped() {
        with_isolated_data_dir(|| {
            let s = add_snippet_sync(SnippetInput {
                tags: vec![" ops ".into(), "OPS".into(), "".into(), "db".into()],
                ..input("a", "uptime")
            })
            .unwrap();
            assert_eq!(s.tags, vec!["ops".to_string(), "db".to_string()]);
        });
    }

    #[test]
    fn tags_are_optional_in_the_payload() {
        let parsed: SnippetInput = serde_json::from_str(r#"{"name":"a","command":"ls"}"#).unwrap();
        assert!(parsed.tags.is_empty());
    }

    #[test]
    fn a_blank_name_or_command_is_refused() {
        with_isolated_data_dir(|| {
            let err = add_snippet_sync(input("  ", "uptime")).unwrap_err();
            assert!(err.contains("name is required"), "got: {}", err);
            let err = add_snippet_sync(input("a", " \n\t")).unwrap_err();
            assert!(err.contains("Command is required"), "got: {}", err);
            assert!(get_snippets().unwrap().is_empty());
        });
    }

    #[test]
    fn long_names_and_commands_are_refused() {
        with_isolated_data_dir(|| {
            let err = add_snippet_sync(input(&"n".repeat(129), "uptime")).unwrap_err();
            assert!(err.contains("128 characters"), "got: {}", err);
            let err = add_snippet_sync(input("a", &"x".repeat(COMMAND_MAX_BYTES + 1))).unwrap_err();
            assert!(err.contains("64 KiB"), "got: {}", err);
            add_snippet_sync(input("a", &"x".repeat(COMMAND_MAX_BYTES))).unwrap();
        });
    }

    #[test]
    fn names_are_unique_but_a_snippet_keeps_its_own() {
        with_isolated_data_dir(|| {
            let a = add_snippet_sync(input("a", "ls")).unwrap();
            add_snippet_sync(input("b", "ls")).unwrap();
            let err = add_snippet_sync(input("a", "ls")).unwrap_err();
            assert!(err.contains("already exists"), "got: {}", err);
            let err = update_snippet_sync(a.id.clone(), input("b", "ls")).unwrap_err();
            assert!(err.contains("already exists"), "got: {}", err);
            update_snippet_sync(a.id, input("a", "pwd")).unwrap();
        });
    }

    #[test]
    fn update_replaces_the_fields_and_keeps_the_id() {
        with_isolated_data_dir(|| {
            let a = add_snippet_sync(SnippetInput {
                tags: vec!["old".into()],
                ..input("a", "ls")
            })
            .unwrap();
            let updated = update_snippet_sync(
                a.id.clone(),
                SnippetInput {
                    tags: vec!["new".into()],
                    ..input("b", "pwd")
                },
            )
            .unwrap();
            assert_eq!(updated.id, a.id);
            assert_eq!(updated.name, "b");
            assert_eq!(updated.command, "pwd");
            assert_eq!(updated.tags, vec!["new".to_string()]);
            assert_eq!(get_snippets().unwrap(), vec![updated]);
        });
    }

    #[test]
    fn updating_an_unknown_snippet_fails() {
        with_isolated_data_dir(|| {
            let err = update_snippet_sync("nope".into(), input("a", "ls")).unwrap_err();
            assert_eq!(err, "Snippet not found");
        });
    }

    #[test]
    fn delete_removes_only_that_snippet() {
        with_isolated_data_dir(|| {
            let a = add_snippet_sync(input("a", "ls")).unwrap();
            let b = add_snippet_sync(input("b", "ls")).unwrap();
            delete_snippet_sync(a.id).unwrap();
            assert_eq!(get_snippets().unwrap(), vec![b]);
            delete_snippet_sync("nope".into()).unwrap();
        });
    }
}
