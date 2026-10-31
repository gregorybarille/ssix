/**
 * Spec 12: run a saved script on two hosts at once.
 *
 * Saves a script in the side panel editor, picks server-a and server-b and
 * runs it. The script prints the user on stdout and a line on stderr, then
 * exits 0 only on server-a, so one card must show success and the other
 * the failure with its exit code; both show their own output.
 *
 * A second test cancels a script mid-run: the card must come back
 * cancelled with the output printed so far, and the script's `sleep` must
 * be gone from the server (the cancel sends SIGTERM, not just a hang-up).
 *
 * A third test saves a Windows script. The servers are Linux, so it can
 * only check that the editor swaps in PowerShell and that the run starts
 * PowerShell rather than `sh`: the host answers "not found", exit 127.
 *
 * A fourth test leaves the view with unsaved changes in the editor: the
 * app must ask first, stay on "keep editing", and only switch on discard.
 * It starts from the sidebar's Scripts button, whose tooltip must say
 * what the view is for.
 *
 * Exercises `run_script` (exec of `sh -s` with the body on stdin, both
 * streams collected) and `cancel_script_run` against real OpenSSH servers.
 */
import { waitForAppReady } from "../helpers/app.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import { sel } from "../helpers/selectors.js";
import {
  click,
  createDirectConnection,
  createPasswordCredential,
  fill,
  navigateTo,
  textContentOf,
} from "../helpers/flows.js";

const SCRIPT_LINES = [
  "whoami",
  "echo to-stderr >&2",
  `[ "$(whoami)" = ${TARGETS.a.user} ] || exit 4`,
];

/** WebKit's WebDriver drops "\n" from typed text, so press Enter between lines. */
async function typeLines(selector: string, lines: string[]): Promise<void> {
  await fill(selector, lines[0]);
  const el = await browser.$(selector);
  for (const line of lines.slice(1)) {
    await browser.keys(["Enter"]);
    await el.addValue(line);
  }
  const typed = await browser.execute((node: HTMLTextAreaElement) => node.value, el as unknown as HTMLTextAreaElement);
  expect(typed).toBe(lines.join("\n"));
}

/** Save a script from the side panel editor and select it. */
async function createScript(name: string, lines: string[], windows = false): Promise<void> {
  await navigateTo("scripts");
  await click(sel.addScriptButton);
  const form = await browser.$(sel.scriptForm);
  await form.waitForExist({ timeout: 10_000 });
  await fill(sel.scriptFormName, name);
  if (windows) {
    await click(sel.scriptFormPlatformWindows);
    const interpreter = await browser.$(sel.scriptFormInterpreter);
    expect(await interpreter.getValue()).toBe("powershell");
  }
  await typeLines(sel.scriptFormBody, lines);
  await click(sel.scriptFormSubmit);
  await form.waitForExist({ reverse: true, timeout: 10_000 });
  const row = await browser.$(sel.scriptRowByName(name));
  await row.waitForExist({ timeout: 10_000 });
  await (await row.$(sel.scriptRowSelect)).click();
}

/** Run the selected script on `hosts` and wait for the button to count them. */
async function runOn(hosts: string[]): Promise<void> {
  for (const host of hosts) await click(sel.scriptHostByName(host));
  const run = await browser.$(sel.scriptRun);
  const label = `Run on ${hosts.length} host${hosts.length === 1 ? "" : "s"}`;
  await browser.waitUntil(async () => (await textContentOf(run)).includes(label), {
    timeout: 5_000,
    timeoutMsg: `Run button never read "${label}"`,
  });
  await run.click();
}

async function resultCard(name: string, status: string): Promise<WebdriverIO.Element> {
  const card = await browser.$(`${sel.scriptResultByName(name)}[data-status="${status}"]`);
  await card.waitForExist({ timeout: 30_000 });
  return card;
}

