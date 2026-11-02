/**
 * Spec 15: keepalive, auto-reconnect and session logs.
 *
 * A session is lost from the server's side, over the shell itself, since the
 * runner cannot control the Docker daemon. `$PPID` is the session's own sshd,
 * running as the logged-in user:
 *   • `kill -9 $PPID`    cuts the connection;
 *   • `kill -STOP $PPID` freezes it: TCP stays up and nothing answers, so only
 *     the keepalive can notice.
 *
 * A proxy command that refuses while a flag file exists makes every attempt
 * fail as a network failure would, for as long as a test wants. OpenBSD `nc`
 * outlives a connection the server cut until something is written to it, so
 * these connections keep a short keepalive: at the default 30 s, the drop
 * would surface right at the moment `waitForPhase` gives up.
 *
 * Commands print `<tag>-42` from `$((40+2))`, so the echo of the typed line
 * can never be mistaken for the shell's answer.
 *
 * Exercises `src-tauri/src/reconnect.rs`, `session_log.rs`, the shell worker in
 * `ssh.rs` and the status bar of `FailedTerminal`. See docs/session-resilience.md.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { waitForAppReady } from "../helpers/app.js";
import { currentTestDataDir } from "../helpers/data-dir.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import { flaggedProxy } from "../helpers/flagged-proxy.js";
import {
  click,
  closeTerminal,
  connectToConnection,
  createDirectConnection,
  createPasswordCredential,
  fill,
  navigateTo,
  openCredentialEditor,
  pickOption,
  readTerminalText,
  reveal,
  saveConnectionForm,
  textContentOf,
  typeIntoTerminal,
  waitForFailedTerminalError,
  waitForTerminalContains,
} from "../helpers/flows.js";
import { BOGUS_KEYS, plantBogusHostKeys } from "../helpers/known-hosts.js";
import {
  cutConnection,
  expectReconnected,
  NO_RETRY_WINDOW_MS,
  RECONNECTED,
  sshdPid,
  waitForPhase,
} from "../helpers/reconnect.js";
import { sel } from "../helpers/selectors.js";

const PROMPT = "server-a:~$";
const CREDENTIAL = "cred-15-a";

function dataDir(): string {
  const dir = currentTestDataDir();
  if (!dir) throw new Error("SSIX_DATA_DIR is not set");
  return dir;
}

const {
  refuseConnections,
  allowConnections,
  proxyCommand: refusingProxy,
} = flaggedProxy("refuse-proxy-15");

interface ShellConnection {
  credentialName?: string;
  keepalive?: number;
  autoReconnect?: "On" | "Off";
  logSession?: "On" | "Off";
  proxyCommand?: string;
}

/** A direct connection to server-a with these session options. */
async function createShellConnection(name: string, options: ShellConnection = {}): Promise<void> {
  await createDirectConnection({
    name,
    host: TARGETS.a.host,
    port: TARGETS.a.sshPort,
    credentialName: options.credentialName ?? CREDENTIAL,
    proxyCommand: options.proxyCommand,
    beforeSave: async () => {
      if (options.keepalive !== undefined) {
        await reveal(sel.connectionFormKeepalive);
        await fill(sel.connectionFormKeepalive, String(options.keepalive));
      }
      if (options.autoReconnect) {
        await reveal(sel.connectionFormAutoReconnect);
        await pickOption(sel.connectionFormAutoReconnect, options.autoReconnect);
      }
      if (options.logSession) {
        await reveal(sel.connectionFormLogSession);
        await pickOption(sel.connectionFormLogSession, options.logSession);
      }
    },
  });
}

async function openShell(name: string): Promise<void> {
  await connectToConnection(name);
  await waitForTerminalContains(PROMPT, 30_000);
}

async function expectShellAnswers(tag: string): Promise<void> {
  await typeIntoTerminal(`echo ${tag}-$((40+2))\n`);
  await waitForTerminalContains(`${tag}-42`, 15_000);
}

/** Stays stopped for longer than a next attempt would take to start. */
async function expectNoRetry(): Promise<void> {
  await browser.pause(NO_RETRY_WINDOW_MS);
  expect(await (await browser.$(sel.reconnectStatusPhase("stopped"))).isExisting()).toBe(true);
  expect(await readTerminalText()).not.toContain(RECONNECTED);
}

async function setCredentialPassword(name: string, password: string): Promise<void> {
  await openCredentialEditor(name);
  await fill(sel.credentialFormPassword, password);
  await click(sel.credentialFormSubmit);
  await (await browser.$(sel.credentialForm)).waitForExist({ reverse: true, timeout: 10_000 });
}

