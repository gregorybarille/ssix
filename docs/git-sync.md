# Git Sync

Git Sync exports a sanitized snapshot of SSIX configuration into a local git repository chosen in Settings.

## What Gets Exported

Files are written under:

- `.ssix-sync/data.json`: connections, credentials (without secrets),
  settings, saved scripts and snippets
- `.ssix-sync/README.md`

## What Does Not Get Exported

- password values
- inline private key contents
- raw secret storage from `~/.ssix/secrets.json`

Passphrases are represented as redacted markers when present, not as the original values.

Scripts and snippets are exported exactly as written, so keep secrets out of them.

For a full local copy that includes the secrets, use [Local Backups](features.md#local-backups) instead.

## Manual Actions

The Git Sync view supports:

- Export sanitized snapshot
- Refresh diff
- Commit (with editable commit message)
- One-click bidirectional **Sync** (see below)

The previously separate Fetch / Pull / Push toolbar buttons were collapsed
into the single `Sync` action — the underlying store still exposes the
individual primitives for tests and future automation, but the UI no
longer surfaces them as standalone destructive operations.

## One-Click Sync

The primary `Sync` action performs these steps:

1. Fetch remote updates
2. If the branch is behind: discard uncommitted changes under `.ssix-sync/`, then fast-forward pull
3. Export sanitized snapshot
4. Stage `.ssix-sync/`
5. Commit if there are local exported changes
6. Push if the branch is ahead

The sync flow stops on the first failing git step and surfaces the git output.

Exporting comes after the pull because a pull is refused when it would overwrite a changed snapshot, and exporting first would hit that on every retry. Only `.ssix-sync/` is discarded, so keep nothing of your own there. It holds derived data: when a pull then fails, nothing is lost, since the next Sync exports again.

Sync and Commit commit `.ssix-sync/` and nothing else. Anything else you have staged stays staged and is not pushed by Sync's commit.

Sync only fast-forwards. If the branch and the remote have diverged, for example after a Commit that was not pushed while another machine pushed, it stops and changes nothing. Rebase or merge in the repository, then Sync again. A conflict in `.ssix-sync/` can be resolved either way, because Sync exports over it.

## Notes

- The sync repository must already exist and be a valid git checkout.
- The configured remote defaults to `origin`. It is either the name of a remote of that repository or a URL or path; anything else fails when Sync tries to reach it.
- Branch override is optional; otherwise the current branch is used. The status and Sync use the same branch.
- Empty commits are not created.

## First Sync And New Branches

The remote may be empty, and the branch may not exist on it yet. The status then counts every local commit as ahead (none when the repository has no commit yet), and Sync creates the branch with its push.

## URL Remotes

A URL has no `refs/remotes/` tracking ref, so Sync keeps its own, `refs/ssix-sync/<branch>`, updated by each fetch and push. The status reads it without going to the network, so it reflects the last Sync: before the first one, the remote branch counts as not existing yet. Sync does not bring the remote's tags into the repository.
