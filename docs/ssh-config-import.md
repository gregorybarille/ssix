# Import from SSH config

The **Import** button in the Connections header turns the hosts of an OpenSSH
client config into SSIX connections. It reads `~/.ssh/config` unless you name
another file; PuTTY and MobaXterm sessions are not imported.

Reading the file saves nothing. The side panel shows what will be created and
what is skipped, each with a reason and the `file:line` it came from. Untick
what you do not want and choose **Import**. Nothing else writes to your data.

## What is read

| Directive | Result |
|---|---|
| `Host a b` | One connection per literal name, named after it |
| `HostName` | The host; `%h` and `%%` are expanded. Without it, the name is the host |
| `Port` | The port, 22 by default |
| `User` | The credential's username |
| `IdentityFile` | An SSH key credential holding only the path |
| `ProxyJump` | A jump host connection, when it is one hop SSIX can resolve |
| `ProxyCommand` | The connection's proxy command |
| `LocalForward`, `RemoteForward`, `DynamicForward` | One forward connection each |
| `Include` | Relative paths from `~/.ssh`, `~`, `*` and `?`, up to 16 levels deep |

Every other directive is ignored, including `ForwardAgent` and
`ClearAllForwardings`.

OpenSSH's rules apply as written. The first value of an option wins, reading
top to bottom, so `Host *` defaults fill in only what is still unset, and a
`Host *` block at the top of the file beats the blocks below it. `IdentityFile`
and the forward directives collect every value. `ProxyJump` and `ProxyCommand`
share one slot, and `none` counts as the first value.

## What is skipped

- **Wildcard and negated patterns** (`Host *`, `*.example.com`, `!prod`) only
  supply options. They are listed, never imported.
- **`Match` blocks are not evaluated**, because their conditions depend on the
  machine and the connection. Their options are not applied, and the preview
  says where each block is.
- **`ProxyJump` beyond one hop**: a list of hops, or a jump host that itself
  goes through a `ProxyJump` or `ProxyCommand`.
- **Forwards SSIX cannot represent**: a forward on a host that goes through a
  `ProxyJump`, a Unix socket, or a `RemoteForward` with no destination (a
  reverse SOCKS proxy).
- **A `ProxyCommand` that does not validate**: SSIX expands `%h`, `%p`, `%r` and
  `%%`; any other token is refused, as it is in the connection form.
- **Bad values**: a port that is not 1 to 65535, a host name holding shell
  characters or starting with `-`, a line over 4096 bytes, an unbalanced quote,
  control characters, or text that is not UTF-8. An unreadable line takes the
  place of the option it holds, so the host is skipped instead of quietly
  connecting on a default.
- **A relative `IdentityFile`**, which depends on the directory `ssh` runs in,
  and one using a token other than `%d %h %n %p %r %u %%`.
- **A token in a username**, in `User` or in `ProxyJump %r@bastion`: a credential
  stores a username as written, so it would sign in as `%r`.

An import reads at most 1 MiB across 64 files and plans at most 2000 hosts.
`Include` cycles stop at the file that would repeat. Anything left out this way
is listed in the panel under **Passed over**.

## Hosts with no `User` or `IdentityFile`

Connections need a credential, so these get the default `ssh` itself would use,
and the preview says so on the row:

- **No `User`:** your login name. If it cannot be determined, the host is skipped.
- **No `IdentityFile`:** an agent credential, which signs in with the keys in the
  SSH agent. This is the first thing `ssh` tries. `ssh` also falls back to default
  files such as `~/.ssh/id_ed25519` and then to a password; SSIX does not guess,
  so if your key is not in the agent, point the credential at the file.

A host with several `IdentityFile` lines uses the first, since a credential holds
one key. The rest are named in a note on the row.

## Credentials

A key credential holds a username and an absolute path, with `~` and tokens
expanded. Import never opens the key file and writes nothing to the secrets
file. A key with a passphrase therefore fails to connect until you edit the
credential and add the passphrase.

A credential is shared when one with the same username and the same path (or,
for the agent, the same username) already exists. Private credentials, which
belong to one connection, are never shared. New ones are named `user@keyfile` or
`user (agent)`, with a number added if the name is taken. Only the credentials
that the rows you ticked use are created.

## Duplicates and name clashes

Connections are compared by destination: the kind, the hosts and ports, the proxy
command, and who signs in, meaning each username with its key path or the SSH
agent. Two hosts on one server with different keys are therefore two accounts, as
in the usual `github-work` and `github-personal`, and both are imported.

The name does not count, so renaming an imported connection does not make it new.
The key does: a stored connection answers with its credential's path, so one you
moved to a password or another key no longer matches the config. Under its own
name it shows as a name clash and stays as it is. Under a new name, the host is
offered again.

| The config has | SSIX has | Result |
|---|---|---|
| A name and destination | The same name and destination | Skipped: already imported |
| A name and destination | That destination under another name | Skipped: already imported as that name |
| A name and destination | That name, with another destination or key | Skipped: **name clash**. The existing connection is left as it is |
| Two aliases with one destination | | The first is created, the second skipped as a duplicate |

Importing the same file again therefore creates nothing. To import a host whose
name clashes, rename the connection or the `Host`.

## Forwards and jump hosts

A forward becomes its own connection, named after its host and flag:
`web (-L 8080)`, `web (-R 9000)`, `web (-D 1080)`. It signs in with the host's
credential and uses the host's `ProxyCommand`. SSIX has no field for a bind
address: a local or SOCKS forward listens on `127.0.0.1` only, and a remote one
wherever the server chooses. A row whose config named another address says so.

A jump host connection copies the jump host's address and credential, so it does
not depend on the jump host's own connection being imported. The parts written in
`ProxyJump user@host:port` win over the jump host's own `Host` block.

A `ProxyCommand` runs on your machine every time you connect. The preview shows
each one in full; read them before importing a config you did not write.

## How it is built

`src-tauri/src/ssh_config.rs` reads the file and answers "what applies to this
host?". `src-tauri/src/commands/import_config.rs` turns that into a plan, with
`import_ssh_config_preview(path)` and `import_ssh_config_apply({ path, keys })`.
Both run the plan on a copy of the data through the checks every saved connection
passes (`check_connection`), so a preview cannot promise what a save would refuse.

Each row's `key` is a hash of what it would create. Apply reads the file again and
plans again under the data lock, then stores the picked rows in one transaction. A
key the new plan does not contain means the file or your connections changed since
the preview: the whole import is refused, nothing is saved, and the panel shows the
fresh preview. `path` exists for this panel and for `e2e/specs/19-import.spec.ts`,
which needs a config it controls.