/** Overwrite a number field and leave it, which is what saves it. */
async function typeOverNumber(selector: string, value: number): Promise<void> {
  await reveal(selector);
  await fill(selector, String(value));
  await browser.keys(["Tab"]);
  expect(await (await browser.$(selector)).getValue()).toBe(String(value));
}

async function setSwitch(selector: string, on: boolean): Promise<void> {
  await reveal(selector);
  const toggle = await browser.$(selector);
  if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
}

async function setLogFolder(path: string): Promise<void> {
  await reveal(sel.settingsSessionLogDir);
  const field = await browser.$(sel.settingsSessionLogDir);
  await field.clearValue();
  if (path) await field.addValue(path);
  await browser.keys(["Tab"]);
}

/** The log whose name contains `name`, once it holds `content`. */
async function waitForLog(dir: string, name: string, content: string): Promise<string> {
  let path = "";
  await browser.waitUntil(
    async () => {
      const file = existsSync(dir)
        ? readdirSync(dir).find((f) => f.includes(name) && f.endsWith(".log"))
        : undefined;
      path = file ? join(dir, file) : "";
      return !!path && readFileSync(path, "utf8").includes(content);
    },
    { timeout: 15_000, timeoutMsg: `No log for ${name} in ${dir} holding ${content}` },
  );
  return path;
}

const modeOf = (path: string) => statSync(path).mode & 0o777;

const anAlertSays = (text: string) =>
  browser.execute(
    (needle: string) =>
      [...document.querySelectorAll('[role="alert"]')].some((el) => el.textContent?.includes(needle)),
    text,
  );

