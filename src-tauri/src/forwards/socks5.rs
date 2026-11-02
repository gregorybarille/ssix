//! The server side of SOCKS5 (RFC 1928), as much of it as `ssh -D` needs:
//! no authentication and the CONNECT command, with IPv4, IPv6 and domain
//! addresses. Domain names are passed on as text so the SSH server resolves
//! them. Anything else is refused with the reply the RFC names for it.

use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, Shutdown, TcpStream};
use std::time::{Duration, Instant};

use super::{LIBSSH2_ERROR_CHANNEL_FAILURE, LIBSSH2_ERROR_TIMEOUT};

const VERSION: u8 = 5;
const METHOD_NO_AUTH: u8 = 0x00;
const METHOD_NONE_ACCEPTABLE: u8 = 0xFF;
const CMD_CONNECT: u8 = 0x01;
const ATYP_IPV4: u8 = 0x01;
const ATYP_DOMAIN: u8 = 0x03;
const ATYP_IPV6: u8 = 0x04;

/// How long a refused client gets to read the reply before the socket closes.
const LINGER: Duration = Duration::from_secs(1);

/// The `REP` field of a reply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(super) enum Reply {
    Succeeded = 0x00,
    GeneralFailure = 0x01,
    NotAllowed = 0x02,
    HostUnreachable = 0x04,
    ConnectionRefused = 0x05,
    CommandNotSupported = 0x07,
    AddressTypeNotSupported = 0x08,
}

/// Where a client asked to go. `host` is an IP address or a name, as text.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Target {
    pub(super) host: String,
    pub(super) port: u16,
}

impl std::fmt::Display for Target {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}", self.host, self.port)
    }
}

/// Send a reply. The bound address is all zeros: a client of a CONNECT has
/// no use for it, and the address the SSH server connected from is unknown.
pub(super) fn write_reply<W: Write>(stream: &mut W, reply: Reply) -> io::Result<()> {
    stream.write_all(&[VERSION, reply as u8, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0])?;
    stream.flush()
}

fn handshake_error(e: io::Error) -> String {
    format!("SOCKS handshake failed: {}", e)
}

fn read_array<const N: usize, R: Read>(stream: &mut R) -> Result<[u8; N], String> {
    let mut bytes = [0u8; N];
    stream.read_exact(&mut bytes).map_err(handshake_error)?;
    Ok(bytes)
}

fn read_vec<R: Read>(stream: &mut R, len: usize) -> Result<Vec<u8>, String> {
    let mut bytes = vec![0u8; len];
    stream.read_exact(&mut bytes).map_err(handshake_error)?;
    Ok(bytes)
}

/// Refuse a request: tell the client why, and report it to the caller.
fn refuse<W: Write>(stream: &mut W, reply: Reply, why: String) -> Result<Target, String> {
    let _ = write_reply(stream, reply);
    Err(why)
}

/// The host a request names. `None` is an address type that cannot be read
/// past, since only the type says how long the address is.
fn read_host<S: Read>(stream: &mut S, address_type: u8) -> Result<Option<Vec<u8>>, String> {
    match address_type {
        ATYP_IPV4 => {
            let octets: [u8; 4] = read_array(stream)?;
            Ok(Some(Ipv4Addr::from(octets).to_string().into_bytes()))
        }
        ATYP_IPV6 => {
            let octets: [u8; 16] = read_array(stream)?;
            Ok(Some(Ipv6Addr::from(octets).to_string().into_bytes()))
        }
        ATYP_DOMAIN => {
            let [len]: [u8; 1] = read_array(stream)?;
            read_vec(stream, len as usize).map(Some)
        }
        _ => Ok(None),
    }
}

