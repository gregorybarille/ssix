//! SSH key generation and remote installation (`ssh-copy-id` equivalent).
//!
//! - `generate_ssh_key`: creates an ed25519 keypair, optionally written to disk
//!   under `~/.ssh/` or a user-supplied path, or kept inline (returned as text
//!   only) so it can be stored in SSX's secrets file.
//! - `ssh_install_public_key`: opens a one-shot ssh2 password session to the
//!   target host and idempotently appends a public key line to
//!   `~/.ssh/authorized_keys` with the standard 700/600 permission setup.

use crate::ssh::AuthMethod;
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use ssh_key::{LineEnding, PrivateKey};
use std::io::Read;
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case", tag = "storage")]
pub enum KeyStorage {
    /// Write to `~/.ssh/<derived_name>` and `<derived_name>.pub`.
    Default,
    /// Write to the given absolute path (and `<path>.pub`).
    CustomPath { path: String },
    /// Don't write to disk; return the key contents only.
    Inline,
}

#[derive(Debug, Deserialize)]
pub struct GenerateSshKeyInput {
    #[serde(flatten)]
    pub storage: KeyStorage,
    /// Used to derive the default filename (e.g. credential name, "my-server"
    /// becomes `id_ed25519_my-server`). Required for `Default` storage; ignored
    /// otherwise.
    #[serde(default)]
    pub name_hint: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    /// Optional comment for the public key line. Defaults to `ssx@<hostname>`.
    #[serde(default)]
    pub comment: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GeneratedKey {
    /// Path to the private key on disk, if it was written.
    pub private_key_path: Option<String>,
    /// Inline private key text in OpenSSH PEM form. Always present so the
    /// caller can immediately use it; persistence to secrets.json is handled
    /// by the credential-add path.
    pub private_key: String,
    /// Public key as a single line, e.g. `ssh-ed25519 AAAA... comment`.
    pub public_key: String,
}

/// Sanitise a free-form name to safe filename characters (alnum, `-`, `_`).
fn sanitise_name(input: &str) -> String {
    let cleaned: String = input
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let trimmed = cleaned.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "ssx".to_string()
    } else {
        trimmed
    }
}

/// Pick a non-existing path under `~/.ssh/id_ed25519_<name>`, suffixing with
/// `_2`, `_3`, ... if the file already exists.
fn default_key_path(name_hint: Option<&str>) -> Result<PathBuf, String> {
    let home = dirs_next::home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?;
    let ssh_dir = home.join(".ssh");
    let base = match name_hint {
        Some(s) if !s.trim().is_empty() => format!("id_ed25519_{}", sanitise_name(s)),
        _ => "id_ed25519_ssx".to_string(),
    };
    let mut candidate = ssh_dir.join(&base);
    let mut counter: u32 = 2;
    while candidate.exists() || candidate.with_extension("pub").exists() {
        candidate = ssh_dir.join(format!("{}_{}", base, counter));
        counter += 1;
        if counter > 1000 {
            return Err("Could not find a free filename under ~/.ssh".to_string());
        }
    }
    Ok(candidate)
}

