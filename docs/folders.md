# Folders

A connection can sit in a folder. The folder is a path stored on the connection
(`folder: "prod/eu"`), so there is no list of folders to keep in step: a folder
exists while something is in it. The **Folders** layout of the Connections view
shows them as a tree. Credentials and port forwards have no such layout, and
`save_settings` refuses it for them.

## Paths

The frontend (`parseFolderPath` in `src/lib/folders.ts`) and the backend
(`src-tauri/src/folder_path.rs`) apply the same rules, and both test files read
the same cases from `src/test/fixtures/folder-paths.json`.

| Typed | Result |
|---|---|
| ` /prod / eu// ` | `prod/eu`: spaces around a segment and empty segments go |
| `prod\eu` | `prod/eu`: a backslash is a separator too |
| Blank, or only slashes and spaces | No folder |
| `.` or `..` as a segment | Refused: "A folder cannot be named . or .." |
| A control character anywhere | Refused |
| More than 512 characters, or more than 10 levels | Refused, measured on the stored form |

Case matters: `Prod` and `prod` are two folders, as in a case-sensitive file
system. Unicode is compared as stored, so two spellings of an accented letter are
two folders, and invisible format characters are kept.

### Paths already in the file

A hand edit, a Git Sync pull or a restored backup can bring a path outside the
rules. It never stops the app from loading: `AppData::clean_stored_folders` cuts
away what the rules refuse (`prod/../eu` becomes `prod/eu`, `../..` becomes no
folder) and logs it. Like every repair on load, it reaches disk once, through
`storage::persist_migrations` at startup or with the next save. A layout the app
does not know goes back to `list` the same way.

## The tree

Folders sort by name with numbers by value (`web2` before `web10`), above the
**No folder** section. Each one counts the connections in it and its subfolders.
Rows are the same `ConnectionRow` as in the list, with every action, test id and
`data-name`, and each folder also has rename and delete buttons.

Which folders are closed is remembered per viewer in `localStorage`
(`ssix.folders.collapsed`), not in `data.json`, so it does not travel with Git
Sync. Empty or corrupt storage just means every folder is open.

Port forwards are not in the tree: they are not counted and the form does not
offer them the field, because the Port Forwards view is where they live. A
forward can still have a folder, from being changed from a shell kind or from a
synced file, and it keeps it. Renaming or deleting a folder applies to its
forwards too, the delete dialog counts them, and the picker offers their paths.

### Keyboard

The tree is one tab stop, following the ARIA tree pattern.

| Key | On a folder | On a connection |
|---|---|---|
| `↑` / `↓`, `Home` / `End` | Previous or next visible row, first or last | Same |
| `→` | Open it, or go to its first child if already open | Nothing |
| `←` | Close it, or go to its parent if already closed | Go to its folder |
| `Enter` / `Space` | Open or close it | Connect |
| A letter | Jump to the next row starting with what was typed | Same |
| `Space` right after a letter | Part of the word being typed, not an activation | Same |
| `Shift+F10` / `Menu` | Expand or collapse, rename, delete | The row's menu, with **Move to folder…** |

### Search

A search shows only what matches, and the folder path is searched too, also in
the list layouts and the Connect picker. Every folder with a match opens, however
it was left, and folders without one disappear, as does an empty No folder
section. Counts become the number of matches. Folding a folder during a search
lasts for that search text only: clearing it brings back the remembered state
untouched. The delete dialog still counts the whole folder.

## Moving a connection

- **Form:** the Folder field offers existing folders and takes a new path. Enter
  chooses an option only after the arrow keys have moved to one, so a typed new
  path that resembles an existing folder is not replaced by it. A bad path shows
  inline as it is typed, and refuses the save.
- **Drag:** drop a row on a folder, on a row in that folder, or on No folder.
  Escape cancels the drag and nothing else, so a side panel stays open, and the
  release that follows does nothing. A press that has not moved yet leaves
  Escape alone. The destination opens so the row stays in sight.
- **Keyboard:** the row's menu has **Move to folder…**. This is only in the tree,
  as the list has no folders to see the result in.

If a connection moves while its form is open, the field follows it, so saving
does not put it back. A folder the user typed in the meantime wins.

Dragging uses pointer events through `usePointerDrag`, shared with the Files
view, and not HTML5 drag and drop: dropping files from the desktop needs Tauri's
`dragDropEnabled`, which on Windows turns HTML5 drag and drop off inside the page.
The list does not scroll by itself during a drag, so scroll first in a long tree.

## Rename and delete

Both are one backend call and one save, and answer with every connection, so a
failure leaves everything as it was.

**Rename** takes a whole path, so it can also move a folder under another. Onto an
existing folder it merges the two, and the dialog says so first. Into itself is
refused. If a path that results would be too long or too deep, the whole rename
is refused and names it.

**Delete** removes the folder and its subfolders and never a connection.
Everything in them moves to the parent folder, or out of any folder at the top
level, and `<ConfirmDialog>` says how many first. Subfolders are flattened rather
than kept, because a folder the user asked to delete should not stay behind under
another name.

## What else sees the folder

- **Git Sync** exports `folder` with the rest of the connection, and the status
  refreshes when a folder changes.
- **Backups** hold the whole file, so a restore brings folders back, repaired on
  load if needed.
- **Import from SSH config** creates connections in no folder, and a host that
  already exists keeps the folder it has.

## Known limits

- A `folder` that is not a string in `data.json` fails to parse like any other
  wrongly typed field: the load-error banner shows, rather than a repair.
- Stale entries for folders that no longer exist stay in `localStorage` unless
  the folder was renamed or deleted here. They are harmless, and a folder that
  comes back under that name starts closed.
