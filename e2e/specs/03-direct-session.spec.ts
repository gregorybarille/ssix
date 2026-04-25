/**
 * Spec 03: Direct SSH session against server-a.
 *
 * Full lifecycle: create credential + Direct connection, click connect,
 * wait for shell prompt, run `whoami`, assert output is `usera`.
 *
 * Exercises `start_ssh_session` + the OS-thread / mpsc plumbing in
 * `src-tauri/src/ssh.rs` against a real OpenSSH server.
 */
import { waitForAppReady } from "../helpers/app.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import {
  createPasswordCredential,
  createDirectConnection,
  navigateTo,
  typeIntoTerminal,
  waitForTerminalContains,
} from "../helpers/flows.js";
import { sel } from "../helpers/selectors.js";

describe("Direct SSH session", () => {
  before(async () => {
    await waitForServers(["a"]);
  });

  it("connects, runs whoami, and sees the expected output", async () => {
    await waitForAppReady();
    await createPasswordCredential({
      name: "cred-03-a",
      username: TARGETS.a.user,
      password: TARGETS.a.password,
    });
    await createDirectConnection({
      name: "conn-03-a",
      host: TARGETS.a.host,
      port: TARGETS.a.sshPort,
      credentialName: "cred-03-a",
    });
    await navigateTo("connections");

    const row = await browser.$(sel.connectionRowByName("conn-03-a"));
    await row.waitForClickable({ timeout: 10_000 });
    await row.doubleClick();

    // Wait for shell prompt (alpine default PS1: `usera@server-a:~$`).
    await waitForTerminalContains("usera@server-a", 30_000);

    await typeIntoTerminal("whoami\n");
    await waitForTerminalContains(TARGETS.a.user, 10_000);
  });
});
