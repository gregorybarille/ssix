use crate::commands::blocking;
use crate::keychain::{self, CredentialSecrets};
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

/// Split a `CredentialKind` into the sanitised shape that goes into
/// `data.json` (passwords as `""`, passphrases and inline keys as `None`)
/// and the secrets that go into the keychain. Pure: validates the shape
/// without touching any file.
fn split_secrets(kind: &CredentialKind) -> Result<(CredentialKind, CredentialSecrets), String> {
    match kind {
        CredentialKind::Password { password } => Ok((
            CredentialKind::Password {
                password: String::new(),
            },
            CredentialSecrets {
                password: Some(password.clone()),
                ..CredentialSecrets::default()
            },
        )),
        CredentialKind::SshKey {
            private_key_path,
            private_key,
            passphrase,
        } => {
            let path = private_key_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let inline = private_key
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            if path.is_none() && inline.is_none() {
                return Err(
                    "SSH key credential requires either a private key path or inline key contents"
                        .to_string(),
                );
            }
            if path.is_some() && inline.is_some() {
                return Err(
                    "SSH key credential cannot have both a path and inline contents; choose one"
                        .to_string(),
                );
            }
            Ok((
                CredentialKind::SshKey {
                    private_key_path: path.map(str::to_string),
                    private_key: None,
                    passphrase: None,
                },
                CredentialSecrets {
                    password: None,
                    passphrase: passphrase.clone().filter(|pp| !pp.is_empty()),
                    private_key: private_key.clone().filter(|pk| !pk.trim().is_empty()),
                },
            ))
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
    let mut credentials: Vec<Credential> = data
        .credentials
        .into_iter()
        .filter(|c| !c.is_private)
        .collect();
    keychain::enrich_credentials(&mut credentials)?;
    Ok(credentials)
}

#[tauri::command]
pub async fn add_credential(input: AddCredentialInput) -> Result<Credential, String> {
    blocking(move || add_credential_sync(input)).await
}

fn add_credential_sync(input: AddCredentialInput) -> Result<Credential, String> {
    validate_credential_fields(&input.name, &input.username, input.is_private)?;
    let (kind_for_json, secrets) = split_secrets(&input.kind)?;
    // The id doubles as the keychain key, so it is generated up front and
    // the keychain entry is rolled back if the data file cannot be saved.
    let cred_id = uuid::Uuid::new_v4().to_string();
    let mut secrets_written = false;

    let result = with_data_mut(|data| {
        // Private credentials skip the unique-name check since they use
        // auto-generated UUID-based names and are never shown in the UI list.
        if !input.is_private && data.credentials.iter().any(|c| c.name == input.name) {
            return Err(format!(
                "A credential named '{}' already exists",
                input.name
            ));
        }
        keychain::replace_for_credential(&cred_id, &secrets)?;
        secrets_written = true;

        let credential = Credential {
            id: cred_id.clone(),
            name: input.name,
            username: input.username,
            kind: kind_for_json,
            is_private: input.is_private,
        };
        // Hand back the sanitised credential with its secrets filled in, so
        // the caller sees exactly what `get_credentials` will return.
        let mut result = credential.clone();
        keychain::apply_secrets(&mut result, &secrets);
        data.credentials.push(credential);
        Ok(result)
    });
    // Only a failure after the secrets were written leaves anything to undo.
    if result.is_err() && secrets_written {
        keychain::delete_all_for_credential(&cred_id);
    }
    result
}

#[tauri::command]
pub async fn update_credential(input: UpdateCredentialInput) -> Result<Credential, String> {
    blocking(move || update_credential_sync(input)).await
}

fn update_credential_sync(input: UpdateCredentialInput) -> Result<Credential, String> {
    // The frontend never calls update on private credentials (they're
    // managed via update_connection); validate as if non-private.
    validate_credential_fields(&input.name, &input.username, false)?;
    let (kind_for_json, secrets) = split_secrets(&input.kind)?;

    // Snapshot the current secrets so a failed save can put them back:
    // otherwise data.json and secrets.json would disagree.
    let previous = keychain::snapshot_for_credential(&input.id)?;
    let mut secrets_written = false;

    let result = with_data_mut(|data| {
        if data
            .credentials
            .iter()
            .any(|c| c.name == input.name && c.id != input.id)
        {
            return Err(format!(
                "A credential named '{}' already exists",
                input.name
            ));
        }
        let idx = data
            .credentials
            .iter()
            .position(|c| c.id == input.id)
            .ok_or_else(|| "Credential not found".to_string())?;

        // One atomic write replaces every secret for this credential.
        keychain::replace_for_credential(&input.id, &secrets)?;
        secrets_written = true;

        data.credentials[idx].name = input.name;
        data.credentials[idx].username = input.username;
        data.credentials[idx].kind = kind_for_json;

        let mut updated = data.credentials[idx].clone();
        keychain::apply_secrets(&mut updated, &secrets);
        Ok(updated)
    });
    if result.is_err() && secrets_written {
        let _ = keychain::replace_for_credential(&input.id, &previous);
    }
    result
}

#[tauri::command]
pub async fn delete_credential(id: String) -> Result<(), String> {
    blocking(move || {
        with_data_mut(|data| {
            data.credentials.retain(|c| c.id != id);
            Ok(())
        })?;
        // Remove secrets from the keychain after the JSON entry is gone.
        keychain::delete_all_for_credential(&id);
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use crate::models::{Credential, CredentialKind};

    #[test]
    fn test_credential_new() {
        let kind = CredentialKind::Password {
            password: "secret".to_string(),
        };
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
        let kind = CredentialKind::Password {
            password: "pw".to_string(),
        };
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
    fn test_split_secrets_rejects_neither_path_nor_inline() {
        let kind = CredentialKind::SshKey {
            private_key_path: None,
            private_key: None,
            passphrase: None,
        };
        let err = super::split_secrets(&kind).unwrap_err();
        assert!(err.to_lowercase().contains("either"));
    }

    #[test]
    fn test_split_secrets_rejects_both_path_and_inline() {
        let kind = CredentialKind::SshKey {
            private_key_path: Some("/tmp/x".into()),
            private_key: Some("KEY".into()),
            passphrase: None,
        };
        let err = super::split_secrets(&kind).unwrap_err();
        assert!(err.to_lowercase().contains("both"));
    }

    #[test]
    fn test_split_secrets_inline_strips_key_into_secrets() {
        let kind = CredentialKind::SshKey {
            private_key_path: None,
            private_key: Some("INLINE-PRIVATE-KEY-CONTENT".into()),
            passphrase: Some("pp".into()),
        };
        let (sanitized, secrets) = super::split_secrets(&kind).unwrap();
        match &sanitized {
            CredentialKind::SshKey {
                private_key,
                private_key_path,
                passphrase,
            } => {
                assert!(private_key.is_none());
                assert!(private_key_path.is_none());
                assert!(passphrase.is_none());
            }
            _ => panic!("unexpected kind"),
        }
        assert_eq!(
            secrets.private_key.as_deref(),
            Some("INLINE-PRIVATE-KEY-CONTENT")
        );
        assert_eq!(secrets.passphrase.as_deref(), Some("pp"));
        assert!(secrets.password.is_none());
    }

    #[test]
    fn test_split_secrets_password_moves_to_secrets() {
        let kind = CredentialKind::Password {
            password: "hunter2".into(),
        };
        let (sanitized, secrets) = super::split_secrets(&kind).unwrap();
        assert!(
            matches!(sanitized, CredentialKind::Password { ref password } if password.is_empty())
        );
        assert_eq!(secrets.password.as_deref(), Some("hunter2"));
    }

    #[test]
    fn test_split_secrets_path_key_trims_and_drops_empty_passphrase() {
        let kind = CredentialKind::SshKey {
            private_key_path: Some("  /home/u/.ssh/id_ed25519  ".into()),
            private_key: None,
            passphrase: Some(String::new()),
        };
        let (sanitized, secrets) = super::split_secrets(&kind).unwrap();
        assert!(matches!(
            sanitized,
            CredentialKind::SshKey { ref private_key_path, .. }
                if private_key_path.as_deref() == Some("/home/u/.ssh/id_ed25519")
        ));
        assert!(secrets.passphrase.is_none());
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
}
