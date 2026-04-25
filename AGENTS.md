# SSX Copilot Instructions

> **Docs index** — keep all docs in sync with code; never leave documentation stale.
> - `docs/architecture.md` — system diagrams and data-flow
> - `docs/development.md` — prerequisites, dev setup, build pipeline
> - `docs/features.md` — feature catalogue and keyboard shortcuts
> - `docs/file-transfer.md` — SCP/file transfer behaviour and constraints
> - `docs/git-sync.md` — git-sync export feature
> - `docs/troubleshooting.md` — common failure modes and fixes

## Build & Test

| Command | Purpose |
|---|---|
| `npm install` | Install frontend deps |
| `npm run tauri dev` | Dev mode (Node 20+, Rust stable, Tauri CLI required) |
| `npm test` | Vitest frontend suite (excludes `e2e/**`) |
| `npm test -- --run src/test/utils.test.ts` | Single test file |
| `cd src-tauri && cargo test` | Rust backend tests |
| `npm run e2e` | Dockerized end-to-end suite (opt-in; see E2E section) |

## Architecture

- **Tauri v2** desktop app: React/Vite frontend (`src/`) + Rust backend (`src-tauri/`)
- **Frontend state**: Zustand stores in `src/store/` call Tauri via `src/lib/tauri.ts` (lazy-loaded for test mocking)
- **Backend commands**: `src-tauri/src/commands/` → registered in `lib.rs` `invoke_handler![]`
- **SSH sessions**: `ssh2` crate, one thread per session, `mpsc` channels, events `ssx:ssh:{output|error|closed}:{id}` and `ssx:tunnel:status:{id}` (use helpers in `src-tauri/src/ssh.rs` + `src/lib/events.ts`)
- **Terminal**: xterm.js, stays mounted when hidden; tunnels live in `TunnelsView`, not the terminal tab bar
- **Persistence**: File-based at `~/.ssx/data.json`. All writes MUST use `atomic_write()` — never `fs::write` directly
- **Models**: `src/types/index.ts` ↔ `src-tauri/src/models.rs` must stay in sync (snake_case throughout). `cargo test` regenerates ts-rs bindings into `src/types/generated/`; `src/test/typesParity.test.ts` fails when a generated field is missing from the hand-written index.ts. CI: run `cargo test && git diff --exit-code src/types/generated/`.
- **IDs**: Generated server-side with `uuid::Uuid::new_v4()`; frontend never generates IDs

## Adding a Tauri Command (end-to-end)

1. `src-tauri/src/models.rs` — add/extend serde struct/enum
2. `src-tauri/src/commands/<area>.rs` — `load_data` → mutate → `save_data`, return `Result<T, String>`
3. `src-tauri/src/lib.rs` — register in `generate_handler![]`, `.manage()` if needed
4. `src/types/index.ts` — mirror Rust shape with snake_case fields
5. `src/store/use<Area>Store.ts` — `invoke("command_name", {...})` + update state
6. Wire into `App.tsx` or relevant component
7. **Tests are mandatory** — `npm test` + `cargo test` must pass before a feature is complete

## Code Reuse (Mandatory)

- **Before writing new code**, check `src/lib/`, `src/hooks/`, `src/components/ui/` — import and reuse existing helpers
- Extract any logic duplicated >5 lines to `src/lib/` (utilities), `src/hooks/` (React hooks), or `src/components/ui/` (presentational primitives) immediately
- No copy-paste logic across Rust crates or React components
- Run a duplication check (`jscpd` or similar) before committing

## Architecture Rules

- **Backend**: Single IPC handler crate; SSH/session lifecycle uses OS threads + `mpsc`; shared app state is managed centrally (for example `SshState` and other managed globals) with disciplined locking
- **Frontend**: Feature-sliced by domain; Zustand slices per feature; no prop drilling >2 levels
- **Separation**: Commands are pure (no UI logic); state is local-first
- **Scalability**: Lazy-load React routes; keep wasm-bindgen surface minimal

## Review Checklist (apply to every change)

1. **Logic**: No dead code paths; validate IPC payloads in both directions
2. **Tests**: 80% coverage on IPC + critical paths; types match (`ts-rs` for Rust/TS sync)
3. **Consistency**: Error shapes identical across frontend/backend; reference `docs/architecture.md`
4. **Docs**: Update `docker/README.md` when `docker-compose.yml` changes; update relevant docs for any API/port/command change

## Key Conventions

- **UI primitives**: Always use shared components (`<Input>`, `<Button>`, `<Checkbox>`, `<PasswordInput>`, `<RadioGroup>`, `<ConfirmDialog>`, `<ContextMenu>`) — never hand-roll
- **Accessibility**: Every icon-only button needs `aria-label`; decorative icons need `aria-hidden="true"`; every dialog needs `<DialogDescription>`; required fields need `aria-required="true"`
- **Styling**: Use `text-muted-foreground-soft` for tertiary metadata (not `/70` opacity blends); use `text-destructive` for error text (never `--destructive` or hex)
- **Forms**: Mount `<ConnectionForm>` / `<CredentialForm>` at App root (not per-view); use `useUnsavedChangesGuard`; call `guard.markSaved()` before closing on success
- **Destructive actions**: Always go through `<ConfirmDialog>`; never hand-roll overlays
- **Dialogs**: Opened from React state (no `<DialogTrigger>`); `<DialogContent>` handles focus-restore automatically
- **Mutex hygiene**: Use `lock_recover(&m)` in worker threads; `lock().map_err(...)?` on the managed-state path
- **Port inputs**: Use `parsePort` from `src/lib/port.ts` — never `parseInt(input) || 22`
- **Keyboard shortcuts**: Register via `useGlobalShortcuts`; document new ones in `docs/features.md`
- **Context menus**: Always use `<ContextMenu>` + `useContextMenu()`; wire `onKeyDown` on every trigger
- **Reduced motion**: Handled globally in `globals.css` with `0.01ms` (not `0s`) — never add component-level bypasses

## Playwright MCP (optional, for visual testing)

Point at `http://localhost:1420` (run `npm run dev` first). Add to `~/.copilot/mcp-config.json`:
```json
{ "mcpServers": { "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] } } }
```

## End-to-End Tests

- **Stack**: `tauri-driver` + WebdriverIO + Mocha (TypeScript). Specs in `e2e/specs/`, helpers in `e2e/helpers/`, selectors in `e2e/helpers/selectors.ts` (single source of truth).
- **CI**: `.github/workflows/e2e.yml` runs on push to `main` and `workflow_dispatch` only. Advisory status — not a PR gate.
- **Local**: `npm run e2e` runs the suite inside a Linux container (tauri-driver doesn't run on macOS). Requires Docker.
- **Storage isolation**: `SSX_DATA_DIR` env var (honored by `storage::data_dir()` and `keychain::secrets_path()`) points to a per-suite `mkdtemp`. The Tauri app is spawned once via `tauri-driver` and inherits the env, so all specs share one data dir — cross-spec isolation relies on every spec using unique credential / connection names.
- **SSH targets**: `docker/docker-compose.yml` defines four alpine sshd servers (`server-a/b/c/d`) with healthchecks. The `e2e-runner` service (under `e2e` profile) is the dockerized runner.
- **Adding a testid**: register the selector in `e2e/helpers/selectors.ts`, add `data-testid="<kebab>"` to the component, and (if the element represents a row) include `data-name` so specs can locate by user-visible name.
- **Artifacts**: failures upload `e2e/.artifacts/` (screenshots) from CI.
