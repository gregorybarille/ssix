//! Host-key verification (trust-on-first-use).
//!
//! Every SSH handshake — direct, jump host, the target behind it, a local
//! forward's SSH server, SCP and the key-install helper — passes through [`verify_session`] before any
//! credential is sent. The first time a `host:port` is seen its key is
//! recorded in `<data_dir>/known_hosts` (OpenSSH format, so it can be
//! inspected or edited with the usual tools). A later connection whose key
//! differs is refused with an error that starts with [`MISMATCH_PREFIX`];
//! the frontend parses that line to offer a "trust new host key" action,
//! which calls [`forget`] and reconnects.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine;
use ssh2::{KnownHostFileKind, KnownHostKeyFormat, Session};

/// Machine-readable marker at the start of a host-key mismatch error.
/// Format: `HOST_KEY_MISMATCH host=<host> port=<port> fingerprint=<fp>`
/// followed by a newline and a human-readable explanation.
pub const MISMATCH_PREFIX: &str = "HOST_KEY_MISMATCH";

/// Serialises every read-modify-write of the known_hosts file: two
/// first-time handshakes on separate threads must not drop each other's
/// newly recorded key.
static KNOWN_HOSTS_LOCK: Mutex<()> = Mutex::new(());

pub fn known_hosts_path() -> PathBuf {
    crate::storage::data_dir().join("known_hosts")
}

/// Check the key negotiated by `session` against the known_hosts file,
/// recording it when the host is new.
pub fn verify_session(session: &Session, host: &str, port: u16) -> Result<(), String> {
    let (key, key_type) = session
        .host_key()
        .ok_or_else(|| format!("{}:{} did not present a host key", host, port))?;
    let fingerprint = fingerprint(session);
    check_and_record(
        session,
        host,
        port,
        key,
        key_type.into(),
        &fingerprint,
        &known_hosts_path(),
    )
}

/// The server key's fingerprint in OpenSSH's `SHA256:<base64>` form.
pub fn fingerprint(session: &Session) -> String {
    session
        .host_key_hash(ssh2::HashType::Sha256)
        .map(|h| format!("SHA256:{}", STANDARD_NO_PAD.encode(h)))
        .unwrap_or_else(|| "unknown".to_string())
}

/// OpenSSH spells non-default ports as `[host]:port`.
fn entry_name(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{}]:{}", host, port)
    }
}

fn load(session: &Session, path: &Path) -> Result<ssh2::KnownHosts, String> {
    let mut hosts = session
        .known_hosts()
        .map_err(|e| format!("known_hosts init failed: {}", e))?;
    if path.exists() {
        hosts
            .read_file(path, KnownHostFileKind::OpenSSH)
            .map_err(|e| format!("{} is unreadable: {}", path.display(), e))?;
    }
    Ok(hosts)
}

fn persist(hosts: &ssh2::KnownHosts, path: &Path) -> Result<(), String> {
    let mut content = String::new();
    for host in hosts
        .hosts()
        .map_err(|e| format!("known_hosts iteration failed: {}", e))?
    {
        let line = hosts
            .write_string(&host, KnownHostFileKind::OpenSSH)
            .map_err(|e| format!("known_hosts serialisation failed: {}", e))?;
        content.push_str(line.trim_end());
        content.push('\n');
    }
    crate::storage::atomic_write(path, content.as_bytes(), Some(0o600))
}

