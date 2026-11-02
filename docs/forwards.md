# Port Forwards

SSIX runs the three forwards OpenSSH has. All three authenticate to an SSH
server with the connection's SSH server credential, and open no shell.

| Kind (`data.json` value) | `ssh` equivalent | Listens on | Each connection goes to |
|---|---|---|---|
| Local forward (`port_forward`) | `ssh -L` | `127.0.0.1:<local port>` here | the remote host, dialled by the SSH server |
| Remote forward (`remote_forward`) | `ssh -R` | the SSH server's loopback, `<remote port>` | the local target, dialled by this machine |
| Dynamic forward (`dynamic_forward`) | `ssh -D` | `127.0.0.1:<SOCKS port>` here | whatever the SOCKS client asks for, dialled by the SSH server |

Forwards are started and stopped from the Port forwards view, or with Connect
on the connection. Starting one that is already running or starting only
brings it into view. Starting one that was just stopped shows Connecting until
the previous attempt has given back its port, rather than failing to bind.
Deleting a connection stops its forward first.

## Where A Forward Listens

- Local and dynamic forwards bind to `127.0.0.1` only; other machines cannot
  reach them.
- A remote forward asks the server for `localhost`, which is what `ssh -R`
  sends when it is given no address. The port is on the server's loopback
  unless the server's `GatewayPorts yes` overrides that. There is no field to
  choose another address. For `localhost` sshd binds both `127.0.0.1` and `::1`
  and reports success if either works, so a port taken on only one of them
  starts normally and is reachable only on the other, as with `ssh -R`.
- The server decides whether a remote forward may listen at all. A refusal
  (`AllowTcpForwarding`, a port already taken, a privileged port) fails the
  start with "refused to listen on port N", and the row shows it.

## The SOCKS5 Proxy

A dynamic forward accepts "no authentication" only, and the `CONNECT` command
with an IPv4, IPv6 or domain address. Names are resolved by the SSH server,
so names only it can resolve work, and the proxy looks nothing up on this
machine.

| Situation | Reply |
|---|---|
| Connected | `0x00` succeeded |
| The server's sshd forbids it (`administratively prohibited`) | `0x02` not allowed |
| The destination could not be connected to | `0x05` connection refused |
| No answer from the server within 15 s, or a host name that can never resolve (empty, spaces, not UTF-8) | `0x04` host unreachable |
| `BIND` or `UDP ASSOCIATE` | `0x07` command not supported |
| Unknown address type | `0x08` address type not supported |
| Anything else | `0x01` general failure |
| The client offers no "no authentication" method | method reply `0xFF`, then close |

SSH reports every failed dial as "connect failed" with no finer reason, so a
refused port, an unknown name and an unreachable host all reply `0x05`.

## What The Row Shows

| Status | Meaning |
|---|---|
| Not connected (grey) | Not running; a forward that was stopped comes back to this |
| Connecting (grey) | Authenticating, or waiting for the server to accept the port |
| Connected (green) | Listening |
| Error connecting (red) | It never started; the details say why |
| Connection lost (red) | It ran and then ended on its own; the details say why |

The details also show how many clients are connected and why the last client
could not be served. One client failing, for example a destination that
refuses, does not end the forward.

Both red states offer the start button again. Forwards do not reconnect on
their own.

The frontend hears about a forward in two ways:

- `ssix:forward:status:{id}` events carry the client count and client errors
  (`ForwardStatus` in `src-tauri/src/forwards.rs`, mirrored in
  `src/store/usePortForwardsStore.ts`). Events are not buffered, so one sent
  before the store subscribes is missed; the next one corrects the count.
- How it ended travels on the session's output channel like a shell's: an
  `error` if it was not asked to stop, then `closed`. The channel buffers until
  the store attaches, so a forward that ends straight away is still reported.

## How A Forward Ends

However it ends, its one supervisor thread does the same, in this order:
closes the port so nobody new arrives, shuts down every client's socket so they
stop tunnelling, gives them up to 3 s to close their channels, closes the
session, and reports.

While no client is connected nothing else reads the session, so the supervisor
watches its socket:

- A connection that closes or resets is noticed at once.
- Every 30 s it also asks the server something, whether clients are connected or
  not. Three requests in a row without an answer end the forward, each waiting
  up to 15 s, so a session that goes silent is given up on within about 75 s. A
  short outage does not end it.

The request opens a channel of a type no server implements
(`ssix-probe@ssix.invalid`) and counts the refusal as an answer. `ssh2` offers
no way to send a global request, and libssh2's own keepalive does not wait for a
reply. A server that disconnects on an unknown channel type, against the
protocol, would end its forwards at the first request. This interval is fixed:
it does not read the connection's keepalive setting.

## Limits

- **One channel open at a time per session.** libssh2 keeps the state of an open
  on the session, so concurrent opens would get each other's replies. They are
  queued, which means a destination the server takes long to answer holds up
  other clients of the same forward, for up to 15 s each. Several unreachable
  destinations can therefore delay the others by several times 15 s, and a
  confirmation that arrives after its 15 s leaves a channel open on the server
  until the session ends.
- **Closing is not half-closing.** When a client closes its side, the channel
  closes in both directions, so a protocol that keeps reading after sending EOF
  loses the rest. This is how `forward_bidi` has always worked.
- **A remote forward polls while it has clients.** New connections arrive over
  the session itself, and reading one client's data can pull in the next one
  without the socket waking anyone, so the supervisor looks every 20 ms instead
  of the 250 ms a local or dynamic forward uses.

## For Contributors

`ssh2` frees a channel without taking the session's lock (`ChannelInner`'s
`Drop`), although `libssh2_channel_free` sends packets. On a session several
threads use, this corrupts the stream: sshd logs `Bad packet length` and
`Connection corrupted`, then drops the session and every client on it. Any
channel on a shared session must therefore end in `free_channel`, which holds the
lock for the drop. `Hub::tunnel` keeps its own handle across `forward_bidi` so
its free is the last one.

The live tests need a real sshd and are ignored by default. With server-a up:

```bash
cd src-tauri
SSIX_LIVE_SSH=127.0.0.1:2201 SSIX_LIVE_USER=usera SSIX_LIVE_PASSWORD=passa \
  SSIX_LIVE_PLATFORM=posix cargo test --lib forwards::live -- --ignored --test-threads=1
```

`live_concurrent_socks_clients_get_their_own_destinations` is the test that
catches a channel freed without the lock. It fails most runs rather than every
run, so run it several times after touching this code, and check the server's
log for the two messages above.

OpenSSH's `PerSourcePenalties` refuses a source that keeps connecting without
authenticating, with "Not allowed at this time". A test that uses sshd itself as
a destination counts towards this, so tests keep such connections few.

`e2e/specs/16-forwards.spec.ts` covers the three kinds through the UI.

## Troubleshooting

- **"refused to listen on port N"**: see Where A Forward Listens. On the server,
  `ss -ltn` shows what holds the port.
- **SOCKS client gets `0x02`, or a local forward's clients are dropped at once**:
  the server has `AllowTcpForwarding no`, or a `PermitOpen` that excludes the
  destination.
- **SOCKS client gets `0x05`**: the destination is not reachable from the SSH
  server. Names are resolved there, not here.
- **A remote forward cannot be reached from other machines**: it listens on the
  server's loopback; see Where A Forward Listens.
- **"Connection lost" or "stopped responding"**: the session died; the forward
  has already closed its port. Start it again once the server is back.
