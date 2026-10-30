use crate::commands::blocking;
use crate::keychain;
use crate::models::{Credential, CredentialKind, CredentialSecrets};
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
    /// Keep the stored secrets and ignore the secret fields of `kind`.
    /// The edit form sets this whenever the user did not change them (or
    /// could not load them), so unchanged secrets never travel back over
    /// IPC and a failed fetch can never wipe them.
    #[serde(default)]
    pub keep_secrets: bool,
}

/// Rebuild `kind` with the secrets from `previous` so a `keep_secrets`
/// update passes `split_secrets` and writes back exactly what is stored.
fn merge_previous_secrets(kind: CredentialKind, previous: &CredentialSecrets) -> CredentialKind {
    match kind {
        CredentialKind::Password { .. } => CredentialKind::Password {
            password: previous.password.clone().unwrap_or_default(),
        },
        CredentialKind::SshKey {
            private_key_path, ..
        } => {
            let path = private_key_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            CredentialKind::SshKey {
                private_key: if path.is_some() {
                    None
                } else {
                    previous.private_key.clone()
                },
                private_key_path: path,
                passphrase: previous.passphrase.clone(),
            }
        }
    }
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
            return Err("Credential name is required".to_string());
        }
        if trimmed.chars().count() > 128 {
            return Err("Credential name must be 128 characters or fewer".to_string());
        }
    }
    if username.trim().is_empty() {
        return Err("Username is required".to_string());
    }
    if username.chars().count() > 256 {
        return Err("Username must be 256 characters or fewer".to_string());
    }
    Ok(())
}

/// Strip every secret from a credential before it crosses the IPC boundary.
///
/// Redaction rules: a password becomes `""`, an inline private key and a
/// passphrase become `None`, and `private_key_path` is kept because a path
/// is not a secret. `data.json` already stores these placeholders, so for
/// current data this is a no-op; it exists so a legacy row that still
/// carries a secret inline can never leak into the frontend store.
fn redact_secrets(cred: &mut Credential) {
    cred.kind = match &cred.kind {
        CredentialKind::Password { .. } => CredentialKind::Password {
            password: String::new(),
        },
        CredentialKind::SshKey {
            private_key_path, ..
        } => CredentialKind::SshKey {
            private_key_path: private_key_path.clone(),
            private_key: None,
            passphrase: None,
        },
    };
}

fn redacted(mut cred: Credential) -> Credential {
    redact_secrets(&mut cred);
    cred
}

/// List the visible credentials with every secret redacted (see
/// `redact_secrets`). The edit form fetches a single credential's secrets
/// on demand through `get_credential_secrets`.
#[tauri::command]
pub fn get_credentials() -> Result<Vec<Credential>, String> {
    let data = load_data()?;
    Ok(data
        .credentials
        .into_iter()
        .filter(|c| !c.is_private)
        .map(redacted)
        .collect())
}

/// Read the secrets of one credential. Only the credential edit form calls
/// this, when it opens, so secrets never sit in the frontend store.
#[tauri::command]
pub async fn get_credential_secrets(id: String) -> Result<CredentialSecrets, String> {
    blocking(move || get_credential_secrets_sync(&id)).await
}

