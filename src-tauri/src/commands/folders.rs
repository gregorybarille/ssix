//! Moving connections between folders, and renaming and deleting folders.
//!
//! A folder exists only as a path on its connections, so each command is one
//! `with_data_mut`: everything is worked out and checked first, and a refusal
//! or a failed save leaves every connection where it was. They act on every
//! connection kind, including the forwards the folder tree does not list, so
//! a forward keeps following the folder it was filed under.

use crate::commands::blocking;
use crate::folder_path;
use crate::models::Connection;
use crate::storage::{load_data, with_data_mut};

#[tauri::command]
pub async fn move_connection_to_folder(
    id: String,
    folder: Option<String>,
) -> Result<Connection, String> {
    blocking(move || move_connection_sync(&id, folder.as_deref().unwrap_or_default())).await
}

fn move_connection_sync(id: &str, folder: &str) -> Result<Connection, String> {
    let folder = folder_path::parse(folder)?;
    with_data_mut(|data| {
        let connection = data
            .connections
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or_else(|| "Connection not found".to_string())?;
        connection.folder = folder;
        Ok(connection.clone())
    })
}

#[tauri::command]
pub async fn rename_folder(from: String, to: String) -> Result<Vec<Connection>, String> {
    blocking(move || rename_folder_sync(&from, &to)).await
}

/// The stored forms of a rename's two paths, or why it cannot happen.
pub(crate) fn check_rename(from: &str, to: &str) -> Result<(String, String), String> {
    let from = folder_path::parse_required(from)?;
    let to = folder_path::parse_required(to)?;
    if to != from && folder_path::is_within(&to, &from) {
        return Err("A folder cannot move inside itself".to_string());
    }
    Ok((from, to))
}

/// Rename `from` and everything under it. Onto a folder that already exists
/// this merges the two, the same as dragging each connection across.
fn rename_folder_sync(from: &str, to: &str) -> Result<Vec<Connection>, String> {
    let (from, to) = check_rename(from, to)?;
    if from == to {
        return Ok(load_data()?.connections);
    }
    with_data_mut(|data| {
        let mut renamed = Vec::new();
        for (index, connection) in data.connections.iter().enumerate() {
            let Some(folder) = connection.folder.as_deref() else {
                continue;
            };
            if folder_path::is_within(folder, &from) {
                let path = format!("{to}{}", &folder[from.len()..]);
                folder_path::check_limits(&path)
                    .map_err(|why| format!("{why}: {} would end up in {path}", connection.name))?;
                renamed.push((index, path));
            }
        }
        if renamed.is_empty() {
            return Err(no_such_folder(&from));
        }
        for (index, path) in renamed {
            data.connections[index].folder = Some(path);
        }
        Ok(data.connections.clone())
    })
}

#[tauri::command]
pub async fn delete_folder(path: String) -> Result<Vec<Connection>, String> {
    blocking(move || delete_folder_sync(&path)).await
}

/// Move every connection in `path` or under it up to the folder that holds
/// `path`, or out of any folder at the top. Never deletes a connection.
fn delete_folder_sync(path: &str) -> Result<Vec<Connection>, String> {
    let path = folder_path::parse_required(path)?;
    let parent = folder_path::parent(&path).map(str::to_string);
    with_data_mut(|data| {
        let mut any = false;
        for connection in &mut data.connections {
            if connection
                .folder
                .as_deref()
                .is_some_and(|folder| folder_path::is_within(folder, &path))
            {
                connection.folder.clone_from(&parent);
                any = true;
            }
        }
        if !any {
            return Err(no_such_folder(&path));
        }
        Ok(data.connections.clone())
    })
}

