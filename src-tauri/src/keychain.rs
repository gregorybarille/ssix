/// Secret storage for SSX.
///
/// Secrets (passwords and SSH key passphrases) are stored in
/// `~/.ssx/secrets.json` with permissions `0600` (owner read/write only).
/// This avoids macOS Keychain code-signature issues that make the `keyring`
/// crate unreliable for unsigned development builds.
///
/// The file is a flat JSON object mapping a string key to a string secret:
///   { "<credential_id>": "password", "<credential_id>:passphrase": "pp" }
use crate::models::{Credential, CredentialKind};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

static SECRETS_LOCK: Mutex<()> = Mutex::new(());

fn secrets_path() -> PathBuf {
    let home = dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".ssx").join("secrets.json")
}

fn load_secrets() -> HashMap<String, String> {
    let path = secrets_path();
    if !path.exists() {
        return HashMap::new();
    }
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[secrets] failed to read secrets file: {}", e);
            return HashMap::new();
        }
    };
    serde_json::from_str(&content).unwrap_or_default()
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
fn with_secrets<T>(f: impl FnOnce(&mut HashMap<String, String>) -> T) -> T {
    let _guard = SECRETS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut secrets = load_secrets();
    f(&mut secrets)
}

/// Run `f` with an exclusive lock, then save the (possibly mutated) map.
fn with_secrets_mut(f: impl FnOnce(&mut HashMap<String, String>)) -> Result<(), String> {
    let _guard = SECRETS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut secrets = load_secrets();
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

/// Store a password in the secrets file.
pub fn store_password(credential_id: &str, password: &str) -> Result<(), String> {
    let key = password_key(credential_id);
    let val = password.to_string();
    with_secrets_mut(|s| { s.insert(key, val); })
}

/// Retrieve a password from the secrets file.
pub fn get_password(credential_id: &str) -> Option<String> {
    with_secrets(|s| s.get(&password_key(credential_id)).cloned())
}

/// Delete a password entry.
#[cfg(test)]
fn delete_password(credential_id: &str) {
    let key = password_key(credential_id);
    let _ = with_secrets_mut(|s| { s.remove(&key); });
}

/// Store an SSH key passphrase in the secrets file.
pub fn store_passphrase(credential_id: &str, passphrase: &str) -> Result<(), String> {
    let key = passphrase_key(credential_id);
    let val = passphrase.to_string();
    with_secrets_mut(|s| { s.insert(key, val); })
}

/// Retrieve an SSH key passphrase from the secrets file.
pub fn get_passphrase(credential_id: &str) -> Option<String> {
    with_secrets(|s| s.get(&passphrase_key(credential_id)).cloned())
}

/// Delete a passphrase entry.
#[cfg(test)]
fn delete_passphrase(credential_id: &str) {
    let key = passphrase_key(credential_id);
    let _ = with_secrets_mut(|s| { s.remove(&key); });
}

/// Store an inline SSH private key (PEM/OpenSSH text) in the secrets file.
pub fn store_private_key(credential_id: &str, private_key: &str) -> Result<(), String> {
    let key = private_key_key(credential_id);
    let val = private_key.to_string();
    with_secrets_mut(|s| { s.insert(key, val); })
}

/// Retrieve an inline SSH private key from the secrets file.
pub fn get_private_key(credential_id: &str) -> Option<String> {
    with_secrets(|s| s.get(&private_key_key(credential_id)).cloned())
}

/// Delete an inline private key entry.
#[cfg(test)]
fn delete_private_key(credential_id: &str) {
    let key = private_key_key(credential_id);
    let _ = with_secrets_mut(|s| { s.remove(&key); });
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

/// Enrich a `Credential` by filling in secrets from the secrets file.
///
/// The JSON data file stores empty-string placeholders for passwords and
/// `None` for passphrases. This function replaces those with the actual
/// secrets so they are available for SSH auth.
pub fn enrich_credential(cred: &mut Credential) {
    match &cred.kind {
        CredentialKind::Password { password } if password.is_empty() => {
            if let Some(pw) = get_password(&cred.id) {
                cred.kind = CredentialKind::Password { password: pw };
            }
        }
        CredentialKind::SshKey {
            private_key_path,
            private_key,
            passphrase,
        } => {
            let mut new_pk = private_key.clone();
            let mut new_pp = passphrase.clone();
            if new_pk.is_none() {
                new_pk = get_private_key(&cred.id);
            }
            if new_pp.is_none() {
                new_pp = get_passphrase(&cred.id);
            }
            cred.kind = CredentialKind::SshKey {
                private_key_path: private_key_path.clone(),
                private_key: new_pk,
                passphrase: new_pp,
            };
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::CredentialKind;

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
        let mut cred = make_password_cred("id-1", "already-set");
        enrich_credential(&mut cred);
        if let CredentialKind::Password { password } = &cred.kind {
            assert_eq!(password, "already-set");
        } else {
            panic!("unexpected kind");
        }
    }

    #[test]
    fn enrich_credential_keeps_existing_passphrase() {
        let mut cred = make_ssh_key_cred("id-2", Some("existing-pp"));
        enrich_credential(&mut cred);
        if let CredentialKind::SshKey { passphrase, .. } = &cred.kind {
            assert_eq!(passphrase.as_deref(), Some("existing-pp"));
        } else {
            panic!("unexpected kind");
        }
    }

    #[test]
    fn enrich_credential_empty_password_stays_empty_when_no_entry() {
        // Use a unique ID that won't exist in the secrets file.
        let mut cred =
            make_password_cred("ssx-test-no-entry-da7e3f8c-8e1b-4a2d-9b3e-1234567890ab", "");
        enrich_credential(&mut cred);
        if let CredentialKind::Password { password } = &cred.kind {
            assert!(
                password.is_empty(),
                "password should stay empty when no entry exists"
            );
        } else {
            panic!("unexpected CredentialKind variant after enrich");
        }
    }

    #[test]
    fn store_and_retrieve_password() {
        // Run sequentially to avoid races on the shared secrets file.
        let id = "ssx-test-store-pw-da7e3f8c";
        store_password(id, "hunter2").unwrap();
        let pw = get_password(id);
        delete_password(id);
        assert_eq!(pw.as_deref(), Some("hunter2"));
    }

    #[test]
    fn store_and_retrieve_passphrase() {
        let id = "ssx-test-store-pp-da7e3f8c";
        store_passphrase(id, "mypassphrase").unwrap();
        let pp = get_passphrase(id);
        delete_passphrase(id);
        assert_eq!(pp.as_deref(), Some("mypassphrase"));
    }

    #[test]
    fn delete_all_removes_both_entries() {
        let id = "ssx-test-delete-all-da7e3f8c";
        store_password(id, "pw").unwrap();
        store_passphrase(id, "pp").unwrap();
        store_private_key(id, "key-data").unwrap();
        delete_all_for_credential(id);
        assert!(get_password(id).is_none());
        assert!(get_passphrase(id).is_none());
        assert!(get_private_key(id).is_none());
    }

    #[test]
    fn store_and_retrieve_private_key() {
        let id = "ssx-test-store-pk-da7e3f8c";
        store_private_key(id, "INLINE-KEY").unwrap();
        let pk = get_private_key(id);
        delete_private_key(id);
        assert_eq!(pk.as_deref(), Some("INLINE-KEY"));
    }

    #[test]
    fn enrich_credential_loads_inline_private_key_from_secrets() {
        let id = "ssx-test-enrich-pk-da7e3f8c";
        store_private_key(id, "SECRET-KEY-BODY").unwrap();
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
        enrich_credential(&mut cred);
        delete_private_key(id);
        if let CredentialKind::SshKey { private_key, .. } = &cred.kind {
            assert_eq!(private_key.as_deref(), Some("SECRET-KEY-BODY"));
        } else {
            panic!("unexpected kind");
        }
    }
}
