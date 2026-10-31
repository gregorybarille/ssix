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
- Set the connection's verbosity to -v (or -vv) and reconnect: the Logs view shows each step of the connection, like `ssh -v`, so the last line before the error tells you where it failed.

## Proxy Command Or WSL Connection Fails

- Look in the Logs view for `proxy` entries: they are what the command printed on stderr (for example `nc: command not found`).
- For **Through WSL**, check `wsl.exe -e nc -h` works in a Windows terminal, and install `netcat-openbsd` in the distribution if it does not.
- Set the connection's verbosity to -v: the Logs view then shows the expanded command that was run.

## Restoring A Backup

- A restore that is refused leaves every file as it was; the message names the file that failed its check.
- To undo a restore, restore the "Before restore" backup it created.
- Backups live in `~/.ssix/backups` (or `$SSIX_DATA_DIR/backups`). Copy one elsewhere to keep it safe from a lost disk, and remember that it contains your secrets.

## Host Key Has Changed

- SSIX refuses to connect when a server's host key differs from the one recorded on first use. The failure view shows the new SHA256 fingerprint.
- Confirm out of band (hosting console, admin) that the server really was reinstalled or re-keyed, then click **Trust new host key**. If nobody changed the server, do not trust the key: the connection may be intercepted.
- Recorded keys live in `~/.ssix/known_hosts` (OpenSSH format). `ssh-keygen -R <host> -f ~/.ssix/known_hosts` removes an entry by hand; for a non-default port use `-R '[host]:port'`.

## Local Forward Does Not Work

- Confirm the local port is free.
- Confirm the remote service is reachable from the SSH server.
- Check the Port forwards view for status updates or errors.

## SCP Transfer Fails

- Make sure the connection is a Direct or Jump host connection.
- Use recursive mode when the source or target is a directory.
- Check whether the remote path exists or whether the remote user has permission to write there.

## A Script Fails On Some Hosts

- Exit 127 usually means the interpreter (or a command the script calls) is not installed on that host, for example `bash` on a minimal Alpine image. Pick `sh -s` or install it.
- The script runs without a terminal and with the remote user's non-login environment, so `PATH` additions from `.bash_profile` and commands that prompt (`sudo` asking for a password) do not work; use full paths and `sudo -n`.
- "only available for direct and jump host connections" means the host is a local forward.
- On a Windows OpenSSH server, save the script with **Runs on: Windows** and write it in PowerShell; a Linux, macOS, BSD script is started through `sh` and fails there with a shell error. The other way round, a Windows script on a Linux host fails with "powershell: not found" (exit 127).
- A Windows script that shows errors but succeeds: errors that don't stop a PowerShell script keep its exit code at 0. End with `exit 1` on failure, or set `$ErrorActionPreference = 'Stop'` at the top.
- Connection errors appear on the card; raise the connection's verbosity to see the `ssh -v` lines in the Logs view.

## Git Sync Fails

- Confirm the configured repository path exists and contains `.git/`.
- Confirm the configured remote name exists in that repository.
- If one-click sync fails during pull, resolve the branch state manually and retry.
- If push fails, inspect the returned git output in the Git Sync view.

## Credentials Seem Missing

- Remember that secrets are stored separately from `data.json`.
- If testing manually, inspect `~/.ssix/secrets.json` rather than expecting password material in `~/.ssix/data.json`.
