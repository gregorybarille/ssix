# File Transfer

SSIX supports SCP-based file transfer for:

- direct connections
- jump host connections

Port forwards are not valid SCP targets.

The [Files view](sftp.md) is the alternative for browsing a server, with progress and cancel; that page compares the two.

## Supported Operations

- upload a single file
- download a single file
- upload a directory recursively
- download a directory recursively

## Remote Path Behavior

- If a connection has `remote_path`, SSIX uses it as the default base path when possible.
- Relative download paths resolve against the connection `remote_path` when set.
- Uploads can target an explicit remote path or fall back to the configured connection base path.
- `~` and `~/...` mean your login folder, in the path you type and in a connection's `remote_path`.

## How Files Are Copied

The dialog, and the bulk transfer that shares its commands, copy with the same
code as the [Files view](sftp.md#transfers):

- **Files stream in 128 KiB chunks**, so a file of any size takes the same small
  amount of memory.
- **A transfer can take as long as it needs.** A dead link still fails: one chunk that
  gets nowhere for 30 seconds ends the transfer, and each tidying step on the dead link
  then gets 2 seconds, so the error took 36 seconds on a download and 38 on an upload
  when measured. A link too slow to move 128 KiB in 30 seconds (about 35 kbit/s)
  counts as dead. Closing a file and the final rename get 60 seconds each, since a
  server can be slow to flush a big file, so a link that dies at that very moment
  takes up to about two minutes to report.
- **Nothing partial under the real name.** A copy goes to a hidden `.ssix-part-<id>`
  beside its target and is renamed when complete, so a failed one leaves the old file
  as it was. If the connection is cut during an upload, that temporary file can stay
  on the server.
- **Uploads need write permission on the target folder**, for the temporary file,
  even when the file itself is writable. Replacing a file also means renaming it, so a
  sticky folder such as `/tmp` refuses to replace another user's file.
- **Modes are kept.** A new file or folder takes the source's mode, limited by the
  umask on the receiving side, so a `0600` file stays private in both directions. A
  file that already exists keeps its own mode, so a `0600` `.env` stays `0600` when
  a `0644` copy replaces it. A folder that exists keeps its own too.

## Servers Without SFTP

SFTP is used whenever the server offers it. Otherwise a single file travels over
legacy `scp`, streamed and with modes kept in the same way. Folders need SFTP.

Legacy `scp` has no rename, so an upload arrives under a temporary name and the
server's shell runs `mv` to put it in place. That needs a POSIX shell, so an account
limited to `scp` alone cannot upload this way. A target that is a symlink is refused
rather than written through, and the replaced file's owner is not kept.

## Recursive Mode

- Required for directory transfers
- Skips symlinks and special files inside a folder, as the Files view does; following
  them could leave the tree or go round in a loop. A symlink you name yourself is
  followed. Skipped entries are only noted in the app's log.
- Is not intended as a full rsync replacement

## Current Limitations

- No progress bar yet
- No cancel action yet
- No advanced sync semantics such as delta transfer
- Modification times are not preserved
