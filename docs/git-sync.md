# Git Sync

Git Sync exports a sanitized snapshot of SSX configuration into a local git repository chosen in Settings.

## What Gets Exported

Files are written under:

- `.ssx-sync/data.json`
- `.ssx-sync/README.md`

## What Does Not Get Exported

- password values
- inline private key contents
- raw secret storage from `~/.ssx/secrets.json`

Passphrases are represented as redacted markers when present, not as the original values.

## Manual Actions

The Git Sync view supports:

- Export sanitized snapshot
- Refresh diff
- Fetch
- Pull
- Commit
- Push

## One-Click Sync

The primary `Sync` action performs these steps:

1. Export sanitized snapshot
2. Fetch remote updates
3. Fast-forward pull if the branch is behind
4. Stage `.ssx-sync/`
5. Commit if there are local exported changes
6. Push if the branch is ahead

The sync flow stops on the first failing git step and surfaces the git output.

## Notes

- The sync repository must already exist and be a valid git checkout.
- The configured remote defaults to `origin`.
- Branch override is optional; otherwise the current branch is used.
- Empty commits are not created.
