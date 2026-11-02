# Files (SFTP)

The **Files** view (sidebar) shows this computer on the left and a connection's
files on the right, with what is being copied between them underneath. Open it
from the sidebar and pick a connection, or use **Browse files** on a connection
row. Local forwards have no shell or files of their own, so they are not
offered.

## What you can do

Each pane lists one folder. Type a path and press Enter, go to the parent folder,
or open a folder by double-clicking it or pressing Enter on it.

| Action | How | Notes |
|---|---|---|
| Select | Click, Ctrl/Cmd-click, Shift-click, or Space on the focused row | |
| Upload, download | The pane's button, the row's menu (right-click or Shift+F10), or drag rows onto the other pane | Drop on a folder row to copy into it. Escape cancels a drag |
| Upload from the desktop | Drop files on the server's pane | |
| New folder, rename | Pane toolbar or row menu | |
| Permissions | Pane toolbar or row menu | Three or four octal digits, with a preview. Not available on symlinks, or on systems with no permission bits |
| Delete | Pane toolbar or row menu | Always asks first |
| Edit | The server pane's **Edit** button or the row menu | See [Edit in place](#edit-in-place) |

Folder operations work on both panes. A listing shows at most 10,000 entries and
says so when there are more. A name that cannot be represented safely (not valid
UTF-8, for example) is left out of the listing, and the pane counts how many.

The view keeps its session and transfers when you switch to another view.

## Connections and security

Every session goes through the same connect path as a terminal, on direct and
jump host connections alike, so host keys are checked the same way. A changed
key refuses the connection and the view offers **Trust new host key**.

The browsing session uses the connection's keepalive interval, or the app's
default. If it is lost, the view connects again to the same folder; should the new
session be lost too, it stops and shows the error with a **Retry** button.

Transfers and edits use sessions of their own, so copying does not hold up browsing.
At most three transfers run at once. The others wait in a queue, which takes no
thread or connection however many files you select, and can be cancelled while
waiting. Transfers queued for one connection share its logins; a transfer that fails
or is cancelled gives up its session, and the next one logs in again.

## Transfers

Files stream in chunks with progress shown as they go, and any transfer can be
cancelled.

- **Nothing partial under the real name.** A file is written to a hidden
  `.ssix-part-<id>` beside its target and renamed when complete. A failed or
  cancelled copy removes that temporary file and leaves an existing target as it
  was. This applies to uploads as well as downloads.
- **Replacing asks first.** When the target exists, the transfer stops before
  writing anything and asks. For a folder, files with the same name are replaced
  and the others stay.
- **Replacing a file on the server takes two renames.** OpenSSH refuses to rename
  onto an existing file, and `ssh2` does not expose its `posix-rename` extension,
  so the old file moves aside, the new one takes its name, and the old one is
  removed. A rename that fails puts the old file back, but there is a brief
  moment when the name does not exist. If putting it back fails too, the error
  names where the old file and the new copy are, and neither is removed.
- **A target that is a symlink is written through**, so the link stays and the
  file it points to changes.
- **Folders keep their permissions**, as files do and as `scp -r` does, so a `0700`
  folder stays private on the other side. A read-only source folder stays writable
  until its contents are in, and if the transfer stops first it keeps its owner's
  write access. The target's umask still applies. A folder that already exists keeps
  its own mode, as a replaced file does.

### Symlinks

| Situation | Behaviour |
|---|---|
| You picked a symlink to copy | Followed, as `scp` does |
| A symlink inside a folder being copied | Skipped and counted in the result. Following it could leave the tree or go round in a loop |
| A symlink inside a folder being deleted | The link is removed; what it points to is untouched |

Deleting the root, your home or login folder, or any folder that holds it, is
refused on both panes, however the path reaches it through symlinks. Names a server
sends are checked before they become local paths, so a hostile listing cannot reach outside
the target folder.

## Edit in place

**Edit** downloads a copy, opens it in your text editor and shows a panel with the
copy's path. Saving in the editor only changes the copy: nothing reaches the server
until you press **Upload changes**.

- If the server's file changed since the copy was made, or was deleted, the upload
  stops and asks. **Keep editing** leaves everything as it is; **Overwrite** replaces
  the server's version. Size and time are compared first, then the content.
- The copy lives in `<data dir>/edit-cache/<id>/`, readable only by you (`0700` on
  the folder, `0600` on the file). Closing the panel removes it, and first looks at
  the copy again and asks if it holds changes that were not uploaded, or if it cannot
  tell. Quitting the app removes open copies.
- The editor is the default text editor on macOS (`open -t`), Notepad on Windows, and
  on other systems whatever `xdg-open` picks for the file's type. The copy is not
  executable, so opening a script does not run it. If nothing can be started, the
  panel says so and you can open the path yourself.
- Files up to 32 MiB can be edited this way, counted as the bytes arrive as well as
  from the size the server reports. Opening and uploading show no progress and cannot
  be cancelled.

## Files view and SCP

The **Transfer files** row action (SCP) stays as it is. See
[File Transfer](file-transfer.md).

| | Files view | SCP dialog |
|---|---|---|
| Purpose | Browse and manage files | Copy one path you already know |
| See the server's files | Yes | No, you type the path |
| Protocol | SFTP only | SFTP when the server offers it, otherwise legacy `scp` |
| Large files | Streamed | Held in memory whole |
| Progress, cancel | Yes | No |
| Existing target | Asks first | Replaced |
| Rename, delete, permissions, edit | Yes | No |

Use the SCP dialog on a server with the SFTP subsystem turned off, which the Files
view cannot browse.

## Known gaps

- **Hosts that ask for a one-time code** cannot prompt from this view: the prompt
  belongs to terminals, and transfers open sessions of their own.
- **Windows** clients and servers are untested. The live tests run only against POSIX
  servers, and the Windows-only code paths are not compiled on other systems.
- **A connection cut during an upload** can leave a hidden `.ssix-part-*` file on the
  server, since nothing is left to remove it.
- **Uploads need write permission on the target folder** for the temporary file, so
  they fail where only the file itself is writable.
- **After a crash**, a leftover edit copy is removed at a later launch, once it is
  more than 24 hours old. Waiting that long keeps the copies of another running
  instance safe.
- **Modification times are not preserved** by transfers.
- **Automated coverage** does not reach dropping files from the desktop or starting
  a real editor. Unit tests cover the first; the end-to-end spec edits the temporary
  copy directly in place of an editor.
