//! Host-key verification (trust-on-first-use).
//!
//! Every SSH handshake — direct, jump host, the target behind it, a local
//! forward's SSH server, SCP and the key-install helper — passes through [`verify_session`] before any
//! credential is sent. The first time a `host:port` is seen its key is
//! recorded in `<data_dir>/known_hosts` (OpenSSH format, so it can be
//! inspected or edited with the usual tools). A later connection whose key
//! is not one of those recorded for that `host:port`, even a key of another
//! type, is refused with an error that starts with [`MISMATCH_PREFIX`]; the
//! frontend parses that line to offer a "trust new host key" action, which
//! calls [`forget`] and reconnects, so the new key replaces the recorded ones.
//!
//! A server may hold several keys and presents the type the client asks for
//! first, so [`prefer_recorded_key_types`] asks for the recorded types first.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine;
use ssh2::{KnownHostFileKind, KnownHostKeyFormat, MethodType, Session};

/// Machine-readable marker at the start of a host-key mismatch error.
/// Format: `HOST_KEY_MISMATCH host=<host> port=<port> fingerprint=<fp>`
/// followed by a newline and a human-readable explanation.
pub const MISMATCH_PREFIX: &str = "HOST_KEY_MISMATCH";

/// Serialises every read-modify-write of the known_hosts file: two
/// first-time handshakes on separate threads must not drop each other's
/// newly recorded key.
static KNOWN_HOSTS_LOCK: Mutex<()> = Mutex::new(());

/// Run `f` while no other thread can read or write the known_hosts file.
pub(crate) fn with_known_hosts_locked<T>(f: impl FnOnce() -> T) -> T {
    let _guard = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    f()
}

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

/// Make `session` propose the key types recorded for `host:port` first, the way
/// OpenSSH orders by known_hosts, so an honest server that also holds a key of
/// a type libssh2 prefers presents the key we can check. Call before the
/// handshake. Returns the new order, or `None` when it is unchanged.
pub fn prefer_recorded_key_types(
    session: &Session,
    host: &str,
    port: u16,
) -> Result<Option<String>, String> {
    prefer_recorded_key_types_in(session, host, port, &known_hosts_path())
}

fn prefer_recorded_key_types_in(
    session: &Session,
    host: &str,
    port: u16,
    path: &Path,
) -> Result<Option<String>, String> {
    let recorded = {
        let _guard = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        recorded_keys(&load(session, path)?, &entry_name(host, port))?
    };
    let supported = session
        .supported_algs(MethodType::HostKey)
        .map_err(|e| format!("Listing host key algorithms failed: {}", e))?;
    let order = host_key_order(&recorded, &supported);
    if let Some(order) = &order {
        session
            .method_pref(MethodType::HostKey, order)
            .map_err(|e| format!("Setting host key algorithms failed: {}", e))?;
    }
    Ok(order)
}

/// `supported` with the algorithms of the `recorded` keys moved to the front.
/// Everything else stays in the list, so a server without those types can still
/// connect far enough to be reported as a changed key.
fn host_key_order(recorded: &[Vec<u8>], supported: &[&str]) -> Option<String> {
    let (first, rest): (Vec<&str>, Vec<&str>) = supported.iter().partition(|method| {
        let key_type = key_type_of_method(method).as_bytes();
        recorded
            .iter()
            .any(|key| key_algorithm(key) == Some(key_type))
    });
    if first.is_empty() {
        return None;
    }
    Some([first, rest].concat().join(","))
}

/// The type at the front of a key blob negotiated under `method`: RSA keys are
/// `ssh-rsa` whichever hash signs with them.
fn key_type_of_method(method: &str) -> &str {
    match method {
        "rsa-sha2-256" | "rsa-sha2-512" => "ssh-rsa",
        other => other,
    }
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
    let changed = match lookup(&hosts, &entry_name(host, port), key)? {
        Lookup::Match => return Ok(()),
        Lookup::Unknown => {
            hosts
                .add(&entry_name(host, port), key, "", format)
                .map_err(|e| format!("known_hosts add failed: {}", e))?;
            persist(&hosts, path)?;
            crate::logs::log_local(
                "info",
                "ssh",
                format!("recorded host key for {}:{} ({})", host, port, fingerprint),
            );
            return Ok(());
        }
        Lookup::Changed => format!("The host key for {}:{} has changed.", host, port),
        Lookup::NewKeyType { offered, recorded } => format!(
            "The host key for {}:{} has changed: the server presented a key of type {}, \
             and the keys on record are of type {}.",
            host, port, offered, recorded
        ),
    };
    Err(format!(
        "{} host={} port={} fingerprint={}\n\
         {} This happens when a server is reinstalled or re-keyed, but it can also \
         mean the connection is being intercepted. New key: {}. If you expect this \
         change, trust the new key and reconnect: it replaces the keys recorded for \
         this host.",
        MISMATCH_PREFIX, host, port, fingerprint, changed, fingerprint
    ))
}

