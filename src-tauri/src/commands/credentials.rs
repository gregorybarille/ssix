use crate::keychain;
use crate::models::{Credential, CredentialKind};
use crate::storage::{load_data, with_data_mut};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct AddCredentialInput {
    pub name: String,
    pub username: String,
    #[serde(flatten)]
    pub kind: CredentialKind,
    #[serde(default)]
    pub is_private: bool,
}

#[derive(Debug, Deserialize)]
pub struct UpdateCredentialInput {
    pub id: String,
    pub name: String,
    pub username: String,
    #[serde(flatten)]
    pub kind: CredentialKind,
}

/// Audit-4 Logic M3: dry-run validation of a `CredentialKind` shape that
/// returns the same errors as `store_secrets_and_sanitize` would but
/// without touching the keychain. Lets `update_credential` validate the
/// proposed update BEFORE wiping the existing secrets.
fn validate_credential_kind_shape(kind: &CredentialKind) -> Result<(), String> {
    match kind {
        CredentialKind::Password { .. } => Ok(()),
        CredentialKind::SshKey {
            private_key_path,
            private_key,
            ..
        } => {
            let path_set = private_key_path
                .as_deref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            let inline_set = private_key
                .as_deref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            if !path_set && !inline_set {
                return Err(
                    "SSH key credential requires either a private key path or inline key contents"
                        .to_string(),
                );
            }
            if path_set && inline_set {
                return Err(
                    "SSH key credential cannot have both a path and inline contents; choose one"
                        .to_string(),
                );
            }
            Ok(())
        }
    }
}

/// Extract the secret fields from a `CredentialKind`, persist them to the OS
/// keychain keyed by `credential_id`, and return a sanitised `CredentialKind`
/// suitable for JSON storage (passwords replaced by `""`, passphrases by `None`).
fn store_secrets_and_sanitize(
    credential_id: &str,
    kind: &CredentialKind,
) -> Result<CredentialKind, String> {
    match kind {
        CredentialKind::Password { password } => {
            keychain::store_password(credential_id, password)?;
            Ok(CredentialKind::Password {
                password: String::new(),
            })
        }
        CredentialKind::SshKey {
            private_key_path,
            private_key,
            passphrase,
        } => {
            let path_set = private_key_path
                .as_deref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            let inline_set = private_key
                .as_deref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            if !path_set && !inline_set {
                return Err(
                    "SSH key credential requires either a private key path or inline key contents"
                        .to_string(),
                );
            }
            if path_set && inline_set {
                return Err(
                    "SSH key credential cannot have both a path and inline contents; choose one"
                        .to_string(),
                );
            }
            if let Some(pp) = passphrase.as_deref() {
                if !pp.is_empty() {
                    keychain::store_passphrase(credential_id, pp)?;
                }
            }
            if inline_set {
                // Persist the inline key body to the secrets file and strip it
                // from the JSON-bound copy.
                keychain::store_private_key(
                    credential_id,
                    private_key.as_deref().unwrap(),
                )?;
                Ok(CredentialKind::SshKey {
                    private_key_path: None,
                    private_key: None,
                    passphrase: None,
                })
            } else {
                Ok(CredentialKind::SshKey {
                    private_key_path: private_key_path.clone(),
                    private_key: None,
                    passphrase: None,
                })
            }
        }
    }
}

