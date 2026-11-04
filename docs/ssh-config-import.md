# Import from SSH config

The **Import** button in the Connections header turns the hosts of an OpenSSH
client config into SSIX connections. It reads `~/.ssh/config` unless you name
another file; PuTTY and MobaXterm sessions are not imported.

Reading the file saves nothing. The side panel shows what can be created and
what is skipped, each with a reason and the `file:line` it came from. Rows start
ticked unless the row says otherwise. Change the ticks and choose **Import**.
Nothing else writes to your data, and what a row creates never depends on a row
you left unticked.

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
| `Include` | Relative paths from `~/.ssh`, `~`, `*` and `?`, up to 16 levels deep. A `%` token or `${VAR}` is not expanded, so the file is not read (see below) |

Every other directive is ignored, including `ForwardAgent` and
`ClearAllForwardings`.

OpenSSH's rules apply as written. The first value of an option wins, reading
top to bottom, so `Host *` defaults fill in only what is still unset, and a
`Host *` block at the top of the file beats the blocks below it. `IdentityFile`
and the forward directives collect every value. `ProxyJump` and `ProxyCommand`
share one slot, and the first value holds it. `none` counts as a value, with one
exception that `ssh -G` confirms: a later `ProxyCommand` still replaces
`ProxyJump none`, so `ProxyJump none` above a `Host *` block with a `ProxyCommand`
does not make a host direct. `ProxyCommand none` does.

## What is skipped

- **Wildcard and negated patterns** (`Host *`, `*.example.com`, `!prod`) only
  supply options. They are listed, never imported.
- **`Match` blocks are not evaluated**, because their conditions depend on the
  machine and the connection. Their options are not applied, the preview says
  where each block is, and every row starts unticked (see below).
- **`ProxyJump` beyond one hop**: a list of hops, or a jump host that itself
  goes through a `ProxyJump` or `ProxyCommand`.
- **Forwards SSIX cannot represent**: a forward on a host that goes through a
  `ProxyJump`, a Unix socket, or a `RemoteForward` with no destination (a
  reverse SOCKS proxy).
- **A `ProxyCommand` that would fail on connect**: SSIX expands `%h`, `%p`, `%r`
  and `%%` and refuses any other token, as the connection form does. A token whose
  host or user holds characters that are not safe in a command line is refused too.
  The preview expands the command with this host's real values to find out.
- **Bad values**: a port that is not 1 to 65535, a host name holding shell
  characters or starting with `-`, a line over 4096 bytes, an unbalanced quote,
  control characters, or text that is not UTF-8. An unreadable line takes the
  place of the option it holds, so the host is skipped instead of quietly
  connecting on a default.
- **A relative `IdentityFile`**, which depends on the directory `ssh` runs in,
  one using a token other than `%d %h %n %p %r %u %%`, and one using `${VAR}`.
- **A token or `${VAR}` in a username**, in `User` or in `ProxyJump %r@bastion`: a
  credential stores a username as written, so it would sign in as `%r`. A bare `$`
  is kept, because `ssh` keeps it and `HOST$` is a real account name.

`${VAR}` in a `ProxyCommand` is left as written: `ssh` hands it to the shell, and
so does SSIX.

An import reads at most 1 MiB across 64 files and expands at most 256 `Include`
paths. It plans at most 2000 hosts, or
fewer when a very large file makes each one slow to work out, and offers at most
2000 connections, with at most 64 forwards per host. It lists at most 2000 skipped
entries and 200 passed-over lines. `Include` cycles stop at the file that would
repeat. Each limit is reported once in the panel under **Passed over**.

## When part of a config is not applied

A `Match` block, an `Include` that could not be read, that uses a `%` token or
`${VAR}` or that is past the limit above, and an unreadable `Host` line can each change what any host does. A
dropped `Match` may be the very line that sends a host through its bastion, and
importing that host as a direct connection would connect straight to it. SSIX
cannot tell which hosts they touch, so if a file has any of these:

- every row says so, and starts unticked;
- **Passed over** lists what was left out, with its `file:line`;
- you can still tick any row, once you have checked it against the config.

The rule is deliberately simple. It also applies to a `Match` block that sets
nothing SSIX reads, which only costs you the extra tick. Two things do not count:
an `Include` that matches no file, because `ssh` reads nothing from it either, and
an unreadable option, which skips the hosts it applies to and leaves the others
alone.

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
`user (agent)`. Only the credentials that the rows you ticked use are created.

A number is added if the name is taken. Numbers follow the rows you ticked, in
order, so unticking `/a/id` leaves `/b/id` with the plain `user@id`. Because the
ticks can change, the preview shows a number only for a name that a stored
credential holds. A row that would need one because of a row above it says so.

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
| Two aliases with one destination | | Both are offered. The first starts ticked and the second unticked, so you can pick either or both |
| Two aliases with one name | | The first is offered and the second skipped as a duplicate. Spaces around a name do not count, because they are not stored: `Host " web"` and `Host web` are one name |

Importing the same file again therefore creates nothing. To import a host whose
name clashes, rename the connection or the `Host`.

## Forwards and jump hosts

A forward becomes its own connection, named after its host and flag:
`web (-L 8080)`, `web (-R 9000)`, `web (-D 1080)`. It signs in with the host's
credential and uses the host's `ProxyCommand`.

A local or SOCKS forward keeps the IP address its config binds to, and `*` becomes
`0.0.0.0` as it means for `ssh`. When other machines could reach the result, the
row says so and starts unticked. SSIX takes IP addresses only, so a name other than `localhost` is dropped
with a note and the forward listens on `127.0.0.1`. So does an empty address
(`:8080`), which `ssh` would open to every network. A remote forward listens
wherever the server chooses, and a row whose config named an address says so.

A jump host connection copies the jump host's address and credential, so it does
not depend on the jump host's own connection being imported. The parts written in
`ProxyJump user@host:port` win over the jump host's own `Host` block.

A `ProxyCommand` runs on your machine every time you connect. The preview shows
each one in full, and its row and its forwards' rows say so and start unticked: a
config you did not write should not run anything until you have read it. Select
every host still ticks them.

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

An import under way cannot be stopped, so the panel cannot be closed from its
buttons or with Escape until it ends. If it closes some other way, as when you
leave the view, the import still finishes and the connection lists update, but its
result never reaches a panel opened since.
