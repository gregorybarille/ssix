# Terminal UX

Find in scrollback, clickable links, broadcast input across a tab's panes, a
look per connection, and terminals that keep their state while another view is
on screen. `Mod` is `Cmd` on macOS and `Ctrl` everywhere else.

Everything here is a terminal extension under `src/components/terminal/`,
except what an extension cannot reach: see the end of this page.

## Off screen

A terminal stays mounted while another tab or view is on screen, so its
scrollback, its modes and any program in it are exactly as they were when you
come back.

- Output that arrives meanwhile lands in the scrollback.
- It keeps its size. A hidden pane has no size of its own, so a terminal off
  screen is not fitted and sends the server no resize. It refits when shown.
- It holds no keyboard. Keys typed in the view that replaced it stay there, and
  shortcuts do not reach it.
- When it comes back it takes the keyboard again, unless a side panel has it or a
  login prompt in the other pane just took it. In a split tab that is the pane
  that last had it.
- Dropped connections keep reconnecting, and the status is there on return. See
  [Session resilience](session-resilience.md).
- A shell that ends off screen does not interrupt you. The terminal asks about
  closing it when it is next shown. This also goes for a tab in the background.

A terminal that just opened takes the keyboard too, unless a side panel has it or
you are typing somewhere else by the time it connects. In a split, that puts it in
the new pane unless you have gone back to typing in the old one.

One thing does start over: splitting a tab, or closing a split back to one pane,
gives the pane that stays a new terminal with an empty scrollback. Its shell goes
on running.

## Find

`Cmd+F` on macOS, or `Ctrl+Shift+F` on Linux and Windows, opens the find bar on the
visible pane that last had the keyboard.

| Key | Action |
|---|---|
| `Enter` | Next match |
| `Shift+Enter` | Previous match |
| `Escape` | Close, and give the keyboard back to the terminal |

The same shortcut again brings the keyboard back to an open bar. It does nothing outside
the Terminals view or while a side panel is open, and the bar closes when its
pane is hidden. It says how many matches there are, up to 1000 (it can still move
beyond those), and **No matches** in words. It covers a corner of the pane rather
than taking a row, which would resize the session for the length of a search.

`Ctrl+F` stays with the terminal on every platform: it is readline's "forward one
character", and programs such as `less` and `vim` have their own use for it.

While the bar is open, moving between matches does not trigger
**auto-copy on selection**.

## Links

Terminal output is untrusted, whatever server it came from, so a link in it
is treated as such.

- **Only `http` and `https` open**, in the default browser. Anything else
  (`file:`, `javascript:`, `data:`, `mailto:`, a custom scheme) is refused and
  logged. A URL containing whitespace or a control character is refused too. The
  check runs twice: in `parseExternalUrl`, and in the shell plugin's `open` scope
  in `tauri.conf.json`.
- **It takes `Mod+click`**, so a stray click on output never opens a browser.
  A plain click still selects text as usual. On macOS it is `Cmd`, since
  `Ctrl+click` is a right-click there.
- **The target is shown before anything opens.** While the mouse is over a link,
  a hint in the corner of the pane shows where it really goes.

URLs in the text open directly, since what you read is where they go. Two kinds
of link ask first and name the real host:

- An **OSC 8 hyperlink**, always. A server chooses its visible text and its target
  separately, so the text can name another site entirely.
- A URL with a **user name or password**: `https://bank.example@evil.example/`
  goes to `evil.example`.

A hyperlink with another scheme is not offered as a link at all.

## Broadcast input

**Broadcast input** in the tab bar sends what you type in one pane of the active
tab to its other pane too. It belongs to the tab and is off by default. While on,
the tab has a red frame around its panes and an icon on its tab, and the button
says how many panes are receiving, as in **Broadcasting to 1 of 2 panes**.

A tab holds at most two panes, so broadcast takes a split tab.

**Which panes receive:** those showing a live shell. A pane that is connecting,
answering a login prompt, reconnecting, stopped, failed, or whose shell ended
receives nothing, and typing in one of those mirrors nothing. A pane that comes
back receives only what is typed from then on: nothing is queued for it.

**A new pane never joins.** Broadcast goes off when closing a pane leaves one, and
stays off when a split adds one back, so you turn it on knowing what it reaches. A
new tab starts off.

**What is mirrored:** keys and pastes.

**What is not:**

- Mouse reports, focus changes and answers to a program's queries (cursor
  position, device attributes, colours). These describe one pane, and would land
  on the other's prompt as garbage.
- `F3` with a modifier, whose sequence cannot be told apart from a cursor position
  report.
- Anything sent to a session without typing it: a snippet from the palette goes
  through `writeToSession`, which runs no input hooks, and stays in its own pane.
  Paste it, or type it, to send it to both.

A bracketed paste is mirrored as it is. Should the other pane's program not have
bracketed paste on, it sees the markers around the text.

## A connection's look

The connection form's **Terminal** section sets a font, a font size and a color
scheme for one connection. Each is taken from the connection first, then from
Settings. Without a scheme, a terminal follows the app theme: Tokyo Night when
dark, Tokyo Night Day when light.

Schemes: Tokyo Night, Tokyo Night Day, Dracula, Nord, Solarized Dark, Solarized
Light, Gruvbox Dark, One Dark. Their foreground is at least 4.5:1 against their
background. Solarized Light uses base01 rather than base00 for that.

**A save applies to open terminals at once**, with no reconnect. Colours change
right away. A font waits until the terminal is shown, because a hidden terminal
cannot measure one, and the terminal then refits and tells the server its new size.

**A stored scheme this build does not know**, say from a newer version or a synced
file, never gets in the way of a session: the connection still loads, and its
terminals use the app's colours. Only saving refuses it, and the form says why
beside the field. Pick another scheme to save. The list is in two places,
`TERMINAL_PALETTES` (`src/lib/terminalTheme.ts`) and `TERMINAL_COLOR_SCHEMES`
(`src-tauri/src/commands/connections.rs`); `src/test/terminalTheme.test.ts` fails
if they differ.

## What lives outside the extensions

Extensions see a terminal once it exists, and cannot change how it is mounted.
So `Terminal.tsx` itself holds what depends on visibility: fitting, focus, refusing
keys off screen, the deferred question about an ended shell, and applying the
look. It also calls the `onKey` hook, which is how `terminalSearch` keeps its shortcut
from xterm: xterm handles a key before the window's shortcut listener sees it.
