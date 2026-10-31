# Features

## Connections

SSIX supports three connection types, named after the OpenSSH options they
correspond to:

| Kind | `ssh` equivalent | Hosts |
|---|---|---|
| Direct (`direct`) | `ssh user@host` | the host |
| Local forward (`port_forward`) | `ssh -L local:remote:port user@server` | the **SSH server**, which forwards a local port to the **remote host** |
| Jump host (`jump_shell`) | `ssh -J user@jumphost user@target` | the **jump host**, which relays the session to the **target** |

The names in backticks are the stored values in `data.json`; they predate
the OpenSSH wording and are kept so existing data loads unchanged. The
`gateway_*` fields hold the SSH server or jump host, and the
`destination_*` fields hold the remote host or target. `src/lib/sshTerms.ts`
maps each kind to the words the UI shows.

Each shell-capable connection can also define:

- `login_command`
- `remote_path`
- tags
- color accent
- verbosity level (see [Diagnostics](#diagnostics))
- extra SSH arguments
- a proxy command (see below)

### Proxy command and WSL

A connection can reach its first hop — the host of a direct connection,
the jump host, or a local forward's SSH server — through a local
command instead of a TCP connection, like `ProxyCommand` in
`ssh_config`. SSIX runs the command (`/bin/sh -c` on macOS and Linux,
`cmd.exe /S /C` on Windows) and speaks SSH over its stdin and stdout.
`%h`, `%p` and `%r` expand to the hop's host, port and user, and `%%` to
`%`; other tokens are refused when the connection is saved. A host or
user containing anything but letters, digits and `. - _ : @` is refused
rather than pasted into the command. Lines the command prints on stderr
appear in the Logs view (source `proxy`), and the command is stopped when
the session closes.

On Windows the **Through WSL** button fills in `wsl.exe -e nc %h %p`,
which connects from inside the default WSL distribution, so SSIX reaches
hosts only WSL can see (its own network, or a VPN running there). The
distribution needs `nc` (`netcat-openbsd` on Debian and Ubuntu). SCP and
local forwards use the proxy too; the copied `ssh` command carries it as
`-o ProxyCommand=…`.

## Credentials

Supported credential modes:

- password
- SSH key path
- inline SSH private key

The connection form can create inline credentials and optionally save them as named credentials.

**Clone** opens the connection form prefilled from a connection, and
everything in it (kind, jump host or SSH server, tags, colour, options) is saved as the
new connection. The original's private inline credential is copied, so
the clone and the original never share one; inline auth entered in the
clone form makes a credential for the clone alone.

A credential that connections use cannot be deleted. Confirming the
delete is refused, and the confirmation then lists the connections that
use it; give them another credential first.

The credentials list only holds redacted credentials. Opening **Edit**
fetches that one credential's saved secrets (`get_credential_secrets`)
and prefills them; the secret fields and the **Update** button are
disabled with a "Loading saved secrets…" status until the fetch
settles. Saving sends the secret fields back only when the user changed
one of them; otherwise the update carries `keep_secrets` and the backend
leaves the stored secrets untouched. If the fetch fails the form shows
the error, locks the secret fields, and still lets the user save the
other fields with the stored secrets kept as they are. Closing the editor without edits never prompts to discard
changes, because the unsaved-changes baseline follows the fetched values.

## Terminals

- tabbed shell sessions
- split right
- split down
- retry failed sessions
- edit source connection from failure UI
- GPU-accelerated rendering (xterm WebGL addon) when the WebView supports it, 10 000 lines of scrollback
- right-click pastes into the terminal under the cursor only

### Host-key verification

Every SSH connection — direct, the jump host, the target behind it, a local forward's SSH server, SCP and the public-key installer — verifies the server's host key before a password or key is sent.

- The first time a `host:port` is seen its key is recorded in `~/.ssix/known_hosts` (OpenSSH format, so `ssh-keygen -F`/`-R` work on it).
- If the key later differs the connection is refused. The failure view names the host, shows the new SHA256 fingerprint and offers **Trust new host key**, which forgets the stale entry and reconnects. Use it only when you know the server was reinstalled or re-keyed.
- Connections time out after 10 s (TCP) / 15 s (SSH setup) instead of hanging on a dead host.

### Terminal tab keyboard shortcuts

The terminal tab bar is a true WAI-ARIA tablist. With focus on a tab:

- **Arrow Left / Arrow Right** — move focus and selection between tabs
- **Home / End** — jump to first / last tab
- **Delete** or **Cmd/Ctrl+W** — close the focused tab
- The "x" affordance on tabs is mouse-only.

## Port Forwards

- local forwards (`ssh -L`): SSIX listens on `127.0.0.1:<local port>` and
  forwards each connection through the SSH server to the remote host
- one row per local forward with status indicator:
  grey for not connected/connecting, green for connected, red for connection errors
- expandable inline detail panes beneath each forward; multiple rows can stay expanded

## Search, Tags, And Colors

- search filters the loaded list in the frontend (`src/lib/search.ts`); no backend call per keystroke
- query terms are AND-matched, case-insensitive
- matches run across connection name, host, jump host / SSH server, target / remote host, and tags; the same matcher powers the Connect Picker
- color accents appear on connection cards and terminal tabs

## SCP File Transfer

- upload files
- download files
- upload directories recursively
- download directories recursively
- direct and jump host connections supported
- local forwards are not SCP targets

See [File Transfer](file-transfer.md) for behavior and limitations.

## Scripts

The **Scripts** view (sidebar) keeps scripts you run on several hosts at
once.

- **New Script** opens the editor in the side panel: a name, what it
  **runs on**, the **interpreter** and the script itself. Names are
  unique; a script can be up to 256 KiB.
- **Linux, macOS, BSD** (the default): the interpreter is the command the
  server runs; it reads the script on its standard input, so nothing is
  copied to the host first. Presets cover `sh -s` (the default), `bash -s`
  and `python3 -`; any other command that reads a program from stdin works
  too. The interpreter is started through the host's POSIX `sh`.
- **Windows** (Windows OpenSSH servers): the script is PowerShell, run by
  `powershell` (Windows PowerShell, built in; the default) or `pwsh`
  (PowerShell 7), or a path to either without spaces. It works with
  either cmd or PowerShell as the server's default shell. The exit code
  is the script's `exit`, else the last program's exit code; an uncaught
  error exits 1. Errors that don't stop the script (`Write-Error`, a
  missing path in `Get-Item`) leave it at 0: use `exit 1`, or set
  `$ErrorActionPreference = 'Stop'`, to make them fail the host.
  Switching platform swaps a preset interpreter for the other platform's
  default; a command you typed stays.
- Select a script to see its body and the hosts it can run on: every
  direct and jump host connection (local forwards cannot run scripts).
  Tick hosts, or **All hosts**, and **Run on N hosts**.
- The script starts on every picked host at the same time. Each host
  gets its own card as it finishes: success when it exits 0, otherwise
  the exit code, the signal that killed it, or the connection error, plus
  how long it took, its standard output and its standard error.
- **Cancel** (shown while a run is going) stops every host that has not
  finished: the script and everything it started get SIGTERM (on Windows,
  `taskkill /T /F`), and the
  card shows **cancelled** with the output printed so far. Hosts that had
  already finished keep their result.
- Each stream keeps the first 1 MiB of output; the card says when output
  was cut. A script still running after 10 minutes is stopped the same way
  as a cancel.
- The last run's results stay while you visit other views, and running
  again starts from the hosts you picked last time.
- Each run is also logged (source `script`) in the Logs view, and a
  connection's verbosity adds its `ssh -v` lines there as for a shell.
- Scripts are saved in `data.json`, so Local Backups and Git Sync carry
  them. Deleting one asks for confirmation first.

## Git Sync

- sanitized config export into `.ssix-sync/`
- exact diff view
- fetch, pull, commit, push
- one-click sync
- sidebar pending indicator for local or remote changes

See [Git Sync](git-sync.md) for details.

## Local Backups

Settings → **Backups** keeps ZIP copies of `~/.ssix` in `~/.ssix/backups`:
`data.json` (connections, credentials, settings), `secrets.json`
(passwords, passphrases and inline keys) and `known_hosts`. Unlike Git
Sync, a backup holds the secrets, so archives are created readable only by
you (0600, in a 0700 folder) and never leave the machine.

- **Back up automatically** (on by default) checks a minute after launch
  and then every ten minutes, and takes a backup once the chosen
  frequency (every hour to every week, default every day) has passed
  since the newest backup — unless nothing changed since then.
- **Automatic backups kept** (default 10) prunes the oldest automatic
  backups. Manual and "before restore" backups stay until you delete them.
- **Back up now** takes a manual backup.
- **Restore** (after a confirmation) checks the whole archive before it
  touches anything: only the expected files, each matching the size and
  SHA-256 in its `manifest.json`, contents SSIX can load, and a format no
  newer than this build. It then backs up the current files as a "before
  restore" backup, so a restore can itself be undone, and replaces the
  live files with the archive's; a file the archive does not hold is
  removed. Connections, credentials and settings reload at once.
- An archive SSIX cannot read is listed with the reason and can only be
  deleted.

Each archive is written in full before it appears under its final name
(`ssix-backup-YYYYMMDD-HHMMSS-mmm.zip`, UTC), so a crash never leaves a
half-written backup in the list.

## Diagnostics

- backend logs
- frontend logs
- per-connection verbosity, modelled on `ssh -v`. Each level adds
  `debugN: [host:port] …` lines to the backend logs for every hop of the
  connection (jump host, SSH server, target), SCP included:
  - **-v**: connecting, server version, key exchange and host key
    algorithms, the server host key and its fingerprint, the
    authentication methods the server allows and which one succeeded,
    session channel, PTY and shell requests, `direct-tcpip` channels and
    forwarded connections
  - **-vv**: the socket peer, the negotiated cipher, MAC and compression
    in each direction, the startup command, closed forwarded connections
  - **-vvv**: the algorithms SSIX offers and how long the TCP connect,
    key exchange and authentication took
  From -v the terminal also starts with a "Connected to …" line.
  Passwords and key contents are never logged.
- screenshot capture from the **Window actions** context menu (right-click
  any empty area of the window, outside an input or terminal selection)

## SSH Key Utilities

- generate keypairs
- choose storage mode for generated keys
- install public key on remote hosts
- **Browse for an existing private key** via the native file picker:
  the SSH Key tab in the credential form has a folder icon next to the
  Private Key Path input that opens the OS file dialog (powered by
  `@tauri-apps/plugin-dialog`). Selecting a file writes the absolute
  path back into the input and clears the "Private key path is
  required" inline error if it was showing. Cancelling the dialog
  leaves the existing value untouched, so users who prefer to type a
  path can still do so.

## Settings

Every control auto-saves; there is no Save button. Writes are debounced
(300 ms after the last edit, `SETTINGS_SAVE_DEBOUNCE_MS` in
`SettingsPanel.tsx`) so toggling several switches or clicking through
swatches produces a single `save_settings` call carrying the final
state. The pending save is flushed immediately when the panel is
closed, when the window loses focus or is hidden, and on page unload,
so the persisted state always equals what the panel shows. A green
"Settings saved!" confirmation appears once the write lands; backend
validation errors (for example an invalid Git remote or branch name)
are shown inline for the final state of the burst.

- theme (light / dark; switching previews immediately and auto-saves on
  change; terminal panes follow it too, swapping between the Tokyo Night
  and Tokyo Night Day palettes live without reconnecting;
  both themes are calibrated to meet WCAG AA — body text and
  tertiary metadata such as timestamps stay above the 4.5:1 contrast
  ratio on both themes)
- font family
- font size
- color scheme
- list/tile layouts per section (the Connections view also offers a
  third **Tag groups** layout — see [Tag groups](#tag-groups))
- default terminal open mode
- Git Sync repository settings

## Title Bar

SSIX renders its own draggable title bar so it can host a Settings shortcut
and (on Windows / Linux) the minimize / maximize / close window controls.

- macOS uses the native traffic-light buttons; only the Settings button is
  rendered on the right.
- Windows / Linux render Minimize, Maximize/Restore, and Close buttons.
  The Maximize button's icon and `aria-label` (`"Maximize window"` vs
  `"Restore window"`) are driven by an `onResized` subscription on the
  Tauri window so the OS — not optimistic local state — is the source of
  truth. This means the icon stays correct after double-clicking the
  title bar, after OS-level shortcuts (Win+Up, F11, Super+Up), and after
  window-snapping behaviour that bypasses our toggleMaximize handler.

## Side Panel

Nothing in SSIX opens a floating window. Editors (connection,
credential and script forms), SCP and bulk SCP, key generation and key install open
in a panel column on the right of the app, beside the current view, so
the list you came from stays visible and usable. Confirmations appear as
a compact card at the top of that column, above the panel they are about.
The column only takes room while something is open in it.

- A panel stays open while you click or tab around the view beside it;
  Escape, **Cancel** or its close button close it.
- Opening another editor from the list (Edit on another row, **New
  Connection**) replaces the open one at once if it is unchanged, and
  asks first if it has unsaved changes (see
  [Unsaved-changes guard](#unsaved-changes-guard)).
- The quick-connect picker (Cmd/Ctrl+K) is the exception: it stays a
  centred palette.

`<DialogContent>` portals into the column (`src/components/ui/panel-slot.tsx`,
mounted by `App`), and its `kind` prop picks `panel`, `confirm` or
`palette`.

## Destructive-Action Confirmations

SSIX shows an in-app confirmation before any destructive action:

- deleting a connection
- deleting a credential
- deleting a script
- closing a live terminal pane
- closing a tab whose panes still hold a live SSH session

Confirmation panels default focus to the **Cancel** button so an
accidental Enter press never destroys data. Failed/never-opened
sessions can be dismissed without confirmation since there is nothing
to lose.

When a panel closes — whether through Cancel, Confirm or the Escape
key — focus returns to the control that opened it. This holds even when the panel is opened from React state rather
than via `<DialogTrigger>` (the pattern used everywhere in SSIX), which
the stock Radix focus-restore can't always handle on its own. The
shared `<DialogContent>` primitive in `src/components/ui/dialog.tsx`
tracks the last interactive element the user touched outside any open
panel (via document-level `focusin` and `pointerdown` capture
listeners) and restores focus to it on close.

## Form Accessibility

The Connection and Credential forms surface submit/validation failures
in an `role="alert"` region with `aria-live="assertive"`, so screen
readers announce the error as soon as it appears. The submit button is
wired to that error via `aria-describedby`, giving keyboard users
context as they re-focus the action.

The Connection and Credential editors open in the side panel next to
their lists. Both use a sticky footer layout: the form body scrolls
inside the panel while the
**Cancel** / **Save** action row stays pinned to the bottom and never
disappears, regardless of viewport height or expanded panels (Advanced
options, inline credentials, etc.).

### Port validation

Port inputs (direct port, jump host / SSH server port, target / remote port, local port)
parse strictly via the `parsePort` helper in `src/lib/port.ts`:

- Empty input is treated as "missing" so callers can decide whether the
  field is required for the active connection type.
- Non-integer or non-numeric input shows the inline error
  *"Port must be a whole number"*.
- Values outside `1..65535` show *"Port must be between 1 and 65535"*.
- Invalid input never silently coerces to `22` (the previous
  `parseInt(...) || 22` behaviour); the form refuses to submit until
  every active port field validates, and each field individually gets
  `aria-invalid="true"` plus an `aria-describedby` link to its inline
  `role="alert"` error.

### Required field validation

Required text fields use the same per-field inline-error pattern as
ports. On submit the form collects every problem at once and surfaces
each one next to its input:

- ConnectionForm: **Connection Name**, **Host** (direct), **Jump Host**
  + **Jump Host Credential** + **Target Host** (jump host), **SSH Server
  Host** + **SSH Server Credential** + **Remote Host** (local forward),
  and the target authentication for Direct and Jump host (a local
  forward only authenticates to its SSH server):
  - **Saved Credential**: a credential must be picked; "None" shows
    *"Credential is required"* (*"Target credential is required"*
    on a jump host connection).
  - **Password** / **SSH Key**: the inline fields get the same checks
    as the credential form (`credentialFieldErrors` in
    `src/lib/credentialValidation.ts`): **Username**, **Password** or
    **Private Key Path**, and, when *Save as a named credential* is
    ticked, a **Credential Name** that no saved credential already uses.
  Everything is checked before the inline credential is created. If the
  backend still refuses the connection (a name already taken, say), the
  form deletes the credential it made for it, so retries never leave
  unused credentials behind.
- CredentialForm: **Credential Name**, **Username**, and either
  **Private Key Path** or **Private Key Contents** when the SSH Key
  tab is active.

The offending input gets `aria-invalid="true"` and an
`aria-describedby` link to a sibling `role="alert"` message; typing
into the input clears the error immediately so the validation feels
responsive instead of nagging.

The backend enforces the credential rule too: `add_connection`,
`update_connection` and `clone_connection` refuse a Direct or Jump host
connection without a credential, a jump host or local forward without a
credential for its jump host or SSH server,
and any credential id that no longer exists. A connection never points
at a deleted credential: deleting a credential that connections still
use is refused with their names, and references that older builds left
behind are cleared when the data loads, so the form asks for a new
credential inline.

A refused save keeps everything the user entered. The forms submit
through `submitWithoutReset` (`src/lib/formSubmit.ts`) instead of
`<form action>`, because React resets an action form after every
submission and Radix Select, Checkbox and RadioGroup answer that reset
by returning to their initial value: a picked credential would silently
go back to "None".

## Connection List Actions

The **Connect** action (green Play icon) is the primary CTA on every
connection row and tile and is **always visible** — it does not wait
for hover, so the action is reachable for keyboard and touch users and
discoverable on the very first visit. Secondary actions (Transfer
files, Clone, Edit, Delete) are likewise rendered in their resting
state at all times: the v2 redesign deliberately removed the
hover-reveal pattern so users know up-front exactly what is available
on each row without any discovery cost. Local forwards
render the Transfer-files (SCP) icon in a disabled state with an
explanatory `title` tooltip rather than hiding it, so the affordance
remains predictable across connection kinds.

### List Keyboard Navigation

The connection list and the credential list both implement a roving
tabindex pattern (via the shared `useRovingFocus` hook in
`src/hooks/useRovingFocus.ts`):

- Only one row is in the page tab order at a time. `Tab` enters the
  list onto the current row; `Tab` again moves out of the list to the
  next focusable element.
- `↑` / `↓` move the focused row, wrapping at the ends. `Home` / `End`
  jump to the first/last row. In tile layout `←` / `→` work as well.
- `↵`, `Space` or a click activates the row. On a connection this
  calls the selection handler when one is wired, otherwise it
  **connects** (the Connections tab wires no selection handler, so a
  click on a row opens a shell). On a credential it opens the **Edit**
  form.
- Action buttons inside a row (Edit / Clone / Delete / Connect / etc.)
  keep their own focus and their own keyboard semantics — pressing
  `↵` while focused on **Delete** activates Delete, not row selection.
- Each row exposes `role="listitem"` inside a `role="list"` container
  with an `aria-label` that includes the connection/credential name and
  any tags, so screen readers announce the row clearly.
- The focus ring uses the same `focus-visible:ring-2 ring-ring`
  treatment as the rest of the app, so keyboard users always see where
  they are.

### Right-click context menus

Right-clicking surfaces a contextual action menu rendered by the shared
`ContextMenu` primitive in `src/components/ContextMenu.tsx`. The
primitive is keyboard-navigable end-to-end:

- Opens at the cursor position (clamped inside the viewport so it never
  spawns off-screen) and moves keyboard focus to the first enabled item.
- **Keyboard alternative for opening the menu**: pressing `Shift+F10`
  or the dedicated `ContextMenu` key on a focused trigger opens the
  menu anchored to the bottom-left of the trigger element. This is the
  WCAG 2.1.1 keyboard-equivalent for the right-click gesture and is
  wired up on connection rows/tiles and terminal tabs.
- `↑` / `↓` move between items, `Home` / `End` jump to ends, disabled
  items are skipped automatically.
- `↵` / `Space` activate the focused item; `Esc`, click-outside, or the
  window losing focus close the menu.
- When the menu closes, focus returns to whichever element had focus
  when it opened (so keyboard users land back on the row/tab they came
  from instead of `<body>`).
- Items can be marked `destructive: true` to render in the destructive
  color, or `disabled: true` to be skipped, and `{ separator: true }`
  inserts a visual divider with `role="separator"`.

Wired surfaces today:

- **Connection rows / tiles** — Connect, Edit, Clone, Transfer files
  (hidden for local forwards), separator, Copy SSH command, separator, Delete
  (destructive). "Copy SSH command" builds a portable `ssh` invocation
  from the connection + selected credential via `buildSshCommand` in
  `src/lib/ssh-command.ts` and writes it to the clipboard.
- **Terminal tabs** — Close tab, Close other tabs, Close tabs to the
  right (the latter two are disabled when they would be no-ops).
- **Window background** — Take screenshot (legacy behavior preserved
  from the original screenshot-only menu, now powered by the same
  primitive).

For new consumers, prefer the `useContextMenu()` hook:

```tsx
const ctx = useContextMenu();
return (
  <>
    <div
      onContextMenu={ctx.open}
      onKeyDown={ctx.onKeyDown}
      tabIndex={0}
    >
      right-click or Shift+F10 me
    </div>
    {ctx.state && (
      <ContextMenu position={ctx.state} onClose={ctx.close} items={...} />
    )}
  </>
);
```

## Unsaved-changes guard

`ConnectionForm`, `CredentialForm` and `ScriptForm` snapshot their initial state when
the app panel opens and watch for changes via the `useUnsavedChangesGuard`
hook (`src/hooks/useUnsavedChangesGuard.ts`). When the user attempts to
close the panel (Cancel button or `Esc`) or to open another editor from
the list beside it, and the form state differs from the baseline, a
destructive `<ConfirmDialog>` prompts:

> **Discard unsaved changes?** You have unsaved changes to this
> connection/credential. Discard them and close the form?
> [ Keep editing ]   [ Discard ]

Choosing **Keep editing** dismisses the prompt and returns focus to the
form; **Discard** confirms and closes the panel (or opens the editor
that was asked for). The open form registers this check in
`useDialogsStore` (`connFormGuard` / `credFormGuard`), which runs it
before `openEditConnection`, `openNewConnection`, `openCloneConnection`
and their credential counterparts swap the form; the Scripts view keeps
the same check for its editor.

The guard self-disables for the close that immediately follows a
successful save: submit handlers call `guard.markSaved()` before
`onOpenChange(false)` so users never see the discard prompt after
clicking Create/Update.

The dirty check uses a stable `JSON.stringify` of every tracked field
(including inline auth secrets in `ConnectionForm`), so typing a
password into the inline-credential tab and trying to close also
triggers the guard. Because the snapshot is captured one tick after
the form initializes, no spurious "dirty" state is detected when the
panel first opens against an existing connection.

## Global Keyboard Shortcuts

SSIX listens for a small set of platform shortcuts. `Mod` is `Cmd` on
macOS and `Ctrl` everywhere else.

| Shortcut       | Action                                                   |
| -------------- | -------------------------------------------------------- |
| `Mod+K`        | Open the Connect picker                                  |
| `Mod+N`        | Open the New Connection form. Works from any view; the form is mounted at the App root so the user is returned to the same view they were on after closing it. |
| `Mod+,`        | Open Settings                                            |
| `Mod+W`        | Close the active terminal tab (with confirm if live)     |
| `Mod+1`…`Mod+9`| Switch to terminal tab N                                 |

On macOS the shortcuts work everywhere, including while a terminal
has focus: `Cmd+K`, `Cmd+W` or `Cmd+1` are never consumed by the shell
or by a text field, so a Mac user can jump between tabs or open the
picker without clicking out of the terminal first. On Linux and
Windows, `Ctrl` combos are suppressed when focus is in an input,
textarea, `contenteditable` element, or anywhere inside an `xterm`
instance, because `Ctrl+K`, `Ctrl+W` and friends are readline bindings
inside the shell. To avoid swallowing those bindings, combos that mix
`Ctrl` and `Cmd` simultaneously are ignored on every platform.

The terminal tab strip itself also implements its own WAI-ARIA
keyboard model (Arrow keys, Home/End, Delete) — see the Terminals
section.

## Connect Picker (Command Palette)

`Cmd/Ctrl+K` (or the `+` button on the terminal tab bar) opens the
**Connect Picker**, a focused command-palette UI for jumping to any
saved connection without leaving the keyboard:

- A search input is autofocused; typing filters the list with
  AND-token matching across **name, host, and tags** (e.g. `prod db`
  matches connections tagged both `production` and `db`).
- `↑` / `↓` move the active row (wrap at the ends), `Home` / `End`
  jump to the first/last match, `↵` connects, `Esc` closes.
- The picker exposes a real ARIA listbox: the input owns the
  `aria-activedescendant`/`aria-controls` wiring and each row has
  `role="option"` with `aria-selected`, so screen readers announce the
  selected connection as the user navigates.
- The footer reminds users of the available keys
  (`↑↓ navigate · ↵ connect · Esc close`).

## Tag Groups

The Connections view supports a third layout — **Tag groups** —
that pivots the list around tags instead of hosts. Each tile
represents one distinct tag (with one trailing `Untagged` tile for
hosts that carry no tags) and offers two bulk actions:

- **Connect-all** opens an SSH session, in its own tab, for every
  actionable connection in the group. Sessions start in the same
  order as the connections list; SSH handshakes still run in
  parallel server-side.
- **SCP** opens the **bulk transfer panel** for the group:
  - **Upload** sends the same local file/directory to the same
    remote path on every host. Use absolute paths so per-host
    `remote_path` defaults don't shift the target.
  - **Download** fetches the same remote path from every host into
    a single local directory. Each downloaded file is suffixed
    with `-<connection-name>` (sanitized for filesystem use) so
    multiple hosts don't overwrite each other (e.g.
    `app.log` → `app-server-a.log`, `app-server-b.log`). Recursive
    downloads suffix the top-level directory name only
    (`mydir-server-a/`).
  - Transfers run sequentially, one host at a time, with a live
    per-host progress list. Errors on one host don't abort the
    rest of the batch.
  - Connections that have multiple tags appear under each of their
    tags so bulk actions on `prod` really do hit every prod host
    even when some are also in `db`.
  - Local forwards are listed but greyed out — they can't
    do SCP and the SCP commands reject them server-side.
- The search bar in tag-groups mode filters tag labels only
  (case-insensitive substring), since the whole point of this view
  is to find tag groups, not individual hosts.
- The view mode is persisted per user via
  `AppSettings.connection_layout` (`"tags"`).

## Reduced Motion

SSIX honors the OS-level **prefers-reduced-motion** preference. When
the user has enabled "Reduce motion" (System Settings → Accessibility
on macOS, Settings → Ease of Access → Display on Windows, GNOME/KDE
animation toggles on Linux), every CSS animation, transition, and
smooth-scroll behavior is reduced to ~0ms. This includes the Radix
Dialog open/close zoom, Select dropdown slide, terminal-tab hover
fades, and split-pane resize transitions.

The duration is set to `0.01ms` rather than `0` so that JavaScript
that listens for `transitionend` / `animationend` events (Radix
focus-scope teardown, our own dialog wiring) still fires reliably.
The rule lives in `src/styles/globals.css` and is asserted by
`src/test/reducedMotion.test.ts` — any change to the rule must keep
those assertions green.
