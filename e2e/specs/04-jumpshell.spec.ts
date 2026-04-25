/**
 * Spec 04: JumpShell connection — server-a → server-c.
 *
 * server-c is only on `private_a`, unreachable from the host. SSX
 * must connect through server-a as a gateway. Validates the two-hop
 * worker in `src-tauri/src/ssh.rs` (`start_jump_shell`).
 *
 * Note: the gateway/dest credential picker selectors here mirror
 * the Direct flow; the form's kind toggle reveals the additional
 * gateway/destination fields.
 */
import { setupTestDataDir, cleanupTestDataDir } from "../helpers/data-dir.js";
import { waitForAppReady } from "../helpers/app.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import {
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
    await waitForServers(["a", "c"]);
    setupTestDataDir();
  });
  after(() => {
    cleanupTestDataDir();
  });

  it("opens a shell on server-c via the server-a gateway", async () => {
    await waitForAppReady();
    await createPasswordCredential({
      name: "cred-a",
      username: TARGETS.a.user,
      password: TARGETS.a.password,
    });
    await createPasswordCredential({
      name: "cred-c",
      username: TARGETS.c.user,
      password: TARGETS.c.password,
    });

    await navigateTo("connections");
    await click(sel.addConnectionButton);
    await fill(sel.connectionFormName, "jump-c");
    await click(sel.connectionFormKindJumpShell);
    // Gateway = server-a (with cred-a).
    await fill(sel.connectionFormHost, TARGETS.a.host);
    await fill(sel.connectionFormPort, String(TARGETS.a.sshPort));
    await pickCredential(sel.connectionFormCredential, "cred-a");
    // Destination = server-c (with cred-c). server-c sshd is on
    // port 22 inside the docker network; the SSH command runs from
    // INSIDE server-a, so we always use port 22 here regardless of
    // whether the test runner is dockerized.
    await fill(sel.connectionFormDestHost, "server-c");
    await fill(sel.connectionFormDestPort, "22");
    await pickCredential(sel.connectionFormDestCredential, "cred-c");
    await click(sel.connectionFormSubmit);

    const row = await browser.$(sel.connectionRowByName("jump-c"));
    await row.waitForClickable({ timeout: 10_000 });
    await row.doubleClick();

    await waitForTerminalContains("userc@server-c", 60_000);
    await typeIntoTerminal("hostname\n");
    await waitForTerminalContains("server-c", 10_000);
  });
});
