/**
 * Spec 14: SSH agent login, agent forwarding and keyboard-interactive prompts.
 *
 * `wdio.conf.ts` runs a real ssh-agent holding one fresh key
 * (`helpers/ssh-agent.ts`), and the first test installs that key on server-a
 * from a password shell. server-e (`docker/Dockerfile.kbdint`) refuses the
 * password method, so `TARGETS.e.password` only works as the answer to its
 * "Password:" prompt.
 *
 * A hardware security key cannot be exercised here: see docs/auth.md for what
 * was verified instead.
 *
 * `waitForTerminalContains` searches every open terminal, so each test starts
 * with no tabs open, and markers are computed by the shell
 * (`$((6*7))`) so that the typed command never matches its own output.
 *
 * Reconnects are forced as in spec 15, from the server's side, over connections
 * without a proxy command: the client sees the socket close at once and no wait
 * here comes near a keepalive interval.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { waitForAppReady } from "../helpers/app.js";
import { fetchBackendLogs } from "../helpers/backend-logs.js";
import { currentTestDataDir } from "../helpers/data-dir.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import {
  click,
  clickDialogFooterButton,
  connectToConnection,
  createDirectConnection,
  createPasswordCredential,
  ensureConnectionRowsLayout,
  fill,
  navigateTo,
  openCredentialEditor,
  pickOption,
  readTerminalText,
  saveConnectionForm,
  textContentOf,
  typeIntoTerminal,
  waitForFailedTerminalError,
  waitForTerminalContains,
} from "../helpers/flows.js";
import {
  cutConnection,
  expectReconnected,
  NO_RETRY_WINDOW_MS,
  RECONNECTED,
  sshdPid,
  waitForPhase,
} from "../helpers/reconnect.js";
import { sel } from "../helpers/selectors.js";
import { AGENT_KEY_COMMENT, agentPublicKey } from "../helpers/ssh-agent.js";

const WRONG_ANSWER = "ssix-14-wrong-answer";
/** The keepalive of the connection that forwards through a reconnect. */
const SHORT_KEEPALIVE_S = 2;
/** The watchdog gives up after this many silent intervals. */
const KEEPALIVES_MISSED_S = 3 * SHORT_KEEPALIVE_S;

/** Close every tab, confirming for each one that holds a live shell. */
async function closeAllTabs(): Promise<void> {
  const openTabs = () => browser.$$(sel.terminalTabCloseAny).length;
  const confirmation = () => browser.$(sel.confirmClosePaneConfirm);
  for (let before = await openTabs(); before > 0; before = await openTabs()) {
    await browser.execute(
      (selector: string) => document.querySelector<HTMLElement>(selector)?.click(),
      sel.terminalTabCloseAny,
    );
    await browser.waitUntil(
      async () => (await openTabs()) < before || (await confirmation().isExisting()),
      { timeout: 10_000, timeoutMsg: "A terminal tab neither closed nor asked to" },
    );
    if (await confirmation().isExisting()) {
      await clickDialogFooterButton(sel.confirmClosePaneConfirm);
      await browser.waitUntil(async () => (await openTabs()) < before, {
        timeout: 10_000,
        timeoutMsg: "A terminal tab did not close after confirming",
      });
    }
  }
}

async function openConnectionEditor(name: string): Promise<void> {
  await navigateTo("connections");
  await ensureConnectionRowsLayout();
  await clickDialogFooterButton(`${sel.connectionRowByName(name)} ${sel.connectionRowEditButton}`);
  await (await browser.$(sel.connectionForm)).waitForExist({ timeout: 10_000 });
}

/** Wait for the shell, run `command` and return once `marker` came back. */
async function runInShell(prompt: string, command: string, marker: string): Promise<void> {
  await waitForTerminalContains(prompt, 30_000);
  await typeIntoTerminal(`${command}\n`);
  await waitForTerminalContains(marker, 15_000);
}

