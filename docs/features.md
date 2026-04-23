# Features

## Connections

SSX supports three connection types:

- `direct`
- `port_forward`
- `jump_shell`

Each shell-capable connection can also define:

- `login_command`
- `remote_path`
- tags
- color accent
- verbosity level
- extra SSH arguments

## Credentials

Supported credential modes:

- password
- SSH key path
- inline SSH private key

The connection form can create inline credentials and optionally save them as named credentials.

## Terminals

- tabbed shell sessions
- split right
- split down
- retry failed sessions
- edit source connection from failure UI

## Tunnels

- local port forwarding through a gateway
- active tunnel status view
- separate Tunnels view for running forwards and definitions

## Search, Tags, And Colors

- search is backend-driven
- query terms are AND-matched
- matches run across connection name, host, and tags
- color accents appear on connection cards and terminal tabs

## SCP File Transfer

- upload files
- download files
- upload directories recursively
- download directories recursively
- direct and jump-shell connections supported
- port-forward definitions are not SCP targets

See [File Transfer](file-transfer.md) for behavior and limitations.

## Git Sync

- sanitized config export into `.ssx-sync/`
- exact diff view
- fetch, pull, commit, push
- one-click sync
- sidebar pending indicator for local or remote changes

See [Git Sync](git-sync.md) for details.

## Diagnostics

- backend logs
- frontend logs
- screenshot capture from the custom context menu

## SSH Key Utilities

- generate keypairs
- choose storage mode for generated keys
- install public key on remote hosts

## Settings

- theme
- font family
- font size
- color scheme
- list/tile layouts per section
- default terminal open mode
- Git Sync repository settings

## Destructive-Action Confirmations

SSX shows a confirmation dialog before any destructive action:

- deleting a connection
- deleting a credential
- closing a live terminal pane
- closing a tab whose panes still hold a live SSH session

Confirmation dialogs default focus to the **Cancel** button so an
accidental Enter press never destroys data. Failed/never-opened
sessions can be dismissed without confirmation since there is nothing
to lose.
