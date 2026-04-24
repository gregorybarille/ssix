# Architecture

SSX is a Tauri v2 desktop application with a React frontend and a Rust backend.

## Layers

### Frontend

- `src/App.tsx` coordinates views, dialogs, terminal tabs, tunnel sessions, and high-level actions.
- `src/components/` contains UI components and feature views.
- `src/components/ui/` contains shared Radix-based primitives.
- `src/store/` contains Zustand stores that act as the async boundary for the UI.
- `src/lib/tauri.ts` lazy-loads Tauri `invoke()` so frontend tests can mock it.
- `src/types/index.ts` mirrors backend data structures. ts-rs writes a reference copy of every Rust model to `src/types/generated/` on `cargo test`; a parity test (`src/test/typesParity.test.ts`) fails when a generated field is missing from the hand-written index.ts.

### Backend

- `src-tauri/src/lib.rs` builds the Tauri app and registers commands.
- `src-tauri/src/models.rs` defines shared persisted models.
- `src-tauri/src/storage.rs` loads and saves `~/.ssx/data.json`.
- `src-tauri/src/keychain.rs` stores secret material in `~/.ssx/secrets.json`.
- `src-tauri/src/commands/` contains domain-specific Tauri commands.
- `src-tauri/src/ssh.rs` handles shell sessions, tunnels, jump-shell bridging, and SSH I/O loops.

## Data Flow

UI -> Zustand store -> `invoke()` -> Tauri command -> storage / SSH subsystem -> response or emitted event

## Persistence Model

- `AppData` stores credentials, connections, and settings in a single JSON document.
- Secrets are stored separately from the main JSON file.
- Frontend and backend keep snake_case field names aligned because the Tauri payload is passed through directly.

## SSH Session Model

- Each shell session runs on its own backend thread.
- The backend emits `ssx:ssh:output:{id}`, `ssx:ssh:error:{id}`, and `ssx:ssh:closed:{id}` events. Tunnels also emit `ssx:tunnel:status:{id}`. Event names are produced by helpers in `src-tauri/src/ssh.rs` and mirrored in `src/lib/events.ts` — both sides MUST go through these helpers.
- The frontend keeps terminal components mounted while hidden so output is not lost when switching tabs.

## Tunnel Model

- Port forwards bind to `127.0.0.1:<local_port>`.
- Jump-shell connections bridge through a gateway and then establish the destination SSH session behind it.
- Tunnel sessions appear in the Tunnels view, not in the shell tab bar.

## Git Sync Model

- Git Sync exports a sanitized snapshot into `.ssx-sync/` inside a user-configured repository.
- The export contains no passwords or inline private key material.
- One-click sync performs export, fetch, fast-forward pull when needed, commit when there are local exported changes, and push.
