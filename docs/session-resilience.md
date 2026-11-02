# Session resilience

Keepalive, auto-reconnect and session logs for shell sessions (direct and
jump host connections).

**Port forwards are out of scope.** A forward keeps its own session, does not
reconnect and writes no log, whatever these options say. It checks that its
session is alive on its own schedule ([forwards.md](forwards.md)).

Settings → Sessions holds the defaults. A connection's form can override the
keepalive, auto-reconnect and logging; the number of attempts and the log
folder are global, and a connection set to reconnect uses that number even with
the global switch off.

| Setting | Default | Per connection |
|---|---|---|
| Keepalive interval | 30 s (0 turns it off, 3600 at most) | `keepalive_interval` |
| Auto-reconnect | on | `auto_reconnect` |
| Reconnect attempts | 5 (1 to 20) | no |
| Session log | off | `log_session` |
| Session log folder | `session-logs/` in the data folder | no |

A connection's keepalive field keeps what you type until you leave it, then shows
the number it was held to. Enter saves that number too. Emptied, the connection
follows the app setting.

## Keepalive

While a shell is open, SSIX sends an SSH keepalive every interval and asks the
server to answer, like `ssh -o ServerAliveInterval`. A connection that stays
silent for **three intervals** counts as lost, so at the default a dead
connection is noticed within about 90 seconds. An interval of 1 s counts as
2 s, the shortest libssh2 sends at.

An SSH server has to answer these, but a rare one does not. On such a server
an idle session counts as lost after three intervals, and the message says what
to do: set that connection's keepalive to 0.

With keepalive off, a network that silently drops packets is noticed only when
something is written and the operating system gives up on it, which can take
many minutes. A server that closes the connection is noticed either way.

A proxy command can hide a drop the same way. OpenBSD `nc`, the `nc` of Debian
and Ubuntu, stays alive after the server closes the connection, until something
is written to it. Through such a proxy, a cut connection is noticed at the next
keepalive or keystroke, not at once.

A jump host connection sends its keepalives to the target, through the tunnel,
so it also notices a dead jump host.

The interval in use is read when a session connects, and again at each
reconnect.

## Auto-reconnect

A session counts as dropped when its connection fails under a live shell: a
read or write error, a failed keepalive, or too long a silence. It reconnects
**in the same tab**: the session keeps its id and the terminal keeps its
scrollback, with the failure and `[SSIX] Reconnected.` marked in it.

Attempts wait 2, 4, 8, 16 and 32 s, doubling up to 60 s. A status bar at the
top of the pane shows the attempt and the countdown, with **Cancel**. The
Logs view has a line for each step.

**Cancel** does not wait for a running attempt. The attempt stops before it logs
in, while a login prompt waits and before it runs the login command, and if it
got further, its shell is closed.

The count survives a reconnect until the new shell has stayed up for a minute,
so a server that accepts the login and drops it straight away uses up the
attempts instead of being retried forever. **Retry** starts the count over.

It never retries:

- **a failed login or a changed host key.** Anything but a known network
  failure stops the retries at once (the allow-list is `RETRYABLE_ERRORS` in
  `src-tauri/src/reconnect.rs`), so a server is never hammered with a bad
  password, and a changed key is never quietly tried again;
- **a session that was closed**: closing the pane or tab, or a shell that ended
  by itself, such as `exit`, or a program killed on the server;
- **after Cancel, or when attempts run out.**

Once it stops, the bar shows why, with **Retry** (one more attempt), **Edit
Connection** and **Close terminal**, plus **Trust new host key** for a changed
key. The pane stays until you close it. With auto-reconnect off, a dropped
session goes straight to this state.

**Edit Connection** keeps the session and its scrollback: save, go back to
Terminals and press **Retry** to use the new values.

Each attempt reads the connection and its credentials again, so a password or
host edited meanwhile applies, and a deleted connection stops the retries. The
choice of whether to reconnect and how many times is read when the session
drops.

The new shell is a **new login**: nothing that ran in the old one comes back,
and the connection's remote path and login command run again. Use `tmux` or
`screen` on the server to keep programs across a drop.

**Keystrokes typed while disconnected are discarded**, because replaying them
into a new shell could run something you no longer want. The terminal is reset
out of any full-screen program on a drop, so the error and the scrollback stay
readable.

## Session logs

With logging on, what a session prints goes to a new file:

```text
<log folder>/<connection name>_<YYYYMMDD-HHMMSS-mmm in UTC>_<session id start>.log
```

- The default folder is `session-logs/` under the SSIX data folder (`~/.ssix`,
  or `SSIX_DATA_DIR`). A custom folder must be an absolute path.
- A file holds the raw terminal stream, as `script(1)` would, including escape
  sequences: `less -R` reads it well. Lines of SSIX's own, such as a lost
  connection or a reconnect, start with `[SSIX <time>]`.
- A session keeps one file across reconnects.
- **On Unix the folder is created as 0700 and each file as 0600.** The default
  folder is set back to 0700 if it was loosened; a folder you picked keeps its
  permissions, and its files are still 0600. On Windows, logs inherit the
  folder's access rules, and those of the default folder keep them to your user.
- A connection name can never leave the folder: anything but letters, digits,
  `-`, `_` and `.` becomes `_`.
- If a log cannot be created or written, the session carries on without it and
  says so in the terminal and the Logs view.

> **Warning: a log can capture secrets.** Your keystrokes are not logged, but
> everything the remote prints is, and that includes anything it echoes: a
> password typed where the terminal echoes it, a token printed by a command, a
> secret shown by `cat` or `env`. Turn logging on only where that is acceptable.

Logs are never rotated or deleted by SSIX, are not part of backups, and are not
exported by Git Sync. Clean up the folder yourself. Logging decisions are made
when a session opens: changing the settings does not affect open sessions.

## Known limits

- libssh2 keeps each keepalive answer in memory until the session ends, about
  100 bytes each: some 300 KB a day per session at the default interval.
  Reconnecting or reopening a session frees it.
- A server that ends a shell and hangs up in one go can lose its last output:
  libssh2 fails the read before those bytes can be read. The session still
  counts as ended by the server and does not reconnect.
- A connection whose login needs a one-time code cannot reconnect unattended:
  each attempt asks in the pane and waits for you. Cancelling, a wrong answer or
  five minutes without one stops the retries and leaves **Retry**
  ([details](auth.md#during-a-reconnect)).
- A network loss during a password or key login stops the retries and leaves
  **Retry**: it reads as a failed login, and those are never retried. During a
  keyboard-interactive or agent login SSIX can tell them apart, so a server that
  goes silent there is retried.
- Windows has no readiness notification yet, so a session there checks the
  socket every 5 ms, as it already does for its output.