pub(crate) fn check_and_record(
    session: &Session,
    host: &str,
    port: u16,
    key: &[u8],
    format: KnownHostKeyFormat,
    fingerprint: &str,
    path: &Path,
) -> Result<(), String> {
    let _guard = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut hosts = load(session, path)?;
    match lookup(&hosts, &entry_name(host, port), key)? {
        Lookup::Match => Ok(()),
        Lookup::Unknown { known_host } => {
            hosts
                .add(&entry_name(host, port), key, "", format)
                .map_err(|e| format!("known_hosts add failed: {}", e))?;
            persist(&hosts, path)?;
            let what = if known_host {
                "recorded additional host key type"
            } else {
                "recorded host key"
            };
            crate::logs::log_local(
                "info",
                "ssh",
                format!("{} for {}:{} ({})", what, host, port, fingerprint),
            );
            Ok(())
        }
        Lookup::Mismatch => Err(format!(
            "{} host={} port={} fingerprint={}\n\
             The host key for {}:{} has changed. This happens when a server is \
             reinstalled, but it can also mean the connection is being intercepted. \
             New key: {}. If you expect this change, trust the new key and reconnect.",
            MISMATCH_PREFIX, host, port, fingerprint, host, port, fingerprint
        )),
    }
}

enum Lookup {
    /// An entry of this name and key type holds exactly this key.
    Match,
    /// No entry of this name has this key's type. `known_host` tells whether
    /// the host is known under another key type (a server that gained an
    /// ed25519 key next to its RSA one is not an interception).
    Unknown { known_host: bool },
    /// An entry of this name and key type holds a different key.
    Mismatch,
}

/// Compare `key` against the entries named exactly `name`, keyed by the
/// algorithm embedded in the key itself. libssh2's own check is
/// type-agnostic (it compares raw bytes against whatever key is stored) and
/// its port-aware lookup falls back to the plain host entry, so a server
/// offering a second key type, or the same host on another port, would be
/// reported as a changed key that `forget` could never clear.
fn lookup(hosts: &ssh2::KnownHosts, name: &str, key: &[u8]) -> Result<Lookup, String> {
    let offered = key_algorithm(key);
    let mut known_host = false;
    let mut same_type = false;
    for entry in hosts
        .hosts()
        .map_err(|e| format!("known_hosts iteration failed: {}", e))?
    {
        if entry.name() != Some(name) {
            continue;
        }
        known_host = true;
        let stored = base64::engine::general_purpose::STANDARD
            .decode(entry.key())
            .map_err(|e| format!("known_hosts entry for {} is not base64: {}", name, e))?;
        if key_algorithm(&stored) != offered {
            continue;
        }
        same_type = true;
        if stored == key {
            return Ok(Lookup::Match);
        }
    }
    Ok(if same_type {
        Lookup::Mismatch
    } else {
        Lookup::Unknown { known_host }
    })
}

/// The algorithm name at the front of an SSH public key blob
/// (`string` = u32 big-endian length + bytes, e.g. `ssh-ed25519`).
fn key_algorithm(blob: &[u8]) -> Option<&[u8]> {
    let len = u32::from_be_bytes(blob.get(..4)?.try_into().ok()?) as usize;
    blob.get(4..4 + len)
}

/// Remove every recorded key for `host:port`. Returns whether anything was removed.
pub fn forget(host: &str, port: u16) -> Result<bool, String> {
    forget_in(host, port, &known_hosts_path())
}

