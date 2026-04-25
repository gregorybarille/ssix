# Development

## Prerequisites

- Node.js 22+
- Rust stable
- Tauri CLI

Install frontend dependencies:

```bash
npm install
```

Install Tauri CLI if needed:

```bash
cargo install tauri-cli --version "^2"
```

## Main Commands

```bash
npm run tauri dev
npm run build
npm test
cd src-tauri && cargo test
```

## Repo Structure

- `src/` frontend app (React 19 + Vite 8 + TypeScript)
- `src-tauri/` backend app
- `docs/` product and engineering documentation
- `docker/` local SSH test environment

## Engineering Conventions

- Keep frontend and backend models in sync.
- Add tests for every new feature.
- Prefer minimal changes over introducing extra abstractions.
- Treat Zustand stores as the async boundary.
- Keep components primarily presentational where possible.

## Testing

Frontend:

- Vitest
- Testing Library
- Tauri APIs mocked centrally in `src/test/setup.ts`

Backend:

- Rust unit tests inside the relevant modules

## Adding A New Tauri Command

1. Update `src-tauri/src/models.rs` if the data model changes.
2. Add the command in `src-tauri/src/commands/`.
3. Register it in `src-tauri/src/lib.rs`.
4. Mirror the shape in `src/types/index.ts`.
5. Add store integration in `src/store/`.
6. Wire the UI.
7. Add frontend and/or backend tests.

## Manual Verification Suggestions

- Direct shell with password auth
- Direct shell with SSH key auth
- Jump-shell through gateway
- Port forward and local client access
- SCP file transfer
- Recursive SCP directory transfer
- Git Sync export, diff, one-click sync
