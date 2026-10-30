/// Secret storage for SSIX.
///
/// Secrets (passwords and SSH key passphrases) are stored in
/// `~/.ssix/secrets.json` with permissions `0600` (owner read/write only).
/// This avoids macOS Keychain code-signature issues that make the `keyring`
/// crate unreliable for unsigned development builds.
///
/// The file is a flat JSON object mapping a string key to a string secret:
///   { "<credential_id>": "password", "<credential_id>:passphrase": "pp" }
use crate::models::{Credential, CredentialKind, CredentialSecrets};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

static SECRETS_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn secrets_path() -> PathBuf {
    crate::storage::data_dir().join("secrets.json")
}

/// Read the secrets file. Returns:
///   * `Ok(map)` on success (or empty map if the file simply doesn't exist).
///   * `Err(msg)` if the file exists but is unreadable or unparseable.
///
/// **Audit-4 C1:** previously this function returned `HashMap::new()` on any
/// read or parse error, which caused `with_secrets_mut` to atomically
/// overwrite `~/.ssix/secrets.json` with `{just_one_entry}` — destroying
/// every other credential's secret on a transient EIO, half-written file
/// after a crash, or any future format change. Errors are now propagated
/// so the caller refuses to save and the user sees a real failure.
fn load_secrets() -> Result<HashMap<String, String>, String> {
    let path = secrets_path();
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content = fs::read_to_string(&path).map_err(|e| {
        crate::logs::log_local(
            "error",
            "secrets",
            format!("failed to read secrets file: {}", e),
        );
        format!("failed to read secrets file: {}", e)
    })?;
    serde_json::from_str(&content).map_err(|e| {
        crate::logs::log_local(
            "error",
            "secrets",
            format!("failed to parse secrets file: {}", e),
        );
        format!(
            "failed to parse secrets file (refusing to save and overwrite existing entries): {}",
            e
        )
    })
}

fn save_secrets(secrets: &HashMap<String, String>) -> Result<(), String> {
    let path = secrets_path();
    let content = serde_json::to_string_pretty(secrets).map_err(|e| e.to_string())?;
    // Audit-3 P1#4: route through `atomic_write` so `secrets.json` cannot
    // be torn by a crash mid-write, and so the 0600 mode is applied to
    // the temp file BEFORE the secret payload is flushed (preventing a
    // brief world-readable window if a crash leaves the temp behind).
    crate::storage::atomic_write(&path, content.as_bytes(), Some(0o600))
}

/// Run `f` with an exclusive lock on the secrets file.
///
/// A read or parse failure is propagated rather than treated as "no
/// entries": otherwise a corrupt secrets file would surface as a baffling
/// "Password auth failed" instead of naming the real problem.
fn with_secrets<T>(f: impl FnOnce(&HashMap<String, String>) -> T) -> Result<T, String> {
    let _guard = SECRETS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let secrets = load_secrets()?;
    Ok(f(&secrets))
}

/// Run `f` with an exclusive lock, then save the (possibly mutated) map.
///
/// **Audit-4 C1:** this function MUST refuse to save when the prior load
/// failed. Otherwise a transient read error would cause us to overwrite
/// `~/.ssix/secrets.json` with `{ just_one_entry }`, deleting every other
/// credential's secret silently.
fn with_secrets_mut(f: impl FnOnce(&mut HashMap<String, String>)) -> Result<(), String> {
    let _guard = SECRETS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut secrets = load_secrets().map_err(|e| {
        format!(
            "Refusing to write secrets: prior load failed ({}). The secrets file may be corrupted; \
             back up ~/.ssix/secrets.json and retry. No data was modified.",
            e
        )
    })?;
    f(&mut secrets);
    save_secrets(&secrets)
}

fn password_key(credential_id: &str) -> String {
    credential_id.to_string()
}

fn passphrase_key(credential_id: &str) -> String {
    format!("{}:passphrase", credential_id)
}

fn private_key_key(credential_id: &str) -> String {
    format!("{}:private_key", credential_id)
}

fn secrets_of(map: &HashMap<String, String>, credential_id: &str) -> CredentialSecrets {
    CredentialSecrets {
        password: map.get(&password_key(credential_id)).cloned(),
        passphrase: map.get(&passphrase_key(credential_id)).cloned(),
        private_key: map.get(&private_key_key(credential_id)).cloned(),
    }
}

/// Read all secrets for a credential in one pass over the file.
pub fn snapshot_for_credential(credential_id: &str) -> Result<CredentialSecrets, String> {
    with_secrets(|s| secrets_of(s, credential_id))
}

