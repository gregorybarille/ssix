use crate::commands::blocking;
use crate::models::{AppData, Connection, ConnectionKind, Credential, CredentialKind};
use crate::storage::{load_data, with_data_mut};
use serde::Deserialize;
use uuid::Uuid;

/// Audit-4 Dup H3: shared field set between AddConnectionInput and
/// UpdateConnectionInput. Previously these two structs duplicated 9
/// fields verbatim — adding a new connection attribute required editing
/// both sites and the test suite couldn't catch a drift if only one was
/// updated. `#[serde(flatten)]` keeps the wire format identical.
#[derive(Debug, Deserialize)]
pub struct ConnectionFields {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub credential_id: Option<String>,
    #[serde(flatten)]
    pub kind: ConnectionKind,
    #[serde(default)]
    pub verbosity: u8,
    #[serde(default)]
    pub extra_args: Option<String>,
    #[serde(default)]
    pub login_command: Option<String>,
    #[serde(default)]
    pub remote_path: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AddConnectionInput {
    #[serde(flatten)]
    pub fields: ConnectionFields,
}

#[derive(Debug, Deserialize)]
pub struct UpdateConnectionInput {
    pub id: String,
    #[serde(flatten)]
    pub fields: ConnectionFields,
}

/// A clone is the clone form's whole connection, saved as a new one. `id`
/// names the original, which must still exist.
#[derive(Debug, Deserialize)]
pub struct CloneConnectionInput {
    pub id: String,
    #[serde(flatten)]
    pub fields: ConnectionFields,
}

#[tauri::command]
pub fn get_connections() -> Result<Vec<Connection>, String> {
    let data = load_data()?;
    Ok(data.connections)
}

/// Audit-4 H6: validate user-provided connection fields BEFORE we mutate
/// state. Without this, the frontend was the only line of defence — a
/// hand-crafted IPC call (or a future programmatic caller) could persist
/// blank names, blank hosts, or port 0, then silently fail at SSH-connect
/// time with a confusing error.
fn validate_connection_fields(name: &str, host: &str, port: u16) -> Result<(), String> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("Connection name is required".to_string());
    }
    if trimmed_name.chars().count() > 128 {
        return Err("Connection name must be 128 characters or fewer".to_string());
    }
    if host.trim().is_empty() {
        return Err("Host is required".to_string());
    }
    if port == 0 {
        return Err("Port must be between 1 and 65535".to_string());
    }
    Ok(())
}

/// Every kind that opens a shell needs a credential for it, and each
/// credential a connection names must exist. Otherwise the connection
/// saves fine and only fails once the user tries to connect.
/// `delete_credential` refuses a credential in use and loading clears old
/// dangling references, so a missing id here means the credential was
/// deleted while a form that had picked it was still open.
fn validate_connection_credentials(
    credentials: &[Credential],
    credential_id: Option<&str>,
    kind: &ConnectionKind,
) -> Result<(), String> {
    // `label` starts mid-sentence; the "is required" message capitalizes it.
    let check = |label: &str, id: Option<&str>| match id.filter(|id| !id.is_empty()) {
        None => {
            let mut chars = label.chars();
            let first = chars.next().map(|c| c.to_uppercase().collect::<String>());
            Err(format!(
                "{}{} is required",
                first.unwrap_or_default(),
                chars.as_str()
            ))
        }
        Some(id) if !credentials.iter().any(|c| c.id == id) => {
            Err(format!("The selected {label} no longer exists"))
        }
        Some(_) => Ok(()),
    };
    match kind {
        ConnectionKind::Direct => check("credential", credential_id),
        ConnectionKind::JumpShell {
            gateway_credential_id,
            ..
        } => {
            check("jump host credential", Some(gateway_credential_id))?;
            check("target credential", credential_id)
        }
        ConnectionKind::PortForward {
            gateway_credential_id,
            ..
        } => check("SSH server credential", Some(gateway_credential_id)),
        // Old files are migrated to JumpShell on load; the variant still
        // deserializes, so a request carrying it must not be stored.
        ConnectionKind::LegacyTunnel { .. } => {
            Err("Legacy tunnel connections can no longer be saved".to_string())
        }
    }
}