enum Lookup {
    /// An entry of this name holds exactly this key.
    Match,
    /// No entry has this name.
    Unknown,
    /// An entry of this name and key type holds a different key.
    Changed,
    /// Entries of this name exist, none of this key's type. A server may have
    /// gained a key type, but an attacker with a fresh key looks the same, and
    /// accepting it would hand them the saved password.
    NewKeyType { offered: String, recorded: String },
}

/// The key blobs of the entries named exactly `name`. libssh2's own check would
/// fall back from `[host]:port` to the plain host entry, and [`forget`] removes
/// exact names only, so it could report a change that `forget` never clears.
fn recorded_keys(hosts: &ssh2::KnownHosts, name: &str) -> Result<Vec<Vec<u8>>, String> {
    let mut keys = Vec::new();
    for entry in hosts
        .hosts()
        .map_err(|e| format!("known_hosts iteration failed: {}", e))?
    {
        if entry.name() == Some(name) {
            keys.push(
                base64::engine::general_purpose::STANDARD
                    .decode(entry.key())
                    .map_err(|e| format!("known_hosts entry for {} is not base64: {}", name, e))?,
            );
        }
    }
    Ok(keys)
}

/// Compare `key` against the entries named exactly `name`. libssh2's own check
/// compares raw bytes against whatever key is stored, which tells nothing about
/// the key's type, so the type is read from the key itself.
fn lookup(hosts: &ssh2::KnownHosts, name: &str, key: &[u8]) -> Result<Lookup, String> {
    let recorded = recorded_keys(hosts, name)?;
    if recorded.is_empty() {
        return Ok(Lookup::Unknown);
    }
    if recorded.iter().any(|stored| stored == key) {
        return Ok(Lookup::Match);
    }
    if recorded
        .iter()
        .any(|stored| key_algorithm(stored) == key_algorithm(key))
    {
        return Ok(Lookup::Changed);
    }
    let mut types: Vec<String> = recorded.iter().map(|k| key_type_name(k)).collect();
    types.sort();
    types.dedup();
    Ok(Lookup::NewKeyType {
        offered: key_type_name(key),
        recorded: types.join(" and "),
    })
}

