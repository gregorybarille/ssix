/**
 * Spec 04: jump host connection (`ssh -J`) — server-a → server-c.
 *
 * server-c is only on `private_a`, unreachable from the host. SSIX
 * must connect through server-a as a jump host. Validates the two-hop
 * worker in `src-tauri/src/ssh.rs` (`start_jump_shell`).
 *
 * Form selector cheat-sheet for `jump_shell` mode:
 *   • `connection-form-hop-host`       — jump host
 *   • `connection-form-hop-port`       — jump host port
 *   • `connection-form-hop-credential` — jump host credential picker
 *   • `connection-form-target-host`    — target host
 *   • `connection-form-target-port`    — target port
 *   • `connection-form-credential`     — target credential
 *     (the auth-section credential picker)
 */
import { waitForAppReady } from "../helpers/app.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import {
  click,
  connectToConnection,
  createPasswordCredential,
  fill,
  navigateTo,
  pickOption,
  typeIntoTerminal,
  waitForTerminalContains,
} from "../helpers/flows.js";
import { sel } from "../helpers/selectors.js";

describe("Jump host session (server-a → server-c)", () => {
  before(async () => {
    await waitForServers(["a"]);
  });

  it("opens a shell on server-c via the server-a jump host", async () => {
    await waitForAppReady();
    await createPasswordCredential({
      name: "cred-04-a",
      username: TARGETS.a.user,
      password: TARGETS.a.password,
    });
    await createPasswordCredential({
      name: "cred-04-c",
      username: TARGETS.c.user,
      password: TARGETS.c.password,
    });

    await navigateTo("connections");
    await click(sel.addConnectionButton);
    await fill(sel.connectionFormName, "jump-04-c");
    await click(sel.connectionFormKindJumpHost);
    // Jump host = server-a (with cred-04-a).
    await fill(sel.connectionFormHopHost, TARGETS.a.host);
    await fill(sel.connectionFormHopPort, String(TARGETS.a.sshPort));
    await pickOption(sel.connectionFormHopCredential, "cred-04-a");
    // Target = server-c (with cred-04-c). server-c sshd is on
    // port 22 inside the docker network; the SSH command runs from
    // INSIDE server-a, so we always use port 22 here regardless of
    // whether the test runner is dockerized.
    await fill(sel.connectionFormTargetHost, "server-c");
    await fill(sel.connectionFormTargetPort, "22");
    await pickOption(sel.connectionFormTargetCredential, "cred-04-c");
    await click(sel.connectionFormSubmit);

    await connectToConnection("jump-04-c");

    // Alpine ash prompt: `<host>:~$` (see spec 03 for context).
    await waitForTerminalContains("server-c:~$", 60_000);
    await typeIntoTerminal("hostname\n");
    await waitForTerminalContains("server-c", 10_000);
  });
});
