/// Cross-platform OS keychain integration for SSX.
///
/// Secrets (passwords and SSH key passphrases) are stored in the native
/// OS credential store:
///   - macOS  → Keychain
///   - Windows → Credential Manager
///   - Linux   → Secret Service (GNOME Keyring / KDE Wallet via D-Bus)
///
/// Only non-secret metadata is persisted to `~/.ssx/data.json`.
use crate::models::{Credential, CredentialKind};
use keyring::Entry;

const SERVICE: &str = "ssx";

/// Return the keyring entry for a password credential.
fn password_entry(credential_id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, credential_id).map_err(|e| e.to_string())
}

/// Return the keyring entry for an SSH key passphrase.
fn passphrase_entry(credential_id: &str) -> Result<Entry, String> {
    let key = format!("{credential_id}:passphrase");
    Entry::new(SERVICE, &key).map_err(|e| e.to_string())
}

/// Store a password in the OS keychain.
pub fn store_password(credential_id: &str, password: &str) -> Result<(), String> {
    password_entry(credential_id)?
        .set_password(password)
        .map_err(|e| e.to_string())
}

/// Retrieve a password from the OS keychain.
/// Returns `None` if the entry does not exist or the keychain is unavailable.
pub fn get_password(credential_id: &str) -> Option<String> {
    password_entry(credential_id).ok()?.get_password().ok()
}

/// Delete a password entry from the OS keychain (best-effort).
pub fn delete_password(credential_id: &str) {
    if let Ok(entry) = password_entry(credential_id) {
        let _ = entry.delete_credential();
    }
}

/// Store an SSH key passphrase in the OS keychain.
pub fn store_passphrase(credential_id: &str, passphrase: &str) -> Result<(), String> {
    passphrase_entry(credential_id)?
        .set_password(passphrase)
        .map_err(|e| e.to_string())
}

/// Retrieve an SSH key passphrase from the OS keychain.
/// Returns `None` if the entry does not exist or the keychain is unavailable.
pub fn get_passphrase(credential_id: &str) -> Option<String> {
    passphrase_entry(credential_id).ok()?.get_password().ok()
}

/// Delete a passphrase entry from the OS keychain (best-effort).
pub fn delete_passphrase(credential_id: &str) {
    if let Ok(entry) = passphrase_entry(credential_id) {
        let _ = entry.delete_credential();
    }
}

/// Delete all keychain entries associated with a credential ID.
pub fn delete_all_for_credential(credential_id: &str) {
    delete_password(credential_id);
    delete_passphrase(credential_id);
}

/// Enrich a `Credential` by filling in secrets from the OS keychain.
///
/// The JSON file stores empty-string placeholders for passwords and `None`
/// for passphrases.  This function replaces those placeholders with the
/// actual secrets retrieved from the keychain.
///
/// If the keychain lookup fails (e.g. first run with legacy plain-text data,
/// or keychain unavailable), the value already in `cred.kind` is kept as-is,
/// providing a graceful fallback for users migrating from older data files.
pub fn enrich_credential(cred: &mut Credential) {
    match &cred.kind {
        CredentialKind::Password { password } if password.is_empty() => {
            if let Some(pw) = get_password(&cred.id) {
                cred.kind = CredentialKind::Password { password: pw };
            }
        }
        CredentialKind::SshKey {
            private_key_path,
            passphrase: None,
        } => {
            if let Some(pp) = get_passphrase(&cred.id) {
                cred.kind = CredentialKind::SshKey {
                    private_key_path: private_key_path.clone(),
                    passphrase: Some(pp),
                };
            }
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
        }
    }

    fn make_ssh_key_cred(id: &str, passphrase: Option<&str>) -> Credential {
        Credential {
            id: id.to_string(),
            name: "key-test".to_string(),
            username: "user".to_string(),
            kind: CredentialKind::SshKey {
                private_key_path: "/home/user/.ssh/id_rsa".to_string(),
                passphrase: passphrase.map(str::to_string),
            },
        }
    }

    #[test]
    fn enrich_credential_keeps_non_empty_password() {
        let mut cred = make_password_cred("id-1", "already-set");
        enrich_credential(&mut cred);
        // Should not touch a non-empty password (it's the plaintext legacy value)
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
    fn enrich_credential_empty_password_stays_empty_when_keychain_unavailable() {
        // Use a long unique ID that cannot exist in any keychain.
        let mut cred =
            make_password_cred("ssx-test-no-entry-da7e3f8c-8e1b-4a2d-9b3e-1234567890ab", "");
        enrich_credential(&mut cred);
        // Since no keychain entry exists for this ID the placeholder ("") must
        // remain unchanged.
        if let CredentialKind::Password { password } = &cred.kind {
            assert!(
                password.is_empty(),
                "password should stay empty when no keychain entry exists"
            );
        } else {
            panic!("unexpected CredentialKind variant after enrich");
        }
    }
}