pub(crate) fn forget_in(host: &str, port: u16, path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let _guard = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let session = Session::new().map_err(|e| format!("SSH session create failed: {}", e))?;
    let hosts = load(&session, path)?;
    let name = entry_name(host, port);
    let mut removed = false;
    for entry in hosts
        .hosts()
        .map_err(|e| format!("known_hosts iteration failed: {}", e))?
    {
        if entry.name() == Some(name.as_str()) {
            hosts
                .remove(&entry)
                .map_err(|e| format!("known_hosts remove failed: {}", e))?;
            removed = true;
        }
    }
    if removed {
        persist(&hosts, path)?;
        crate::logs::log_local(
            "warn",
            "ssh",
            format!("forgot host key for {}:{}", host, port),
        );
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ssix-known-hosts-{}-{}-{}",
            tag,
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.join("known_hosts")
    }

    fn check(path: &Path, host: &str, port: u16, key: &[u8]) -> Result<(), String> {
        let session = Session::new().unwrap();
        check_and_record(
            &session,
            host,
            port,
            key,
            KnownHostKeyFormat::Ed25519,
            "SHA256:test",
            path,
        )
    }

    #[test]
    fn first_use_records_key_and_second_check_matches() {
        let path = temp_path("tofu");
        assert!(!path.exists());
        check(&path, "example.com", 22, b"key-one").unwrap();
        assert!(path.exists(), "known_hosts must be created on first use");
        let content = fs::read_to_string(&path).unwrap();
        assert!(
            content.starts_with("example.com ssh-ed25519 "),
            "got: {}",
            content
        );
        check(&path, "example.com", 22, b"key-one").unwrap();
    }

    #[test]
    fn changed_key_is_refused_with_machine_readable_prefix() {
        let path = temp_path("mismatch");
        check(&path, "example.com", 22, b"key-one").unwrap();
        let err = check(&path, "example.com", 22, b"key-two").unwrap_err();
        assert!(err.starts_with(MISMATCH_PREFIX), "got: {}", err);
        assert!(err.contains("host=example.com port=22 fingerprint=SHA256:test"));
        // The stored key is left untouched so the user keeps the evidence.
        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content.lines().count(), 1);
    }

    #[test]
    fn non_default_port_uses_bracket_syntax_and_is_distinct() {
        let path = temp_path("port");
        check(&path, "example.com", 2222, b"key-one").unwrap();
        let content = fs::read_to_string(&path).unwrap();
        assert!(
            content.starts_with("[example.com]:2222 "),
            "got: {}",
            content
        );
        // Same host on another port is a different entry, not a mismatch.
        check(&path, "example.com", 22, b"key-two").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 2);
    }

    #[test]
    fn forget_removes_only_the_requested_entry() {
        let path = temp_path("forget");
        check(&path, "a.example", 22, b"key-a").unwrap();
        check(&path, "b.example", 22, b"key-b").unwrap();
        assert!(forget_in("a.example", 22, &path).unwrap());
        assert!(
            !forget_in("a.example", 22, &path).unwrap(),
            "second forget is a no-op"
        );
        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content.lines().count(), 1);
        assert!(content.starts_with("b.example "));
        // After forgetting, a new key is accepted (trust-on-first-use again).
        check(&path, "a.example", 22, b"key-a2").unwrap();
    }

    /// Build a key blob the way SSH does: `string algorithm` + body.
    fn wire_key(algorithm: &str, body: &[u8]) -> Vec<u8> {
        let mut out = (algorithm.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(algorithm.as_bytes());
        out.extend_from_slice(body);
        out
    }

    #[test]
    fn a_new_key_type_for_a_known_host_is_recorded_not_refused() {
        let path = temp_path("keytype");
        let rsa = wire_key("ssh-rsa", b"rsa-body");
        let ed = wire_key("ssh-ed25519", b"ed-body");
        check(&path, "example.com", 22, &rsa).unwrap();
        // The server gained an ed25519 key: trust it alongside the RSA one.
        check(&path, "example.com", 22, &ed).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 2);
        // Both keys keep matching afterwards.
        check(&path, "example.com", 22, &rsa).unwrap();
        check(&path, "example.com", 22, &ed).unwrap();
        // A different key of a recorded type is still a mismatch.
        let other_ed = wire_key("ssh-ed25519", b"evil-body");
        let err = check(&path, "example.com", 22, &other_ed).unwrap_err();
        assert!(err.starts_with(MISMATCH_PREFIX), "got: {}", err);
    }

    #[test]
    fn key_algorithm_reads_the_leading_string() {
        assert_eq!(
            key_algorithm(&wire_key("ssh-ed25519", b"x")),
            Some(&b"ssh-ed25519"[..])
        );
        assert_eq!(key_algorithm(b"key-one"), None);
        assert_eq!(key_algorithm(b""), None);
    }

    #[test]
    fn forget_on_missing_file_is_false() {
        let path = temp_path("missing");
        assert!(!forget_in("nobody", 22, &path).unwrap());
    }
}