fn get_credential_secrets_sync(id: &str) -> Result<CredentialSecrets, String> {
    let data = load_data()?;
    if !data.credentials.iter().any(|c| c.id == id) {
        return Err("Credential not found".to_string());
    }
    keychain::snapshot_for_credential(id)
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
        // Hand back the redacted credential, exactly what `get_credentials`
        // will list; the form closes on success and never needs the secret.
        let result = redacted(credential.clone());
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
    let UpdateCredentialInput {
        id,
        name,
        username,
        kind,
        keep_secrets,
    } = input;
    // The frontend never calls update on private credentials (they're
    // managed via update_connection); validate as if non-private.
    validate_credential_fields(&name, &username, false)?;

    // Snapshot the current secrets so a failed save can put them back:
    // otherwise data.json and secrets.json would disagree.
    let previous = keychain::snapshot_for_credential(&id)?;
    let kind = if keep_secrets {
        merge_previous_secrets(kind, &previous)
    } else {
        kind
    };
    let (kind_for_json, secrets) = split_secrets(&kind)?;
    let mut secrets_written = false;

    let result = with_data_mut(|data| {
        if data
            .credentials
            .iter()
            .any(|c| c.name == name && c.id != id)
        {
            return Err(format!("A credential named '{}' already exists", name));
        }
        let idx = data
            .credentials
            .iter()
            .position(|c| c.id == id)
            .ok_or_else(|| "Credential not found".to_string())?;

        // One atomic write replaces every secret for this credential;
        // skipped when nothing changed (the usual `keep_secrets` case).
        if secrets != previous {
            keychain::replace_for_credential(&id, &secrets)?;
            secrets_written = true;
        }

        data.credentials[idx].name = name;
        data.credentials[idx].username = username;
        data.credentials[idx].kind = kind_for_json;

        Ok(redacted(data.credentials[idx].clone()))
    });
    if result.is_err() && secrets_written {
        let _ = keychain::replace_for_credential(&id, &previous);
    }
    result
}

#[tauri::command]
pub async fn delete_credential(id: String) -> Result<(), String> {
    blocking(move || delete_credential_sync(&id)).await
}

