# File Transfer

SSIX supports SCP-based file transfer for:

- direct connections
- jump host connections

Port forwards are not valid SCP targets.

The [Files view](sftp.md) is the alternative for browsing a server, with progress; that page compares the two.

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

## Stopping a Transfer

While a transfer runs, both dialogs show **Stop**. It reaches every way a copy can go:
SFTP and legacy `scp`, either direction, files and folders, and a transfer still
connecting. Close, Escape and the X stay inert until the transfer has ended, so Stop
is the way out and the outcome is always shown.

- **It waits for the call in progress**, so the button says *Stopping...* and is
  disabled until then. When measured, a stop took under a second on a working link,
  including a 1 MiB/s one. On a stalled link it took 29 to 33 seconds, since a chunk has a
  30-second limit.
- **A stopped copy leaves the target as it was** and removes its `.ssix-part-*` file on
  either side. A stop is not a link failure, so that tidying keeps the usual limit. On
  a link that has also stalled the file cannot be removed from the server, and the status
  says one may remain.
- **In a folder, finished files stay.** The status says how many. Folders the copy
  created stay too, and a source folder's missing owner permissions are not applied,
  since that happens only once everything is in.
- **The result is a neutral "Transfer stopped"** status with the bytes copied, not an
  error, and screen readers hear it from the same live region as a finished transfer.
- **A stop that comes after the last chunk is too late.** The file is put in place and
  the dialog says *Transferred*, which is what happened.
- **A connection copies one thing at a time here.** A second transfer on a connection
  already copying is refused. The Files view has its own sessions and is not affected.

In the bulk panel, Stop ends the current host's transfer, whose row says *Transfer
stopped*, and marks the hosts after it `skipped`. Hosts already done keep their
result, and the summary counts each: `Transfer stopped — 1 succeeded, 1 stopped, 1 skipped.`

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
- The dialog stays open until a running transfer ends, whatever closes it otherwise (Close, Escape), so its result or error is always shown. See [Stopping a Transfer](#stopping-a-transfer).
- While a transfer runs, opening SCP for another connection or a group does nothing, so the running transfer keeps its dialog and shows its result.
- No advanced sync semantics such as delta transfer
- Modification times are not preserved