/// Replace every secret for a credential in one atomic write: entries not
/// present in `secrets` are removed. Used for updates (so the old and new
/// values never coexist on disk) and for rolling back a failed save.
pub fn replace_for_credential(
    credential_id: &str,
    secrets: &CredentialSecrets,
) -> Result<(), String> {
    let entries = [
        (password_key(credential_id), secrets.password.clone()),
        (passphrase_key(credential_id), secrets.passphrase.clone()),
        (private_key_key(credential_id), secrets.private_key.clone()),
    ];
    with_secrets_mut(|s| {
        for (key, value) in entries {
            match value {
                Some(v) if !v.is_empty() => {
                    s.insert(key, v);
                }
                _ => {
                    s.remove(&key);
                }
            }
        }
    })
}

/// Delete all secret entries associated with a credential ID.
pub fn delete_all_for_credential(credential_id: &str) {
    let pk = password_key(credential_id);
    let ppk = passphrase_key(credential_id);
    let pkk = private_key_key(credential_id);
    let _ = with_secrets_mut(|s| {
        s.remove(&pk);
        s.remove(&ppk);
        s.remove(&pkk);
    });
}

fn enrich_from(cred: &mut Credential, secrets: &HashMap<String, String>) {
    apply_secrets(cred, &secrets_of(secrets, &cred.id));
}

/// Fill the placeholders in `cred.kind` from `found`, without touching the
/// secrets file.
fn apply_secrets(cred: &mut Credential, found: &CredentialSecrets) {
    match &cred.kind {
        CredentialKind::Password { password } if password.is_empty() => {
            if let Some(pw) = &found.password {
                cred.kind = CredentialKind::Password {
                    password: pw.clone(),
                };
            }
        }
        CredentialKind::SshKey {
            private_key_path,
            private_key,
            passphrase,
        } => {
            cred.kind = CredentialKind::SshKey {
                private_key_path: private_key_path.clone(),
                private_key: private_key.clone().or_else(|| found.private_key.clone()),
                passphrase: passphrase.clone().or_else(|| found.passphrase.clone()),
            };
        }
        _ => {}
    }
}