/// A dialog can outlive its folder, when its last connection was moved or
/// deleted while it stayed open.
fn no_such_folder(path: &str) -> String {
    format!("The folder {path} no longer exists")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ConnectionKind;
    use crate::storage::get_data_path;
    use crate::storage::test_support::with_isolated_data_dir;

    fn filed(name: &str, folder: Option<&str>, kind: ConnectionKind) -> Connection {
        let mut connection = Connection::new(name.into(), "h".into(), 22, None, kind);
        connection.folder = folder.map(str::to_string);
        connection
    }

    fn direct(name: &str, folder: Option<&str>) -> Connection {
        filed(name, folder, ConnectionKind::Direct)
    }

    fn forward(name: &str, folder: Option<&str>) -> Connection {
        filed(
            name,
            folder,
            ConnectionKind::DynamicForward {
                gateway_host: "gw".into(),
                gateway_port: 22,
                gateway_credential_id: String::new(),
                bind_address: None,
                local_port: 1080,
            },
        )
    }

    fn folder_of(connections: &[Connection], name: &str) -> Option<String> {
        connections
            .iter()
            .find(|c| c.name == name)
            .unwrap_or_else(|| panic!("{name} must still exist"))
            .folder
            .clone()
    }

    fn stored_folder(name: &str) -> Option<String> {
        folder_of(&load_data().unwrap().connections, name)
    }

    fn id_of(name: &str) -> String {
        let data = load_data().unwrap();
        let connection = data.connections.iter().find(|c| c.name == name).unwrap();
        connection.id.clone()
    }

    fn with_tree(test: impl FnOnce()) {
        with_isolated_data_dir(|| {
            with_data_mut(|data| {
                data.connections = vec![
                    direct("top", Some("prod")),
                    direct("eu", Some("prod/eu")),
                    direct("west", Some("prod/eu/west")),
                    direct("lookalike", Some("production")),
                    direct("other-case", Some("Prod")),
                    direct("loose", None),
                    forward("tunnel", Some("prod/eu")),
                ];
                Ok(())
            })
            .unwrap();
            test();
        });
    }

    #[test]
    fn move_sets_only_the_folder_and_normalizes_it() {
        with_tree(|| {
            let moved = move_connection_sync(&id_of("loose"), " /staging//a/ ").unwrap();
            assert_eq!(moved.folder.as_deref(), Some("staging/a"));
            assert_eq!(moved.name, "loose");
            assert_eq!(stored_folder("loose").as_deref(), Some("staging/a"));
            assert_eq!(stored_folder("top").as_deref(), Some("prod"));
        });
    }

    #[test]
    fn a_blank_move_clears_the_folder() {
        with_tree(|| {
            let moved = move_connection_sync(&id_of("top"), "  ").unwrap();
            assert_eq!(moved.folder, None);
            assert_eq!(stored_folder("top"), None);
        });
    }

    #[test]
    fn a_refused_move_changes_nothing() {
        with_tree(|| {
            assert_eq!(
                move_connection_sync(&id_of("top"), "a/../b").unwrap_err(),
                "A folder cannot be named . or .."
            );
            assert_eq!(stored_folder("top").as_deref(), Some("prod"));
            assert_eq!(
                move_connection_sync("gone", "a").unwrap_err(),
                "Connection not found"
            );
        });
    }

    #[test]
    fn rename_moves_the_folder_and_all_it_holds() {
        with_tree(|| {
            let connections = rename_folder_sync("prod", "staging").unwrap();
            assert_eq!(connections.len(), 7);
            assert_eq!(folder_of(&connections, "top").as_deref(), Some("staging"));
            assert_eq!(folder_of(&connections, "eu").as_deref(), Some("staging/eu"));
            assert_eq!(
                folder_of(&connections, "west").as_deref(),
                Some("staging/eu/west")
            );
            assert_eq!(stored_folder("west").as_deref(), Some("staging/eu/west"));
        });
    }

    #[test]
    fn rename_keeps_a_forward_filed_under_the_folder() {
        with_tree(|| {
            rename_folder_sync("prod", "staging").unwrap();
            assert_eq!(stored_folder("tunnel").as_deref(), Some("staging/eu"));
            let data = load_data().unwrap();
            let tunnel = data
                .connections
                .iter()
                .find(|c| c.name == "tunnel")
                .unwrap();
            assert!(matches!(tunnel.kind, ConnectionKind::DynamicForward { .. }));
        });
    }

    #[test]
    fn rename_leaves_folders_with_a_similar_name_alone() {
        with_tree(|| {
            rename_folder_sync("prod", "staging").unwrap();
            assert_eq!(stored_folder("lookalike").as_deref(), Some("production"));
            assert_eq!(stored_folder("other-case").as_deref(), Some("Prod"));
            assert_eq!(stored_folder("loose"), None);
        });
    }

    #[test]
    fn rename_can_move_a_folder_to_another_parent_or_change_its_case() {
        with_tree(|| {
            rename_folder_sync("prod/eu", "europe").unwrap();
            assert_eq!(stored_folder("eu").as_deref(), Some("europe"));
            assert_eq!(stored_folder("west").as_deref(), Some("europe/west"));
            assert_eq!(stored_folder("top").as_deref(), Some("prod"));
            rename_folder_sync("europe", "Europe").unwrap();
            assert_eq!(stored_folder("west").as_deref(), Some("Europe/west"));
        });
    }

    #[test]
    fn rename_onto_an_existing_folder_merges_without_losing_a_connection() {
        with_tree(|| {
            let connections = rename_folder_sync("production", "prod").unwrap();
            assert_eq!(connections.len(), 7);
            assert_eq!(
                folder_of(&connections, "lookalike").as_deref(),
                Some("prod")
            );
            assert_eq!(folder_of(&connections, "top").as_deref(), Some("prod"));
        });
    }

    #[test]
    fn rename_to_itself_writes_nothing() {
        with_tree(|| {
            let before = std::fs::read(get_data_path()).unwrap();
            let connections = rename_folder_sync("prod", " /prod/ ").unwrap();
            assert_eq!(connections.len(), 7);
            assert_eq!(std::fs::read(get_data_path()).unwrap(), before);
        });
    }

    #[test]
    fn a_rename_that_cannot_fit_one_connection_moves_none_of_them() {
        with_tree(|| {
            let before = std::fs::read(get_data_path()).unwrap();
            // Nine levels is fine for `prod` itself; only `prod/eu` and
            // `prod/eu/west` end up too deep.
            let why = rename_folder_sync("prod", "a/b/c/d/e/f/g/h/i").unwrap_err();
            assert!(why.contains("nest at most 10 levels"), "{why}");
            assert_eq!(std::fs::read(get_data_path()).unwrap(), before);

            // The same for a path that gets too long, however it is reached.
            let long = "y".repeat(508);
            let why = rename_folder_sync("prod", &long).unwrap_err();
            assert!(why.contains("at most 512 characters"), "{why}");
            assert_eq!(std::fs::read(get_data_path()).unwrap(), before);
            assert_eq!(stored_folder("top").as_deref(), Some("prod"));
        });
    }

    #[test]
    fn a_rename_is_refused_before_anything_is_touched() {
        with_tree(|| {
            let before = std::fs::read(get_data_path()).unwrap();
            for (from, to, why) in [
                ("prod", "prod/eu", "A folder cannot move inside itself"),
                ("prod", "", "A folder path is required"),
                ("prod", "a/../b", "A folder cannot be named . or .."),
                ("", "b", "A folder path is required"),
                ("missing", "b", "The folder missing no longer exists"),
            ] {
                assert_eq!(rename_folder_sync(from, to).unwrap_err(), why);
            }
            assert_eq!(std::fs::read(get_data_path()).unwrap(), before);
        });
    }

    /// The save itself failing must not leave a half-renamed tree in the
    /// in-memory copy that later reads are served from.
    #[cfg(unix)]
    #[test]
    fn a_failed_save_leaves_every_connection_where_it_was() {
        use std::os::unix::fs::PermissionsExt;
        with_tree(|| {
            let dir = get_data_path().parent().unwrap().to_path_buf();
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
            let renamed = rename_folder_sync("prod", "staging");
            let deleted = delete_folder_sync("prod");
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
            // Root ignores the mode, so there is nothing to learn as root.
            if renamed.is_ok() || deleted.is_ok() {
                return;
            }
            assert_eq!(stored_folder("west").as_deref(), Some("prod/eu/west"));
            assert_eq!(stored_folder("tunnel").as_deref(), Some("prod/eu"));
        });
    }

    #[test]
    fn delete_moves_everything_inside_up_one_level() {
        with_tree(|| {
            let connections = delete_folder_sync("prod/eu").unwrap();
            assert_eq!(connections.len(), 7);
            assert_eq!(folder_of(&connections, "eu").as_deref(), Some("prod"));
            assert_eq!(folder_of(&connections, "west").as_deref(), Some("prod"));
            assert_eq!(folder_of(&connections, "top").as_deref(), Some("prod"));
            assert_eq!(folder_of(&connections, "tunnel").as_deref(), Some("prod"));
        });
    }

    #[test]
    fn deleting_a_top_folder_clears_the_path_and_keeps_every_connection() {
        with_tree(|| {
            let connections = delete_folder_sync("prod").unwrap();
            assert_eq!(connections.len(), 7);
            for name in ["top", "eu", "west", "tunnel"] {
                assert_eq!(folder_of(&connections, name), None, "{name}");
            }
            assert_eq!(stored_folder("west"), None);
            assert_eq!(stored_folder("lookalike").as_deref(), Some("production"));
            assert_eq!(stored_folder("other-case").as_deref(), Some("Prod"));
        });
    }

    #[test]
    fn delete_of_a_missing_folder_is_refused() {
        with_tree(|| {
            let before = std::fs::read(get_data_path()).unwrap();
            assert_eq!(
                delete_folder_sync("missing").unwrap_err(),
                "The folder missing no longer exists"
            );
            assert_eq!(
                delete_folder_sync(" ").unwrap_err(),
                "A folder path is required"
            );
            assert_eq!(std::fs::read(get_data_path()).unwrap(), before);
        });
    }
}
