# SSH Test Environment

Docker Compose setup for testing direct and jump/tunnel SSH connections.

## Architecture

```
Host machine
│
├── [port 2201] ──► server-a (usera / passa)
│                       │
│                       └── private_a network ──► server-c (userc / passc)
│
└── [port 2202] ──► server-b (userb / passb)
                        │
                        └── private_b network ──► server-d (userd / passd)
```

- **server-a** and **server-b** are directly accessible from the host on ports `2201` and `2202`.
- **server-c** is only reachable through **server-a** (via the `private_a` internal network).
- **server-d** is only reachable through **server-b** (via the `private_b` internal network).

## Usage

```bash
# Start all servers
npm run docker:up

# Start Docker servers and Tauri dev together
npm run dev:full

# Test direct connection to server-a
ssh -p 2201 usera@localhost

# Test direct connection to server-b
ssh -p 2202 userb@localhost

# Test jump connection to server-c through server-a
ssh -J usera@localhost:2201 userc@server-c

# Test jump connection to server-d through server-b
ssh -J userb@localhost:2202 userd@server-d

# Stop all servers
npm run docker:down
```

## Credentials

> **Note:** These are test-only credentials for local development. Do not reuse them in any production environment.

| Server   | Hostname | Username | Password | Host Port | Access              |
|----------|----------|----------|----------|-----------|---------------------|
| server-a | server-a | usera    | passa    | 2201      | Direct              |
| server-b | server-b | userb    | passb    | 2202      | Direct              |
| server-c | server-c | userc    | passc    | —         | Jump via server-a   |
| server-d | server-d | userd    | passd    | —         | Jump via server-b   |
