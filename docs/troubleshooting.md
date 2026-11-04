# Troubleshooting

## "SSIX is running outside its desktop app"

Older builds showed this as `TypeError: ... window.__TAURI_INTERNALS__ is undefined`.

- The frontend was opened in a regular browser, usually `npm run dev` at `http://localhost:1420`. Backend commands only exist inside the Tauri webview, so every view shows this message instead of data.
- Start the app with `npm run tauri dev`. The browser dev server is still fine for layout work that needs no backend.

## A View Shows "Could not load …"

- The backend could not read `data.json` (`~/.ssix/`, or `SSIX_DATA_DIR` when set). The banner names the file and the parse error.
- `data.json` is written atomically, so a corrupt file usually means a manual edit or a bad merge in a synced repository. Fix or restore the file, then click **Retry** in each view.
- Settings show their defaults while their load error is displayed. Fix the file and retry before changing settings.

## Connection Fails Immediately

- Verify host, port, username, and credential choice.
- Check whether a jump host connection has credentials for both the jump host and the target.
- A host that is an alias in `~/.ssh/config` takes only its `HostName` from the file. Set a custom `Port` on the connection, or import the host to take everything. A `HostName` with a token other than `%h` or `%%`, or inside a `Match` block, is not used (see [Aliases when connecting](ssh-config-import.md#aliases-when-connecting)).
- Set the connection's verbosity to -v (or -vv) and reconnect: the Logs view shows each step of the connection, like `ssh -v`, so the last line before the error tells you where it failed.

## Agent Login Fails

- "Could not list the SSH agent's keys" usually means SSIX cannot see the agent. An app started from the Dock or a desktop launcher may not have the `SSH_AUTH_SOCK` your terminal has. Start SSIX from that terminal, or set the variable for your desktop session.
- "The SSH agent holds no keys" means the agent is running but empty: add a key with `ssh-add`, and check with `ssh-add -l`.
- With a forwarded agent, an empty `$SSH_AUTH_SOCK` on the server means forwarding did not start. The Logs view says why; the server may have `AllowAgentForwarding no`. See [Authentication](auth.md) before enabling forwarding.

## Proxy Command Or WSL Connection Fails

- Look in the Logs view for `proxy` entries: they are what the command printed on stderr (for example `nc: command not found`).
- On macOS, an SSIX started from Finder does not get the `PATH` your shell sets up. SSIX adds `/opt/homebrew/bin` and `/usr/local/bin` after what it has. A tool anywhere else (`~/.local/bin`, for example) needs its full path in the command.
- For **Through WSL**, check `wsl.exe -e nc -h` works in a Windows terminal, and install `netcat-openbsd` in the distribution if it does not.
- Set the connection's verbosity to -v: the Logs view then shows the expanded command that was run.

## Restoring A Backup

- A restore that is refused leaves every file as it was; the message names the file that failed its check.
- To undo a restore, restore the "Before restore" backup it created.
- Backups live in `~/.ssix/backups` (or `$SSIX_DATA_DIR/backups`). Copy one elsewhere to keep it safe from a lost disk, and remember that it contains your secrets.

## "Saved By A Newer Version Of SSIX"

- `data.json` was written by a newer SSIX, after a downgrade or a restore of a newer backup. This version can read it but refuses every change, because saving would drop what it does not understand.
- Update SSIX, or restore a backup made by this version.

## Host Key Has Changed

- SSIX refuses to connect when a server's host key differs from the one recorded on first use. The failure view shows the new SHA256 fingerprint.
- That includes a key of another type, for example an Ed25519 key when an ECDSA key is on record. The message names both types. SSIX asks for the recorded type first, so this means the server did not offer that type at all: it dropped the key, or it is not the same server.
- Confirm out of band (hosting console, admin) that the server really was reinstalled or re-keyed, then click **Trust new host key**. Check the fingerprint shown first: only a key with that fingerprint is accepted, and it replaces every key recorded for that `host:port`. If the key changes again before the reconnect, nothing is recorded and SSIX shows the new fingerprint with "not the key you chose to trust". If nobody changed the server, do not trust the key: the connection may be intercepted.
- Recorded keys live in `~/.ssix/known_hosts` (OpenSSH format). `ssh-keygen -R <host> -f ~/.ssix/known_hosts` removes an entry by hand; for a non-default port use `-R '[host]:port'`.

## A Port Forward Does Not Work

- Confirm the local port is free.
- Confirm the remote service is reachable from the SSH server.
- Check the Port forwards view for status updates or errors; a row's details show its last client error.
- A remote forward listens on the SSH server's loopback, so other machines cannot reach it unless the server has `GatewayPorts yes`.
- See [Port Forwards](forwards.md#troubleshooting) for what SOCKS replies, "refused to listen" and "Could not accept a new client" mean.

## SCP Transfer Fails

- Make sure the connection is a Direct or Jump host connection.
- Use recursive mode when the source or target is a directory.
- Check whether the remote path exists or whether the remote user has permission to write there. An upload writes a temporary file first, so it needs write permission on the folder and not only on the file.
- An upload that was cut off can leave a hidden `.ssix-part-*` file on the server. It is safe to delete, and the file it was replacing is untouched.
- "Could not put the new copy in place" on a server without SFTP means the shell refused the final `mv`: the target is a folder or a symlink, or the account has no shell. See [File Transfer](file-transfer.md#servers-without-sftp).

## A Script Fails On Some Hosts

- Exit 127 usually means the interpreter (or a command the script calls) is not installed on that host, for example `bash` on a minimal Alpine image. Pick `sh -s` or install it.
- The script runs without a terminal and with the remote user's non-login environment, so `PATH` additions from `.bash_profile` and commands that prompt (`sudo` asking for a password) do not work; use full paths and `sudo -n`.
- "only available for direct and jump host connections" means the host is a port forward.
- On a Windows OpenSSH server, save the script with **Runs on: Windows** and write it in PowerShell; a Linux, macOS, BSD script is started through `sh` and fails there with a shell error. The other way round, a Windows script on a Linux host fails with "powershell: not found" (exit 127).
- Cancel on Windows ends the script and everything it started together (a job object). On a Windows too old to nest job objects (before Windows 8 / Server 2012), only PowerShell stops and the programs it started run on.
- A Windows script that shows errors but succeeds: errors that don't stop a PowerShell script keep its exit code at 0. End with `exit 1` on failure, or set `$ErrorActionPreference = 'Stop'` at the top.
- Connection errors appear on the card; raise the connection's verbosity to see the `ssh -v` lines in the Logs view.

## Git Sync Fails

- Confirm the configured repository path exists and contains `.git/`.
- Confirm the configured remote is a remote name of that repository, or a URL or path. A name it does not know, such as a missing `origin`, is tried as a path and fails with "does not appear to be a git repository". An empty remote is fine: the first Sync creates the branch.
- If one-click sync reports that the branch has diverged, rebase or merge onto the remote branch in the repository and retry. A conflict in `.ssix-sync/` can be resolved either way, because Sync exports over it.
- If the pull is refused because of local changes, those are your own files outside `.ssix-sync/`: commit or restore them and retry. Sync only touches `.ssix-sync/`, and asks first when that would lose an edit there.
- If a dialog lists a file you never edited, it is usually the first export after updating: SSIX has no record of what it last wrote yet, so an uncommitted file that differs counts as a hand edit. A conflict in `.ssix-sync/` is listed too. Confirm, or commit the file first. See [Hand Edits In The Folder](git-sync.md#hand-edits-in-the-folder).
- If Refresh diff says files were not exported because they hold hand edits, it left them alone on purpose. Commit or restore them, or use Export and confirm to overwrite them.
- If push fails, inspect the returned git output in the Git Sync view.

## Credentials Seem Missing

- Remember that secrets are stored separately from `data.json`.
- "could not be read" or "failed to read secrets file" means the file is there but SSIX cannot read it, for example because of its permissions, a failing disk, or a link to a volume that is not mounted. SSIX shows the error instead of an empty list and saves nothing over the file: fix the cause and try again.
- If testing manually, inspect `~/.ssix/secrets.json` rather than expecting password material in `~/.ssix/data.json`.
- A secret from an old `data.json` moves to `secrets.json` the next time SSIX starts. If `secrets.json` is corrupt, the move waits and the Logs view has a `migration` warning: fix or restore the file, then restart.