#[tauri::command]
pub async fn add_connection(input: AddConnectionInput) -> Result<Connection, String> {
    blocking(move || add_connection_sync(input)).await
}

fn add_connection_sync(input: AddConnectionInput) -> Result<Connection, String> {
    let mut f = input.fields;
    with_data_mut(|data| {
        check_connection(data, &mut f, None)?;
        Ok(insert_new_connection(data, f))
    })
}

/// Every check a saved connection must pass, shared by add, clone and
/// update. Trims the name first, so " web" is stored as, and clashes with,
/// "web". `editing` is the id of the connection being updated, whose own
/// name is not a clash.
fn check_connection(
    data: &AppData,
    f: &mut ConnectionFields,
    editing: Option<&str>,
) -> Result<(), String> {
    f.name = f.name.trim().to_string();
    validate_connection_fields(&f.name, &f.host, f.port)?;
    if data
        .connections
        .iter()
        .any(|c| c.name.trim() == f.name && Some(c.id.as_str()) != editing)
    {
        return Err(format!("A connection named '{}' already exists", f.name));
    }
    validate_connection_credentials(&data.credentials, f.credential_id.as_deref(), &f.kind)
}

/// Store `f`, already checked, as a new connection: shared by add and
/// clone, so a clone gets exactly the normalization a new connection gets.
fn insert_new_connection(data: &mut AppData, f: ConnectionFields) -> Connection {
    let mut connection = Connection::new(f.name, f.host, f.port, f.credential_id, f.kind);
    connection.verbosity = f.verbosity;
    connection.extra_args = f.extra_args;
    connection.login_command = normalize_optional_text(f.login_command);
    connection.remote_path = normalize_remote_path(f.remote_path);
    connection.tags = normalize_tags(f.tags);
    connection.color = f.color;
    data.connections.push(connection.clone());
    connection
}

#[tauri::command]
pub async fn update_connection(input: UpdateConnectionInput) -> Result<Connection, String> {
    blocking(move || update_connection_sync(input)).await
}

fn update_connection_sync(input: UpdateConnectionInput) -> Result<Connection, String> {
    let (updated, orphaned_private) = with_data_mut(|data| apply_update(data, input))?;
    // Secrets go only once the save succeeded: deleting them inside the
    // transaction would leave a failed save pointing at a credential with
    // no password, hidden from the user.
    if let Some(old_id) = orphaned_private {
        crate::keychain::delete_all_for_credential(&old_id);
    }
    Ok(updated)
}

/// The edit itself, on the loaded data. Never touches the keychain: a
/// private credential the edit leaves unused is removed from `data` and its
/// id returned, for the caller to delete its secrets after the save.
fn apply_update(
    data: &mut AppData,
    input: UpdateConnectionInput,
) -> Result<(Connection, Option<String>), String> {
    let id = input.id;
    let mut f = input.fields;
    let mut orphaned_private: Option<String> = None;
    check_connection(data, &mut f, Some(&id))?;
    let idx = data
        .connections
        .iter()
        .position(|c| c.id == id)
        .ok_or_else(|| "Connection not found".to_string())?;

    // Capture the old credential_id before overwriting so we can clean up
    // an orphaned private credential if the auth method changes.
    let old_cred_id = data.connections[idx].credential_id.clone();

    data.connections[idx].name = f.name;
    data.connections[idx].host = f.host;
    data.connections[idx].port = f.port;
    data.connections[idx].credential_id = f.credential_id.clone();
    data.connections[idx].kind = f.kind;
    data.connections[idx].verbosity = f.verbosity;
    data.connections[idx].extra_args = f.extra_args;
    data.connections[idx].login_command = normalize_optional_text(f.login_command);
    data.connections[idx].remote_path = normalize_remote_path(f.remote_path);
    data.connections[idx].tags = normalize_tags(f.tags);
    data.connections[idx].color = f.color;
    let updated = data.connections[idx].clone();

    // If the credential changed and the old one was private, check whether it
    // is still referenced by another connection. If not, delete it so it
    // doesn't become an invisible orphan.
    if let Some(ref old_id) = old_cred_id {
        if f.credential_id.as_deref() != Some(old_id.as_str()) {
            let is_private = data
                .credentials
                .iter()
                .any(|c| c.id == *old_id && c.is_private);
            if is_private {
                let still_referenced = data
                    .connections
                    .iter()
                    .any(|c| c.credential_ids().any(|id| id == old_id));
                if !still_referenced {
                    data.credentials.retain(|c| c.id != *old_id);
                    orphaned_private = Some(old_id.clone());
                }
            }
        }
    }
    Ok((updated, orphaned_private))
}

