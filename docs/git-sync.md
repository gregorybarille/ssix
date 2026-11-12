# Git Sync

Git Sync exports a sanitized snapshot of SSIX configuration into a local git repository chosen in Settings.

## What Gets Exported

Files are written under:

- `.ssix-sync/data.json`: connections, credentials (without secrets),
  settings, saved scripts and snippets
- `.ssix-sync/README.md`, whose first line says it is generated and that edits in this folder are overwritten
- `.ssix-sync/.gitattributes`, which turns off line ending conversion for the folder. With it on, as Git for Windows has by default, git reports the snapshot as changed after a pull and then has nothing to commit.

## What Does Not Get Exported

- password values
- a password or token inside a URL remote
- inline private key contents
- raw secret storage from `~/.ssix/secrets.json`

Passphrases are represented as redacted markers when present, not as the original values.

A password or token inside a URL remote is also left out of what the Git Sync view
shows: the remote in the status, the steps of a sync, and git's error messages.

Scripts and snippets are exported exactly as written, so keep secrets out of them.

For a full local copy that includes the secrets, use [Local Backups](features.md#local-backups) instead.

## Manual Actions

The Git Sync view supports:

- Export sanitized snapshot
- Refresh diff
- Commit (with editable commit message)
- One-click bidirectional **Sync** (see below)

Fetch, pull and push exist only as steps of `Sync`: there is no separate
button or backend command for them.

## One-Click Sync

The primary `Sync` action performs these steps:

1. Fetch remote updates
2. If the branch is behind: put `.ssix-sync/` back to its last commit, then fast-forward pull
3. Export sanitized snapshot
4. Stage `.ssix-sync/`
5. Commit if there are local exported changes
6. Push if the branch is ahead

The sync flow stops on the first failing git step and surfaces the git output.

Exporting comes after the pull because a pull is refused when it would overwrite a changed snapshot, and exporting first would hit that on every retry.

Sync and Commit commit `.ssix-sync/` and nothing else. Anything else you have staged stays staged and is not pushed by Sync's commit.

Sync only fast-forwards. If the branch and the remote have diverged, for example after a Commit that was not pushed while another machine pushed, it stops and changes nothing. Rebase or merge in the repository, then Sync again. A conflict in `.ssix-sync/` can be resolved either way, because Sync exports over it.

## Hand Edits In The Folder

SSIX never reads `.ssix-sync/` back, so every export writes over the generated files (`data.json`, `README.md`, `.gitattributes`). **Export sanitized snapshot**, **Commit** and **Sync** stop first when that would really lose something: nothing changes, nothing is committed, pulled or pushed, and a dialog lists the files. Confirm runs the same action again with your agreement to those files, and Cancel leaves everything as it was. If the rerun finds a file you were not asked about, it asks again.

| File | At risk? |
|---|---|
| Generated, only ever written by SSIX, even uncommitted or older than the current data | No: SSIX writes it again |
| Clean in `git status`, including a hand edit you committed | No: git still has it |
| Identical to what the export would write | No |
| Generated, with an uncommitted edit | Yes |
| Any other uncommitted file in the folder, on a Sync that pulls | Yes: pulling puts the folder back to its last commit and deletes untracked files there |
| Any other uncommitted file in the folder, otherwise | No: exports leave it alone, and Commit and Sync commit it |

To tell its own output from an edit, each export records a SHA-256 per generated file in the repository's git directory (`git rev-parse --git-path ssix-sync-last-export`), never in the snapshot. Without a record, as right after updating to this version, an uncommitted file that differs from the new export counts as at risk, so you may get one extra question. Changing a file by hand and back to what SSIX wrote is not an edit.

**Refresh diff** never overwrites an at-risk file and never asks. It exports the other files, shows the diff of what is on disk, and names the files it held back under the diff. They stay at risk until you commit them, restore them, or agree to lose them through one of the other actions.

An edit is only noticed in the working tree: a hand edit that is staged while the file on disk holds SSIX's output is not listed, and an agreement is per file, so a further edit made while the dialog is open is lost with the one you agreed to.

## Notes

- The sync repository must already exist and be a valid git checkout.
- The configured remote defaults to `origin`. It is either the name of a remote of that repository or a URL or path; anything else fails when Sync tries to reach it.
- Branch override is optional; otherwise the current branch is used. The status and Sync use the same branch.
- Empty commits are not created.

## First Sync And New Branches

The remote may be empty, and the branch may not exist on it yet. The status then counts every local commit as ahead (none when the repository has no commit yet), and Sync creates the branch with its push.

## URL Remotes

A URL has no `refs/remotes/` tracking ref, so Sync keeps its own, `refs/ssix-sync/<branch>`, updated by each fetch and push. The status reads it without going to the network, so it reflects the last Sync: before the first one, the remote branch counts as not existing yet. Sync does not bring the remote's tags into the repository.