describe("Scripts", () => {
  before(async () => {
    await waitForServers(["a", "b"]);
  });

  it("runs a script on two hosts and shows each host's output and exit code", async () => {
    await waitForAppReady();
    for (const key of ["a", "b"] as const) {
      await createPasswordCredential({
        name: `cred-12-${key}`,
        username: TARGETS[key].user,
        password: TARGETS[key].password,
      });
      await createDirectConnection({
        name: `conn-12-${key}`,
        host: TARGETS[key].host,
        port: TARGETS[key].sshPort,
        credentialName: `cred-12-${key}`,
      });
    }

    // The editor opens in the side panel, beside the list.
    await navigateTo("scripts");
    await click(sel.addScriptButton);
    await (await browser.$(`${sel.appPanelSlot} ${sel.scriptForm}`)).waitForExist({ timeout: 10_000 });
    await click(sel.scriptFormCancel);
    await createScript("script-12", SCRIPT_LINES);
    await runOn(["conn-12-a", "conn-12-b"]);

    const a = await resultCard("conn-12-a", "success");
    expect(await a.getAttribute("data-exit-code")).toBe("0");
    expect(await textContentOf(await a.$(sel.scriptResultStdout))).toContain(TARGETS.a.user);
    expect(await textContentOf(await a.$(sel.scriptResultStderr))).toContain("to-stderr");

    const b = await resultCard("conn-12-b", "error");
    expect(await b.getAttribute("data-exit-code")).toBe("4");
    expect(await textContentOf(await b.$(sel.scriptResultStdout))).toContain(TARGETS.b.user);
    expect(await textContentOf(b)).toContain("exit 4");
  });

  it("cancels a running script and stops it on the server", async () => {
    await createScript("script-12-slow", ["echo started", "sleep 30", "echo finished"]);
    await runOn(["conn-12-a"]);
    await resultCard("conn-12-a", "running");
    // Let the script start: a run cancelled before it starts never runs.
    await browser.pause(1_500);
    await click(sel.scriptCancel);

    const card = await resultCard("conn-12-a", "cancelled");
    expect(await textContentOf(card)).toContain("cancelled");
    const stdout = await textContentOf(await card.$(sel.scriptResultStdout));
    expect(stdout).toContain("started");
    expect(stdout).not.toContain("finished");
    await (await browser.$(sel.scriptCancel)).waitForExist({ reverse: true, timeout: 5_000 });

    // SIGTERM went to the whole process group, so the sleep is gone too.
    await createScript("script-12-check", ['ps | grep -q "[s]leep 30" && exit 1', "exit 0"]);
    await runOn(["conn-12-a"]);
    await resultCard("conn-12-a", "success");
  });

  it("runs a Windows script through PowerShell", async () => {
    await createScript("script-12-windows", ["Get-Date"], true);
    expect(await textContentOf(await browser.$(sel.scriptPlatform))).toContain("Windows");
    expect(await textContentOf(await browser.$(sel.scriptRowByName("script-12-windows")))).toContain(
      "Windows · powershell",
    );
    await runOn(["conn-12-a"]);

    const card = await resultCard("conn-12-a", "error");
    expect(await card.getAttribute("data-exit-code")).toBe("127");
    expect(await textContentOf(await card.$(sel.scriptResultStderr))).toContain("powershell");
  });

  it("asks before leaving the view with unsaved changes", async () => {
    const nav = await browser.$(sel.navScripts);
    await browser.execute((node: HTMLElement) => node.focus(), nav as unknown as HTMLElement);
    const tooltip = await browser.$(sel.navTooltip("nav-scripts"));
    await tooltip.waitForExist({ timeout: 5_000 });
    expect(await textContentOf(tooltip)).toContain("Saved scripts to run on several hosts");
    await navigateTo("scripts");
    await click(sel.addScriptButton);
    await (await browser.$(sel.scriptForm)).waitForExist({ timeout: 10_000 });
    await fill(sel.scriptFormName, "script-12-unsaved");

    await navigateTo("connections");
    const discard = await browser.$(sel.scriptDiscard);
    await discard.waitForExist({ timeout: 5_000 });
    await click(sel.scriptDiscardCancel);
    await discard.waitForExist({ reverse: true, timeout: 5_000 });
    expect(await (await browser.$(sel.scriptFormName)).getValue()).toBe("script-12-unsaved");
    expect(await (await browser.$(sel.addConnectionButton)).isExisting()).toBe(false);

    await navigateTo("connections");
    await click(sel.scriptDiscardConfirm);
    await (await browser.$(sel.addConnectionButton)).waitForExist({ timeout: 5_000 });
    await navigateTo("scripts");
    expect(await (await browser.$(sel.scriptForm)).isExisting()).toBe(false);
    expect(await (await browser.$(sel.scriptRowByName("script-12-unsaved"))).isExisting()).toBe(false);
  });
});
