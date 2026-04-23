# Troubleshooting

## Connection Fails Immediately

- Verify host, port, username, and credential choice.
- Check whether a jump-shell connection has both gateway and destination credentials.
- Use a higher verbosity level in the connection settings to surface more SSH output.

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
- If testing manually, inspect `~/.ssx/secrets.json` rather than expecting password material in `~/.ssx/data.json`.