/// Delete a credential no connection uses. One that is still in use is
/// refused (naming the connections) rather than leaving them pointing at
/// nothing, which used to surface only as a failure at connect time.
fn delete_credential_sync(id: &str) -> Result<(), String> {
    with_data_mut(|data| {
        let users: Vec<&str> = data
            .connections
            .iter()
            .filter(|c| c.credential_ids().any(|used| used == id))
            .map(|c| c.name.as_str())
            .collect();
        if !users.is_empty() {
            let name = data
                .credentials
                .iter()
                .find(|c| c.id == id)
                .map_or("This credential", |c| c.name.as_str());
            return Err(format!(
                "'{}' is used by {}. Pick another credential for {} first.",
                name,
                users.join(", "),
                if users.len() == 1 { "it" } else { "them" }
            ));
        }
        data.credentials.retain(|c| c.id != id);
        Ok(())
    })?;
    // Remove secrets from the keychain after the JSON entry is gone.
    keychain::delete_all_for_credential(id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{AddCredentialInput, UpdateCredentialInput};
    use crate::models::{Credential, CredentialKind, CredentialSecrets};
    use crate::storage::test_support::with_isolated_data_dir;

    fn add(name: &str, kind: CredentialKind) -> Credential {
        super::add_credential_sync(AddCredentialInput {
            name: name.to_string(),
            username: "user".to_string(),
            kind,
            is_private: false,
        })
        .unwrap()
    }

    fn password_kind() -> CredentialKind {
        CredentialKind::Password {
            password: "pw".to_string(),
        }
    }

    #[test]
    fn delete_refuses_a_credential_a_connection_uses() {
        with_isolated_data_dir(|| {
            let dest = add("dest", password_kind());
            let gateway = add("gateway", password_kind());
            let unused = add("unused", password_kind());
            crate::storage::with_data_mut(|data| {
                data.connections.push(crate::models::Connection::new(
                    "jump".to_string(),
                    "db".to_string(),
                    22,
                    Some(dest.id.clone()),
                    crate::models::ConnectionKind::JumpShell {
                        gateway_host: "gw".to_string(),
                        gateway_port: 22,
                        gateway_credential_id: gateway.id.clone(),
                        destination_host: "db".to_string(),
                        destination_port: 22,
                    },
                ));
                Ok(())
            })
            .unwrap();

            assert_eq!(
                super::delete_credential_sync(&dest.id).unwrap_err(),
                "'dest' is used by jump. Pick another credential for it first."
            );
            assert_eq!(
                super::delete_credential_sync(&gateway.id).unwrap_err(),
                "'gateway' is used by jump. Pick another credential for it first."
            );
            super::delete_credential_sync(&unused.id).unwrap();

            let data = crate::storage::load_data().unwrap();
            let ids: Vec<&str> = data.credentials.iter().map(|c| c.id.as_str()).collect();
            assert_eq!(ids, vec![dest.id.as_str(), gateway.id.as_str()]);
        });
    }

    fn inline_key_kind(key: &str, passphrase: Option<&str>) -> CredentialKind {
        CredentialKind::SshKey {
            private_key_path: None,
            private_key: Some(key.to_string()),
            passphrase: passphrase.map(str::to_string),
        }
    }

    fn assert_redacted_password(cred: &Credential) {
        match &cred.kind {
            CredentialKind::Password { password } => assert!(password.is_empty()),
            other => panic!("expected password kind, got {:?}", other),
        }
    }

    fn assert_redacted_ssh_key(cred: &Credential, expected_path: Option<&str>) {
        match &cred.kind {
            CredentialKind::SshKey {
                private_key_path,
                private_key,
                passphrase,
            } => {
                assert_eq!(private_key_path.as_deref(), expected_path);
                assert!(private_key.is_none(), "inline key must be redacted");
                assert!(passphrase.is_none(), "passphrase must be redacted");
            }
            other => panic!("expected ssh_key kind, got {:?}", other),
        }
    }

    #[test]
    fn add_credential_returns_redacted_shape() {
        with_isolated_data_dir(|| {
            let pw = add(
                "pw",
                CredentialKind::Password {
                    password: "hunter2".into(),
                },
            );
            assert_redacted_password(&pw);
            let key = add("key", inline_key_kind("INLINE-KEY", Some("pp")));
            assert_redacted_ssh_key(&key, None);
        });
    }

    #[test]
    fn get_credentials_redacts_secrets_but_keeps_key_path() {
        with_isolated_data_dir(|| {
            add(
                "pw",
                CredentialKind::Password {
                    password: "hunter2".into(),
                },
            );
            add("inline", inline_key_kind("INLINE-KEY", Some("pp")));
            add(
                "path",
                CredentialKind::SshKey {
                    private_key_path: Some("/home/u/.ssh/id_ed25519".into()),
                    private_key: None,
                    passphrase: Some("pp".into()),
                },
            );

            let listed = super::get_credentials().unwrap();
            assert_eq!(listed.len(), 3);
            assert_redacted_password(&listed[0]);
            assert_redacted_ssh_key(&listed[1], None);
            assert_redacted_ssh_key(&listed[2], Some("/home/u/.ssh/id_ed25519"));
        });
    }

    #[test]
    fn get_credentials_redacts_legacy_rows_with_inline_secrets() {
        with_isolated_data_dir(|| {
            // A data.json written before secrets moved to secrets.json.
            crate::storage::with_data_mut(|data| {
                data.credentials.push(Credential {
                    id: "legacy-pw".into(),
                    name: "legacy-pw".into(),
                    username: "u".into(),
                    kind: CredentialKind::Password {
                        password: "plain".into(),
                    },
                    is_private: false,
                });
                data.credentials.push(Credential {
                    id: "legacy-key".into(),
                    name: "legacy-key".into(),
                    username: "u".into(),
                    kind: CredentialKind::SshKey {
                        private_key_path: Some("/k".into()),
                        private_key: Some("INLINE".into()),
                        passphrase: Some("pp".into()),
                    },
                    is_private: false,
                });
                Ok(())
            })
            .unwrap();

            let listed = super::get_credentials().unwrap();
            assert_redacted_password(&listed[0]);
            assert_redacted_ssh_key(&listed[1], Some("/k"));
        });
    }

    #[test]
    fn get_credentials_hides_private_credentials() {
        with_isolated_data_dir(|| {
            super::add_credential_sync(AddCredentialInput {
                name: String::new(),
                username: "u".into(),
                kind: CredentialKind::Password {
                    password: "x".into(),
                },
                is_private: true,
            })
            .unwrap();
            assert!(super::get_credentials().unwrap().is_empty());
        });
    }

    #[test]
    fn get_credential_secrets_returns_stored_secrets() {
        with_isolated_data_dir(|| {
            let pw = add(
                "pw",
                CredentialKind::Password {
                    password: "hunter2".into(),
                },
            );
            assert_eq!(
                super::get_credential_secrets_sync(&pw.id).unwrap(),
                CredentialSecrets {
                    password: Some("hunter2".into()),
                    ..CredentialSecrets::default()
                }
            );

            let key = add("key", inline_key_kind("INLINE-KEY", Some("pp")));
            assert_eq!(
                super::get_credential_secrets_sync(&key.id).unwrap(),
                CredentialSecrets {
                    password: None,
                    passphrase: Some("pp".into()),
                    private_key: Some("INLINE-KEY".into()),
                }
            );
        });
    }

    #[test]
    fn get_credential_secrets_rejects_unknown_id() {
        with_isolated_data_dir(|| {
            let err = super::get_credential_secrets_sync("nope").unwrap_err();
            assert!(err.contains("not found"), "got: {}", err);
        });
    }

    #[test]
    fn update_credential_returns_redacted_shape_and_replaces_secrets() {
        with_isolated_data_dir(|| {
            let pw = add(
                "pw",
                CredentialKind::Password {
                    password: "old".into(),
                },
            );
            let updated = super::update_credential_sync(UpdateCredentialInput {
                id: pw.id.clone(),
                name: "pw".into(),
                username: "user".into(),
                kind: CredentialKind::Password {
                    password: "new".into(),
                },
                keep_secrets: false,
            })
            .unwrap();
            assert_redacted_password(&updated);
            assert_eq!(
                super::get_credential_secrets_sync(&pw.id)
                    .unwrap()
                    .password
                    .as_deref(),
                Some("new")
            );
        });
    }

    #[test]
    fn update_with_keep_secrets_preserves_the_stored_password() {
        with_isolated_data_dir(|| {
            let pw = add(
                "pw",
                CredentialKind::Password {
                    password: "stored".into(),
                },
            );
            // The form sends an empty password when the user left it alone.
            let updated = super::update_credential_sync(UpdateCredentialInput {
                id: pw.id.clone(),
                name: "pw-renamed".into(),
                username: "user2".into(),
                kind: CredentialKind::Password {
                    password: String::new(),
                },
                keep_secrets: true,
            })
            .unwrap();
            assert_eq!(updated.name, "pw-renamed");
            assert_eq!(updated.username, "user2");
            assert_redacted_password(&updated);
            assert_eq!(
                super::get_credential_secrets_sync(&pw.id)
                    .unwrap()
                    .password
                    .as_deref(),
                Some("stored")
            );
        });
    }

    #[test]
    fn update_with_keep_secrets_preserves_an_inline_key_and_passphrase() {
        with_isolated_data_dir(|| {
            let key = add(
                "key",
                CredentialKind::SshKey {
                    private_key_path: None,
                    private_key: Some("INLINE".into()),
                    passphrase: Some("pp".into()),
                },
            );
            // No inline key in the input would normally fail validation;
            // with keep_secrets the stored one is used instead.
            super::update_credential_sync(UpdateCredentialInput {
                id: key.id.clone(),
                name: "key".into(),
                username: "deploy2".into(),
                kind: CredentialKind::SshKey {
                    private_key_path: None,
                    private_key: None,
                    passphrase: None,
                },
                keep_secrets: true,
            })
            .unwrap();
            let secrets = super::get_credential_secrets_sync(&key.id).unwrap();
            assert_eq!(secrets.private_key.as_deref(), Some("INLINE"));
            assert_eq!(secrets.passphrase.as_deref(), Some("pp"));
        });
    }

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
