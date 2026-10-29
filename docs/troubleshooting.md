# Troubleshooting

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
