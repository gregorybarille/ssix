/**
 * Spec 22: the sidebar's order, and the screenshot shortcut.
 *
 * The default order, then every way to change it: the menu by mouse and by
 * keyboard, and a long press and drag. Everything that moves is read back from
 * `data.json` as well as from the screen. A press too short to count is timing a
 * WebDriver chain cannot promise, so only the unit tests cover it.
 *
 * This is the one spec that changes the order, and every test leaves it at the
 * default, so a failure here does not spread.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { waitForAppReady } from "../helpers/app.js";
import { currentTestDataDir } from "../helpers/data-dir.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import {
  click,
  closeAllTabs,
  connectToConnection,
  createDirectConnection,
  createPasswordCredential,
  navigateTo,
  rightClick,
  textContentOf,
  waitForGone,
  waitForTerminalContains,
} from "../helpers/flows.js";
import { sel } from "../helpers/selectors.js";

const DEFAULT_TOP = ["nav-connections", "nav-files", "nav-snippets", "nav-forwards", "nav-scripts"];
const DEFAULT_BOTTOM = ["nav-credentials", "nav-logs", "nav-git-sync"];
/** Comfortably past the sidebar's hold before a press can drag. */
const HOLD_PAUSE_MS = 700;

const mouse = () =>
  browser.action("pointer", { id: "sidebar-mouse", parameters: { pointerType: "mouse" } });

async function shown(group: "top" | "bottom"): Promise<string[]> {
  return browser.execute(
    (selector: string) =>
      [...document.querySelectorAll<HTMLElement>(`${selector} button`)].map(
        (button) => button.dataset.testid ?? "",
      ),
    sel.sidebarGroup(group),
  );
}

async function waitForShown(top: string[], bottom: string[]): Promise<void> {
  const want = JSON.stringify([top, bottom]);
  await browser.waitUntil(
    async () => JSON.stringify([await shown("top"), await shown("bottom")]) === want,
    {
      timeout: 10_000,
      timeoutMsg: `The sidebar never showed ${want}; it shows ${JSON.stringify([
        await shown("top"),
        await shown("bottom"),
      ])}`,
    },
  );
}

function stored(): { top: string[]; bottom: string[] } {
  const dir = currentTestDataDir();
  if (!dir) throw new Error("No test data dir");
  const { settings } = JSON.parse(readFileSync(join(dir, "data.json"), "utf8"));
  return { top: settings.sidebar_top, bottom: settings.sidebar_bottom };
}

/** As stored, so without the `nav-` of the test ids and with `git_sync` as itself. */
const idsOf = (testIds: string[]) =>
  testIds.map((testId) => testId.replace("nav-", "").replace("-", "_"));

async function waitForStored(top: string[], bottom: string[]): Promise<void> {
  const want = JSON.stringify({ top, bottom });
  await browser.waitUntil(() => JSON.stringify(stored()) === want, {
    timeout: 10_000,
    timeoutMsg: `data.json never held ${want}; it holds ${JSON.stringify(stored())}`,
  });
}

async function chooseFromMenu(button: string, item: string): Promise<void> {
  await rightClick(`[data-testid="${button}"]`);
  await click(sel.sidebarMenuItem(item));
  await waitForGone(sel.contextMenu);
}

async function resetOrder(): Promise<void> {
  await chooseFromMenu("nav-connections", "Reset order");
  await waitForShown(DEFAULT_TOP, DEFAULT_BOTTOM);
  await waitForStored([], []);
}