fn key_type_name(blob: &[u8]) -> String {
    key_algorithm(blob).map_or_else(
        || "unknown".to_string(),
        |name| String::from_utf8_lossy(name).into_owned(),
    )
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
    fn a_new_key_type_for_a_known_host_is_refused() {
        let path = temp_path("keytype");
        let ecdsa = wire_key("ecdsa-sha2-nistp256", b"ecdsa-body");
        check(&path, "example.com", 22, &ecdsa).unwrap();
        let before = fs::read_to_string(&path).unwrap();

        let err = check(
            &path,
            "example.com",
            22,
            &wire_key("ssh-ed25519", b"ed-body"),
        )
        .unwrap_err();
        assert!(
            err.starts_with(&format!(
                "{} host=example.com port=22 fingerprint=SHA256:test\n",
                MISMATCH_PREFIX
            )),
            "got: {}",
            err
        );
        assert!(
            err.contains("key of type ssh-ed25519")
                && err.contains("on record are of type ecdsa-sha2-nistp256"),
            "got: {}",
            err
        );
        // Nothing is recorded until the user decides.
        assert_eq!(fs::read_to_string(&path).unwrap(), before);
        check(&path, "example.com", 22, &ecdsa).unwrap();
    }

    #[test]
    fn trusting_a_new_key_type_replaces_every_recorded_key_of_that_host() {
        let path = temp_path("keytype-trust");
        let (rsa, ecdsa, ed) = (
            wire_key("ssh-rsa", b"rsa-body"),
            wire_key("ecdsa-sha2-nistp256", b"ecdsa-body"),
            wire_key("ssh-ed25519", b"ed-body"),
        );
        // Files written by earlier versions can hold several types for a host.
        let session = Session::new().unwrap();
        let mut hosts = load(&session, &path).unwrap();
        for key in [&rsa, &ecdsa] {
            hosts
                .add("[example.com]:2222", key, "", KnownHostKeyFormat::Ed25519)
                .unwrap();
        }
        hosts
            .add("example.com", &rsa, "", KnownHostKeyFormat::Ed25519)
            .unwrap();
        persist(&hosts, &path).unwrap();
        // Both still match: a key only has to equal one recorded key.
        check(&path, "example.com", 2222, &rsa).unwrap();
        check(&path, "example.com", 2222, &ecdsa).unwrap();
        check(&path, "example.com", 2222, &ed).unwrap_err();

        // What "Trust new host key" does: forget, then connect again.
        assert!(forget_in("example.com", 2222, &path).unwrap());
        check(&path, "example.com", 2222, &ed).unwrap();

        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content.lines().count(), 2, "got: {}", content);
        check(&path, "example.com", 2222, &ed).unwrap();
        // The old keys are gone, so they now count as a change themselves.
        let err = check(&path, "example.com", 2222, &rsa).unwrap_err();
        assert!(err.starts_with(MISMATCH_PREFIX), "got: {}", err);
        // The same host on another port is someone else's entry.
        check(&path, "example.com", 22, &rsa).unwrap();
    }

    #[test]
    fn recorded_key_types_come_first_and_every_other_algorithm_stays() {
        let supported = [
            "ecdsa-sha2-nistp256",
            "ssh-ed25519",
            "rsa-sha2-512",
            "rsa-sha2-256",
            "ssh-rsa",
        ];
        let ed = wire_key("ssh-ed25519", b"x");
        assert_eq!(
            host_key_order(std::slice::from_ref(&ed), &supported).unwrap(),
            "ssh-ed25519,ecdsa-sha2-nistp256,rsa-sha2-512,rsa-sha2-256,ssh-rsa"
        );
        // An RSA key signs under the SHA-2 names too. Recorded types keep libssh2's order.
        assert_eq!(
            host_key_order(&[wire_key("ssh-rsa", b"x"), ed], &supported).unwrap(),
            "ssh-ed25519,rsa-sha2-512,rsa-sha2-256,ssh-rsa,ecdsa-sha2-nistp256"
        );
    }

    #[test]
    fn a_host_without_a_recorded_key_keeps_the_default_order() {
        let supported = ["ecdsa-sha2-nistp256", "ssh-ed25519"];
        assert_eq!(host_key_order(&[], &supported), None);
        // Nor does a recorded type libssh2 cannot use change anything.
        let dss = wire_key("ssh-dss", b"x");
        assert_eq!(host_key_order(&[dss], &supported), None);
    }

    #[test]
    fn preference_reads_only_this_hosts_entries_and_libssh2_accepts_it() {
        let path = temp_path("prefer");
        check(&path, "a.example", 22, &wire_key("ssh-ed25519", b"x")).unwrap();
        let session = Session::new().unwrap();
        let order = prefer_recorded_key_types_in(&session, "a.example", 22, &path)
            .unwrap()
            .unwrap();
        assert!(order.starts_with("ssh-ed25519,"), "got: {}", order);
        let supported = session.supported_algs(MethodType::HostKey).unwrap();
        assert_eq!(order.split(',').count(), supported.len());
        assert_eq!(
            prefer_recorded_key_types_in(&session, "b.example", 22, &path).unwrap(),
            None
        );
        assert_eq!(
            prefer_recorded_key_types_in(&session, "a.example", 2222, &path).unwrap(),
            None
        );
    }

    /// Against a real sshd holding several key types, which a plain `cargo test`
    /// does not have:
    ///
    /// ```text
    /// SSIX_LIVE_SSH=127.0.0.1:2201 cargo test live_a_server -- --ignored
    /// ```
    #[test]
    #[ignore]
    fn live_a_server_presents_the_recorded_key_type_of_every_type_it_holds() {
        let addr = std::env::var("SSIX_LIVE_SSH").expect("SSIX_LIVE_SSH is host:port");
        let (host, port) = addr.rsplit_once(':').unwrap();
        let port: u16 = port.parse().unwrap();
        let handshake = |prepare: &dyn Fn(&Session)| {
            let mut session = Session::new().unwrap();
            prepare(&session);
            session.set_tcp_stream(std::net::TcpStream::connect(&addr).unwrap());
            session.handshake().unwrap();
            session
        };
        for only in ["ssh-ed25519", "rsa-sha2-512", "ecdsa-sha2-nistp256"] {
            let session = handshake(&|s| s.method_pref(MethodType::HostKey, only).unwrap());
            let (key, kind) = session.host_key().unwrap();
            let path = temp_path("live");
            check_and_record(&session, host, port, key, kind.into(), "SHA256:x", &path).unwrap();

            // Without the preference libssh2's default pick would be refused.
            let session = handshake(&|s| {
                prefer_recorded_key_types_in(s, host, port, &path).unwrap();
            });
            let (again, kind) = session.host_key().unwrap();
            assert_eq!(again, key, "{}", only);
            check_and_record(&session, host, port, again, kind.into(), "SHA256:x", &path).unwrap();
        }
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