/// Fill in a credential's secrets from the secrets file.
///
/// The JSON data file stores empty-string placeholders for passwords and
/// `None` for passphrases / inline keys. One read of the file serves all
/// three lookups. Backend-only: the result must never be returned over IPC
/// (see `commands::credentials::redact_secrets`).
pub fn enrich_credential(cred: &mut Credential) -> Result<(), String> {
    with_secrets(|s| enrich_from(cred, s))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::CredentialKind;
    use crate::storage::test_support::with_isolated_data_dir;

    #[test]
    fn secrets_path_honors_ssix_data_dir_env_override() {
        // Sibling of crate::storage::data_dir tests — secrets must
        // live alongside data.json in the override directory so E2E
        // runs are fully isolated from `~/.ssix`.
        crate::storage::test_support::with_isolated_data_dir(|| {
            let dir = std::path::PathBuf::from(std::env::var("SSIX_DATA_DIR").unwrap());
            assert_eq!(secrets_path(), dir.join("secrets.json"));
        });
    }

    fn make_password_cred(id: &str, password: &str) -> Credential {
        Credential {
            id: id.to_string(),
            name: "test".to_string(),
            username: "user".to_string(),
            kind: CredentialKind::Password {
                password: password.to_string(),
            },
            is_private: false,
        }
    }

    fn make_ssh_key_cred(id: &str, passphrase: Option<&str>) -> Credential {
        Credential {
            id: id.to_string(),
            name: "key-test".to_string(),
            username: "user".to_string(),
            kind: CredentialKind::SshKey {
                private_key_path: Some("/home/user/.ssh/id_rsa".to_string()),
                private_key: None,
                passphrase: passphrase.map(str::to_string),
            },
            is_private: false,
        }
    }

    #[test]
    fn enrich_credential_keeps_non_empty_password() {
        with_isolated_data_dir(|| {
            let mut cred = make_password_cred("id-1", "already-set");
            enrich_credential(&mut cred).unwrap();
            if let CredentialKind::Password { password } = &cred.kind {
                assert_eq!(password, "already-set");
            } else {
                panic!("unexpected kind");
            }
        });
    }

    #[test]
    fn enrich_credential_keeps_existing_passphrase() {
        with_isolated_data_dir(|| {
            let mut cred = make_ssh_key_cred("id-2", Some("existing-pp"));
            enrich_credential(&mut cred).unwrap();
            if let CredentialKind::SshKey { passphrase, .. } = &cred.kind {
                assert_eq!(passphrase.as_deref(), Some("existing-pp"));
            } else {
                panic!("unexpected kind");
            }
        });
    }

    #[test]
    fn enrich_credential_empty_password_stays_empty_when_no_entry() {
        with_isolated_data_dir(|| {
            let mut cred = make_password_cred(
                "ssix-test-no-entry-da7e3f8c-8e1b-4a2d-9b3e-1234567890ab",
                "",
            );
            enrich_credential(&mut cred).unwrap();
            if let CredentialKind::Password { password } = &cred.kind {
                assert!(
                    password.is_empty(),
                    "password should stay empty when no entry exists"
                );
            } else {
                panic!("unexpected CredentialKind variant after enrich");
            }
        });
    }

    fn store(id: &str, secrets: CredentialSecrets) {
        replace_for_credential(id, &secrets).unwrap();
    }

    #[test]
    fn store_and_retrieve_each_secret_kind() {
        with_isolated_data_dir(|| {
            let id = "ssix-test-store-da7e3f8c";
            let all = CredentialSecrets {
                password: Some("hunter2".into()),
                passphrase: Some("mypassphrase".into()),
                private_key: Some("INLINE-KEY".into()),
            };
            store(id, all.clone());
            assert_eq!(snapshot_for_credential(id).unwrap(), all);
            // Another credential's entries are untouched and invisible here.
            assert_eq!(
                snapshot_for_credential("someone-else").unwrap(),
                CredentialSecrets::default()
            );
        });
    }

    #[test]
    fn delete_all_removes_every_entry() {
        with_isolated_data_dir(|| {
            let id = "ssix-test-delete-all-da7e3f8c";
            store(
                id,
                CredentialSecrets {
                    password: Some("pw".into()),
                    passphrase: Some("pp".into()),
                    private_key: Some("key-data".into()),
                },
            );
            delete_all_for_credential(id);
            assert_eq!(
                snapshot_for_credential(id).unwrap(),
                CredentialSecrets::default()
            );
        });
    }

    #[test]
    fn replace_drops_empty_values() {
        with_isolated_data_dir(|| {
            let id = "ssix-test-empty-da7e3f8c";
            store(
                id,
                CredentialSecrets {
                    password: Some(String::new()),
                    passphrase: None,
                    private_key: Some("k".into()),
                },
            );
            let snap = snapshot_for_credential(id).unwrap();
            assert!(snap.password.is_none(), "empty password must not be stored");
            assert_eq!(snap.private_key.as_deref(), Some("k"));
        });
    }

    #[test]
    fn enrich_credential_loads_inline_private_key_from_secrets() {
        with_isolated_data_dir(|| {
            let id = "ssix-test-enrich-pk-da7e3f8c";
            store(
                id,
                CredentialSecrets {
                    private_key: Some("SECRET-KEY-BODY".into()),
                    ..CredentialSecrets::default()
                },
            );
            let mut cred = Credential {
                id: id.to_string(),
                name: "k".to_string(),
                username: "u".to_string(),
                kind: CredentialKind::SshKey {
                    private_key_path: None,
                    private_key: None,
                    passphrase: None,
                },
                is_private: false,
            };
            enrich_credential(&mut cred).unwrap();
            delete_all_for_credential(id);
            if let CredentialKind::SshKey { private_key, .. } = &cred.kind {
                assert_eq!(private_key.as_deref(), Some("SECRET-KEY-BODY"));
            } else {
                panic!("unexpected kind");
            }
        });
    }

    #[test]
    fn replace_for_credential_swaps_all_entries_atomically_and_snapshot_reads_them() {
        with_isolated_data_dir(|| {
            let id = "ssix-test-replace-da7e3f8c";
            store(
                id,
                CredentialSecrets {
                    password: Some("old-pw".into()),
                    passphrase: Some("old-pp".into()),
                    private_key: None,
                },
            );

            let next = CredentialSecrets {
                password: None,
                passphrase: Some("new-pp".into()),
                private_key: Some("KEY".into()),
            };
            replace_for_credential(id, &next).unwrap();

            let snap = snapshot_for_credential(id).unwrap();
            assert_eq!(snap, next, "old password gone, new entries present");

            // Restoring the previous snapshot is the rollback path.
            replace_for_credential(
                id,
                &CredentialSecrets {
                    password: Some("old-pw".into()),
                    passphrase: Some("old-pp".into()),
                    private_key: None,
                },
            )
            .unwrap();
            let restored = snapshot_for_credential(id).unwrap();
            assert_eq!(restored.password.as_deref(), Some("old-pw"));
            assert!(restored.private_key.is_none());
        });
    }

    #[test]
    fn corrupt_secrets_file_is_reported_not_treated_as_empty() {
        with_isolated_data_dir(|| {
            let path = secrets_path();
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"{ not json").unwrap();
            let err = snapshot_for_credential("anything").unwrap_err();
            assert!(err.contains("parse"), "got: {}", err);
            let mut cred = make_password_cred("x", "");
            assert!(enrich_credential(&mut cred).is_err());
        });
    }
}
