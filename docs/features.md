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
- screenshot capture from the custom context menu

## SSH Key Utilities

- generate keypairs
- choose storage mode for generated keys
- install public key on remote hosts

## Settings

- theme
- font family
- font size
- color scheme
- list/tile layouts per section
- default terminal open mode
- Git Sync repository settings

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

## Connection List Actions

The **Connect** action (green Play icon) is the primary CTA on every
connection row and tile and is **always visible** — it does not wait
for hover, so the action is reachable for keyboard and touch users and
discoverable on the very first visit. Secondary actions (Transfer
files, Clone, Edit, Delete) remain in a hover-revealed group to keep
the list visually quiet, and that group also expands when any of its
buttons receives keyboard focus (`focus-within`).

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
