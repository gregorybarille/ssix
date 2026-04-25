/**
 * Spec 04: JumpShell connection — server-a → server-c.
 *
 * server-c is only on `private_a`, unreachable from the host. SSX
 * must connect through server-a as a gateway. Validates the two-hop
 * worker in `src-tauri/src/ssh.rs` (`start_jump_shell`).
 *
 * Form selector cheat-sheet for `jump_shell` mode:
 *   • `connection-form-gateway`            — gateway host
 *   • `connection-form-gateway-port`       — gateway port
 *   • `connection-form-gateway-credential` — gateway credential picker
 *   • `connection-form-dest-host`          — destination host
 *   • `connection-form-dest-port`          — destination port
 *   • `connection-form-credential`         — destination credential
 *     (the auth-section credential picker; reused as the dest cred)
 */
import { waitForAppReady } from "../helpers/app.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import {
  connectToConnection,
  createPasswordCredential,
  navigateTo,
  typeIntoTerminal,
  waitForTerminalContains,
} from "../helpers/flows.js";
import { sel } from "../helpers/selectors.js";

async function fill(selector: string, value: string) {
  const el = await browser.$(selector);
  await el.waitForClickable({ timeout: 10_000 });
  await el.setValue(value);
}
async function click(selector: string) {
  const el = await browser.$(selector);
  await el.waitForClickable({ timeout: 10_000 });
  await el.click();
}
async function pickCredential(triggerSelector: string, name: string) {
  await click(triggerSelector);
  const opt = await browser.$(`[role="option"][data-name="${name}"]`);
  await opt.waitForClickable({ timeout: 10_000 });
  await opt.click();
}

describe("JumpShell session (server-a → server-c)", () => {
  before(async () => {
    await waitForServers(["a"]);
  });

  it("opens a shell on server-c via the server-a gateway", async () => {
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
    await click(sel.connectionFormKindJumpShell);
    // Gateway = server-a (with cred-04-a).
    await fill(sel.connectionFormGateway, TARGETS.a.host);
    await fill(sel.connectionFormGatewayPort, String(TARGETS.a.sshPort));
    await pickCredential(sel.connectionFormGatewayCredential, "cred-04-a");
    // Destination = server-c (with cred-04-c). server-c sshd is on
    // port 22 inside the docker network; the SSH command runs from
    // INSIDE server-a, so we always use port 22 here regardless of
    // whether the test runner is dockerized.
    await fill(sel.connectionFormDestHost, "server-c");
    await fill(sel.connectionFormDestPort, "22");
    await pickCredential(sel.connectionFormDestCredential, "cred-04-c");
    await click(sel.connectionFormSubmit);

    await connectToConnection("jump-04-c");

    await waitForTerminalContains("userc@server-c", 60_000);
    await typeIntoTerminal("hostname\n");
    await waitForTerminalContains("server-c", 10_000);
  });
});
