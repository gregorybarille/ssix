# SSH Test Environment

Docker Compose setup for testing direct connections, local forwards (`ssh -L`), and jump host (`ssh -J`) connections.

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
- **server-c** is additionally reachable through **server-a** via the `private_a` internal network (for testing local forwards and jump host connections).
- **server-d** is additionally reachable through **server-b** via the `private_b` internal network.
- All servers have `AllowTcpForwarding yes` in sshd, which local forwards and jump host connections need.

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

## Testing local forwards and jump hosts

The Docker environment is designed to validate both two-hop connection kinds end-to-end.

### Local forward (`ConnectionKind::PortForward`, like `ssh -L`)

SSIX opens an SSH session to the SSH server with password auth, binds `127.0.0.1:<local_port>`,
and forwards every accepted local connection through the SSH server to the remote host. The
remote host need not run sshd — any TCP service works.

Configure an SSIX connection:

| Field                | Value           |
|----------------------|-----------------|
| Type                 | Local forward   |
| SSH Server Host      | `127.0.0.1`     |
| SSH Server Port      | `2201`          |
| SSH Server Credential| usera / passa   |
| Local Port           | `9001`          |
| Remote Host          | `server-c`      |
| Remote Port          | `22`            |

After connecting, validate from any other shell on the host:

```bash
ssh -p 9001 userc@127.0.0.1
```

The same pattern works for forwarding non-SSH services (HTTP APIs, databases, etc.) — set
`Remote Port` to whatever the service listens on inside the private network.

### Jump host (`ConnectionKind::JumpShell`, like `ssh -J`)

SSIX opens an SSH terminal to the target *through* the jump host. No SSH keys are
required on the jump host: SSIX authenticates to both the jump host and the target separately
with their own credentials.

Configure an SSIX connection:

| Field                  | Value         |
|------------------------|---------------|
| Type                   | Jump host     |
| Jump Host              | `127.0.0.1`   |
| Jump Host Port         | `2201`        |
| Jump Host Credential   | usera / passa |
| Target Host            | `server-c`    |
| Target Port            | `22`          |
| Target Credential      | userc / passc |

The terminal that opens is a shell on `server-c`, reached via `server-a`.

## Credentials

> **Note:** These are test-only credentials for local development. Do not reuse them in any production environment.

| Server   | Hostname    | Username | Password | Host Port | Access                        |
|----------|-------------|----------|----------|-----------|-------------------------------|
| server-a | `127.0.0.1` | usera    | passa    | 2201      | Direct, jump host or SSH server |
| server-b | `127.0.0.1` | userb    | passb    | 2202      | Direct, jump host or SSH server |
| server-c | `127.0.0.1` | userc    | passc    | 2203      | Direct, or via server-a (local forward or jump host) |
| server-d | `127.0.0.1` | userd    | passd    | 2204      | Direct, or via server-b (local forward or jump host) |