/// Whether `name` can go to the SSH server as a host name. This only rules
/// out what can never resolve; the server decides about the rest.
fn is_plausible_host(name: &str) -> bool {
    !name.is_empty() && !name.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// Run the handshake up to a CONNECT request. Everything refused here has
/// already been answered on `stream`, and the error says why, for the logs.
/// For a CONNECT the caller still owes the client the final reply.
pub(super) fn negotiate<S: Read + Write>(stream: &mut S) -> Result<Target, String> {
    let [version, method_count]: [u8; 2] = read_array(stream)?;
    if version != VERSION {
        return Err(format!("not a SOCKS5 client (version {})", version));
    }
    let methods = read_vec(stream, method_count as usize)?;
    if !methods.contains(&METHOD_NO_AUTH) {
        let _ = stream
            .write_all(&[VERSION, METHOD_NONE_ACCEPTABLE])
            .and_then(|()| stream.flush());
        return Err("the SOCKS client requires authentication".to_string());
    }
    stream
        .write_all(&[VERSION, METHOD_NO_AUTH])
        .and_then(|()| stream.flush())
        .map_err(handshake_error)?;

    let [version, command, _reserved, address_type]: [u8; 4] = read_array(stream)?;
    if version != VERSION {
        return refuse(
            stream,
            Reply::GeneralFailure,
            format!("bad SOCKS request version {}", version),
        );
    }
    // The whole request is read before the command is looked at: closing a
    // socket with unread input resets it, which would lose the reply.
    let Some(host) = read_host(stream, address_type)? else {
        return refuse(
            stream,
            Reply::AddressTypeNotSupported,
            format!("unsupported SOCKS address type {}", address_type),
        );
    };
    let port = u16::from_be_bytes(read_array(stream)?);
    if command != CMD_CONNECT {
        return refuse(
            stream,
            Reply::CommandNotSupported,
            format!("unsupported SOCKS command {}", command),
        );
    }
    match String::from_utf8(host) {
        Ok(host) if is_plausible_host(&host) => Ok(Target { host, port }),
        _ => refuse(
            stream,
            Reply::HostUnreachable,
            "invalid host name in SOCKS request".to_string(),
        ),
    }
}

/// The reply for a `direct-tcpip` channel that could not be opened. libssh2
/// keeps the server's reason only in its message.
pub(super) fn reply_for_open_error(error: &ssh2::Error) -> Reply {
    let code = error.code();
    if code == ssh2::ErrorCode::Session(LIBSSH2_ERROR_TIMEOUT) {
        return Reply::HostUnreachable;
    }
    if code != ssh2::ErrorCode::Session(LIBSSH2_ERROR_CHANNEL_FAILURE) {
        return Reply::GeneralFailure;
    }
    let message = error.message();
    if message.contains("administratively prohibited") {
        Reply::NotAllowed
    } else if message.contains("connect failed") {
        Reply::ConnectionRefused
    } else {
        Reply::GeneralFailure
    }
}

/// Close after a refusal without losing the reply. Closing a socket that
/// still has unread input resets the connection, and a reset discards what
/// the client has not read yet, so this sends EOF and drains for a moment.
pub(super) fn close_gracefully(mut stream: &TcpStream) {
    let _ = stream.shutdown(Shutdown::Write);
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(LINGER));
    let deadline = Instant::now() + LINGER;
    let mut sink = [0u8; 512];
    while Instant::now() < deadline && matches!(stream.read(&mut sink), Ok(n) if n > 0) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::net::TcpListener;

    /// What a client sent, and what it was sent back.
    struct Duplex {
        input: Cursor<Vec<u8>>,
        output: Vec<u8>,
    }

    impl Read for Duplex {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.input.read(buf)
        }
    }

    impl Write for Duplex {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.output.write(buf)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn run(bytes: &[u8]) -> (Result<Target, String>, Vec<u8>) {
        let mut duplex = Duplex {
            input: Cursor::new(bytes.to_vec()),
            output: Vec::new(),
        };
        let result = negotiate(&mut duplex);
        (result, duplex.output)
    }

    const GREETING: [u8; 3] = [5, 1, METHOD_NO_AUTH];
    const METHOD_CHOSEN: [u8; 2] = [5, METHOD_NO_AUTH];

    fn request(command: u8, address: &[u8]) -> Vec<u8> {
        let mut bytes = GREETING.to_vec();
        bytes.extend_from_slice(&[5, command, 0]);
        bytes.extend_from_slice(address);
        bytes
    }

    fn reply_bytes(reply: Reply) -> Vec<u8> {
        let mut bytes = METHOD_CHOSEN.to_vec();
        bytes.extend_from_slice(&[5, reply as u8, 0, 1, 0, 0, 0, 0, 0, 0]);
        bytes
    }

    fn target(host: &str, port: u16) -> Target {
        Target {
            host: host.to_string(),
            port,
        }
    }

    #[test]
    fn connect_to_an_ipv4_address() {
        let (result, output) = run(&request(1, &[ATYP_IPV4, 10, 0, 0, 7, 0x1F, 0x90]));
        assert_eq!(result.unwrap(), target("10.0.0.7", 8080));
        // The final reply is the caller's, once the channel opened or not.
        assert_eq!(output, METHOD_CHOSEN);
    }

    #[test]
    fn connect_to_an_ipv6_address() {
        let mut address = vec![ATYP_IPV6];
        address.extend_from_slice(&Ipv6Addr::LOCALHOST.octets());
        address.extend_from_slice(&443u16.to_be_bytes());
        let (result, _) = run(&request(1, &address));
        assert_eq!(result.unwrap(), target("::1", 443));
    }

    #[test]
    fn connect_to_a_name_keeps_it_unresolved_for_the_server() {
        let mut address = vec![ATYP_DOMAIN, 15];
        address.extend_from_slice(b"internal.lan.io");
        address.extend_from_slice(&22u16.to_be_bytes());
        let (result, _) = run(&request(1, &address));
        assert_eq!(result.unwrap(), target("internal.lan.io", 22));
    }

    #[test]
    fn no_auth_is_picked_among_the_methods_a_client_offers() {
        let mut bytes = vec![5, 3, 0x01, 0x02, METHOD_NO_AUTH];
        bytes.extend_from_slice(&[5, 1, 0, ATYP_IPV4, 127, 0, 0, 1, 0, 80]);
        let (result, output) = run(&bytes);
        assert_eq!(result.unwrap(), target("127.0.0.1", 80));
        assert_eq!(output, METHOD_CHOSEN);
    }

    #[test]
    fn a_client_that_insists_on_authentication_is_refused() {
        // 0x02 is username/password; the client is told no method is acceptable.
        let (result, output) = run(&[5, 1, 0x02]);
        assert!(result.unwrap_err().contains("authentication"));
        assert_eq!(output, [5, METHOD_NONE_ACCEPTABLE]);

        let (result, output) = run(&[5, 0]);
        assert!(result.is_err());
        assert_eq!(output, [5, METHOD_NONE_ACCEPTABLE]);
    }

    #[test]
    fn bind_and_udp_associate_are_not_supported() {
        for command in [0x02, 0x03, 0x7F] {
            let (result, output) = run(&request(command, &[ATYP_IPV4, 127, 0, 0, 1, 0, 80]));
            assert!(result.unwrap_err().contains("command"), "{}", command);
            assert_eq!(output, reply_bytes(Reply::CommandNotSupported));
        }
    }

    #[test]
    fn an_unknown_address_type_is_not_supported() {
        let (result, output) = run(&request(1, &[0x09, 1, 2, 3, 4]));
        assert!(result.unwrap_err().contains("address type"));
        assert_eq!(output, reply_bytes(Reply::AddressTypeNotSupported));
    }

    #[test]
    fn a_host_name_that_can_never_resolve_is_refused() {
        for name in [&b""[..], b"has space", b"nul\0byte", b"\xFF\xFE"] {
            let mut address = vec![ATYP_DOMAIN, name.len() as u8];
            address.extend_from_slice(name);
            address.extend_from_slice(&80u16.to_be_bytes());
            let (result, output) = run(&request(1, &address));
            assert!(result.is_err(), "{:?}", name);
            assert_eq!(output, reply_bytes(Reply::HostUnreachable));
        }
    }

    #[test]
    fn another_protocol_gets_no_socks_reply() {
        let (result, output) = run(b"GET / HTTP/1.1\r\n\r\n");
        assert!(result.unwrap_err().contains("not a SOCKS5 client"));
        assert!(output.is_empty());
    }

    #[test]
    fn a_wrong_version_in_the_request_is_a_general_failure() {
        let mut bytes = GREETING.to_vec();
        bytes.extend_from_slice(&[4, 1, 0, ATYP_IPV4]);
        let (result, output) = run(&bytes);
        assert!(result.is_err());
        assert_eq!(output, reply_bytes(Reply::GeneralFailure));
    }

    #[test]
    fn a_client_that_hangs_up_mid_handshake_is_an_error_without_a_reply() {
        let (result, output) = run(&[5]);
        assert!(result.unwrap_err().contains("handshake"));
        assert!(output.is_empty());

        let (result, output) = run(&request(1, &[ATYP_IPV4, 127, 0]));
        assert!(result.is_err());
        assert_eq!(output, METHOD_CHOSEN);
    }

    #[test]
    fn the_servers_refusal_picks_the_reply() {
        let open_failure = |message| {
            ssh2::Error::new(
                ssh2::ErrorCode::Session(LIBSSH2_ERROR_CHANNEL_FAILURE),
                message,
            )
        };
        assert_eq!(
            reply_for_open_error(&open_failure("Channel open failure (connect failed)")),
            Reply::ConnectionRefused
        );
        assert_eq!(
            reply_for_open_error(&open_failure(
                "Channel open failure (administratively prohibited)"
            )),
            Reply::NotAllowed
        );
        assert_eq!(
            reply_for_open_error(&open_failure("Channel open failure (resource shortage)")),
            Reply::GeneralFailure
        );
        assert_eq!(
            reply_for_open_error(&ssh2::Error::new(
                ssh2::ErrorCode::Session(LIBSSH2_ERROR_TIMEOUT),
                "Unexpected error"
            )),
            Reply::HostUnreachable
        );
        assert_eq!(
            reply_for_open_error(&ssh2::Error::new(ssh2::ErrorCode::Session(-13), "gone")),
            Reply::GeneralFailure
        );
    }

    /// The reply must arrive even when the client sent more than was read.
    #[test]
    fn close_gracefully_delivers_the_reply_past_unread_input() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut server, _) = listener.accept().unwrap();

        client.write_all(&[1, 2, 3, 4]).unwrap();
        write_reply(&mut server, Reply::CommandNotSupported).unwrap();
        close_gracefully(&server);
        drop(server);

        let mut received = Vec::new();
        client.read_to_end(&mut received).unwrap();
        assert_eq!(received[..2], [5, Reply::CommandNotSupported as u8]);
    }
}
