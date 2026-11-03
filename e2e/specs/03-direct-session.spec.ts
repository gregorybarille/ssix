/**
 * Spec 03: Direct SSH session against server-a.
 *
 * Full lifecycle: create credential + Direct connection, click connect,
 * wait for shell prompt, run `whoami`, assert output is `usera`. A second
 * connection at verbosity -vv must write `ssh -vv` style lines to the
 * Logs view, and a third reaches server-a only through its proxy command.
 * Then the same session under load: a paste bigger than the server holds, and
 * output faster than the terminal can take.
 *
 * Exercises `start_ssh_session` + the OS-thread / mpsc plumbing in
 * `src-tauri/src/ssh.rs` against a real OpenSSH server.
 */
import { waitForAppReady } from "../helpers/app.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import { sel } from "../helpers/selectors.js";
import {
  click,
  closeAllTabs,
  connectToConnection,
  createPasswordCredential,
  createDirectConnection,
  navigateTo,
  readTerminalText,
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

/**
 * Input of about `bytes` as it reaches the backend from a paste, without a paste's
 * megabytes of keystrokes. Ends the input of the program that reads it.
 */
async function sendLotsOfInput(bytes: number): Promise<void> {
  await browser.execute(
    (selector: string, size: number) => {
      const pane = document.querySelector<HTMLElement>(selector);
      const line = `${"x".repeat(63)}\n`;
      const data = `${line.repeat(Math.ceil(size / line.length))}\x04`;
      return (window as any).__TAURI_INTERNALS__.invoke("ssh_write", {
        sessionId: pane?.dataset.sessionId,
        data,
      });
    },
    sel.terminalContainer,
    bytes,
  );
}

async function openLoadShell(name: string): Promise<void> {
  await closeAllTabs();
  await navigateTo("connections");
  await createDirectConnection({
    name,
    host: TARGETS.a.host,
    port: TARGETS.a.sshPort,
    credentialName: "cred-03-a",
  });
  await connectToConnection(name);
  await waitForTerminalContains("server-a:~$", 30_000);
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

  it("reaches the host through its proxy command", async () => {
    // The host name does not resolve: only the proxy command can reach
    // server-a, so a shell proves the connection went through it.
    await createDirectConnection({
      name: "conn-03-proxy",
      host: "proxied-a.invalid",
      port: 22,
      credentialName: "cred-03-a",
      verbosity: "-v (connection steps)",
      proxyCommand: `nc ${TARGETS.a.host} ${TARGETS.a.sshPort}`,
    });
    await connectToConnection("conn-03-proxy");
    // Every open terminal is searched; the -v banner names this host and
    // is only written once the proxied login has opened a shell.
    await waitForTerminalContains("Connected to proxied-a.invalid:22", 30_000);
  });

  it("takes a paste bigger than the server holds, under a program not reading it", async () => {
    await openLoadShell("conn-03-paste");
    // Reads nothing for longer than a write was once given. The arithmetic keeps
    // the marker out of the echo of this line.
    await typeIntoTerminal("sleep 14; stty -echo; cat >/dev/null; stty echo; echo paste-$((6*7))\n");
    await sendLotsOfInput(3 * 1024 * 1024);
    // A session dropped on the way would not print this: the new shell runs nothing.
    await waitForTerminalContains("paste-42", 60_000);
  });

  it("shows the end of a flood, also after it ran off screen", async () => {
    await openLoadShell("conn-03-flood");
    // About 90 MB, past the 50 MB at which xterm throws output away.
    await typeIntoTerminal("seq 1 12000000; echo flood-$((6*7))\n");
    await navigateTo("connections");
    await browser.pause(3_000);
    await click(sel.navTerminals);
    await waitForTerminalContains("flood-42", 100_000);
    expect(await readTerminalText()).toContain("12000000");
  });

  it("stops a flood with Ctrl+C", async () => {
    await openLoadShell("conn-03-interrupt");
    await typeIntoTerminal("yes spec03flood\n");
    await waitForTerminalContains("spec03flood\nspec03flood", 30_000);
    await browser.keys(["Control", "c"]);
    await typeIntoTerminal("echo stopped-$((6*7))\n");
    await waitForTerminalContains("stopped-42", 30_000);
  });
});
