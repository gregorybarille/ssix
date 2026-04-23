# File Transfer

SSX supports SCP-based file transfer for:

- direct connections
- jump-shell connections

Port-forward connection definitions are not valid SCP targets.

## Supported Operations

- upload a single file
- download a single file
- upload a directory recursively
- download a directory recursively

## Remote Path Behavior

- If a connection has `remote_path`, SSX uses it as the default base path when possible.
- Relative download paths resolve against the connection `remote_path` when set.
- Uploads can target an explicit remote path or fall back to the configured connection base path.

## Recursive Mode

- Required for directory transfers
- Keeps behavior simple
- Does not attempt advanced metadata preservation
- Is not intended as a full rsync replacement

## Current Limitations

- No progress bar yet
- No cancel action yet
- No advanced sync semantics such as delta transfer
- No explicit metadata preservation controls
