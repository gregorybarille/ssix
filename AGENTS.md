# SSX Copilot Instructions

## Build and test commands

- Prerequisites from the project docs: Node.js 20+, Rust stable, and Tauri CLI.
- `npm install` installs the frontend/tooling dependencies.
- `npm run tauri dev` starts the desktop app in development mode.
- `npm run build` builds the frontend bundle with `tsc && vite build`.
- `npm run tauri build` builds the packaged Tauri desktop app. Tauri runs `npm run build` first.
- `npm test` runs the Vitest frontend suite.
- `npm test -- --run src/test/utils.test.ts` runs a single frontend test file.
- `npm test -- -t "cn utility"` runs a single frontend test by name.
- `cd src-tauri && cargo test` runs the Rust backend tests.
- `cd src-tauri && cargo test test_default_settings` runs a single Rust test by name.

## High-level architecture

- This repository is a Tauri v2 desktop app with a React/Vite frontend in `src/` and a Rust backend in `src-tauri/`.
- `src/App.tsx` is the top-level coordinator for the three main views: connections, credentials, and settings. It owns dialog/open state and wires list and form components to the stores.
- Frontend data access is centralized in the Zustand stores under `src/store/`. Each store calls Tauri commands through `src/lib/tauri.ts`, which lazy-loads `@tauri-apps/api/core` so tests can mock it.
- The Rust side registers the command surface in `src-tauri/src/lib.rs`. The command modules in `src-tauri/src/commands/` implement CRUD/search behavior for connections, credentials, and settings.
- Persistence is file-based, not database-backed: `src-tauri/src/storage.rs` loads and saves a single `AppData` document at `~/.ssx/data.json`.
- The data model is shared across the frontend and backend. `src/types/index.ts` and `src-tauri/src/models.rs` describe the same JSON payload, so shape changes need to stay synchronized across both layers.
- Tauri config in `src-tauri/tauri.conf.json` uses Vite on port `1420` during development and packages `dist/` for production.

## Key conventions

- Keep the frontend and backend models in sync. Connections, credentials, and settings use the same snake_case field names in TypeScript and Rust because that shape is passed directly through Tauri and persisted to JSON.
- Credential and connection variants are encoded as tagged unions with a `type` field (`password` / `ssh_key`, `direct` / `tunnel`). Preserve that wire format instead of introducing camelCase adapters.
- Treat the Zustand stores as the async boundary. Components are mostly presentational; create/update/delete/search operations should go through the stores, which call Tauri commands and update local state.
- Forms keep local draft state and local error UI. They close their dialogs only after the awaited submit handler succeeds.
- Connection cloning is its own flow, not just a normal edit: `App.tsx` tracks `cloningConn`, `ConnectionForm` receives `isClone`, and the backend has a dedicated `clone_connection` command.
- Search is backend-driven through `search_connections`. Clearing the search box should refetch the full list instead of applying a client-side reset.
- Styling uses Tailwind utility classes with Radix UI primitives. Reuse the shared `cn()` helper from `src/lib/utils.ts` for class merging and keep theme/color work aligned with `src/styles/globals.css` and the constants in `src/types/index.ts`.
- Frontend tests use Vitest + Testing Library in `jsdom`, with Tauri invocations mocked centrally in `src/test/setup.ts`.
- UI components under `src/components/ui/` are shadcn/ui-style primitives built on Radix UI. They accept a `className` prop and compose with `cn()`. Prefer extending these over adding new third-party component libraries.
- Rust command functions follow the pattern: deserialize an input struct, call `load_data()`, mutate, call `save_data()`, and return the result or `Err(String)`. New commands must also be registered in the `invoke_handler!` macro in `src-tauri/src/lib.rs`.
- IDs are generated server-side using `uuid::Uuid::new_v4()`. The frontend never generates IDs; it sends data without `id` for creates and with `id` for updates.
- The CI workflow (`.github/workflows/test.yml`) runs frontend and backend tests separately on `main` pushes and PRs.
- Rust commands return `Result<T, String>`. Frontend stores catch the rejection, stringify it into `error`, and rethrow on mutating actions (`add/update/delete/clone`) so form components can display it. `fetch*` actions swallow the error into state instead of rethrowing.
- The Tauri CSP in `src-tauri/tauri.conf.json` is locked to `self` + `http://localhost:1420`. Adding outbound HTTP calls from the frontend requires updating the CSP.

## Adding a new Tauri command (end-to-end)

A feature that touches both layers typically needs edits in all of these spots:

1. `src-tauri/src/models.rs` — add or extend the serde-annotated struct/enum.
2. `src-tauri/src/commands/<area>.rs` — define the input struct and `#[tauri::command]` function using the `load_data` → mutate → `save_data` pattern.
3. `src-tauri/src/lib.rs` — register the new command inside `tauri::generate_handler![...]`.
4. `src/types/index.ts` — mirror the Rust shape with matching snake_case field names.
5. `src/store/use<Area>Store.ts` — add the action that calls `invoke("command_name", { ... })` and updates store state.
6. `src/App.tsx` or the relevant component — wire the store action into the UI.
7. Add backend tests in the command's `#[cfg(test)] mod tests` block and, if applicable, frontend tests under `src/test/`.

## Recommended MCP server: Playwright

Playwright MCP gives Copilot browser automation for visually testing the React frontend. Since this is a Tauri app, you can use it against the Vite dev server at `http://localhost:1420` to inspect rendered UI, fill forms, and verify behavior interactively.

To add it to your Copilot CLI, run `/mcp add` inside a session and configure:

```
Name:    playwright
Type:    local
Command: npx
Args:    @playwright/mcp@latest
```

Or add it directly to `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

Start the Vite dev server first with `npm run dev`, then Copilot can use Playwright to navigate `http://localhost:1420` and interact with the SSX UI.
