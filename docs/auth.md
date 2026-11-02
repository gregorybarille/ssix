# Authentication

A credential logs in with a password, an SSH key or the SSH agent. Whichever it
is, a server can still ask questions of its own, which SSIX shows in the
terminal pane.

## How a login goes

1. SSIX asks the server which methods it accepts, as `ssh -v` shows at its start.
2. If the server accepts the credential's method, SSIX tries it. If not, the
   credential is skipped, so a saved password never reaches a server that
   refuses passwords.
3. If that did not finish the login and the server offers keyboard-interactive,
   SSIX asks you in the pane. This covers a server that takes nothing else, a
   refused credential, and a second factor after an accepted first one.

Set the connection's verbosity to `-v` to see these steps in the Logs view.

## SSH agent

Choose **SSH Agent** when creating a credential. It stores a username and
nothing secret. SSIX offers each key in the agent in turn until the server
accepts one.

SSIX finds the agent through `SSH_AUTH_SOCK`, or the OpenSSH agent service and
Pageant on Windows. An app started from the Dock or a desktop launcher may not
have `SSH_AUTH_SOCK` set even though your terminal does; see
[troubleshooting](troubleshooting.md#agent-login-fails).

## Agent forwarding

**Forward SSH agent (`ssh -A`)** in the connection form lets programs on the
server use your local agent while you are connected, for example to `git pull`
or reach another host without copying a key there. It is off by default and
applies only to that connection. It is offered for direct and jump host
connections. On a jump host connection the agent reaches the final target, not
the jump host.

**The trade-off:** the keys stay on your computer and cannot be read from the
server, but anyone with root on that server, or who controls your account there,
can ask your agent to sign while you are connected, and so log in as you
wherever those keys work. Enable forwarding only for servers you trust. To limit
what a compromised server could do:

- Hold only the keys you need: `ssh-add` a dedicated key rather than all of them.
- Add keys with `ssh-add -c`, so your agent asks you to confirm each use.
- Use a security key that requires a touch for each signature.

SSIX decides nothing about signing. It relays bytes between the server and your
agent, so the agent's own confirmation prompts and constraints still apply.

If the server refuses forwarding or the local agent is unreachable, the shell
still opens and the Logs view says why. A reconnected shell asks for forwarding
again, and `$SSH_AUTH_SOCK` on the server changes with it. Agent traffic does not
count towards the keepalive: only what arrives from the server shows it is there.

Forwarding is not available on Windows: a connection that enables it logs a
warning and opens without it. SSIX's **Copy SSH command** does not add `-A`.

## Keyboard-interactive (2FA, OTP)

The server's questions appear in the pane that is connecting, one round at a
time. A field the server marks as hidden shows dots and has no reveal button.
Empty answers are allowed, since some servers only want Enter.

- Answers go to the server and nowhere else. They are not logged or saved, and
  are cleared from the form when sent.
- A saved password never answers a prompt on its own. It could be the wrong
  thing to send, and each wrong answer can count against the account.
- A wrong answer ends in the failure view with **Retry**, which asks again.
- **Cancel**, or closing the pane or tab, ends the connection attempt by closing
  its socket rather than sending blank answers, so it costs no failed attempt
  on a server that locks accounts. On Windows blank answers are sent instead.
- A prompt left unanswered for five minutes ends the attempt. Most servers give
  up sooner (OpenSSH's `LoginGraceTime` is two minutes).

### During a reconnect

A dropped shell that needs answers asks again in the same pane
([session resilience](session-resilience.md) covers the rest of a reconnect).

- While the prompt is open it has the whole pane. The status bar and the terminal
  step aside, and both come back when it closes, with the scrollback intact.
- **Cancel** stops the reconnect but keeps the pane: the status bar shows
  "Authentication cancelled" with **Retry**, which asks again. On a first
  connection Cancel closes the pane, as there is nothing to keep.
- A wrong answer, or a prompt left open for five minutes, stops the reconnect the
  same way. Nothing asks again until you press **Retry**, so walking away from a
  dropped session cannot lock an account or fill the pane with prompts. A failed
  agent login stops it too.
- Closing the pane or tab, or anything else that ends the attempt, closes a
  waiting prompt within a moment.
- A prompt in a background tab waits there, and nothing draws attention to it
  until you switch to that tab.

Only a shell has a pane to ask in, so it is the only thing that can answer. The
shell of a jump host connection can ask for either hop, and the pane says which
host is asking. SCP, script runs and local forwards refuse such a server with a
message saying so; use a key or the agent for those.

## FIDO2 security keys

A `sk-ed25519` or `sk-ecdsa` key works through the agent: load it with `ssh-add`
and use an SSH Agent credential. The agent does the signing, and SSIX waits up
to two minutes for it, enough for a touch.

libssh2's own agent login cannot carry such a signature: it drops the flags and
counter that end one, and the server rejects the result. So SSIX asks the agent
to sign over its socket and passes the answer on whole.

**How far this has been tested:** Docker cannot exercise a hardware key, and no
hardware key has been used with SSIX. The login is verified against a real
OpenSSH server with a software `sk-ed25519` key and a stand-in agent, which
checks the wire format but not a real device, its PIN or touch handling, or a
real agent's behaviour with one. Security keys in the agent are not supported on
Windows.

## Tests

- `e2e/specs/14-auth.spec.ts` runs the whole flow against a real `ssh-agent`
  (`e2e/helpers/ssh-agent.ts`), `server-a` and `server-e`.
- The Rust live tests are ignored by a plain `cargo test`. With `server-a` and
  `server-e` running on the default ports:

  ```sh
  SSIX_LIVE_SSH=127.0.0.1:2201 SSIX_LIVE_USER=usera SSIX_LIVE_PASSWORD=passa \
  SSIX_LIVE_PLATFORM=posix SSIX_LIVE_KBDINT_SSH=127.0.0.1:2205 \
  SSIX_LIVE_KBDINT_USER=usere SSIX_LIVE_KBDINT_PASSWORD=passe \
  cargo test live_ -- --ignored --test-threads=1
  ```

  CI sets only the `server-a` variables, so `live_keyboard_*` and `live_reopen_*`
  skip there and the spec above covers `server-e`, reconnects included.
- The second-factor test needs a server that takes a password and then a prompt.
  See `live_keyboard_interactive_as_second_factor` in
  `src-tauri/src/auth_prompt.rs` for the container to start.