#[tauri::command]
pub async fn delete_connection(id: String) -> Result<(), String> {
    blocking(move || {
        with_data_mut(|data| {
            data.connections.retain(|c| c.id != id);
            Ok(())
        })
    })
    .await
}

/// Returns the ID of the private credential associated with the given connection
/// if that credential would become an orphan (not referenced by any other
/// connection) when the connection is deleted.  Returns `None` if there is no
/// private credential or if other connections still reference it.
#[tauri::command]
pub fn get_orphan_private_credential(conn_id: String) -> Result<Option<String>, String> {
    let data = load_data()?;
    let conn = data
        .connections
        .iter()
        .find(|c| c.id == conn_id)
        .ok_or_else(|| "Connection not found".to_string())?;
    if let Some(ref cred_id) = conn.credential_id {
        let is_private = data
            .credentials
            .iter()
            .any(|c| c.id == *cred_id && c.is_private);
        if is_private {
            let other_refs = data
                .connections
                .iter()
                .filter(|c| c.id != conn_id && c.credential_ids().any(|id| id == cred_id))
                .count();
            if other_refs == 0 {
                return Ok(Some(cred_id.clone()));
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn clone_connection(input: CloneConnectionInput) -> Result<Connection, String> {
    blocking(move || clone_connection_sync(input)).await
}

fn clone_connection_sync(input: CloneConnectionInput) -> Result<Connection, String> {
    let mut f = input.fields;

    // When the clone duplicates a private credential its secrets are
    // written inside the `with_data_mut` closure, but data.json is only
    // committed after the closure returns. Remember the new id so a failed
    // save can remove the orphaned keychain entry.
    let mut created_private_credential: Option<String> = None;

    let result = with_data_mut(|data| {
        if !data.connections.iter().any(|c| c.id == input.id) {
            return Err("Connection not found".to_string());
        }
        // Refuse a bad clone before any secret is copied.
        check_connection(data, &mut f, None)?;
        // A private credential belongs to one connection (it is created by
        // the inline auth tabs and hidden from the list), so a clone that
        // names one another connection uses gets its own copy instead of
        // sharing it. One no connection uses yet is the private credential
        // the clone form just created for its own inline auth, and is used
        // as is.
        let private = f
            .credential_id
            .as_deref()
            .filter(|cred_id| {
                data.connections
                    .iter()
                    .any(|c| c.credential_ids().any(|id| id == *cred_id))
            })
            .and_then(|cred_id| {
                data.credentials
                    .iter()
                    .find(|c| c.id == cred_id && c.is_private)
                    .cloned()
            });
        if let Some(orig_cred) = private {
            let new_cred_id = Uuid::new_v4().to_string();
            // Copy every secret in one read and one write.
            let secrets = crate::keychain::snapshot_for_credential(&orig_cred.id)?;
            if matches!(orig_cred.kind, CredentialKind::Password { .. })
                && secrets.password.is_none()
            {
                return Err("Failed to read password from secrets store while duplicating private credential".to_string());
            }
            crate::keychain::replace_for_credential(&new_cred_id, &secrets)?;
            created_private_credential = Some(new_cred_id.clone());
            let mut copy = Credential {
                id: new_cred_id.clone(),
                ..orig_cred
            };
            // The secrets live in the keychain; data.json keeps placeholders.
            crate::commands::credentials::redact_secrets(&mut copy);
            data.credentials.push(copy);
            f.credential_id = Some(new_cred_id);
        }
        Ok(insert_new_connection(data, f))
    });

    // If with_data_mut failed (validation Err from the closure, or a
    // save_data failure after it ran), strip the keychain entry we created
    // so the next run doesn't see ghost secrets.
    if result.is_err() {
        if let Some(id) = created_private_credential {
            crate::keychain::delete_all_for_credential(&id);
        }
    }

    result
}

/// Trim, drop empties, and dedupe a tag vector while preserving first-seen order.
fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for t in tags {
        let trimmed = t.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        let key = trimmed.to_lowercase();
        if seen.insert(key) {
            out.push(trimmed);
        }
    }
    out
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_remote_path(value: Option<String>) -> Option<String> {
    normalize_optional_text(value).map(|path| path.replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Connection, ConnectionKind, Credential, CredentialKind};
    use crate::storage::test_support::with_isolated_data_dir;

    fn password_credential(name: &str) -> Credential {
        Credential::new(
            name.to_string(),
            "root".to_string(),
            CredentialKind::Password {
                password: String::new(),
            },
        )
    }

    fn jump_kind(gateway_credential_id: &str) -> ConnectionKind {
        ConnectionKind::JumpShell {
            gateway_host: "gw".to_string(),
            gateway_port: 22,
            gateway_credential_id: gateway_credential_id.to_string(),
            destination_host: "db".to_string(),
            destination_port: 22,
        }
    }

    fn port_forward_kind(gateway_credential_id: &str) -> ConnectionKind {
        ConnectionKind::PortForward {
            gateway_host: "gw".to_string(),
            gateway_port: 22,
            gateway_credential_id: gateway_credential_id.to_string(),
            local_port: 15432,
            destination_host: "db".to_string(),
            destination_port: 5432,
        }
    }

    fn direct_fields(credential_id: Option<String>) -> ConnectionFields {
        ConnectionFields {
            name: "web".to_string(),
            host: "10.0.0.1".to_string(),
            port: 22,
            credential_id,
            kind: ConnectionKind::Direct,
            verbosity: 0,
            extra_args: None,
            login_command: None,
            remote_path: None,
            tags: Vec::new(),
            color: None,
        }
    }

    #[test]
    fn test_validate_credentials_requires_one_for_shell_kinds() {
        let creds = vec![password_credential("a")];
        let id = creds[0].id.as_str();
        let direct = ConnectionKind::Direct;
        let required = |msg: &str| Err(msg.to_string());
        assert_eq!(
            validate_connection_credentials(&creds, None, &direct),
            required("Credential is required")
        );
        assert_eq!(
            validate_connection_credentials(&creds, Some(""), &direct),
            required("Credential is required")
        );
        assert_eq!(
            validate_connection_credentials(&creds, None, &jump_kind(id)),
            required("Target credential is required")
        );
        assert_eq!(
            validate_connection_credentials(&creds, Some(id), &jump_kind("")),
            required("Jump host credential is required")
        );
        assert!(validate_connection_credentials(&creds, Some(id), &direct).is_ok());
        assert!(validate_connection_credentials(&creds, Some(id), &jump_kind(id)).is_ok());
        // A port forward only authenticates to its gateway.
        assert!(validate_connection_credentials(&creds, None, &port_forward_kind(id)).is_ok());
    }

    #[test]
    fn test_validate_credentials_rejects_deleted_references() {
        let creds = vec![password_credential("a")];
        let id = creds[0].id.as_str();
        assert_eq!(
            validate_connection_credentials(&creds, Some("gone"), &ConnectionKind::Direct),
            Err("The selected credential no longer exists".to_string())
        );
        assert_eq!(
            validate_connection_credentials(&creds, Some("gone"), &jump_kind(id)),
            Err("The selected target credential no longer exists".to_string())
        );
        assert_eq!(
            validate_connection_credentials(&creds, None, &port_forward_kind("gone")),
            Err("The selected SSH server credential no longer exists".to_string())
        );
    }

    fn store_credential(cred: &Credential) {
        with_data_mut(|data| {
            data.credentials.push(cred.clone());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn test_add_update_and_clone_enforce_credentials() {
        with_isolated_data_dir(|| {
            let cred = password_credential("a");
            store_credential(&cred);

            let err = add_connection_sync(AddConnectionInput {
                fields: direct_fields(None),
            })
            .unwrap_err();
            assert_eq!(err, "Credential is required");

            let conn = add_connection_sync(AddConnectionInput {
                fields: direct_fields(Some(cred.id.clone())),
            })
            .unwrap();

            let err = update_connection_sync(UpdateConnectionInput {
                id: conn.id.clone(),
                fields: direct_fields(Some("gone".to_string())),
            })
            .unwrap_err();
            assert_eq!(err, "The selected credential no longer exists");

            let mut clone_fields = direct_fields(None);
            clone_fields.name = "web copy".to_string();
            let err = clone_connection_sync(CloneConnectionInput {
                id: conn.id.clone(),
                fields: clone_fields,
            })
            .unwrap_err();
            assert_eq!(err, "Credential is required");

            let data = load_data().unwrap();
            assert_eq!(data.connections.len(), 1);
            assert_eq!(
                data.connections[0].credential_id.as_deref(),
                Some(cred.id.as_str())
            );
        });
    }

    #[test]
    fn test_clone_saves_the_whole_form() {
        with_isolated_data_dir(|| {
            let gateway = password_credential("gateway");
            let new_gateway = password_credential("new-gateway");
            let dest = password_credential("dest");
            for c in [&gateway, &new_gateway, &dest] {
                store_credential(c);
            }
            let mut fields = direct_fields(Some(dest.id.clone()));
            fields.kind = jump_kind(&gateway.id);
            let original = add_connection_sync(AddConnectionInput { fields }).unwrap();

            let mut fields = direct_fields(Some(dest.id.clone()));
            fields.name = "web copy".to_string();
            fields.kind = jump_kind(&new_gateway.id);
            fields.tags = vec![" prod ".to_string()];
            fields.verbosity = 2;
            let clone = clone_connection_sync(CloneConnectionInput {
                id: original.id.clone(),
                fields,
            })
            .unwrap();

            assert_ne!(clone.id, original.id);
            assert_eq!(clone.tags, vec!["prod".to_string()]);
            assert_eq!(clone.verbosity, 2);
            match clone.kind {
                ConnectionKind::JumpShell {
                    gateway_credential_id,
                    ..
                } => assert_eq!(gateway_credential_id, new_gateway.id),
                other => panic!("expected a jump shell, got {other:?}"),
            }
            // Shared named credentials stay shared.
            assert_eq!(clone.credential_id.as_deref(), Some(dest.id.as_str()));
        });
    }

    /// Clone `original_id` as "web copy" naming the private credential
    /// `cred_id`, and return the id of the copy the clone got instead.
    fn clone_with_credential(original_id: &str, cred_id: &str) -> String {
        let mut fields = direct_fields(Some(cred_id.to_string()));
        fields.name = "web copy".to_string();
        let clone = clone_connection_sync(CloneConnectionInput {
            id: original_id.to_string(),
            fields,
        })
        .unwrap();
        let copy_id = clone.credential_id.expect("clone keeps a credential");
        assert_ne!(copy_id, cred_id);
        copy_id
    }

    #[test]
    fn test_clone_copies_a_private_credential() {
        with_isolated_data_dir(|| {
            let private = private_credential("inline-x");
            let original = add_connection_sync(AddConnectionInput {
                fields: direct_fields(Some(private.id.clone())),
            })
            .unwrap();

            let copy_id = clone_with_credential(&original.id, &private.id);
            let data = load_data().unwrap();
            let copy = data.credentials.iter().find(|c| c.id == copy_id).unwrap();
            assert!(copy.is_private);
            assert_eq!(
                crate::keychain::snapshot_for_credential(&copy_id)
                    .unwrap()
                    .password
                    .as_deref(),
                Some("s3cret")
            );
        });
    }

    /// Any connection's private credential is copied, not only the
    /// original's: sharing it would tie two connections to one inline auth.
    #[test]
    fn test_clone_copies_another_connections_private_credential() {
        with_isolated_data_dir(|| {
            let named = password_credential("named");
            store_credential(&named);
            let original = add_connection_sync(AddConnectionInput {
                fields: direct_fields(Some(named.id.clone())),
            })
            .unwrap();
            let private = private_credential("inline-other");
            let mut fields = direct_fields(Some(private.id.clone()));
            fields.name = "other".to_string();
            add_connection_sync(AddConnectionInput { fields }).unwrap();

            clone_with_credential(&original.id, &private.id);
            assert_eq!(load_data().unwrap().credentials.len(), 3);
        });
    }

    /// Names are trimmed before they are checked and stored, so padding
    /// neither survives a save nor slips past the clash check.
    #[test]
    fn test_connection_names_are_trimmed() {
        with_isolated_data_dir(|| {
            let cred = password_credential("a");
            store_credential(&cred);
            let mut fields = direct_fields(Some(cred.id.clone()));
            fields.name = "  web  ".to_string();
            let conn = add_connection_sync(AddConnectionInput { fields }).unwrap();
            assert_eq!(conn.name, "web");

            let mut fields = direct_fields(Some(cred.id.clone()));
            fields.name = "web ".to_string();
            let err = add_connection_sync(AddConnectionInput { fields }).unwrap_err();
            assert_eq!(err, "A connection named 'web' already exists");

            let mut fields = direct_fields(Some(cred.id.clone()));
            fields.name = " web".to_string();
            let err = clone_connection_sync(CloneConnectionInput {
                id: conn.id.clone(),
                fields,
            })
            .unwrap_err();
            assert_eq!(err, "A connection named 'web' already exists");

            // Re-saving the connection under its own padded name is no clash.
            let mut fields = direct_fields(Some(cred.id.clone()));
            fields.name = " web\t".to_string();
            let updated = update_connection_sync(UpdateConnectionInput {
                id: conn.id,
                fields,
            })
            .unwrap();
            assert_eq!(updated.name, "web");
        });
    }

    fn private_credential(name: &str) -> Credential {
        let mut cred = password_credential(name);
        cred.is_private = true;
        store_credential(&cred);
        crate::keychain::replace_for_credential(
            &cred.id,
            &crate::models::CredentialSecrets {
                password: Some("s3cret".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        cred
    }

    #[test]
    fn test_clone_keeps_the_inline_credential_its_form_created() {
        with_isolated_data_dir(|| {
            let original_cred = private_credential("inline-original");
            let original = add_connection_sync(AddConnectionInput {
                fields: direct_fields(Some(original_cred.id.clone())),
            })
            .unwrap();
            // The clone form's Password tab made this one for the clone.
            let form_cred = private_credential("inline-clone");

            let mut fields = direct_fields(Some(form_cred.id.clone()));
            fields.name = "web copy".to_string();
            let clone = clone_connection_sync(CloneConnectionInput {
                id: original.id,
                fields,
            })
            .unwrap();

            assert_eq!(clone.credential_id.as_deref(), Some(form_cred.id.as_str()));
            assert_eq!(load_data().unwrap().credentials.len(), 2);
        });
    }

    #[test]
    fn test_refused_clone_copies_no_secret() {
        with_isolated_data_dir(|| {
            let cred = private_credential("inline-original");
            let original = add_connection_sync(AddConnectionInput {
                fields: direct_fields(Some(cred.id.clone())),
            })
            .unwrap();
            // Same name as the original: refused before the copy.
            let err = clone_connection_sync(CloneConnectionInput {
                id: original.id,
                fields: direct_fields(Some(cred.id.clone())),
            })
            .unwrap_err();
            assert_eq!(err, "A connection named 'web' already exists");
            assert_eq!(load_data().unwrap().credentials.len(), 1);
            let secrets = std::fs::read_to_string(crate::keychain::secrets_path()).unwrap();
            assert_eq!(secrets.matches("s3cret").count(), 1);
        });
    }

    #[test]
    fn test_orphan_check_counts_gateway_use() {
        with_isolated_data_dir(|| {
            let cred = private_credential("inline-shared");
            let direct = add_connection_sync(AddConnectionInput {
                fields: direct_fields(Some(cred.id.clone())),
            })
            .unwrap();
            assert_eq!(
                get_orphan_private_credential(direct.id.clone()).unwrap(),
                Some(cred.id.clone())
            );

            let other = password_credential("dest");
            store_credential(&other);
            let mut fields = direct_fields(Some(other.id.clone()));
            fields.name = "jump".to_string();
            fields.kind = jump_kind(&cred.id);
            add_connection_sync(AddConnectionInput { fields }).unwrap();
            // Still the jump shell's gateway credential: not an orphan.
            assert_eq!(get_orphan_private_credential(direct.id).unwrap(), None);
        });
    }

    #[test]
    fn test_update_deletes_a_replaced_private_credential_only_after_the_save() {
        with_isolated_data_dir(|| {
            let private = private_credential("inline-x");
            let saved = password_credential("saved");
            store_credential(&saved);
            let conn = add_connection_sync(AddConnectionInput {
                fields: direct_fields(Some(private.id.clone())),
            })
            .unwrap();
            let secrets = crate::keychain::secrets_path();

            // The transaction alone drops the credential but keeps its
            // secrets, so a save that then fails loses nothing.
            let mut data = load_data().unwrap();
            let (_, orphaned) = apply_update(
                &mut data,
                UpdateConnectionInput {
                    id: conn.id.clone(),
                    fields: direct_fields(Some(saved.id.clone())),
                },
            )
            .unwrap();
            assert_eq!(orphaned.as_deref(), Some(private.id.as_str()));
            assert!(!data.credentials.iter().any(|c| c.id == private.id));
            assert!(std::fs::read_to_string(&secrets)
                .unwrap()
                .contains("s3cret"));

            // The command deletes them once the save went through.
            update_connection_sync(UpdateConnectionInput {
                id: conn.id,
                fields: direct_fields(Some(saved.id.clone())),
            })
            .unwrap();
            assert!(!std::fs::read_to_string(&secrets)
                .unwrap()
                .contains("s3cret"));
        });
    }

    #[test]
    fn test_clone_of_a_missing_connection_is_refused() {
        with_isolated_data_dir(|| {
            let cred = password_credential("a");
            store_credential(&cred);
            let err = clone_connection_sync(CloneConnectionInput {
                id: "gone".to_string(),
                fields: direct_fields(Some(cred.id.clone())),
            })
            .unwrap_err();
            assert_eq!(err, "Connection not found");
        });
    }

    #[test]
    fn test_legacy_tunnel_kind_is_never_stored() {
        let creds = vec![password_credential("a")];
        let legacy = ConnectionKind::LegacyTunnel {
            gateway_host: "gw".to_string(),
            gateway_port: 22,
            gateway_credential_id: None,
            destination_host: "db".to_string(),
            destination_port: 22,
        };
        assert_eq!(
            validate_connection_credentials(&creds, Some(creds[0].id.as_str()), &legacy),
            Err("Legacy tunnel connections can no longer be saved".to_string())
        );
    }

    #[test]
    fn test_normalize_tags_dedupes_and_trims() {
        let tags = vec![
            "  Prod  ".to_string(),
            "prod".to_string(),
            "DB".to_string(),
            "".to_string(),
            "db".to_string(),
            "us-east".to_string(),
        ];
        let out = normalize_tags(tags);
        assert_eq!(
            out,
            vec!["Prod".to_string(), "DB".to_string(), "us-east".to_string()]
        );
    }

    #[test]
    fn test_connection_new() {
        let conn = Connection::new(
            "prod".to_string(),
            "192.168.1.1".to_string(),
            22,
            None,
            ConnectionKind::Direct,
        );
        assert_eq!(conn.name, "prod");
        assert_eq!(conn.port, 22);
        assert!(!conn.id.is_empty());
        assert!(conn.tags.is_empty());
        assert!(conn.color.is_none());
    }

    #[test]
    fn test_connection_jump_shell() {
        let kind = ConnectionKind::JumpShell {
            gateway_host: "gateway.example.com".to_string(),
            gateway_port: 22,
            gateway_credential_id: "gw-cred-1".to_string(),
            destination_host: "internal.example.com".to_string(),
            destination_port: 22,
        };
        let conn = Connection::new(
            "jump-prod".to_string(),
            "internal.example.com".to_string(),
            22,
            Some("dest-cred-1".to_string()),
            kind,
        );
        assert_eq!(conn.name, "jump-prod");
    }

    #[test]
    fn test_connection_port_forward() {
        let kind = ConnectionKind::PortForward {
            gateway_host: "gateway.example.com".to_string(),
            gateway_port: 22,
            gateway_credential_id: "gw-cred-1".to_string(),
            local_port: 8080,
            destination_host: "api.internal".to_string(),
            destination_port: 80,
        };
        let conn = Connection::new(
            "forward-api".to_string(),
            "api.internal".to_string(),
            80,
            None,
            kind,
        );
        assert_eq!(conn.name, "forward-api");
    }

    #[test]
    fn test_normalize_optional_text_drops_blank_values() {
        assert_eq!(normalize_optional_text(Some("   ".into())), None);
        assert_eq!(
            normalize_optional_text(Some(" cmd ".into())),
            Some("cmd".into())
        );
    }

    #[test]
    fn test_normalize_remote_path_prefers_forward_slashes() {
        assert_eq!(
            normalize_remote_path(Some(r#"  C:\Users\greg\repo  "#.into())),
            Some("C:/Users/greg/repo".into())
        );
    }

    // Audit-4 H6 regression tests: backend validation of connection fields.
    #[test]
    fn test_validate_rejects_blank_name() {
        let err = validate_connection_fields("   ", "host", 22).unwrap_err();
        assert_eq!(err, "Connection name is required");
    }

    #[test]
    fn test_validate_rejects_blank_host() {
        let err = validate_connection_fields("ok", "  ", 22).unwrap_err();
        assert_eq!(err, "Host is required");
    }

    #[test]
    fn test_validate_rejects_port_zero() {
        let err = validate_connection_fields("ok", "host", 0).unwrap_err();
        assert_eq!(err, "Port must be between 1 and 65535");
    }

    #[test]
    fn test_validate_rejects_overlong_name() {
        let long = "a".repeat(129);
        let err = validate_connection_fields(&long, "host", 22).unwrap_err();
        assert!(err.contains("128"), "got: {}", err);
    }

    #[test]
    fn test_validate_accepts_typical_inputs() {
        assert!(validate_connection_fields("prod-db", "10.0.0.1", 22).is_ok());
        assert!(validate_connection_fields("a", "x", 1).is_ok());
        assert!(validate_connection_fields("z", "y", 65535).is_ok());
    }
}
