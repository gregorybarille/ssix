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
  saveConnectionForm,
  textContentOf,
  typeIntoTerminal,
  waitForFailedTerminalError,
  waitForTerminalContains,
} from "../helpers/flows.js";
import { sel } from "../helpers/selectors.js";
import { AGENT_KEY_COMMENT, agentPublicKey } from "../helpers/ssh-agent.js";

const WRONG_ANSWER = "ssix-14-wrong-answer";

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

async function waitForAuthPrompt(): Promise<void> {
  await (await browser.$(sel.authPromptInput(0))).waitForDisplayed({ timeout: 30_000 });
}

async function answerAuthPrompt(answer: string): Promise<void> {
  await fill(sel.authPromptInput(0), answer);
  await click(sel.authPromptSubmit);
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
    await navigateTo("credentials");
    await click(sel.addCredentialButton);
    await fill(sel.credentialFormName, "cred-14-agent");
    await fill(sel.credentialFormUsername, TARGETS.a.user);
    await click(sel.credentialFormKindAgent);
    await (await browser.$(sel.credentialFormAgentHint)).waitForDisplayed({ timeout: 10_000 });
    expect(await (await browser.$(sel.credentialFormPassword)).isExisting()).toBe(false);
    await click(sel.credentialFormSubmit);
    await (await browser.$(sel.credentialForm)).waitForExist({ reverse: true, timeout: 10_000 });

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

    const retry = await (await browser.$(sel.failedTerminal)).$("button*=Retry");
    await retry.waitForClickable({ timeout: 10_000 });
    await retry.click();
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
