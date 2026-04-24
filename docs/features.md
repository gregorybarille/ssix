# Features

## Connections

SSX supports three connection types:

- `direct`
- `port_forward`
- `jump_shell`

Each shell-capable connection can also define:

- `login_command`
- `remote_path`
- tags
- color accent
- verbosity level
- extra SSH arguments

## Credentials

Supported credential modes:

- password
- SSH key path
- inline SSH private key

The connection form can create inline credentials and optionally save them as named credentials.

## Terminals

- tabbed shell sessions
- split right
- split down
- retry failed sessions
- edit source connection from failure UI

### Terminal tab keyboard shortcuts

The terminal tab bar is a true WAI-ARIA tablist. With focus on a tab:

- **Arrow Left / Arrow Right** — move focus and selection between tabs
- **Home / End** — jump to first / last tab
- **Delete** or **Cmd/Ctrl+W** — close the focused tab
- The "x" affordance on tabs is mouse-only.

## Tunnels

- local port forwarding through a gateway
- active tunnel status view
- separate Tunnels view for running forwards and definitions

## Search, Tags, And Colors

- search is backend-driven
- query terms are AND-matched
- matches run across connection name, host, and tags
- color accents appear on connection cards and terminal tabs

## SCP File Transfer

- upload files
- download files
- upload directories recursively
- download directories recursively
- direct and jump-shell connections supported
- port-forward definitions are not SCP targets

See [File Transfer](file-transfer.md) for behavior and limitations.

## Git Sync

- sanitized config export into `.ssx-sync/`
- exact diff view
- fetch, pull, commit, push
- one-click sync
- sidebar pending indicator for local or remote changes

See [Git Sync](git-sync.md) for details.

## Diagnostics

- backend logs
- frontend logs
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

- theme (light / dark; both calibrated to meet WCAG AA — body text and
  tertiary metadata such as timestamps stay above the 4.5:1 contrast
  ratio on both themes)
- font family
- font size
- color scheme
- list/tile layouts per section
- default terminal open mode
- Git Sync repository settings

## Title Bar

SSX renders its own draggable title bar so it can host a Settings shortcut
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

## Destructive-Action Confirmations

SSX shows a confirmation dialog before any destructive action:

- deleting a connection
- deleting a credential
- closing a live terminal pane
- closing a tab whose panes still hold a live SSH session

Confirmation dialogs default focus to the **Cancel** button so an
accidental Enter press never destroys data. Failed/never-opened
sessions can be dismissed without confirmation since there is nothing
to lose.

## Form Accessibility

The Connection and Credential forms surface submit/validation failures
in an `role="alert"` region with `aria-live="assertive"`, so screen
readers announce the error as soon as it appears. The submit button is
wired to that error via `aria-describedby`, giving keyboard users
context as they re-focus the action.

Both dialogs use a sticky footer layout: the form body scrolls inside
`DialogContent` while the **Cancel** / **Save** action row stays pinned
to the bottom and never disappears, regardless of viewport height or
expanded panels (Advanced options, inline credentials, etc.).

### Port validation

Port inputs (direct port, gateway port, destination port, local port)
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

- ConnectionForm: **Connection Name**, **Host** (direct), **Gateway
  Host** + **Gateway Credential** + **Destination Host** (tunnels).
- CredentialForm: **Credential Name**, **Username**, and either
  **Private Key Path** or **Private Key Contents** when the SSH Key
  tab is active.

The offending input gets `aria-invalid="true"` and an
`aria-describedby` link to a sibling `role="alert"` message; typing
into the input clears the error immediately so the validation feels
responsive instead of nagging.

## Connection List Actions

The **Connect** action (green Play icon) is the primary CTA on every
connection row and tile and is **always visible** — it does not wait
for hover, so the action is reachable for keyboard and touch users and
discoverable on the very first visit. Secondary actions (Transfer
files, Clone, Edit, Delete) remain in a hover-revealed group to keep
the list visually quiet, and that group also expands when any of its
buttons receives keyboard focus (`focus-within`).

### List Keyboard Navigation

The connection list and the credential list both implement a roving
tabindex pattern (via the shared `useRovingFocus` hook in
`src/hooks/useRovingFocus.ts`):

- Only one row is in the page tab order at a time. `Tab` enters the
  list onto the current row; `Tab` again moves out of the list to the
  next focusable element.
- `↑` / `↓` move the focused row, wrapping at the ends. `Home` / `End`
  jump to the first/last row. In tile layout `←` / `→` work as well.
- `↵` or `Space` activates the row. On a connection this calls the
  same selection handler the click does (or falls back to **Connect**
  if no selection handler is wired). On a credential it opens the
  **Edit** form.
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
- `↑` / `↓` move between items, `Home` / `End` jump to ends, disabled
  items are skipped automatically.
- `↵` / `Space` activate the focused item; `Esc`, click-outside, or the
  window losing focus close the menu.
- Items can be marked `destructive: true` to render in the destructive
  color, or `disabled: true` to be skipped, and `{ separator: true }`
  inserts a visual divider with `role="separator"`.

Wired surfaces today:

- **Connection rows / tiles** — Connect, Edit, Clone, Transfer files
  (hidden for tunnels), separator, Copy SSH command, separator, Delete
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
    <div onContextMenu={ctx.open}>right-click me</div>
    {ctx.state && (
      <ContextMenu position={ctx.state} onClose={ctx.close} items={...} />
    )}
  </>
);
```

## Global Keyboard Shortcuts

SSX listens for a small set of platform shortcuts. `Mod` is `Cmd` on
macOS and `Ctrl` everywhere else.

| Shortcut       | Action                                                   |
| -------------- | -------------------------------------------------------- |
| `Mod+K`        | Open the Connect picker                                  |
| `Mod+N`        | New connection (switches to Connections, opens the form) |
| `Mod+,`        | Open Settings                                            |
| `Mod+W`        | Close the active terminal tab (with confirm if live)     |
| `Mod+1`…`Mod+9`| Switch to terminal tab N                                 |

Shortcuts are suppressed when focus is in an input, textarea,
`contenteditable` element, or anywhere inside an `xterm` instance, so
typing in the shell or filling forms is never intercepted. To avoid
swallowing well-known terminal readline bindings, combos that mix
`Ctrl` and `Cmd` simultaneously are ignored.

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
