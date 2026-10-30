/**
 * Spec 03: Direct SSH session against server-a.
 *
 * Full lifecycle: create credential + Direct connection, click connect,
 * wait for shell prompt, run `whoami`, assert output is `usera`. A second
 * connection at verbosity -vv must write `ssh -vv` style lines to the
 * Logs view.
 *
 * Exercises `start_ssh_session` + the OS-thread / mpsc plumbing in
 * `src-tauri/src/ssh.rs` against a real OpenSSH server.
 */
import { waitForAppReady } from "../helpers/app.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import { sel } from "../helpers/selectors.js";
import {
  connectToConnection,
  createPasswordCredential,
  createDirectConnection,
  navigateTo,
  textContentOf,
  typeIntoTerminal,
  waitForTerminalContains,
} from "../helpers/flows.js";

async function debugLogLines(): Promise<string[]> {
  const rows = await browser.$$(`${sel.logEntry}[data-level="debug"]`);
  const lines: string[] = [];
  for (const row of rows) lines.push(await textContentOf(row));
  return lines;
}

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
    await connectToConnection("conn-03-a");

    // Wait for shell prompt. The alpine images use ash, whose default
    // PS1 is `\h:\w\$` — i.e. `server-a:~$`, NOT the bash-style
    // `user@host:~$`. (An earlier version of this spec assumed bash
    // and timed out waiting for a prompt that never appears.)
    await waitForTerminalContains("server-a:~$", 30_000);

    await typeIntoTerminal("whoami\n");
    await waitForTerminalContains(TARGETS.a.user, 10_000);
  });

  it("logs ssh -vv style debug lines at verbosity 2", async () => {
    await createDirectConnection({
      name: "conn-03-vv",
      host: TARGETS.a.host,
      port: TARGETS.a.sshPort,
      credentialName: "cred-03-a",
      verbosity: "-vv (negotiated algorithms)",
    });
    await connectToConnection("conn-03-vv");
    await waitForTerminalContains("Connected to", 30_000);

    await navigateTo("logs");
    let lines: string[] = [];
    await browser.waitUntil(
      async () => {
        lines = await debugLogLines();
        return lines.some((l) => l.includes("Authentication succeeded (password)"));
      },
      { timeout: 15_000, timeoutMsg: "no -v authentication line in the Logs view" },
    );
    expect(lines.some((l) => l.includes("debug1:") && l.includes("kex: algorithm:"))).toBe(true);
    expect(lines.some((l) => l.includes("debug2:") && l.includes("cipher:"))).toBe(true);
    expect(lines.some((l) => l.includes("debug3:"))).toBe(false);
  });
});
