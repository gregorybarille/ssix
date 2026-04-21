# SSH Test Environment

Docker Compose setup for testing direct connections, port forwarding, and jump-shell SSH connections.

## Architecture

```
Host machine
│
├── [port 2201] ──► server-a (usera / passa)
│                       │
│                       └── private_a network ──► server-c (userc / passc) [port 2203]
│
└── [port 2202] ──► server-b (userb / passb)
                        │
                        └── private_b network ──► server-d (userd / passd) [port 2204]
```

- All four servers are directly accessible from the host on their respective ports.
- **server-c** is additionally reachable through **server-a** via the `private_a` internal network (for testing port forwarding and jump-shell connections).
- **server-d** is additionally reachable through **server-b** via the `private_b` internal network.
- All servers have `AllowTcpForwarding yes` in sshd, which is required for port-forward and jump-shell to work.

## Usage

```bash
# Start all servers
npm run docker:up

# Start Docker servers and Tauri dev together
npm run dev:full

# Direct connections
ssh -p 2201 usera@localhost
ssh -p 2202 userb@localhost
ssh -p 2203 userc@localhost
ssh -p 2204 userd@localhost

# Reference: ssh jump connection (server-c via server-a)
ssh -J usera@localhost:2201 userc@server-c

# Reference: ssh local port forward (server-c:22 via server-a, exposed on host port 9001)
ssh -L 9001:server-c:22 usera@localhost -p 2201 -N

# Stop all servers
npm run docker:down
```

## Testing SSX tunneling features

The Docker environment is designed to validate the two SSX tunnel kinds end-to-end.

### Port Forward (`ConnectionKind::PortForward`)

SSX opens an SSH session to the gateway with password auth, binds `127.0.0.1:<local_port>`,
and forwards every accepted local connection through the gateway to the destination. The
destination need not run sshd — any TCP service works.

Configure an SSX connection:

| Field                | Value           |
|----------------------|-----------------|
| Type                 | Port Forward    |
| Gateway Host         | `127.0.0.1`     |
| Gateway Port         | `2201`          |
| Gateway Credential   | usera / passa   |
| Local Port           | `9001`          |
| Destination Host     | `server-c`      |
| Destination Port     | `22`            |

After connecting, validate from any other shell on the host:

```bash
ssh -p 9001 userc@127.0.0.1
```

The same pattern works for forwarding non-SSH services (HTTP APIs, databases, etc.) — set
`Destination Port` to whatever the service listens on inside the private network.

### Jump Shell (`ConnectionKind::JumpShell`)

SSX opens an SSH terminal to the destination *through* the gateway. No SSH keys are
required on the gateway: SSX authenticates to both gateway and destination separately
with their own credentials.

Configure an SSX connection:

| Field                  | Value         |
|------------------------|---------------|
| Type                   | Jump Shell    |
| Gateway Host           | `127.0.0.1`   |
| Gateway Port           | `2201`        |
| Gateway Credential     | usera / passa |
| Destination Host       | `server-c`    |
| Destination Port       | `22`          |
| Destination Credential | userc / passc |

The terminal that opens is a shell on `server-c`, reached via `server-a`.

## Credentials

> **Note:** These are test-only credentials for local development. Do not reuse them in any production environment.

| Server   | Hostname    | Username | Password | Host Port | Access                        |
|----------|-------------|----------|----------|-----------|-------------------------------|
| server-a | `127.0.0.1` | usera    | passa    | 2201      | Direct or gateway             |
| server-b | `127.0.0.1` | userb    | passb    | 2202      | Direct or gateway             |
| server-c | `127.0.0.1` | userc    | passc    | 2203      | Direct, port-forward, or jump via server-a |
| server-d | `127.0.0.1` | userd    | passd    | 2204      | Direct, port-forward, or jump via server-b |
