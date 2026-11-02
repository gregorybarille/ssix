# Roadmap: SSH client parity

Validated 2026-11-01. Nine features, delivered as one foundation branch
followed by eight feature streams that run in parallel. Each stream works
in its own git worktree on `feat/<stream>` and owns a disjoint set of
files, so merges stay small.

Out of scope: multi-device cloud sync (Git Sync covers it), Mosh, X11
forwarding, PuTTY and MobaXterm import.

## Decisions

| Topic | Decision |
|---|---|
| SFTP browser | A sidebar **Files** view, not a terminal tab |
| Folders | `folder: Option<String>` path on the connection (`prod/eu`), shown as a fourth connection layout |
| 2FA / OTP prompts | Answered inside the terminal pane, in the style of the host-key failure view |
| Resilience defaults | Keepalive every 30 s, auto-reconnect on (5 attempts, exponential backoff), session logging off |
| Remote / dynamic forwards | Two new connection kinds (`remote_forward`, `dynamic_forward`) listed in Port forwards |
| Import | `~/.ssh/config` only |
| Concurrency | Six streams at once in wave 1, two in wave 2 |

## Wave 0: foundation (sequential, merges first)

One branch, `feat/foundation`. Moves every shared edit up front and turns
the hot files into registries so the streams never touch the same lines.

1. **Persisted fields, all at once** (`models.rs`, generated bindings,
   `src/types/index.ts`), every one with a serde default:
   - `CredentialKind::Agent {}` (username only; keys come from the SSH agent)
   - `Connection`: `agent_forwarding: bool`, `keepalive_interval: Option<u16>`,
     `auto_reconnect: Option<bool>`, `log_session: Option<bool>`,
     `font_family: Option<String>`, `font_size: Option<u8>`,
     `color_scheme: Option<String>`, `folder: Option<String>`
   - `ConnectionKind::RemoteForward { gateway_*, remote_port, destination_host, destination_port }`
     and `ConnectionKind::DynamicForward { gateway_*, local_port }`, data only
   - `AppSettings`: `keepalive_interval: u16` (30), `auto_reconnect: bool` (true),
     `reconnect_max_attempts: u8` (5), `session_log_enabled: bool` (false),
     `session_log_dir: Option<String>`
   - `Snippet { id, name, command, tags }` and `snippets: Vec<Snippet>` on `AppData`
2. **Form and settings sections.** The connection form's Advanced area
   becomes one file per stream under `src/components/connection-form/`
   (`AuthOptions`, `SessionOptions`, `TerminalOptions`, `ForwardKinds`),
   fed by a pass-through `advanced` state object. Credential kind tabs
   become a table. `SettingsPanel.tsx` is split into section files under
   `src/components/settings/`.
3. **Terminal extension registry** (`src/components/terminal/extensions.ts`):
   `Terminal.tsx` runs a list of `TerminalExtension` objects
   (`onCreate`, which returns its cleanup, `onData`, `onOutput`). `terminalRegistry.ts`
   gains `writeToSession(id, text)` and `activeSessionId()`.
4. **Backend extension points.** Local-forward code moves from `ssh.rs`
   to `forwards.rs`; auth and direct-tcpip helpers become `pub(crate)`.
5. **Registries and anchors.** A view table (`src/lib/views.ts`) consumed
   by the sidebar and `App.tsx`; a shortcut table in `useGlobalShortcuts`;
   per-stream anchor comments in `generate_handler![]` and
   `e2e/helpers/selectors.ts`.
6. **Docker fixtures in one pass**: `server-e` with keyboard-interactive
   auth, `AllowTcpForwarding yes` and `GatewayPorts clientspecified` on
   `server-a`, `docker/README.md` updated.

## Wave 1: six streams in parallel

Merge order: B, A, C, D, F, G.

| Stream | Scope | Owns | E2E spec |
|---|---|---|---|
| **A Auth** | Agent auth, agent forwarding (libssh2 1.11 `AUTHAGENT` callbacks through a small raw-FFI module), keyboard-interactive for 2FA/OTP, FIDO2 keys via the agent | `authenticate()` in `ssh.rs`, `agent.rs`, `libssh2_ext.rs`, credential Agent tab, `AuthOptions`, `AuthPrompt` pane component | `14-auth` |
| **B Resilience** | Keepalive, auto-reconnect with backoff, session logging to `~/.ssix/session-logs/` | `run_io_loop` and session setup in `ssh.rs`, `commands/ssh.rs`, `useTerminalsStore`, `FailedTerminal.tsx`, `src/lib/reconnect.ts`, `SessionOptions`, session settings section | `15-resilience` |
| **C Forwards** | Remote `-R` and dynamic SOCKS5 `-D` forwards | `forwards.rs`, `PortForwardsView`, `usePortForwardsStore`, `ForwardKinds`, `ssh-command.ts`, `sshTerms.ts` | `16-forwards` |
| **D SFTP** | Two-pane browser: list, upload, download, rename, delete, mkdir, chmod, drag-drop, edit in place | `commands/sftp.rs`, `useSftpStore`, `views/FilesView.tsx`, `components/sftp/`, Browse-files row action | `17-sftp` |
| **F Snippets** | Snippet CRUD, `{{variable}}` prompts, Snippets view, palette that pastes into the active pane | `commands/snippets.rs`, `useSnippetsStore`, `views/SnippetsView.tsx`, `SnippetForm`, `SnippetPalette`, one shortcut | `18-snippets` |
| **G Import** | Import from `~/.ssh/config` with preview, dedupe, mapping of forwards, ProxyJump, ProxyCommand, IdentityFile | `ssh_config.rs`, `commands/import_config.rs`, `ImportDialog.tsx`, Import button in `ConnectionsView` | `19-import` |

