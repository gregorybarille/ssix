# Architecture

SSIX is a Tauri v2 desktop application with a React frontend and a Rust backend.

## Layers

### Frontend

- `src/App.tsx` is the composition layer: it wires stores to the top-level layout, hosts the app-wide dialogs, and holds the cross-store submit handlers. It subscribes to stores through shallow selectors so loading/error flips in one store do not re-render the shell.
- `src/components/views/` holds the tab-level views (`ConnectionsView`, `CredentialsView`); `src/components/` contains the remaining UI components and feature views.
- `src/hooks/` holds reusable React hooks (`useGlobalShortcuts`, `useRovingFocus`, `useUnsavedChangesGuard`, `useScreenshotToast`, `useApplySettings`).
- `src/lib/` holds pure helpers shared across components (`search.ts` for the connection filter, `terminalTheme.ts` for the xterm palettes, `port.ts`, `hostKey.ts`, ...).
- `src/components/ui/` contains shared Radix-based primitives.
- `src/store/` contains Zustand stores that act as the async boundary for the UI.
- `src/lib/tauri.ts` lazy-loads Tauri `invoke()` so frontend tests can mock it.
- `src/types/index.ts` mirrors backend data structures. ts-rs writes a reference copy of every Rust model to `src/types/generated/` on `cargo test`; a parity test (`src/test/typesParity.test.ts`) fails when a generated field is missing from the hand-written index.ts.

### Backend

- `src-tauri/src/lib.rs` builds the Tauri app and registers commands.
- `src-tauri/src/models.rs` defines shared persisted models.
- `src-tauri/src/storage.rs` loads and saves `~/.ssix/data.json`.
- `src-tauri/src/keychain.rs` stores secret material in `~/.ssix/secrets.json`.
- `src-tauri/src/commands/` contains domain-specific Tauri commands.
- `src-tauri/src/ssh.rs` handles shell sessions, tunnels, jump-shell bridging, and SSH I/O loops.
- `src-tauri/src/known_hosts.rs` verifies server host keys (trust-on-first-use) against `~/.ssix/known_hosts`.

## Data Flow

UI -> Zustand store -> `invoke()` -> Tauri command -> storage / SSH subsystem -> response or emitted event

## Persistence Model

- `AppData` stores credentials, connections, and settings in a single JSON document.
- `storage.rs` keeps the parsed document in memory, keyed by path and mtime, so reads never touch disk unless the file changed underneath the app; every write goes through `atomic_write` and refreshes the cache.
- Secrets are stored separately from the main JSON file. A credential's secrets are read and replaced as one unit (`keychain::snapshot_for_credential` / `replace_for_credential`); commands that change a credential snapshot first and restore on a failed save so `data.json` and `secrets.json` never disagree. A corrupt secrets file is reported as such instead of being treated as empty.
- Commands that write to disk, spawn `git`, or use the network are `async` and run their bodies through `commands::blocking` (the Tauri blocking pool) so the UI thread never waits on fsync or I/O.
- Git remote and branch names are validated (`validate_git_name`) both when saved and when used, so a value starting with `-` can never reach `git` as an option.
- Frontend and backend keep snake_case field names aligned because the Tauri payload is passed through directly.

## SSH Session Model

- Each shell session runs on its own backend thread. The command layer reaches it through a `SessionHandle` (mpsc queue + wake pipe); the worker sleeps in `poll(2)` on the SSH socket and the wake pipe, so idle sessions cost nothing and a keystroke wakes the worker immediately.
- Shell output streams to the webview as raw bytes over a Tauri `Channel` created by `src/lib/terminalOutput.ts` and passed to `ssh_connect` as `onOutput`. The sink buffers bytes until the `<Terminal>` mounts. Input travels as a string (`ssh_write { data }`).
- The backend emits `ssix:ssh:error:{id}` and `ssix:ssh:closed:{id}` events. Tunnels also emit `ssix:tunnel:status:{id}`. Event names are produced by helpers in `src-tauri/src/ssh.rs` and mirrored in `src/lib/events.ts` — both sides MUST go through these helpers.
- Every handshake (direct, gateway, destination behind a gateway, SCP, key install) runs through one helper that applies a 10 s connect timeout, a 15 s libssh2 setup timeout, and host-key verification before any credential is sent. Unknown hosts are recorded on first use; a changed key is refused with a `HOST_KEY_MISMATCH host=… port=… fingerprint=…` error that the UI turns into a "Trust new host key" action (`ssh_forget_host_key`).
- Workers remove their own entry from `SshState.sessions` when they exit, so a session that ends on EOF does not linger in the registry.
- The frontend keeps terminal components mounted while hidden so output is not lost when switching tabs. xterm uses the WebGL renderer when the WebView provides WebGL (falling back to the DOM renderer) with a 10 000 line scrollback.

## Tunnel Model

- Port forwards bind to `127.0.0.1:<local_port>`. The gateway session runs non-blocking so clients never stall each other; each client's `direct-tcpip` channel is opened with EAGAIN retries and forwarded by a thread that sleeps in `poll(2)` on both sockets.
- Jump-shell and SCP share `bridge_via_gateway`, which returns a loopback stream only once the gateway channel is open (no handshake/bridge race) and times out instead of hanging if the gateway never answers.
- Jump-shell connections bridge through a gateway and then establish the destination SSH session behind it.
- Tunnel sessions appear in the Tunnels view, not in the shell tab bar.

## Git Sync Model

- Git Sync exports a sanitized snapshot into `.ssix-sync/` inside a user-configured repository.
- The export contains no passwords or inline private key material.
- One-click sync performs export, fetch, fast-forward pull when needed, commit when there are local exported changes, and push.
