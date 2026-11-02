# Snippets

A snippet is a saved command to paste into a terminal: a name, the command
and optional tags. The **Snippets** view lists them, and the side panel edits
them. Pasting never runs anything: the command lands at the prompt and waits
for you to press Enter.

## Pasting

`Mod+Shift+S` (`Cmd` on macOS, `Ctrl` elsewhere) opens the palette in the side
panel, from any view and from inside a terminal. So does the **Paste** button
in the Snippets view. Type to filter by name, command or tag (terms are
AND-matched), move with `↑`/`↓`/`Home`/`End`, press `↵` or click to paste, and
`Esc` to close. The palette names the connection it will paste into. In a
split that is the pane that last had focus, and clicking another pane changes it.

After a paste the keyboard goes to that terminal, so your next Enter runs the
command. An Enter still held down from choosing the snippet does not count: the
terminal ignores its repeats until you let go.

| Situation | What happens |
|---|---|
| No terminal is open, or every pane of the active tab failed | The palette says there is no live terminal. Nothing is sent and it stays open. |
| Terminals are open but you are on another view | The palette goes to the Terminals view first, so you see where the text lands. An editor with unsaved changes asks before leaving, as it does for any change of view, and the palette opens only if you leave. |
| The active pane shows a login prompt | The palette targets another pane of the tab if it has a live one, and otherwise asks you to answer the prompt first. A prompt takes questions, not text. |
| The active pane lost its connection, is still connecting, or its shell ended | The palette targets another pane of the tab if it has a live one, even if the other had the keyboard, and otherwise says why. The backend would discard the text, so nothing is sent and the palette stays open. |

## Line breaks and control characters

Sending a line break to a shell is the same as pressing Enter, so:

- **A newline is never added**, and blank lines around the command are dropped
  when pasting, so a saved `uptime\n` does not run itself. Spaces at the end of
  the command stay, so `kubectl logs ` waits for you to finish it.
- **Several lines go as a bracketed paste** when the program in the terminal has
  asked for one (`ESC [ ? 2004 h`): bash 5.1 or later, zsh and fish do at every
  prompt. The lines arrive between `ESC [ 200 ~` and `ESC [ 201 ~` and the shell
  keeps them as text until you press Enter.
- **Otherwise several lines are refused**, with an explanation, and nothing is
  sent. `sh`, `dash`, BusyBox `ash` and older bash do not ask for bracketed
  paste, and without it each line would run on arrival. SSIX does not join the
  lines, since that would change the command. Put it on one line (`a && b`).
- **A tab goes only in a bracketed paste, too.** Otherwise it is refused, with an
  explanation, and nothing is sent: the shell would take it as a request to
  complete, which can change the text or swallow what follows.
- **Control characters are removed** from what is pasted, other than tabs and
  line breaks. Otherwise a snippet containing `ESC [ 201 ~` could end the
  bracketed paste early and run the lines after it, and `Ctrl+C` or `Ctrl+D`
  would act on the shell.

SSIX only knows what the terminal has seen. A terminal keeps what it knows while
another tab or view is on screen, and while its tab is split or a split closes. A
program that asked for bracketed paste and then crashed leaves it on until
something turns it off.

## Variables

`{{name}}` in a command is a value to ask for before pasting. The palette shows
one field per variable and a preview of the result.

| Written | Result |
|---|---|
| `{{host}} {{host}}` | Asked once, replaced everywhere |
| `{{ host }}` | The same variable as `{{host}}` |
| `{{Host}}`, `{{host}}` | Two variables: names are case-sensitive |
| `{{hôte}}`, `{{log-file}}`, `{{_x1}}` | Variables: a name starts with a letter or `_`, then letters, digits, `_` or `-` |
| `{{name`, `name}}`, `{{name}` | Literal: an unclosed `{{` is plain text |
| `{{}}`, `{{ }}`, `{{a b}}`, `{{a.b}}`, `{{1a}}` | Literal: not a name |
| `{{.Names}}`, `{{json .}}` | Literal, so `docker --format` and Go templates paste as written |
| `{{a,b},c}` | Literal, so shell brace expansion pastes as written |
| `{{{name}}}` | The variable, inside literal braces: `{value}` |
| `\{{end}}` | Literal `{{end}}`, for a template word that looks like a name |
| `C:\Users\\{{user}}\Documents` | One backslash, then the variable: `C:\Users\ann\Documents` |
| `\\\{{end}}` | One backslash, then literal `{{end}}` |

Backslashes right in front of a variable pair up: `\\` pastes as one backslash,
and one left over keeps the braces literal. A single backslash therefore always
escapes, so write a Windows path as `C:\Users\\{{user}}`. The form lists the
variables it found, which shows whether a value will be asked for. Backslashes
anywhere else are plain text.

Every variable needs a value; a single space counts, for one you want to leave
out. Values go in exactly as typed, without shell quoting, and are not expanded
again, so a value containing `{{x}}` stays as it is.

## Git Sync

Git Sync exports snippets exactly as written, like scripts (see
[Git Sync](git-sync.md)). The form says so: keep passwords and tokens out of a
snippet, and use a variable for them instead, whose value is never saved.

## For developers

`src/lib/snippets.ts` holds the variable grammar and `preparePaste`, which
decides what is sent. The paste goes through `writeToSession`, so terminal
extensions' `onData` hooks do not see it. The backend (`commands/snippets.rs`)
stores the command as written: names are trimmed and unique, commands limited
to 64 KiB, IDs generated server-side.
