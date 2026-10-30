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
- Check whether a jump-shell connection has both gateway and destination credentials.
- Use a higher verbosity level in the connection settings to surface more SSH output.

## Host Key Has Changed

- SSIX refuses to connect when a server's host key differs from the one recorded on first use. The failure view shows the new SHA256 fingerprint.
- Confirm out of band (hosting console, admin) that the server really was reinstalled or re-keyed, then click **Trust new host key**. If nobody changed the server, do not trust the key: the connection may be intercepted.
- Recorded keys live in `~/.ssix/known_hosts` (OpenSSH format). `ssh-keygen -R <host> -f ~/.ssix/known_hosts` removes an entry by hand; for a non-default port use `-R '[host]:port'`.

## Port Forward Does Not Work

- Confirm the local port is free.
- Confirm the destination service is reachable from the gateway.
- Check the Tunnels view for status updates or errors.

## SCP Transfer Fails

- Make sure the connection type is `direct` or `jump_shell`.
- Use recursive mode when the source or target is a directory.
- Check whether the remote path exists or whether the remote user has permission to write there.

## Git Sync Fails

- Confirm the configured repository path exists and contains `.git/`.
- Confirm the configured remote name exists in that repository.
- If one-click sync fails during pull, resolve the branch state manually and retry.
- If push fails, inspect the returned git output in the Git Sync view.

## Credentials Seem Missing

- Remember that secrets are stored separately from `data.json`.
- If testing manually, inspect `~/.ssix/secrets.json` rather than expecting password material in `~/.ssix/data.json`.