Notes the foundation review left for the streams:

- **A Auth** replaces the `AuthMethod::Agent` refusal in `authenticate()`,
  and gives `CredentialForm` a full path for the agent kind: today an agent
  credential opens with no active tab and has no submit branch.
- **C Forwards** also fixes two bugs that predate the roadmap, both in
  `forwards.rs`. Stopping a forward leaves clients already inside
  `forward_bidi` tunnelling on their own session clone. An idle forward
  never notices a dead SSH session, so it stays "running" and keeps
  accepting clients it cannot serve. The frontend has the same gap:
  nothing listens to `forwardStatusEvent`, and `startForward` drops the
  output sink, so a forward that ended keeps showing as running.
- **C Forwards** rebases on B, then edits only the two refusal arms in
  `commands/ssh.rs`, which B owns. It no longer needs `useTerminalsStore`:
  the foundation already routes every forward kind to the forwards store
  and lists them in `PortForwardsView`. C still updates that view's
  `ssh -L` heading and empty state, and `CONNECTION_KIND_TABS`.
  `ForwardKinds` must show the remote and SOCKS port inputs with their
  errors: until then, a bad stored port blocks the save with no message.
- **A and C** update `src/test/ConnectionFormAdvanced.test.tsx` when they
  add tabs, because it pins today's lists.
- **F Snippets** tells users that Git Sync exports snippets as written,
  like scripts, because a saved command may hold a secret. The foundation
  already exports them and says so in `docs/git-sync.md`.
- **E Terminal UX** checks `color_scheme` against its palette list in
  `ConnectionAdvanced::validate`; the foundation checks only its shape.

## Wave 2: two streams, each starting when its dependency has merged

| Stream | Scope | After | Owns | E2E spec |
|---|---|---|---|---|
| **E Terminal UX** | Scrollback kept across views, search (Mod+F), clickable URLs, broadcast input to every pane in a tab, per-connection font/size/scheme overrides, extra palettes | B | extension files under `components/terminal/`, `TerminalTabs` broadcast toggle, `terminalTheme.ts`, `TerminalOptions` | `20-terminal-ux` |
| **H Folders** | Folders layout with a tree, drag to folder, folder picker in the form | D, G | `FolderTree.tsx`, `src/lib/folders.ts`, layout toggle, `ConnectionList` grouping | `21-folders` |

## Rules for every stream

- Own worktree, branch `feat/<stream>`, based on `main` after the
  foundation merged. Edit only owned files. Shared lists are append-only
  under the stream's anchor. New Cargo dependencies are appended to
  `Cargo.toml`; the integrator re-resolves `Cargo.lock` at merge time.
- Done means: `npm test`, `cargo fmt --check`,
  `cargo clippy --all-targets -- -D warnings`, `cargo test`,
  `npx tsc --noEmit`, generated
  types unchanged, a new E2E spec with unique connection and credential
  names run locally with the stream's isolated command below, a
  `docs/<feature>.md` plus one link line in `docs/features.md` and the
  `AGENTS.md` index.
- Never run the Docker scripts without the stream's project name: the
  default project holds the fixtures of the main checkout.

  ```bash
  COMPOSE_PROJECT_NAME=ssix-<stream> SSIX_PORT_PREFIX=<prefix> npm run e2e
  COMPOSE_PROJECT_NAME=ssix-<stream> npm run e2e:teardown
  ```

  | Stream | Prefix | | Stream | Prefix |
  |---|---|---|---|---|
  | auth | 231 | | snippets | 235 |
  | resilience | 232 | | import | 236 |
  | forwards | 233 | | terminal-ux | 237 |
  | sftp | 234 | | folders | 238 |
- The `AGENTS.md` conventions apply unchanged: shared UI primitives,
  `aria-label` on icon buttons, `DialogDescription`, `ConfirmDialog` for
  destructive actions, `atomic_write` for every file write, no floating
  overlays.
- Commits carry no attribution lines.
- Each stream reports a summary, decisions taken and known gaps. The
  integrator reviews every branch, resolves conflicts and runs the full
  suites after each merge. Nothing merges with a red E2E run.
