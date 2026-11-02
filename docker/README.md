# SSH Test Environment

Docker Compose setup for testing direct connections, local forwards (`ssh -L`), remote forwards (`ssh -R`), jump host (`ssh -J`) connections and keyboard-interactive authentication.

## Architecture

```
Host machine
│
├── [port 2201] ──► server-a (usera / passa)
│                       │
│                       └── private_a network ──► server-c (userc / passc)
│
├── [port 2202] ──► server-b (userb / passb)
│                       │
│                       └── private_b network ──► server-d (userd / passd)
│
└── [port 2205] ──► server-e (usere / passe, keyboard-interactive only)
```

- **server-a**, **server-b** and **server-e** are directly accessible from the host on their respective ports.
- **server-c** and **server-d** sit only on internal networks, so Docker does not publish the ports the compose file lists for them. Reach them through a jump host.
- **server-c** is reachable through **server-a** via the `private_a` internal network (for testing local forwards and jump host connections).
- **server-d** is reachable through **server-b** via the `private_b` internal network.
- All servers have `AllowTcpForwarding yes` in sshd, which local forwards and jump host connections need.
- **server-a** also has `GatewayPorts clientspecified`, set by its `command:` in `docker-compose.yml`, so a remote forward can choose the address it binds on the server.
- **server-e** offers keyboard-interactive and refuses the password method. It is built from `Dockerfile.kbdint`, which runs Alpine's PAM build of sshd (`sshd.pam`); the other servers share `Dockerfile`. It has `PerSourcePenalties` off: its tests fail logins on purpose, all from one address, and the penalty would turn the tests after them away before their handshake.

## Usage

```bash
# Start all servers
npm run docker:up

# Start Docker servers and Tauri dev together
npm run dev:full

# Direct connections
ssh -p 2201 usera@localhost
ssh -p 2202 userb@localhost
ssh -p 2205 usere@localhost   # answers a "Password:" prompt from PAM

# Reference: ssh jump connection (server-c via server-a)
ssh -J usera@localhost:2201 userc@server-c

# Reference: ssh local port forward (server-c:22 via server-a, exposed on host port 9001)
ssh -L 9001:server-c:22 usera@localhost -p 2201 -N

# Reference: ssh remote port forward, bound on all of server-a's interfaces
ssh -R 0.0.0.0:9100:127.0.0.1:22 usera@localhost -p 2201 -N

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

## Testing keyboard-interactive authentication

`server-e` stands in for servers that ask questions at login, as 2FA and OTP servers do. PAM
sends one `Password:` prompt, and the answer is `passe`. To see what it offers, and that the
password method is refused:

```bash
# Permission denied (publickey,keyboard-interactive).
ssh -p 2205 -o PubkeyAuthentication=no -o PreferredAuthentications=none usere@localhost

# Permission denied, without ever asking for a password.
ssh -p 2205 -o PubkeyAuthentication=no -o PreferredAuthentications=password usere@localhost

# Prompts, then logs in.
ssh -p 2205 -o PubkeyAuthentication=no -o PreferredAuthentications=keyboard-interactive usere@localhost
```

## Credentials

> **Note:** These are test-only credentials for local development. Do not reuse them in any production environment.

| Server   | Hostname    | Username | Password | Host Port | Access                        |
|----------|-------------|----------|----------|-----------|-------------------------------|
| server-a | `127.0.0.1` | usera    | passa    | 2201      | Direct, jump host or SSH server |
| server-b | `127.0.0.1` | userb    | passb    | 2202      | Direct, jump host or SSH server |
| server-c | `server-c`  | userc    | passc    | 22        | Via server-a only (local forward or jump host) |
| server-d | `server-d`  | userd    | passd    | 22        | Via server-b only (local forward or jump host) |
| server-e | `127.0.0.1` | usere    | passe    | 2205      | Direct, keyboard-interactive only |

## Running from several checkouts

Compose names a project after the directory of its compose file, so every checkout and git
worktree of this repo is the same project, `docker`. Running `npm run docker:up`,
`npm run docker:down` or `npm run e2e` in a second checkout recreates or removes the containers
of the first and shares its cargo and `node_modules` volumes.

To run side by side, give each checkout its own project name and port prefix:

```bash
COMPOSE_PROJECT_NAME=ssix-auth SSIX_PORT_PREFIX=231 npm run e2e
COMPOSE_PROJECT_NAME=ssix-auth npm run e2e:teardown
```

- `COMPOSE_PROJECT_NAME` gives the checkout its own containers, networks and volumes. The first
  run in a project builds from cold.
- `SSIX_PORT_PREFIX` moves the published ports: with `231`, server-a is on `2311`, server-b on
  `2312` and server-e on `2315`. It defaults to `220`, which gives the usual `2201`, `2202` and
  `2205`.
- The dockerized runner reaches the servers by hostname on port 22, so it does not care about the
  prefix. `npm run e2e:wdio` on the host expects the default ports.
- Keep the project name on the teardown too, or it removes the default project's fixtures.

## Windows OpenSSH server (script tests)

`docker/windows-sshd/` builds a Windows Server Core image with Win32-OpenSSH and a
local user `ssix` / `Remote-Run-2026!`. It runs only on a Windows host whose kernel
matches the base image (`ltsc2022`, so Windows Server 2022 or a `windows-2022`
GitHub runner); Docker on macOS and Linux cannot run it. CI uses it to run the
script tests in `src-tauri/src/remote_script.rs` (`remote_script::live`) against a
real Windows host:

```powershell
docker build -t ssix-windows-sshd docker/windows-sshd
docker run -d --name ssix-windows-sshd ssix-windows-sshd
$ip = docker inspect -f "{{.NetworkSettings.Networks.nat.IPAddress}}" ssix-windows-sshd
$env:SSIX_LIVE_SSH = "${ip}:22"; $env:SSIX_LIVE_USER = "ssix"
$env:SSIX_LIVE_PASSWORD = "Remote-Run-2026!"; $env:SSIX_LIVE_PLATFORM = "windows"
cd src-tauri; cargo test live_ -- --ignored --test-threads=1
```

The same tests run against `server-a` for POSIX (see the module docs).