async function centreOf(testId: string): Promise<{ x: number; y: number }> {
  const box = await browser.execute((id: string) => {
    const rect = document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, testId);
  return { x: Math.round(box.x), y: Math.round(box.y) };
}

async function viewShowing(): Promise<string> {
  return browser.execute(
    () => document.querySelector<HTMLElement>('[aria-current="page"]')?.dataset.testid ?? "",
  );
}

describe("Sidebar order", () => {
  before(async () => {
    await waitForAppReady();
    await navigateTo("connections");
  });

  it("starts with daily views on top and occasional ones at the bottom", async () => {
    await waitForShown(DEFAULT_TOP, DEFAULT_BOTTOM);
    expect(await (await browser.$(sel.navSettings)).isExisting()).toBe(true);
    expect(await shown("top")).not.toContain("nav-settings");
    expect(await shown("bottom")).not.toContain("nav-settings");
  });

  it("moves a button inside a group from its menu, and saves it", async () => {
    await chooseFromMenu("nav-files", "Move up");
    const top = ["nav-files", "nav-connections", "nav-snippets", "nav-forwards", "nav-scripts"];
    await waitForShown(top, DEFAULT_BOTTOM);
    await waitForStored(idsOf(top), idsOf(DEFAULT_BOTTOM));

    // The first button has nowhere higher to go.
    await rightClick('[data-testid="nav-files"]');
    const moveUp = await browser.$(sel.sidebarMenuItem("Move up"));
    await moveUp.waitForExist({ timeout: 10_000 });
    expect(await moveUp.isEnabled()).toBe(false);
    await browser.keys(["Escape"]);
    await waitForGone(sel.contextMenu);

    await resetOrder();
  });

  it("moves a button between groups from its menu", async () => {
    await chooseFromMenu("nav-scripts", "Move down");
    await waitForShown(DEFAULT_TOP.slice(0, -1), ["nav-scripts", ...DEFAULT_BOTTOM]);
    await chooseFromMenu("nav-scripts", "Move up");
    await waitForShown(DEFAULT_TOP, DEFAULT_BOTTOM);
    // Back at the default, so nothing is left stored to hold back a later default.
    await waitForStored([], []);
  });

  it("does the same from the keyboard, and keeps focus on the moved button", async () => {
    await browser.execute(
      () => document.querySelector<HTMLElement>('[data-testid="nav-scripts"]')?.focus(),
    );
    await browser.keys(["Shift", "F10"]);
    await (await browser.$(sel.contextMenu)).waitForExist({ timeout: 10_000 });
    await browser.keys(["ArrowDown"]);
    await browser.keys(["Enter"]);
    await waitForShown(DEFAULT_TOP.slice(0, -1), ["nav-scripts", ...DEFAULT_BOTTOM]);
    await browser.waitUntil(
      () =>
        browser.execute(() => (document.activeElement as HTMLElement | null)?.dataset.testid === "nav-scripts"),
      { timeout: 10_000, timeoutMsg: "Focus did not follow the button into the other group" },
    );
    await resetOrder();
  });

  it("moves a button by long press and drag, without opening its view", async () => {
    const before = await viewShowing();
    const from = await centreOf("nav-logs");
    const over = await centreOf("nav-files");
    await mouse()
      .move({ x: from.x, y: from.y })
      .down({ button: 0 })
      .pause(HOLD_PAUSE_MS)
      .move({ x: from.x, y: from.y - 20, duration: 100 })
      // Just above the middle of Files, so Logs lands in front of it.
      .move({ x: over.x, y: over.y - 4, duration: 200 })
      .up({ button: 0 })
      .perform();
    const top = ["nav-connections", "nav-logs", "nav-files", "nav-snippets", "nav-forwards", "nav-scripts"];
    const bottom = ["nav-credentials", "nav-git-sync"];
    await waitForShown(top, bottom);
    await waitForStored(idsOf(top), idsOf(bottom));
    expect(await viewShowing()).toBe(before);
    await resetOrder();
  });

  it("cancels a drag on Escape, and the release opens nothing", async () => {
    const before = await viewShowing();
    const from = await centreOf("nav-logs");
    const over = await centreOf("nav-files");
    await mouse()
      .move({ x: from.x, y: from.y })
      .down({ button: 0 })
      .pause(HOLD_PAUSE_MS)
      .move({ x: from.x, y: from.y - 20, duration: 100 })
      .move({ x: over.x, y: over.y - 4, duration: 200 })
      .perform(true);
    await (await browser.$(sel.sidebarDragChip)).waitForExist({ timeout: 10_000 });
    await browser.keys(["Escape"]);
    await waitForGone(sel.sidebarDragChip);
    await mouse().move({ x: from.x, y: from.y, duration: 100 }).up({ button: 0 }).perform();

    await waitForShown(DEFAULT_TOP, DEFAULT_BOTTOM);
    expect(await viewShowing()).toBe(before);
  });

  it("still opens a view on a plain click", async () => {
    await click(sel.navLogs);
    await browser.waitUntil(async () => (await viewShowing()) === "nav-logs", {
      timeout: 10_000,
      timeoutMsg: "A click on Logs did not open it",
    });
    await navigateTo("connections");
  });

  it("has no menu on Terminals, which stays between the groups", async () => {
    await waitForServers(["a"]);
    await createPasswordCredential({
      name: "cred-22-a",
      username: TARGETS.a.user,
      password: TARGETS.a.password,
    });
    await createDirectConnection({
      name: "conn-22-a",
      host: TARGETS.a.host,
      port: TARGETS.a.sshPort,
      credentialName: "cred-22-a",
    });
    await connectToConnection("conn-22-a");
    await waitForTerminalContains("server-a:~$", 30_000);

    const terminals = await centreOf("nav-terminals");
    expect(terminals.y).toBeGreaterThan((await centreOf("nav-scripts")).y);
    expect(terminals.y).toBeLessThan((await centreOf("nav-credentials")).y);

    await rightClick(sel.navTerminals);
    expect(await (await browser.$(sel.contextMenu)).isExisting()).toBe(false);
  });
});

describe("Screenshot shortcut", () => {
  async function expectToastAfterShortcut(): Promise<void> {
    await browser.keys(["Control", "Shift", "p"]);
    const toast = await browser.$(sel.screenshotToast);
    await toast.waitForExist({ timeout: 30_000 });
    expect(await textContentOf(toast)).not.toBe("");
    await waitForGone(sel.screenshotToast);
  }

  // The terminal is the one the last test of the suite above left open.
  it("works from inside a terminal", async () => {
    await click(sel.navTerminals);
    await browser.execute(
      () => document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus(),
    );
    await expectToastAfterShortcut();
    await waitForTerminalContains("server-a:~$", 10_000);
    await closeAllTabs();
  });

  it("works from a view, where a right click no longer opens a window menu", async () => {
    await navigateTo("connections");
    await rightClick(sel.sidebar);
    expect(await (await browser.$(sel.contextMenu)).isExisting()).toBe(false);
    await expectToastAfterShortcut();
  });
});
