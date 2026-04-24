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
| `npm test` | Vitest frontend suite |
| `npm test -- --run src/test/utils.test.ts` | Single test file |
| `cd src-tauri && cargo test` | Rust backend tests |

## Architecture

- **Tauri v2** desktop app: React/Vite frontend (`src/`) + Rust backend (`src-tauri/`)
- **Frontend state**: Zustand stores in `src/store/` call Tauri via `src/lib/tauri.ts` (lazy-loaded for test mocking)
- **Backend commands**: `src-tauri/src/commands/` → registered in `lib.rs` `invoke_handler![]`
- **SSH sessions**: `ssh2` crate, one thread per session, `mpsc` channels, events `ssh-{output|error|closed}-{id}`
- **Terminal**: xterm.js, stays mounted when hidden; tunnels live in `TunnelsView`, not the terminal tab bar
- **Persistence**: File-based at `~/.ssx/data.json`. All writes MUST use `atomic_write()` — never `fs::write` directly
- **Models**: `src/types/index.ts` ↔ `src-tauri/src/models.rs` must stay in sync (snake_case throughout)
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

- **Before writing new code**, check `src/utils/`, `src/lib/`, `src/hooks/` — import and reuse existing helpers
- Extract any logic duplicated >5 lines to `src/utils/` immediately
- No copy-paste logic across Rust crates or React components
- Run a duplication check (`jscpd` or similar) before committing

## Architecture Rules

- **Backend**: Single IPC handler crate, async-safe Rust (tokio), no global mutable state
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
