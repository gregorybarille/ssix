/**
 * Spec 12: run a saved script on two hosts at once.
 *
 * Saves a script in the side panel editor, picks server-a and server-b and
 * runs it. The script prints the user on stdout and a line on stderr, then
 * exits 0 only on server-a, so one card must show success and the other
 * the failure with its exit code; both show their own output.
 *
 * Exercises `run_script` (exec of `sh -s` with the body on stdin, both
 * streams collected) against real OpenSSH servers.
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

    await navigateTo("scripts");
    await click(sel.addScriptButton);
    const form = await browser.$(sel.scriptForm);
    await form.waitForExist({ timeout: 10_000 });
    // The editor opens in the side panel, beside the list.
    expect(await (await browser.$(`${sel.appPanelSlot} ${sel.scriptForm}`)).isExisting()).toBe(true);
    await fill(sel.scriptFormName, "script-12");
    await typeLines(sel.scriptFormBody, SCRIPT_LINES);
    await click(sel.scriptFormSubmit);
    await form.waitForExist({ reverse: true, timeout: 10_000 });

    const row = await browser.$(sel.scriptRowByName("script-12"));
    await row.waitForExist({ timeout: 10_000 });
    await (await row.$(sel.scriptRowSelect)).click();

    await click(sel.scriptHostByName("conn-12-a"));
    await click(sel.scriptHostByName("conn-12-b"));
    const run = await browser.$(sel.scriptRun);
    await browser.waitUntil(async () => (await textContentOf(run)).includes("Run on 2 hosts"), {
      timeout: 5_000,
      timeoutMsg: "Run button never counted both hosts",
    });
    await run.click();

    const a = await resultCard("conn-12-a", "success");
    expect(await a.getAttribute("data-exit-code")).toBe("0");
    expect(await textContentOf(await a.$(sel.scriptResultStdout))).toContain(TARGETS.a.user);
    expect(await textContentOf(await a.$(sel.scriptResultStderr))).toContain("to-stderr");

    const b = await resultCard("conn-12-b", "error");
    expect(await b.getAttribute("data-exit-code")).toBe("4");
    expect(await textContentOf(await b.$(sel.scriptResultStdout))).toContain(TARGETS.b.user);
    expect(await textContentOf(b)).toContain("exit 4");
  });
});
