# Development

## Prerequisites

- Node.js 22.12+ (CI and the e2e Docker image use Node 24) for frontend tooling and npm commands in this guide (`npm run tauri dev`, `npm run build`, and `npm test`). Vitest 5 requires `^22.12 || ^24 || >=26`; concurrently 10, jest-dom 7 and WebdriverIO 10 require 22+.
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

`npm run dev` serves the frontend alone at `http://localhost:1420`. Opened in a
browser it has no backend: `src/lib/runtime.ts` detects the missing Tauri
bridge and every backend call fails with "SSIX is running outside its desktop
app". Use it for layout work only; anything that loads or saves data needs
`npm run tauri dev`.

## Releases

Releases are built by `.github/workflows/release.yml` and uploaded to the
repository's GitHub Releases page as prereleases:

| Platform | Runner | Asset |
|---|---|---|
| Windows | `windows-latest` | portable `ssix.exe` (`npm run tauri build -- --no-bundle`), for users who cannot install MSI packages |
| macOS, Apple Silicon | `macos-15` | `.dmg` |
| Linux, x86_64 | `ubuntu-22.04` | `.deb`, `.rpm` and AppImage (`--bundles deb,rpm,appimage`) |

Windows and macOS tests run in their own jobs alongside the builds (Linux
tests run on every push and pull request in `test.yml`). A small publish job
uploads the assets only after every job succeeds. The beta builds disable
release LTO and raise codegen units to cut turnaround time while still
producing optimized binaries.

The workflow publishes against the actual Git tag (for example
`v1.0.0-beta.11`) using `gh release --verify-tag`, so the assets appear on the
tagged release page. The release notes, with install steps per platform, come
from `.github/release-notes.md`.

The package version remains semver (`1.0.0`) in `src-tauri/tauri.conf.json`.
Use prerelease labels on the Git tag and GitHub release name.

To publish a release, push a Git tag:

```bash
git tag v1.0.0-beta.1
git push origin v1.0.0-beta.1
```

The release workflow can also be started manually from the Actions tab by
providing the release tag input, for example `v1.0.0-beta.1`.

Current builds are unsigned and intended for personal use:

- **Windows** may show SmartScreen warnings until code signing is added.
- **macOS**: the app is ad-hoc signed (`bundle.macOS.signingIdentity: "-"`)
  but not notarized. Without the ad-hoc seal a downloaded copy is reported as
  damaged; with it, Gatekeeper blocks the first launch and System Settings →
  Privacy & Security offers **Open Anyway**.
- **Linux**: the Linux build uses Ubuntu 22.04 because it is the oldest
  runner with WebKitGTK 4.1. Its glibc (2.35) caps what the binary can
  require (2.34 today), which Debian 12, Fedora and RHEL 10 all meet. RHEL 10 and its rebuilds get WebKitGTK
  4.1 from EPEL. RHEL 9 has no WebKitGTK 4.1 at all, so it is not supported.

## Icons

Every file in `src-tauri/icons` is generated from the SVGs in
`src-tauri/icons/source` by `npm run icons` (`scripts/generate-icons.mjs`):

- `ssix.svg` is the icon itself, used for Windows, Linux, Android and iOS.
- `ssix-small.svg` replaces it at 16–32 px (the small sizes of `icon.ico`
  and `32x32.png`), with solid wings instead of the sketched ones, which blur
  at that size.
- `icon.icns` puts `ssix.svg` on Apple's icon grid (an 824 px body in the
  1024 px canvas), so it matches the size of other Dock icons.

Edit the SVGs, run `npm run icons`, and commit the regenerated files.

## Repo Structure

- `src/` frontend app (React 19 + Vite 8 + TypeScript 7). `tsc` is the native TypeScript 7 compiler (per-platform binary, no JS compiler API); `npm run build` runs `tsc && vite build`
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

- Vitest 5 (jest-dom matchers registered via the `@testing-library/jest-dom/vitest` entry in `src/test/setup.ts`)
- Testing Library
- Tauri APIs mocked centrally in `src/test/setup.ts`

Backend:

- Rust unit tests inside the relevant modules

Continuous integration (`.github/workflows/test.yml`, required on PRs):

- Frontend: `npm audit --omit=dev --audit-level=high`, `npm test`, `npm run build`
- Backend: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, and a
  `git diff --exit-code src/types/generated/` check so regenerated ts-rs
  bindings are always committed
- `cargo audit` via `rustsec/audit-check` for advisories in `src-tauri/Cargo.lock`. `.cargo/audit.toml` (at the repo root, where the action runs) ignores advisories for optional crates that are in the lockfile but never compiled, with the reason for each

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
  # one spec only (the runner forwards extra args to the container):
  docker compose --profile e2e -f docker/docker-compose.yml run --rm --build \
    e2e-runner npx wdio run e2e/wdio.conf.ts --spec /workspace/e2e/specs/10-host-key.spec.ts
  npm run e2e:teardown   # stop containers, drop named volumes
  ```

  Test specs and helpers live in `e2e/`. A single shared `SSIX_DATA_DIR`
  is created once in `wdio.conf.ts` `onPrepare` and deleted in
  `onComplete` (see `helpers/data-dir.ts`). Because the Tauri app
  process is started once and inherits the env var at launch, cross-spec
  isolation relies on every spec using unique credential / connection
  names rather than separate directories. Runs cannot leak into the
  developer's real `~/.ssix`. Failure artifacts (screenshots, docker
  logs) are written to `e2e/.artifacts/` and uploaded as a workflow
  artifact in CI.

  The first iteration covers credentials/connections CRUD, direct
  SSH, jump host, local forwarding, SCP round-trip, key generation +
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
- Jump host connection
- Local forward and local client access
- SCP file transfer
- Recursive SCP directory transfer
- Git Sync export, diff, one-click sync
