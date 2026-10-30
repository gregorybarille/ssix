//! `ssh -v` style tracing into the Logs view.
//!
//! A connection's verbosity (0-3) maps to OpenSSH's `-v`, `-vv` and `-vvv`:
//! each line is logged at "debug" level with the familiar `debugN:` prefix
//! when the verbosity reaches `N`, and is tagged with the host it is about
//! so the hops of a jump host or forward stay apart.

use ssh2::{HostKeyType, MethodType, Session};

#[derive(Clone)]
pub(crate) struct SshDebug {
    verbosity: u8,
    addr: String,
}

impl SshDebug {
    pub(crate) fn new(verbosity: u8, addr: impl Into<String>) -> Self {
        Self {
            verbosity,
            addr: addr.into(),
        }
    }

    pub(crate) fn enabled(&self, level: u8) -> bool {
        level >= 1 && self.verbosity >= level
    }

    /// The line logged for `message` at `level`, or `None` when the
    /// verbosity is below it.
    fn line(&self, level: u8, message: impl FnOnce() -> String) -> Option<String> {
        self.enabled(level)
            .then(|| format!("debug{}: [{}] {}", level, self.addr, message()))
    }

    /// Log the message built by `message` when `level` is enabled; the
    /// closure keeps a quiet connection from formatting anything.
    pub(crate) fn at(&self, level: u8, message: impl FnOnce() -> String) {
        if let Some(line) = self.line(level, message) {
            crate::logs::log_local("debug", "ssh", line);
        }
    }

    /// What `ssh -v` prints after key exchange: the server banner, the
    /// negotiated algorithms (ciphers, MACs and compression from `-vv`).
    pub(crate) fn negotiated(&self, session: &Session) {
        let method = |m| session.methods(m).unwrap_or("none").to_string();
        self.at(1, || {
            format!(
                "Remote protocol version: {}",
                session.banner().unwrap_or("unknown")
            )
        });
        self.at(1, || format!("kex: algorithm: {}", method(MethodType::Kex)));
        self.at(1, || {
            format!("kex: host key algorithm: {}", method(MethodType::HostKey))
        });
        for (direction, crypt, mac, comp) in [
            (
                "server->client",
                MethodType::CryptSc,
                MethodType::MacSc,
                MethodType::CompSc,
            ),
            (
                "client->server",
                MethodType::CryptCs,
                MethodType::MacCs,
                MethodType::CompCs,
            ),
        ] {
            self.at(2, || {
                format!(
                    "kex: {} cipher: {} MAC: {} compression: {}",
                    direction,
                    method(crypt),
                    method(mac),
                    method(comp)
                )
            });
        }
    }

    /// The algorithms this build of libssh2 offers, like the proposal
    /// `ssh -vvv` prints before key exchange.
    pub(crate) fn proposal(&self, session: &Session) {
        if !self.enabled(3) {
            return;
        }
        for (what, m) in [
            ("KEX algorithms", MethodType::Kex),
            ("host key algorithms", MethodType::HostKey),
            ("ciphers", MethodType::CryptCs),
            ("MACs", MethodType::MacCs),
        ] {
            let algs = session
                .supported_algs(m)
                .map(|a| a.join(","))
                .unwrap_or_else(|e| format!("unavailable ({})", e));
            self.at(3, || format!("local client {}: {}", what, algs));
        }
    }
}

/// OpenSSH's name for a host key type, as in `Server host key: ssh-ed25519`.
pub(crate) fn host_key_type_name(kind: HostKeyType) -> &'static str {
    match kind {
        HostKeyType::Rsa => "ssh-rsa",
        HostKeyType::Dss => "ssh-dss",
        HostKeyType::Ecdsa256 => "ecdsa-sha2-nistp256",
        HostKeyType::Ecdsa384 => "ecdsa-sha2-nistp384",
        HostKeyType::Ecdsa521 => "ecdsa-sha2-nistp521",
        HostKeyType::Ed25519 => "ssh-ed25519",
        HostKeyType::Unknown => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_follow_the_verbosity_like_ssh_v() {
        let quiet = SshDebug::new(0, "host:22");
        assert_eq!(quiet.line(1, || "hello".into()), None);

        let vv = SshDebug::new(2, "host:22");
        assert_eq!(
            vv.line(1, || "a".into()).as_deref(),
            Some("debug1: [host:22] a")
        );
        assert_eq!(
            vv.line(2, || "b".into()).as_deref(),
            Some("debug2: [host:22] b")
        );
        assert_eq!(vv.line(3, || "c".into()), None);
    }

    #[test]
    fn level_zero_is_never_a_debug_line() {
        assert!(!SshDebug::new(3, "h:22").enabled(0));
    }

    #[test]
    fn host_key_types_use_openssh_names() {
        assert_eq!(host_key_type_name(HostKeyType::Ed25519), "ssh-ed25519");
        assert_eq!(
            host_key_type_name(HostKeyType::Ecdsa256),
            "ecdsa-sha2-nistp256"
        );
        assert_eq!(host_key_type_name(HostKeyType::Rsa), "ssh-rsa");
    }
}