fn write_key_files(
    path: &PathBuf,
    private_pem: &str,
    public_line: &str,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create dir: {}", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    // Audit-3 P2#13: route the key file writes through
    // `crate::storage::atomic_write` so a crash mid-write cannot
    // strand a half-written private key on disk (which would later
    // be silently re-used by ssh2 and reject every connection).
    // `atomic_write` applies the requested Unix mode to the temp
    // BEFORE the payload is written, so the temp itself is never
    // world-readable — even if the process crashes between
    // `create_new` and the rename.
    let private_bytes = private_pem.as_bytes().to_vec();
    crate::storage::atomic_write(path, &private_bytes, Some(0o600))
        .map_err(|e| format!("write private key: {}", e))?;
    let pub_path = path.with_extension("pub");
    let public_bytes = public_line.as_bytes().to_vec();
    crate::storage::atomic_write(&pub_path, &public_bytes, Some(0o644))
        .map_err(|e| format!("write public key: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn generate_ssh_key(input: GenerateSshKeyInput) -> Result<GeneratedKey, String> {
    let mut private = PrivateKey::random(&mut OsRng, ssh_key::Algorithm::Ed25519)
        .map_err(|e| format!("Key generation failed: {}", e))?;

    let comment = input.comment.unwrap_or_else(|| {
        let host = hostname().unwrap_or_else(|| "ssx".to_string());
        format!("ssx@{}", host)
    });
    private.set_comment(comment);

    // Optionally encrypt with a passphrase.
    let private_owned: PrivateKey = if let Some(pp) = input.passphrase.as_deref() {
        if pp.is_empty() {
            private
        } else {
            private
                .encrypt(&mut OsRng, pp)
                .map_err(|e| format!("Failed to encrypt key with passphrase: {}", e))?
        }
    } else {
        private
    };

    let private_pem = private_owned
        .to_openssh(LineEnding::LF)
        .map_err(|e| format!("Serialise private key: {}", e))?
        .to_string();
    let public_line = private_owned
        .public_key()
        .to_openssh()
        .map_err(|e| format!("Serialise public key: {}", e))?;

    let path_written: Option<String> = match input.storage {
        KeyStorage::Inline => None,
        KeyStorage::Default => {
            let p = default_key_path(input.name_hint.as_deref())?;
            write_key_files(&p, &private_pem, &public_line)?;
            Some(p.to_string_lossy().to_string())
        }
        KeyStorage::CustomPath { path } => {
            let p = PathBuf::from(&path);
            if p.exists() {
                return Err(format!("Refusing to overwrite existing file at {}", path));
            }
            write_key_files(&p, &private_pem, &public_line)?;
            Some(p.to_string_lossy().to_string())
        }
    };

    Ok(GeneratedKey {
        private_key_path: path_written,
        private_key: private_pem,
        public_key: public_line,
    })
}

fn hostname() -> Option<String> {
    std::env::var("HOSTNAME").ok().or_else(|| std::env::var("HOST").ok())
}

#[derive(Debug, Deserialize)]
pub struct InstallPublicKeyInput {
    pub host: String,
    pub port: u16,
    pub username: String,
    /// One-time password used only to authenticate the install session. Never
    /// persisted.
    pub password: String,
    /// Public key line as it should appear in `~/.ssh/authorized_keys`.
    pub public_key: String,
}

/// Single-quote-escape a string for a POSIX shell: `'` becomes `'\''`.
pub fn shell_single_quote(s: &str) -> String {
    let escaped = s.replace('\'', "'\\''");
    format!("'{}'", escaped)
}

/// Build the idempotent shell command that installs `public_key` into
/// `~/.ssh/authorized_keys`. Extracted as a pure function so it can be
/// unit-tested without a real SSH connection.
///
/// Properties:
/// - **Idempotent.** `grep -qxF` checks for the exact line before
///   appending; running the script repeatedly never produces duplicate
///   entries.
/// - **Newline-safe at EOF.** If `authorized_keys` exists but lacks a
///   trailing newline, the script prepends one before appending so the
///   new entry is not concatenated onto the previous (otherwise valid)
///   key. We use `tail -c1` rather than `wc -l` because the latter
///   reports the count of complete lines, hiding the missing-newline
///   case.
/// - **CRLF / trailing-whitespace tolerant on input.** The supplied
///   public key is trimmed of trailing `\r` and `\n` so a key copied
///   from a Windows clipboard or read from a file with CRLF line
///   endings is still recognised as the same line by `grep -qxF`.
/// - **Permissions enforced.** `~/.ssh` is chmod 700, the file 600
///   (matching ssh-copy-id), so a freshly created file passes the
///   default sshd `StrictModes` check.
pub fn build_install_script(public_key: &str) -> String {
    // Trim trailing newlines AND carriage returns so the literal we
    // append is exactly one line (and CRLF input matches LF entries).
    let key_line = public_key.trim_end_matches(|c| c == '\n' || c == '\r');
    let q = shell_single_quote(key_line);
    format!(
        "set -e; \
         mkdir -p \"$HOME/.ssh\"; \
         chmod 700 \"$HOME/.ssh\"; \
         touch \"$HOME/.ssh/authorized_keys\"; \
         chmod 600 \"$HOME/.ssh/authorized_keys\"; \
         if ! grep -qxF -- {q} \"$HOME/.ssh/authorized_keys\"; then \
           if [ -s \"$HOME/.ssh/authorized_keys\" ] \
              && [ \"$(tail -c1 \"$HOME/.ssh/authorized_keys\" | od -An -c | tr -d ' ')\" != \"\\n\" ]; then \
             printf '\\n' >> \"$HOME/.ssh/authorized_keys\"; \
           fi; \
           printf '%s\\n' {q} >> \"$HOME/.ssh/authorized_keys\"; \
         fi"
    )
}

#[tauri::command]
pub fn ssh_install_public_key(input: InstallPublicKeyInput) -> Result<(), String> {
    install_public_key_with_password(
        &input.host,
        input.port,
        &input.username,
        &input.password,
        &input.public_key,
    )
}

fn install_public_key_with_password(
    host: &str,
    port: u16,
    username: &str,
    password: &str,
    public_key: &str,
) -> Result<(), String> {
    if public_key.trim().is_empty() {
        return Err("Public key is empty".to_string());
    }

    let auth = AuthMethod::Password(password.to_string());
    let addr = format!("{}:{}", host, port);
    let socket_addr = addr
        .to_socket_addrs()
        .map_err(|e| format!("Resolve {}: {}", addr, e))?
        .next()
        .ok_or_else(|| format!("No address for {}", addr))?;
    let tcp = TcpStream::connect_timeout(&socket_addr, Duration::from_secs(10))
        .map_err(|e| format!("TCP connect to {} failed: {}", addr, e))?;
    tcp.set_nonblocking(false).ok();

    let mut session =
        ssh2::Session::new().map_err(|e| format!("SSH session create failed: {}", e))?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|e| format!("SSH handshake failed: {}", e))?;

    match &auth {
        AuthMethod::Password(pw) => session
            .userauth_password(username, pw)
            .map_err(|e| format!("Password auth failed: {}", e))?,
        _ => unreachable!(),
    }

    if !session.authenticated() {
        return Err("Authentication failed".to_string());
    }

    let mut channel = session
        .channel_session()
        .map_err(|e| format!("Channel open failed: {}", e))?;

    let script = build_install_script(public_key);
    channel
        .exec(&script)
        .map_err(|e| format!("exec failed: {}", e))?;

    let mut stdout = String::new();
    let _ = channel.read_to_string(&mut stdout);
    let mut stderr = String::new();
    let _ = channel.stderr().read_to_string(&mut stderr);

    channel
        .wait_close()
        .map_err(|e| format!("wait_close failed: {}", e))?;
    let exit = channel.exit_status().unwrap_or(-1);
    if exit != 0 {
        return Err(format!(
            "Remote install failed (exit {}): {}",
            exit,
            if stderr.is_empty() { stdout } else { stderr }
        ));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct InstallPublicKeyByCredentialInput {
    pub credential_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

/// Derive the public key for a stored ssh_key credential and install it on
/// the remote host. Convenience wrapper used by the frontend so it doesn't
/// need to pass the public key text around.
#[tauri::command]
pub fn ssh_install_public_key_by_credential(
    input: InstallPublicKeyByCredentialInput,
) -> Result<(), String> {
    let public_key = derive_public_key_for_credential(&input.credential_id)?;
    install_public_key_with_password(
        &input.host,
        input.port,
        &input.username,
        &input.password,
        &public_key,
    )
}

/// Look up an ssh_key credential by id and produce the corresponding public
/// key as a single OpenSSH-format line.
///
/// Resolution order:
/// 1. Inline private key (from secrets.json) → derive public key in memory.
/// 2. Path-based key with a sibling `<path>.pub` file → read it.
/// 3. Path-based key without sibling `.pub` → derive from the private key file
///    (only works for unencrypted keys; otherwise returns an error asking the
///    user to provide a `.pub` file).
fn derive_public_key_for_credential(credential_id: &str) -> Result<String, String> {
    use crate::models::CredentialKind;
    let mut data = crate::storage::load_data()?;
    let cred = data
        .credentials
        .iter_mut()
        .find(|c| c.id == credential_id)
        .ok_or_else(|| format!("Credential {} not found", credential_id))?;
    crate::keychain::enrich_credential(cred);
    match &cred.kind {
        CredentialKind::Password { .. } => {
            Err("This credential is a password, not an SSH key".to_string())
        }
        CredentialKind::SshKey {
            private_key,
            private_key_path,
            passphrase,
        } => {
            if let Some(pk) = private_key.as_deref() {
                public_key_from_private_text(pk, passphrase.as_deref())
            } else if let Some(path) = private_key_path.as_deref() {
                let pub_path = format!("{}.pub", path);
                if let Ok(contents) = std::fs::read_to_string(&pub_path) {
                    let line = contents.lines().next().unwrap_or("").trim().to_string();
                    if line.is_empty() {
                        Err(format!("Public key file {} is empty", pub_path))
                    } else {
                        Ok(line)
                    }
                } else {
                    let priv_text = std::fs::read_to_string(path)
                        .map_err(|e| format!("Could not read {}: {}", path, e))?;
                    public_key_from_private_text(&priv_text, passphrase.as_deref())
                }
            } else {
                Err("Credential has neither inline key nor path".to_string())
            }
        }
    }
}

fn public_key_from_private_text(
    private_text: &str,
    passphrase: Option<&str>,
) -> Result<String, String> {
    let parsed = PrivateKey::from_openssh(private_text)
        .map_err(|e| format!("Could not parse private key: {}", e))?;
    let unlocked = if parsed.is_encrypted() {
        let pp = passphrase.ok_or_else(|| {
            "Private key is encrypted; cannot derive public key without passphrase".to_string()
        })?;
        parsed
            .decrypt(pp)
            .map_err(|e| format!("Failed to decrypt private key: {}", e))?
    } else {
        parsed
    };
    unlocked
        .public_key()
        .to_openssh()
        .map_err(|e| format!("Failed to serialise public key: {}", e))
}

use std::net::ToSocketAddrs;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitise_name_strips_unsafe_chars() {
        assert_eq!(sanitise_name("my server!"), "my_server");
        assert_eq!(sanitise_name("../etc/passwd"), "etc_passwd");
        assert_eq!(sanitise_name(""), "ssx");
        assert_eq!(sanitise_name("ok-name_1"), "ok-name_1");
    }

    #[test]
    fn shell_single_quote_escapes_quotes() {
        assert_eq!(shell_single_quote("abc"), "'abc'");
        assert_eq!(shell_single_quote("a'b"), "'a'\\''b'");
        assert_eq!(shell_single_quote("'"), "''\\'''");
    }

    #[test]
    fn build_install_script_quotes_key_and_uses_grep_qxf() {
        let key = "ssh-ed25519 AAAA test@host";
        let script = build_install_script(key);
        assert!(script.contains("grep -qxF"));
        assert!(script.contains("authorized_keys"));
        assert!(script.contains("'ssh-ed25519 AAAA test@host'"));
        assert!(script.contains("chmod 700"));
        assert!(script.contains("chmod 600"));
    }

    #[test]
    fn build_install_script_handles_quotes_in_key_comment() {
        // Highly unusual but nothing should break shell parsing.
        let key = "ssh-ed25519 AAAA user's@host";
        let script = build_install_script(key);
        // The escaped form should appear; no unescaped single quote inside the
        // key literal.
        assert!(script.contains("user'\\''s@host"));
    }

    #[test]
    fn build_install_script_strips_trailing_newline() {
        let key = "ssh-ed25519 AAAA x\n";
        let script = build_install_script(key);
        assert!(!script.contains("x\n'"));
        assert!(script.contains("'ssh-ed25519 AAAA x'"));
    }

    #[test]
    fn build_install_script_strips_trailing_crlf_for_grep_match() {
        // A key copied from a Windows clipboard or read from a CRLF
        // file should match the same literal that grep -qxF compares
        // against the (LF-only) line in authorized_keys.
        let key = "ssh-ed25519 AAAA x\r\n";
        let script = build_install_script(key);
        assert!(script.contains("'ssh-ed25519 AAAA x'"));
        assert!(!script.contains("\\r"));
    }

    #[test]
    fn build_install_script_uses_grep_qxf_for_idempotency() {
        // Re-asserts the property: running this script twice must not
        // produce duplicate authorized_keys entries. We check the
        // exact-line, fixed-string match flags rather than running the
        // shell.
        let script = build_install_script("ssh-ed25519 AAAA test@host");
        // -q (quiet), -x (whole-line), -F (fixed string).
        assert!(
            script.contains("grep -qxF"),
            "missing exact-line guard; running twice would duplicate entries"
        );
        // The append is gated by the negated grep result.
        assert!(script.contains("if ! grep -qxF"));
    }

    #[test]
    fn build_install_script_prepends_newline_when_authorized_keys_lacks_eof_lf() {
        // If authorized_keys exists with no trailing newline, appending
        // a new entry would concatenate it onto the previous line and
        // corrupt the previous entry. The script must detect this and
        // emit a leading '\n' before the new entry.
        let script = build_install_script("ssh-ed25519 AAAA new@host");
        assert!(
            script.contains("tail -c1"),
            "must inspect the last byte of authorized_keys to detect missing EOF newline"
        );
        // Guards: the file must exist AND be non-empty before we look.
        assert!(script.contains("[ -s \"$HOME/.ssh/authorized_keys\" ]"));
        // The corrective newline is a literal printf '\n'.
        assert!(script.contains("printf '\\n' >> \"$HOME/.ssh/authorized_keys\""));
    }

    #[test]
    fn build_install_script_enforces_ssh_dir_and_file_modes() {
        let script = build_install_script("ssh-ed25519 AAAA x");
        assert!(script.contains("chmod 700 \"$HOME/.ssh\""));
        assert!(script.contains("chmod 600 \"$HOME/.ssh/authorized_keys\""));
    }

    #[test]
    fn generate_ssh_key_inline_returns_parseable_keypair() {
        let out = generate_ssh_key(GenerateSshKeyInput {
            storage: KeyStorage::Inline,
            name_hint: None,
            passphrase: None,
            comment: Some("test@ssx".into()),
        })
        .unwrap();
        assert!(out.private_key_path.is_none());
        assert!(out.private_key.contains("BEGIN OPENSSH PRIVATE KEY"));
        assert!(out.public_key.starts_with("ssh-ed25519 "));
        assert!(out.public_key.contains("test@ssx"));
        // Round-trip parse.
        let parsed = PrivateKey::from_openssh(&out.private_key).unwrap();
        assert!(matches!(parsed.algorithm(), ssh_key::Algorithm::Ed25519));
    }

    #[test]
    fn generate_ssh_key_custom_path_writes_files_and_refuses_overwrite() {
        let dir = std::env::temp_dir().join(format!(
            "ssx-keygen-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("id_test");
        let out = generate_ssh_key(GenerateSshKeyInput {
            storage: KeyStorage::CustomPath {
                path: path.to_string_lossy().to_string(),
            },
            name_hint: None,
            passphrase: None,
            comment: None,
        })
        .unwrap();
        assert_eq!(out.private_key_path.as_deref(), Some(path.to_string_lossy().as_ref()));
        assert!(path.exists());
        assert!(path.with_extension("pub").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
            // Audit-3 P2#13: also pin the public-key mode. The
            // atomic_write helper applies the requested mode to the
            // temp BEFORE the payload is written, so a mid-write
            // crash never leaks a private key as world-readable.
            // The .pub file is always 0o644 (world-readable is
            // intentional — it's the public half).
            let pub_mode = std::fs::metadata(path.with_extension("pub"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(pub_mode, 0o644);
        }
        // Refuse to overwrite.
        let err = generate_ssh_key(GenerateSshKeyInput {
            storage: KeyStorage::CustomPath {
                path: path.to_string_lossy().to_string(),
            },
            name_hint: None,
            passphrase: None,
            comment: None,
        })
        .unwrap_err();
        assert!(err.contains("Refusing to overwrite"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn generate_ssh_key_with_passphrase_encrypts_key() {
        let out = generate_ssh_key(GenerateSshKeyInput {
            storage: KeyStorage::Inline,
            name_hint: None,
            passphrase: Some("test-pass".into()),
            comment: None,
        })
        .unwrap();
        let parsed = PrivateKey::from_openssh(&out.private_key).unwrap();
        assert!(parsed.is_encrypted());
        let decrypted = parsed.decrypt("test-pass").unwrap();
        assert!(matches!(decrypted.algorithm(), ssh_key::Algorithm::Ed25519));
    }

    #[test]
    fn public_key_from_private_text_unencrypted_matches_generation() {
        let out = generate_ssh_key(GenerateSshKeyInput {
            storage: KeyStorage::Inline,
            name_hint: None,
            passphrase: None,
            comment: Some("derive@test".into()),
        })
        .unwrap();
        let derived = public_key_from_private_text(&out.private_key, None).unwrap();
        assert_eq!(derived, out.public_key);
    }

    #[test]
    fn public_key_from_private_text_encrypted_requires_passphrase() {
        let out = generate_ssh_key(GenerateSshKeyInput {
            storage: KeyStorage::Inline,
            name_hint: None,
            passphrase: Some("p4ss".into()),
            comment: None,
        })
        .unwrap();
        let err = public_key_from_private_text(&out.private_key, None).unwrap_err();
        assert!(err.contains("encrypted"));
        let derived = public_key_from_private_text(&out.private_key, Some("p4ss")).unwrap();
        // Compare algorithm + key body (ignore optional trailing comment).
        let parts = |s: &str| {
            s.split_whitespace()
                .take(2)
                .map(String::from)
                .collect::<Vec<_>>()
        };
        assert_eq!(parts(&derived), parts(&out.public_key));
    }
}