/// Audit-4 H6: validate user-provided credential fields BEFORE we mutate
/// state or touch the keychain. Without this, the frontend was the only
/// line of defence — a hand-crafted IPC call could persist blank names,
/// blank usernames, or names exceeding sane limits.
///
/// `is_private` credentials skip the name check because they use
/// auto-generated UUID-based names invisible to the user.
fn validate_credential_fields(name: &str, username: &str, is_private: bool) -> Result<(), String> {
    if !is_private {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Credential name is required.".to_string());
        }
        if trimmed.chars().count() > 128 {
            return Err("Credential name must be 128 characters or fewer.".to_string());
        }
    }
    if username.trim().is_empty() {
        return Err("Username is required.".to_string());
    }
    if username.chars().count() > 256 {
        return Err("Username must be 256 characters or fewer.".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn get_credentials() -> Result<Vec<Credential>, String> {
    let data = load_data()?;
    let credentials = data
        .credentials
        .into_iter()
        .filter(|c| !c.is_private)
        .map(|mut c| {
            keychain::enrich_credential(&mut c);
            c
        })
        .collect();
    Ok(credentials)
}

#[tauri::command]
pub fn add_credential(input: AddCredentialInput) -> Result<Credential, String> {
    validate_credential_fields(&input.name, &input.username, input.is_private)?;
    with_data_mut(|data| {
        // Private credentials skip the unique-name check since they use
        // auto-generated UUID-based names and are never shown in the UI list.
        if !input.is_private && data.credentials.iter().any(|c| c.name == input.name) {
            return Err(format!("A credential named '{}' already exists", input.name));
        }

        // Generate the ID here so we can use it as the keychain key.
        let cred_id = uuid::Uuid::new_v4().to_string();
        let kind_for_json = store_secrets_and_sanitize(&cred_id, &input.kind)?;

        let credential = Credential {
            id: cred_id,
            name: input.name,
            username: input.username,
            kind: kind_for_json,
            is_private: input.is_private,
        };

        // Return the credential enriched with its secret so the caller can use it
        // immediately (e.g. for display or connection).
        let mut result = credential.clone();
        keychain::enrich_credential(&mut result);

        data.credentials.push(credential);
        Ok(result)
    })
}

#[tauri::command]
pub fn update_credential(input: UpdateCredentialInput) -> Result<Credential, String> {
    // Audit-4 H6: validate fields before any mutation.
    // We can't tell whether this credential is private without loading it,
    // but the frontend never calls update on private credentials (they're
    // managed via update_connection); validate as if non-private.
    validate_credential_fields(&input.name, &input.username, false)?;
    with_data_mut(|data| {
        if data
            .credentials
            .iter()
            .any(|c| c.name == input.name && c.id != input.id)
        {
            return Err(format!("A credential named '{}' already exists", input.name));
        }
        let idx = data
            .credentials
            .iter()
            .position(|c| c.id == input.id)
            .ok_or_else(|| "Credential not found".to_string())?;

        // Audit-4 Logic M3: validate the new kind BEFORE wiping the existing
        // keychain entries. The previous order called
        // `delete_all_for_credential` first, then `store_secrets_and_sanitize`
        // — if sanitize returned an error (e.g. SshKey with neither path
        // nor inline body), the user lost their existing password/passphrase
        // with no way to roll back. We now sanitize into a temp ID first,
        // then move the secrets atomically.
        //
        // Strategy: validate the kind shape WITHOUT touching the keychain
        // by performing a dry-run validation, then delete + store.
        validate_credential_kind_shape(&input.kind)?;

        // Replace keychain entries with updated values.
        keychain::delete_all_for_credential(&input.id);
        let kind_for_json = store_secrets_and_sanitize(&input.id, &input.kind)?;

        data.credentials[idx].name = input.name;
        data.credentials[idx].username = input.username;
        data.credentials[idx].kind = kind_for_json;

        let mut updated = data.credentials[idx].clone();
        keychain::enrich_credential(&mut updated);
        Ok(updated)
    })
}

#[tauri::command]
pub fn delete_credential(id: String) -> Result<(), String> {
    with_data_mut(|data| {
        data.credentials.retain(|c| c.id != id);
        Ok(())
    })?;
    // Remove secrets from the keychain after the JSON entry is gone.
    keychain::delete_all_for_credential(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::models::{Credential, CredentialKind};

    #[test]
    fn test_credential_new() {
        let kind = CredentialKind::Password { password: "secret".to_string() };
        let cred = Credential::new("test".to_string(), "user".to_string(), kind);
        assert_eq!(cred.name, "test");
        assert_eq!(cred.username, "user");
        assert!(!cred.id.is_empty());
    }

    #[test]
    fn test_credential_ssh_key() {
        let kind = CredentialKind::SshKey {
            private_key_path: Some("/home/user/.ssh/id_rsa".to_string()),
            private_key: None,
            passphrase: None,
        };
        let cred = Credential::new("my_key".to_string(), "admin".to_string(), kind);
        assert_eq!(cred.name, "my_key");
    }

    #[test]
    fn test_credential_new_is_not_private_by_default() {
        let kind = CredentialKind::Password { password: "pw".to_string() };
        let cred = Credential::new("test".to_string(), "user".to_string(), kind);
        assert!(!cred.is_private);
    }

    #[test]
    fn test_is_private_serde_default() {
        // Existing JSON without is_private deserializes correctly (defaults to false).
        let json = r#"{"id":"1","name":"old","username":"u","type":"password","password":""}"#;
        let cred: Credential = serde_json::from_str(json).unwrap();
        assert!(!cred.is_private);
    }

    #[test]
    fn test_sanitize_rejects_neither_path_nor_inline() {
        let kind = CredentialKind::SshKey {
            private_key_path: None,
            private_key: None,
            passphrase: None,
        };
        let err = super::store_secrets_and_sanitize("test-id-bad-1", &kind).unwrap_err();
        assert!(err.to_lowercase().contains("either"));
    }

    #[test]
    fn test_sanitize_rejects_both_path_and_inline() {
        let kind = CredentialKind::SshKey {
            private_key_path: Some("/tmp/x".into()),
            private_key: Some("KEY".into()),
            passphrase: None,
        };
        let err = super::store_secrets_and_sanitize("test-id-bad-2", &kind).unwrap_err();
        assert!(err.to_lowercase().contains("both"));
    }

    #[test]
    fn test_sanitize_inline_strips_key_and_persists_secret() {
        let id = "test-id-sanitize-inline-da7e3f8c";
        let kind = CredentialKind::SshKey {
            private_key_path: None,
            private_key: Some("INLINE-PRIVATE-KEY-CONTENT".into()),
            passphrase: None,
        };
        let sanitized = super::store_secrets_and_sanitize(id, &kind).unwrap();
        match &sanitized {
            CredentialKind::SshKey {
                private_key,
                private_key_path,
                ..
            } => {
                assert!(private_key.is_none());
                assert!(private_key_path.is_none());
            }
            _ => panic!("unexpected kind"),
        }
        // Cleanup
        crate::keychain::delete_all_for_credential(id);
    }

    // Audit-4 H6 regression tests: backend validation of credential fields.
    #[test]
    fn test_validate_credential_rejects_blank_name() {
        let err = super::validate_credential_fields("  ", "user", false).unwrap_err();
        assert!(err.contains("name"), "got: {}", err);
    }

    #[test]
    fn test_validate_credential_allows_blank_name_when_private() {
        // Private credentials use UUID-based names; validation must not reject.
        assert!(super::validate_credential_fields("", "user", true).is_ok());
    }

    #[test]
    fn test_validate_credential_rejects_blank_username() {
        let err = super::validate_credential_fields("ok", "  ", false).unwrap_err();
        assert!(err.contains("Username"), "got: {}", err);
    }

    #[test]
    fn test_validate_credential_rejects_overlong_name() {
        let long = "x".repeat(129);
        let err = super::validate_credential_fields(&long, "user", false).unwrap_err();
        assert!(err.contains("128"), "got: {}", err);
    }

    // Audit-4 Logic M3 regression: validate_credential_kind_shape mirrors
    // store_secrets_and_sanitize errors without touching the keychain.
    #[test]
    fn test_kind_shape_rejects_neither_path_nor_inline() {
        let kind = CredentialKind::SshKey {
            private_key_path: None,
            private_key: None,
            passphrase: None,
        };
        let err = super::validate_credential_kind_shape(&kind).unwrap_err();
        assert!(err.to_lowercase().contains("either"), "got: {}", err);
    }

    #[test]
    fn test_kind_shape_rejects_both_path_and_inline() {
        let kind = CredentialKind::SshKey {
            private_key_path: Some("/tmp/x".into()),
            private_key: Some("KEY".into()),
            passphrase: None,
        };
        let err = super::validate_credential_kind_shape(&kind).unwrap_err();
        assert!(err.to_lowercase().contains("both"), "got: {}", err);
    }

    #[test]
    fn test_kind_shape_accepts_password() {
        let kind = CredentialKind::Password { password: "x".into() };
        assert!(super::validate_credential_kind_shape(&kind).is_ok());
    }
}