async function createAgentCredential(name: string, username: string): Promise<void> {
  await navigateTo("credentials");
  await click(sel.addCredentialButton);
  await fill(sel.credentialFormName, name);
  await fill(sel.credentialFormUsername, username);
  await click(sel.credentialFormKindAgent);
  await (await browser.$(sel.credentialFormAgentHint)).waitForDisplayed({ timeout: 10_000 });
  expect(await (await browser.$(sel.credentialFormPassword)).isExisting()).toBe(false);
  await click(sel.credentialFormSubmit);
  await (await browser.$(sel.credentialForm)).waitForExist({ reverse: true, timeout: 10_000 });
}

/** Open `name` beside the active tab's shell. */
async function openSplitWith(name: string): Promise<void> {
  await click(sel.terminalNewMenu);
  await click(sel.terminalNewSplitRight);
  await fill(sel.connectPickerInput, name);
  await browser.keys(["Enter"]);
  await browser.waitUntil(async () => (await browser.$$(sel.terminalContainer).length) === 2, {
    timeout: 30_000,
    timeoutMsg: "The split never opened",
  });
}

async function terminalPanes(): Promise<string[]> {
  return browser.execute(
    (selector: string) =>
      [...document.querySelectorAll(selector)].map((pane) => pane.getAttribute("data-session-id") ?? ""),
    sel.terminalContainer,
  );
}

async function typeKeys(text: string): Promise<void> {
  for (const key of text) await browser.keys([key]);
}

async function waitForAuthPrompt(): Promise<void> {
  await (await browser.$(sel.authPromptInput(0))).waitForDisplayed({ timeout: 30_000 });
}

async function answerAuthPrompt(answer: string): Promise<void> {
  await fill(sel.authPromptInput(0), answer);
  await click(sel.authPromptSubmit);
}

async function failedTerminalError(): Promise<string> {
  return (await (await browser.$(sel.failedTerminal)).getAttribute("data-error")) ?? "";
}

