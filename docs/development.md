# Development

## Prerequisites

- Node.js 22+ for frontend tooling and npm commands in this guide (`npm run tauri dev`, `npm run build`, and `npm test`)
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

End-to-end:

- WebdriverIO + `tauri-driver` drives the real built Tauri app against
  the four Dockerized SSH servers in `docker/docker-compose.yml`.
- **CI-only by default**: runs on every push to `main` via
  `.github/workflows/e2e.yml` (advisory status — does not block merges).
  Trigger manually from the Actions tab via `workflow_dispatch`.
- **Locally optional**: developers run `npm test` + `cargo test` only.
  E2E does NOT run locally as part of the standard workflow because
  `tauri-driver` is unsupported on macOS.
- **Local debugging** (when reproducing a CI E2E failure): use the
  Dockerized runner, which works on every host that runs Docker:

  ```bash
  npm run e2e            # build image, run full suite
  npm run e2e:shell      # interactive shell inside the runner
  npm run e2e:teardown   # stop containers, drop named volumes
  ```

  Test specs and helpers live in `e2e/`. Each spec gets a fresh
  `SSX_DATA_DIR` (see `helpers/data-dir.ts`) so runs cannot leak into
  the developer's real `~/.ssx`. Failure artifacts (screenshots,
  docker logs) are written to `e2e/.artifacts/` and uploaded as a
  workflow artifact in CI.

  The first iteration covers credentials/connections CRUD, direct
  SSH, jump-shell, port forwarding, SCP round-trip, key generation +
  install, and git-sync export. Selectors are centralised in
  `e2e/helpers/selectors.ts`; some `data-testid` attributes are still
  to be added as the suite is brought green for the first time
  (Sidebar, ConnectionList, and the App add-buttons are wired today).

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