describe("Session resilience", () => {
  before(async () => {
    await waitForServers(["a"]);
    await waitForAppReady();
    await createPasswordCredential({
      name: CREDENTIAL,
      username: TARGETS.a.user,
      password: TARGETS.a.password,
    });
  });

  afterEach(async () => {
    allowConnections();
    await closeTerminal();
  });

  it("notices a frozen server through its keepalive and reconnects in the same pane", async () => {
    await createShellConnection("conn-15-keepalive", { keepalive: 2 });
    await openShell("conn-15-keepalive");
    await expectShellAnswers("BEFORE-FREEZE");
    const frozen = await sshdPid();

    await typeIntoTerminal("kill -STOP $PPID\n");

    // Three silent intervals of 2 s; the connection itself never fails.
    await waitForTerminalContains("The server did not answer for", 30_000);
    await expectReconnected("BEFORE-FREEZE-42");
    await expectShellAnswers("AFTER-FREEZE");

    await typeIntoTerminal(`kill -9 ${frozen}\n`);
  });

  it("reconnects a connection the server cut", async () => {
    await createShellConnection("conn-15-cut");
    await openShell("conn-15-cut");
    await expectShellAnswers("BEFORE-CUT");

    await cutConnection();

    await expectReconnected("BEFORE-CUT-42", "SSH Error:");
    await expectShellAnswers("AFTER-CUT");
  });

  it("leaves the alternate screen of a program that died with the connection", async () => {
    await createShellConnection("conn-15-altscreen");
    await openShell("conn-15-altscreen");
    await expectShellAnswers("BEFORE-ALT");
    await typeIntoTerminal("printf '\\033[?1049h'\n");
    await browser.waitUntil(async () => !(await readTerminalText()).includes("BEFORE-ALT-42"), {
      timeout: 10_000,
      timeoutMsg: "The terminal never switched to the alternate screen",
    });

    await cutConnection();

    await expectReconnected("BEFORE-ALT-42");
    await expectShellAnswers("AFTER-ALT");
  });

  it("counts its attempts until cancelled, drops what is typed meanwhile, and retries on request", async () => {
    await createShellConnection("conn-15-cancel", { keepalive: 2, proxyCommand: refusingProxy() });
    await openShell("conn-15-cancel");
    await expectShellAnswers("BEFORE-CANCEL");
    refuseConnections();

    await cutConnection();

    const waiting = await waitForPhase("waiting");
    expect(await textContentOf(waiting)).toContain("Reconnecting: attempt");
    await browser.waitUntil(async () => (await waiting.getAttribute("data-reconnect-attempt")) === "2", {
      timeout: 40_000,
      timeoutMsg: "The second attempt never came",
    });

    await click(sel.reconnectCancelButton);

    await waitForPhase("stopped", 10_000);
    await waitForFailedTerminalError("SSH handshake with");
    await expectNoRetry();

    // Nothing is listening: these keys must not reach the next shell.
    await typeIntoTerminal("echo TYPED-WHILE-DOWN-$((40+2))\n");

    allowConnections();
    await click(sel.failedTerminalRetry);

    await expectReconnected("BEFORE-CANCEL-42");
    await expectShellAnswers("AFTER-CANCEL");
    expect(await readTerminalText()).not.toContain("TYPED-WHILE-DOWN-42");
  });

  it("stops by itself when its attempts run out, and closes at once from there", async () => {
    await navigateTo("settings");
    await typeOverNumber(sel.settingsReconnectMaxAttempts, 2);
    try {
      await createShellConnection("conn-15-attempts", { keepalive: 2, proxyCommand: refusingProxy() });
      await openShell("conn-15-attempts");
      await expectShellAnswers("BEFORE-ATTEMPTS");
      refuseConnections();

      await cutConnection();

      const waiting = await waitForPhase("waiting");
      expect(await textContentOf(waiting)).toContain("of 2");
      await waitForPhase("stopped");
      await waitForFailedTerminalError("SSH handshake with");

      await click(sel.failedTerminalDismiss);
      await (await browser.$(sel.navTerminals)).waitForExist({ reverse: true, timeout: 10_000 });
    } finally {
      allowConnections();
      await closeTerminal();
      await navigateTo("settings");
      await typeOverNumber(sel.settingsReconnectMaxAttempts, 5);
      await navigateTo("connections");
    }
  });

  it("never retries a failed login, and takes a corrected password on Retry", async () => {
    await createPasswordCredential({
      name: "cred-15-auth",
      username: TARGETS.a.user,
      password: TARGETS.a.password,
    });
    await createShellConnection("conn-15-auth", { credentialName: "cred-15-auth" });
    await openShell("conn-15-auth");
    await expectShellAnswers("BEFORE-AUTH");

    await setCredentialPassword("cred-15-auth", "not-the-password");
    await click(sel.navTerminals);
    await cutConnection();

    await waitForPhase("stopped");
    const failed = await browser.$(sel.failedTerminal);
    expect(await failed.getAttribute("data-error")).toMatch(/auth/i);
    await expectNoRetry();

    await setCredentialPassword("cred-15-auth", TARGETS.a.password);
    await click(sel.navTerminals);
    await click(sel.failedTerminalRetry);

    await expectReconnected("BEFORE-AUTH-42");
    await expectShellAnswers("AFTER-AUTH");
  });

  it("never retries a changed host key, and reconnects once it is trusted", async () => {
    const knownHosts = join(dataDir(), "known_hosts");
    await createShellConnection("conn-15-hostkey");
    await openShell("conn-15-hostkey");
    await expectShellAnswers("BEFORE-HOSTKEY");
    const trusted = readFileSync(knownHosts, "utf8");

    plantBogusHostKeys(knownHosts, TARGETS.a.host, TARGETS.a.sshPort);
    try {
      await cutConnection();

      await waitForFailedTerminalError("HOST_KEY_MISMATCH");
      await waitForPhase("stopped");
      await expectNoRetry();
      // The stale keys stay until the user acts.
      for (const key of BOGUS_KEYS) expect(readFileSync(knownHosts, "utf8")).toContain(key);

      await click(sel.trustHostKeyButton);

      await expectReconnected("BEFORE-HOSTKEY-42");
      await expectShellAnswers("AFTER-HOSTKEY");
      for (const key of BOGUS_KEYS) expect(readFileSync(knownHosts, "utf8")).not.toContain(key);
    } catch (error) {
      // Later specs reach the same server.
      writeFileSync(knownHosts, trusted);
      throw error;
    }
  });

  it("does not reconnect a shell that ended by itself", async () => {
    await createShellConnection("conn-15-exit");
    await openShell("conn-15-exit");

    await typeIntoTerminal("exit\n");

    await waitForTerminalContains("Connection closed.", 15_000);
    await (await browser.$(sel.confirmClosePane)).waitForExist({ timeout: 10_000 });
    await browser.pause(NO_RETRY_WINDOW_MS);
    expect(await (await browser.$(sel.reconnectStatus)).isExisting()).toBe(false);
    expect(await readTerminalText()).not.toContain(RECONNECTED);
  });

  it("with auto-reconnect off, waits for the user instead of trying", async () => {
    await createShellConnection("conn-15-off", { autoReconnect: "Off" });
    await openShell("conn-15-off");
    await expectShellAnswers("BEFORE-OFF");

    await cutConnection();

    const stopped = await waitForPhase("stopped");
    expect(await stopped.getAttribute("data-reconnect-attempt")).toBeNull();
    await expectNoRetry();

    await click(sel.failedTerminalRetry);

    await expectReconnected("BEFORE-OFF-42");
    await expectShellAnswers("AFTER-OFF");
  });

  it("keeps a dropped session through Edit Connection, and retries with what was saved", async () => {
    await createShellConnection("conn-15-edit", { autoReconnect: "Off" });
    await openShell("conn-15-edit");
    await expectShellAnswers("BEFORE-EDIT");

    await cutConnection();
    await waitForPhase("stopped");

    // Nothing listens on this port, so the failure proves the edit applied.
    await click(sel.failedTerminalEdit);
    await fill(sel.connectionFormPort, "1");
    await saveConnectionForm();
    await click(sel.navTerminals);
    await click(sel.failedTerminalRetry);
    await waitForFailedTerminalError("TCP connect to");

    // The form starts from what was saved, not from the pane's older copy.
    await click(sel.failedTerminalEdit);
    expect(await (await browser.$(sel.connectionFormPort)).getValue()).toBe("1");
    await fill(sel.connectionFormPort, String(TARGETS.a.sshPort));
    await saveConnectionForm();
    await click(sel.navTerminals);
    await click(sel.failedTerminalRetry);

    await expectReconnected("BEFORE-EDIT-42");
    await expectShellAnswers("AFTER-EDIT");
  });

  it("logs a session to a private file that its name cannot move out of the folder", async () => {
    const name = "../../evil-15";
    await createShellConnection(name, { logSession: "On" });
    await openShell(name);
    await expectShellAnswers("LOGGED-BEFORE");

    const folder = join(dataDir(), "session-logs");
    const log = await waitForLog(folder, "evil-15", "LOGGED-BEFORE-42");
    expect(dirname(log)).toBe(folder);
    expect(modeOf(folder)).toBe(0o700);
    expect(modeOf(log)).toBe(0o600);
    for (const outside of [dataDir(), dirname(dataDir())]) {
      expect(readdirSync(outside).filter((file) => file.includes("evil-15"))).toEqual([]);
    }

    // One file for the whole session, reconnect included.
    await cutConnection();
    await expectReconnected("LOGGED-BEFORE-42");
    await expectShellAnswers("LOGGED-AFTER");
    await waitForLog(folder, "evil-15", "LOGGED-AFTER-42");
    expect(readdirSync(folder).filter((file) => file.includes("evil-15"))).toHaveLength(1);
    const written = readFileSync(log, "utf8");
    expect(written).toContain("Connection lost:");
    expect(written).toContain("Reconnected");
  });

  it("does not log a session unless asked to", async () => {
    await createShellConnection("conn-15-nolog");
    await openShell("conn-15-nolog");
    await expectShellAnswers("NOT-LOGGED");

    const folder = join(dataDir(), "session-logs");
    const logs = existsSync(folder) ? readdirSync(folder) : [];
    expect(logs.filter((file) => file.includes("conn-15-nolog"))).toEqual([]);
  });

  it("applies the app's settings to a connection that overrides nothing", async () => {
    const folder = join(dataDir(), "custom-logs-15");
    await navigateTo("settings");
    await typeOverNumber(sel.settingsKeepaliveInterval, 2);
    await setSwitch(sel.settingsAutoReconnect, false);
    // A connection set to On still uses the attempts.
    expect(await (await browser.$(sel.settingsReconnectMaxAttempts)).isEnabled()).toBe(true);
    await setSwitch(sel.settingsSessionLogEnabled, true);
    await setLogFolder(folder);
    try {
      await createShellConnection("conn-15-settings");
      await openShell("conn-15-settings");
      await expectShellAnswers("BEFORE-SETTINGS");
      await waitForLog(folder, "conn-15-settings", "BEFORE-SETTINGS-42");
      const frozen = await sshdPid();

      await typeIntoTerminal("kill -STOP $PPID\n");

      await waitForFailedTerminalError("The server did not answer for");
      await waitForPhase("stopped");

      await click(sel.failedTerminalRetry);
      await expectReconnected("BEFORE-SETTINGS-42");
      await typeIntoTerminal(`kill -9 ${frozen}\n`);
    } finally {
      await closeTerminal();
      await navigateTo("settings");
      await typeOverNumber(sel.settingsKeepaliveInterval, 30);
      await setSwitch(sel.settingsAutoReconnect, true);
      await setSwitch(sel.settingsSessionLogEnabled, false);
      await setLogFolder("");
      await navigateTo("connections");
    }
  });

  it("refuses a log folder that is not an absolute path", async () => {
    await navigateTo("settings");
    await setLogFolder("relative/logs");
    await browser.waitUntil(() => anAlertSays("must be an absolute path"), {
      timeout: 10_000,
      timeoutMsg: "A relative log folder was not refused",
    });

    await setLogFolder("");
    await browser.waitUntil(async () => !(await anAlertSays("must be an absolute path")), {
      timeout: 10_000,
      timeoutMsg: "The refusal stayed after the folder was emptied",
    });
    await navigateTo("connections");
  });
});
