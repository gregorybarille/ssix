# SSH Test Environment

Docker Compose setup for testing direct and jump/tunnel SSH connections.

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
- **server-c** is additionally reachable through **server-a** via the `private_a` internal network (for testing tunnel/jump connections).
- **server-d** is additionally reachable through **server-b** via the `private_b` internal network (for testing tunnel/jump connections).

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

# Test jump connection to server-c through server-a
ssh -J usera@localhost:2201 userc@server-c

# Test jump connection to server-d through server-b
ssh -J userb@localhost:2202 userd@server-d

# Stop all servers
npm run docker:down
```

## Credentials

> **Note:** These are test-only credentials for local development. Do not reuse them in any production environment.

| Server   | Hostname    | Username | Password | Host Port | Access                        |
|----------|-------------|----------|----------|-----------|-------------------------------|
| server-a | `127.0.0.1` | usera    | passa    | 2201      | Direct                        |
| server-b | `127.0.0.1` | userb    | passb    | 2202      | Direct                        |
| server-c | `127.0.0.1` | userc    | passc    | 2203      | Direct or jump via server-a   |
| server-d | `127.0.0.1` | userd    | passd    | 2204      | Direct or jump via server-b   |
