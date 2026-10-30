# Architecture

SSIX is a Tauri v2 desktop application with a React frontend and a Rust backend.

## Layers

### Frontend

- `src/App.tsx` is the composition layer: it wires stores to the top-level layout, hosts the app-wide dialogs, and holds the cross-store submit handlers. It subscribes to stores through shallow selectors so loading/error flips in one store do not re-render the shell.
- `src/components/views/` holds the tab-level views (`ConnectionsView`, `CredentialsView`); `src/components/` contains the remaining UI components and feature views.
- `src/hooks/` holds reusable React hooks (`useGlobalShortcuts`, `useRovingFocus`, `useUnsavedChangesGuard`, `useScreenshotToast`, `useApplySettings`, `useDebouncedCallback`).
- `src/lib/` holds pure helpers shared across components (`search.ts` for the connection filter, `terminalTheme.ts` for the xterm palettes, `port.ts`, `hostKey.ts`, ...).
- `src/components/ui/` contains shared Radix-based primitives.
- `src/store/` contains Zustand stores that act as the async boundary for the UI. A store's `error` holds the last *load* failure only; views render it with the shared `ErrorBanner` (Retry re-runs the fetch) so a failed load never looks like an empty list. Mutations called from forms and confirm dialogs pass `runAsyncRethrow(..., { recordError: false })`: the caller shows the error and nothing lingers in `error` after the form closes. The Git Sync store is the exception and records action errors too, since its view is where they are shown.
- `src/lib/tauri.ts` (`invoke`) and `src/lib/terminalOutput.ts` (`createOutputChannel`) call `assertTauriRuntime()` from `src/lib/runtime.ts` first, so outside the desktop webview every backend call rejects with one readable message instead of the bridge's `__TAURI_INTERNALS__ is undefined` TypeError.
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
- Secrets never reach the frontend store. `get_credentials`, `add_credential` and `update_credential` return redacted credentials (password `""`, no inline key or passphrase; `private_key_path` is kept because a path is not a secret). The credential edit form fetches one credential's secrets with `get_credential_secrets(id)` when it opens and drops them when it closes; `update_credential` takes `keep_secrets`, set by the form whenever the secret fields were not changed (or could not be loaded), so unchanged secrets are never sent back and a failed fetch can never wipe them. Every backend consumer that needs real secrets (SSH/SCP auth, key install, connection cloning, sync-export redaction) resolves them server-side through `keychain::enrich_credential` / `snapshot_for_credential`.
- Commands that write to disk, spawn `git`, or use the network are `async` and run their bodies through `commands::blocking` (the Tauri blocking pool) so the UI thread never waits on fsync or I/O.
- `SettingsPanel` coalesces writes: edits are debounced for 300 ms (`useDebouncedCallback`) and at most one `save_settings` is in flight; a newer edit made during a save is queued behind it rather than issued in parallel. The pending save is flushed on panel unmount, window blur/hide and `pagehide`, and the panel refuses to adopt the store's echoed settings while a save is pending or in flight, so the UI state is never overwritten by a stale value. Each save sends the store's latest settings plus only the keys the panel changed, so a change made elsewhere during the window (a shortcut toggling the theme) survives. `useSettingsStore.saveSettings` is optimistic: the store takes the new value immediately and reverts if the backend rejects it, so previews never flash back while the write is in flight.
- Git remotes (`validate_git_remote`: names, URLs or local paths; no leading `-`, no control characters) and branches (`validate_git_branch`: valid ref names) are validated both when saved and when used, so a value starting with `-` can never reach `git` as an option.
- Connections are validated when saved, not only when used: `add_connection`, `update_connection` and `clone_connection` check the name, host and port (`validate_connection_fields`) and that every credential the kind needs is set and still exists (`validate_connection_credentials`). The connection form runs the same credential checks first. `delete_credential` refuses a credential any connection uses (`Connection::credential_ids`), and `AppData::drop_dangling_credential_refs` clears references that older builds left behind when data loads, so the backend's "no longer exists" message only appears in a race: a credential deleted while a form that picked it was open. `clone_connection` takes the clone form's whole connection and saves it through the same path as `add_connection`, copying the original's private credential instead of sharing it, after the name and credential checks pass so a refused clone copies no secret.
- Frontend and backend keep snake_case field names aligned because the Tauri payload is passed through directly.

## SSH Session Model

- Each shell session runs on its own backend thread. The command layer reaches it through a `SessionHandle` (mpsc queue + wake pipe); the worker sleeps in `poll(2)` on the SSH socket and the wake pipe, so idle sessions cost nothing and a keystroke wakes the worker immediately.
- Shell output streams to the webview as raw bytes over a Tauri `Channel` created by `src/lib/terminalOutput.ts` and passed to `ssh_connect` as `onOutput`. The sink buffers bytes until the `<Terminal>` mounts. Input travels as a string (`ssh_write { data }`).
- Per-session `error` and `closed` notifications travel on the same output `Channel` as small JSON messages (`OutputEvent` in `src-tauri/src/ssh.rs` ↔ `src/lib/terminalOutput.ts`), so they stay ordered with the bytes and are buffered until the terminal mounts. A session registers its `SessionHandle` in `SshState` before its worker thread starts, so a shell that exits immediately still cleans up its own entry. Tunnels emit `ssix:tunnel:status:{id}` events; the name is produced by helpers in `src-tauri/src/ssh.rs` and mirrored in `src/lib/events.ts` — both sides MUST go through these helpers.
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