describe("SSH agent", () => {
  before(async () => {
    await waitForServers(["a"]);
    await waitForAppReady();
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  it("creates an agent credential, with nothing secret to fill in", async () => {
    await createAgentCredential("cred-14-agent", TARGETS.a.user);

    await openCredentialEditor("cred-14-agent");
    const tab = await browser.$(sel.credentialFormKindAgent);
    expect(await tab.getAttribute("aria-selected")).toBe("true");
    await click(sel.credentialFormCancel);
    await (await browser.$(sel.credentialForm)).waitForExist({ reverse: true, timeout: 10_000 });
  });

  it("logs in with the key in the agent", async () => {
    await createPasswordCredential({
      name: "cred-14-a-password",
      username: TARGETS.a.user,
      password: TARGETS.a.password,
    });
    await createDirectConnection({
      name: "conn-14-a-password",
      host: TARGETS.a.host,
      port: TARGETS.a.sshPort,
      credentialName: "cred-14-a-password",
    });
    await connectToConnection("conn-14-a-password");
    await runInShell(
      "server-a:~$",
      `umask 077; mkdir -p ~/.ssh; echo '${agentPublicKey()}' >> ~/.ssh/authorized_keys; echo ssix-14-$((6*7))`,
      "ssix-14-42",
    );
    await closeAllTabs();

    await createDirectConnection({
      name: "conn-14-agent",
      host: TARGETS.a.host,
      port: TARGETS.a.sshPort,
      credentialName: "cred-14-agent",
    });
    await connectToConnection("conn-14-agent");
    await runInShell("server-a:~$", "echo ssix-14-agent-$((6*7))", "ssix-14-agent-42");
  });

  it("does not forward the agent unless the connection asks", async () => {
    await connectToConnection("conn-14-agent");
    await runInShell("server-a:~$", "echo sock=[$SSH_AUTH_SOCK]", "sock=[]");
  });

  it("forwards the agent when the connection enables it", async () => {
    await openConnectionEditor("conn-14-agent");
    const checkbox = await browser.$(sel.connectionFormAgentForwarding);
    expect(await checkbox.getAttribute("aria-checked")).toBe("false");
    await clickDialogFooterButton(sel.connectionFormAgentForwarding);
    await saveConnectionForm();

    await openConnectionEditor("conn-14-agent");
    const saved = await browser.$(sel.connectionFormAgentForwarding);
    expect(await saved.getAttribute("aria-checked")).toBe("true");
    await clickDialogFooterButton(sel.connectionFormCancel);
    await (await browser.$(sel.connectionForm)).waitForExist({ reverse: true, timeout: 10_000 });

    await connectToConnection("conn-14-agent");
    // Only the comment: a whole key line would wrap across terminal rows.
    await runInShell("server-a:~$", "ssh-add -L | cut -d' ' -f3", AGENT_KEY_COMMENT);
  });

  it("keeps forwarding next to the keepalive, after a reconnect, and closes cleanly", async () => {
    await createDirectConnection({
      name: "conn-14-agent-resilient",
      host: TARGETS.a.host,
      port: TARGETS.a.sshPort,
      credentialName: "cred-14-agent",
      beforeSave: async () => {
        await clickDialogFooterButton(sel.connectionFormAgentForwarding);
        const keepalive = await browser.$(sel.connectionFormKeepalive);
        await keepalive.scrollIntoView({ block: "center" });
        await fill(sel.connectionFormKeepalive, String(SHORT_KEEPALIVE_S));
      },
    });
    await connectToConnection("conn-14-agent-resilient");
    await runInShell(
      "server-a:~$",
      "ssh-add -L | cut -d' ' -f3; echo forward-one-$((6*7))",
      "forward-one-42",
    );

    // Past the watchdog's limit, with only keepalive answers coming back.
    await browser.pause((KEEPALIVES_MISSED_S + SHORT_KEEPALIVE_S) * 1000);
    expect(await (await browser.$(sel.reconnectStatus)).isExisting()).toBe(false);

    // The new shell asks for forwarding again, with the agent credential.
    await cutConnection();
    await expectReconnected("forward-one-42");
    await runInShell(
      "server-a:~$",
      "ssh-add -L | cut -d' ' -f3; echo forward-two-$((6*7))",
      "forward-two-42",
    );
    expect((await readTerminalText()).split(AGENT_KEY_COMMENT).length - 1).toBe(2);

    await typeIntoTerminal("exit\n");
    await waitForTerminalContains("Connection closed.", 15_000);
    expect(await (await browser.$(sel.reconnectStatus)).isExisting()).toBe(false);
  });

  it("notices a frozen server while the agent is in use", async () => {
    await connectToConnection("conn-14-agent-resilient");
    await waitForTerminalContains("server-a:~$", 30_000);
    const frozen = await sshdPid();

    // Bounded, as nothing is sure to end this once the session is gone.
    await typeIntoTerminal(
      "(for i in $(seq 100); do ssh-add -L >/dev/null 2>&1; sleep 0.1; done) & echo agent-busy-$((6*7))\n",
    );
    await waitForTerminalContains("agent-busy-42", 15_000);
    await typeIntoTerminal("kill -STOP $PPID\n");

    await waitForTerminalContains("The server did not answer for", 30_000);
    await expectReconnected("agent-busy-42");
    await typeIntoTerminal(`kill -9 ${frozen}\n`);
    await runInShell("server-a:~$", "ssh-add -L >/dev/null; echo agent-back=$?", "agent-back=0");
  });
});

describe("Keyboard-interactive login", () => {
  before(async () => {
    await waitForServers(["a", "e"]);
    await waitForAppReady();
    // The saved password is the right answer, so a login without a prompt
    // would mean it was sent on its own.
    await createPasswordCredential({
      name: "cred-14-e",
      username: TARGETS.e.user,
      password: TARGETS.e.password,
    });
    await createDirectConnection({
      name: "conn-14-e",
      host: TARGETS.e.host,
      port: TARGETS.e.sshPort,
      credentialName: "cred-14-e",
      verbosity: "-vvv (everything)",
    });
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  it("asks in the pane without echoing, fails on a wrong answer and asks again on Retry", async () => {
    await connectToConnection("conn-14-e");
    await waitForAuthPrompt();

    const text = await textContentOf(await browser.$(sel.authPrompt));
    expect(text).toContain(`${TARGETS.e.user}@`);
    expect(text).toContain("Password");
    const field = await browser.$(sel.authPromptInput(0));
    expect(await field.getAttribute("type")).toBe("password");

    await answerAuthPrompt(WRONG_ANSWER);
    const error = await waitForFailedTerminalError("Keyboard-interactive auth failed");
    expect(error).not.toContain(WRONG_ANSWER);

    await click(sel.failedTerminalRetry);
    await waitForAuthPrompt();
    expect(await (await browser.$(sel.authPromptInput(0))).getValue()).toBe("");

    await answerAuthPrompt(TARGETS.e.password);
    await runInShell("server-e:~$", "echo ssix-14-otp-$((6*7))", "ssix-14-otp-42");
  });

  it("closes the pane on Cancel, and the next attempt still works", async () => {
    await connectToConnection("conn-14-e");
    await waitForAuthPrompt();
    await click(sel.authPromptCancel);
    await (await browser.$(sel.authPrompt)).waitForExist({ reverse: true, timeout: 10_000 });
    expect(await browser.$$(sel.terminalTabCloseAny).length).toBe(0);
    expect(await (await browser.$(sel.failedTerminal)).isExisting()).toBe(false);

    await connectToConnection("conn-14-e");
    await waitForAuthPrompt();
    await answerAuthPrompt(TARGETS.e.password);
    await runInShell("server-e:~$", "echo ssix-14-again-$((6*7))", "ssix-14-again-42");
  });

  it("says what the server refused, and keeps that error when the answer is wrong", async () => {
    // The agent's key is only installed on server-a, so server-e turns it down
    // and goes on to its prompt.
    await createAgentCredential("cred-14-e-agent", TARGETS.e.user);
    await createDirectConnection({
      name: "conn-14-e-agent",
      host: TARGETS.e.host,
      port: TARGETS.e.sshPort,
      credentialName: "cred-14-e-agent",
    });
    await connectToConnection("conn-14-e-agent");
    await waitForAuthPrompt();
    expect(await textContentOf(await browser.$(sel.authPromptRefused))).toContain("SSH agent");

    await answerAuthPrompt(WRONG_ANSWER);
    const error = await waitForFailedTerminalError("Agent auth failed");
    expect(error).toContain("Keyboard-interactive auth failed");

    await click(sel.failedTerminalRetry);
    await waitForAuthPrompt();
    await answerAuthPrompt(TARGETS.e.password);
    await runInShell("server-e:~$", "echo ssix-14-refused-$((6*7))", "ssix-14-refused-42");
  });

  it("reports a key file it cannot read at once, without asking", async () => {
    await navigateTo("credentials");
    await click(sel.addCredentialButton);
    await fill(sel.credentialFormName, "cred-14-e-no-key");
    await fill(sel.credentialFormUsername, TARGETS.e.user);
    await click(sel.credentialFormKindSshKey);
    await fill(sel.credentialFormPrivateKeyPath, "/nonexistent/ssix-14-no-such-key");
    await click(sel.credentialFormSubmit);
    await (await browser.$(sel.credentialForm)).waitForExist({ reverse: true, timeout: 10_000 });
    await createDirectConnection({
      name: "conn-14-e-no-key",
      host: TARGETS.e.host,
      port: TARGETS.e.sshPort,
      credentialName: "cred-14-e-no-key",
    });

    await connectToConnection("conn-14-e-no-key");
    const error = await waitForFailedTerminalError("Key auth failed");
    expect(error).not.toContain("Keyboard-interactive");
    expect(await (await browser.$(sel.authPrompt)).isExisting()).toBe(false);
  });

  it("leaves the keyboard where it is when a prompt opens in another pane", async () => {
    await createPasswordCredential({
      name: "cred-14-typing",
      username: TARGETS.a.user,
      password: TARGETS.a.password,
    });
    await createDirectConnection({
      name: "conn-14-typing",
      host: TARGETS.a.host,
      port: TARGETS.a.sshPort,
      credentialName: "cred-14-typing",
    });
    await connectToConnection("conn-14-e");
    await waitForAuthPrompt();
    await answerAuthPrompt(TARGETS.e.password);
    await waitForTerminalContains("server-e:~$", 30_000);
    await openSplitWith("conn-14-typing");
    await waitForTerminalContains("server-a:~$", 30_000);
    const [dropping, typing] = await terminalPanes();

    // The connection drops a moment after the keyboard moved to the other pane.
    await (await browser.$$(sel.terminalContainer))[0].click();
    await typeKeys("(sleep 3; kill -9 $PPID) &\n");
    await (await browser.$$(sel.terminalContainer))[1].click();
    await waitForAuthPrompt();

    const focused = await browser.execute(
      (selector: string) =>
        document.activeElement?.closest(selector)?.getAttribute("data-session-id") ?? null,
      sel.terminalContainer,
    );
    expect(focused).toBe(typing);
    expect(focused).not.toBe(dropping);

    await typeKeys("echo ssix-14-typed-$((6*7))\n");
    await browser.waitUntil(
      async () =>
        (
          await browser.execute((id: string) => window.__ssixTerminalText?.(id) ?? "", typing)
        ).includes("ssix-14-typed-42"),
      { timeout: 15_000, timeoutMsg: "What was typed did not reach the pane that had the keyboard" },
    );
    expect(await (await browser.$(sel.authPromptInput(0))).getValue()).toBe("");

    await answerAuthPrompt(TARGETS.e.password);
    await waitForTerminalContains(RECONNECTED, 40_000);
  });

  it("asks in the pane for the target behind a jump host", async () => {
    await createPasswordCredential({
      name: "cred-14-jump",
      username: TARGETS.a.user,
      password: TARGETS.a.password,
    });
    await navigateTo("connections");
    await click(sel.addConnectionButton);
    await fill(sel.connectionFormName, "jump-14-e");
    await click(sel.connectionFormKindJumpHost);
    await fill(sel.connectionFormHopHost, TARGETS.a.host);
    await fill(sel.connectionFormHopPort, String(TARGETS.a.sshPort));
    await pickOption(sel.connectionFormHopCredential, "cred-14-jump");
    // Dialled from inside server-a, so always the docker name and port 22.
    await fill(sel.connectionFormTargetHost, "server-e");
    await fill(sel.connectionFormTargetPort, "22");
    await pickOption(sel.connectionFormTargetCredential, "cred-14-e");
    await saveConnectionForm();

    await connectToConnection("jump-14-e");
    await waitForAuthPrompt();
    const text = await textContentOf(await browser.$(sel.authPrompt));
    expect(text).toContain(`${TARGETS.e.user}@server-e:22`);

    await answerAuthPrompt(TARGETS.e.password);
    await runInShell("server-e:~$", "echo ssix-14-jump-$((6*7))", "ssix-14-jump-42");
  });

  /** Log in through the prompt and print `tag`-42, to find again after a drop. */
  async function openPromptedShell(tag: string): Promise<void> {
    await connectToConnection("conn-14-e");
    await waitForAuthPrompt();
    await answerAuthPrompt(TARGETS.e.password);
    await runInShell("server-e:~$", `echo ${tag}-$((6*7))`, `${tag}-42`);
  }

  it("asks again in the pane when the shell reconnects, over the status bar", async () => {
    await openPromptedShell("before-drop");

    await cutConnection();
    await waitForPhase("waiting");

    await waitForAuthPrompt();
    expect(await (await browser.$(sel.authPromptReconnecting)).isExisting()).toBe(true);
    expect(await (await browser.$(sel.reconnectStatus)).isExisting()).toBe(false);

    await answerAuthPrompt(TARGETS.e.password);
    await expectReconnected("before-drop-42");
    await runInShell("server-e:~$", "echo after-drop-$((6*7))", "after-drop-42");
  });

  it("shows from any view that a prompt is waiting, and gives it the keyboard on arrival", async () => {
    await openPromptedShell("before-away");

    await cutConnection();
    await navigateTo("connections");
    await (await browser.$(sel.navTerminalsWaiting)).waitForExist({ timeout: 30_000 });
    expect(await (await browser.$(sel.navTerminals)).getAttribute("aria-label")).toContain(
      "login prompt waiting",
    );

    await click(sel.navTerminals);
    await waitForAuthPrompt();
    expect(await (await browser.$(sel.terminalTabPromptWaiting)).isExisting()).toBe(true);
    const focused = await browser.execute(() => document.activeElement?.getAttribute("data-testid"));
    expect(focused).toBe("auth-prompt-input-0");

    await answerAuthPrompt(TARGETS.e.password);
    await expectReconnected("before-away-42");
    await (await browser.$(sel.navTerminalsWaiting)).waitForExist({ reverse: true, timeout: 10_000 });
    expect(await (await browser.$(sel.terminalTabPromptWaiting)).isExisting()).toBe(false);
  });

  it("stops reconnecting on Cancel, keeps the pane and asks again on Retry", async () => {
    await openPromptedShell("before-cancel");

    await cutConnection();
    await waitForAuthPrompt();
    await click(sel.authPromptCancel);

    await waitForPhase("stopped");
    expect(await failedTerminalError()).toMatch(/auth/i);
    await browser.pause(NO_RETRY_WINDOW_MS);
    expect(await (await browser.$(sel.authPrompt)).isExisting()).toBe(false);
    expect(await (await browser.$(sel.reconnectStatusPhase("stopped"))).isExisting()).toBe(true);

    await click(sel.failedTerminalRetry);
    await waitForAuthPrompt();
    await answerAuthPrompt(TARGETS.e.password);
    await expectReconnected("before-cancel-42");
  });

  it("does not ask again after a wrong answer during a reconnect", async () => {
    await openPromptedShell("before-wrong");

    await cutConnection();
    await waitForAuthPrompt();
    await answerAuthPrompt(WRONG_ANSWER);

    await waitForPhase("stopped");
    const error = await failedTerminalError();
    expect(error).toMatch(/auth/i);
    expect(error).not.toContain(WRONG_ANSWER);
    await browser.pause(NO_RETRY_WINDOW_MS);
    expect(await (await browser.$(sel.authPrompt)).isExisting()).toBe(false);
    expect(await (await browser.$(sel.reconnectStatusPhase("stopped"))).isExisting()).toBe(true);
  });

  it("neither logs nor stores an answer", async () => {
    const entries = await fetchBackendLogs();
    if (!entries) throw new Error("The backend logs are unavailable");
    const logs = entries.map((entry) => entry.message).join("\n");
    // The prompt rounds ran at -vvv, so these logs are the ones to check.
    expect(logs).toContain("The server asks 1 question(s).");
    expect(logs).not.toContain(WRONG_ANSWER);
    expect(logs).not.toMatch(new RegExp(`\\b${TARGETS.e.password}\\b`));

    const dataDir = currentTestDataDir();
    if (!dataDir) throw new Error("SSIX_DATA_DIR is not set");
    for (const name of readdirSync(dataDir)) {
      const path = join(dataDir, name);
      if (statSync(path).isFile()) expect(readFileSync(path, "utf8")).not.toContain(WRONG_ANSWER);
    }
  });
});
