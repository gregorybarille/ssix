/**
 * Spec 20: the terminal beyond a plain shell.
 *
 *   • it keeps its scrollback and session across views, off screen;
 *   • the terminal that stays is the same one when its tab splits or a split closes;
 *   • find in the scrollback (Ctrl+Shift+F);
 *   • links, which come from output and so are not to be trusted;
 *   • broadcast input across the panes of a tab;
 *   • a connection's own font and colours.
 *
 * Commands print `<tag>-42` from `$((40+2))`, so the echo of the typed line
 * can never be mistaken for the shell's answer. Terminals are read through
 * `window.__ssixTerminalText`, which also reads one off screen. The suite runs
 * on Linux only, where the shortcut modifier is Ctrl.
 *
 * Exercises `src/components/Terminal.tsx`, `src/components/terminal/`,
 * `src/lib/terminalTheme.ts` and `validate_color_scheme` in
 * `src-tauri/src/commands/connections.rs`. See docs/terminal-ux.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitForAppReady } from "../helpers/app.js";
import { currentTestDataDir } from "../helpers/data-dir.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import { flaggedProxy } from "../helpers/flagged-proxy.js";
import {
  click,
  clickDialogFooterButton,
  closeAllTabs,
  connectToConnection,
  createDirectConnection,
  createPasswordCredential,
  fill,
  navigateTo,
  openConnectionEditor,
  pickOption,
  reveal,
  saveConnectionForm,
  textContentOf,
  waitForTerminalContains,
} from "../helpers/flows.js";
import { sel } from "../helpers/selectors.js";

const PROMPT_A = "server-a:~$";
const PROMPT_B = "server-b:~$";
const CREDENTIAL_A = "cred-20-a";
const CREDENTIAL_B = "cred-20-b";
const RECONNECTED = "[SSIX] Reconnected.";
const CLOSED = "Connection closed.";
/** What a terminal shows with no scheme of its own: Tokyo Night, or Day on a light app theme. */
const APP_BACKGROUNDS = ["#1a1b26", "#e1e2e7"];
/** Long enough for a key that was going to reach somewhere to have done so. */
const SETTLE_MS = 500;

function dataDir(): string {
  const dir = currentTestDataDir();
  if (!dir) throw new Error("SSIX_DATA_DIR is not set");
  return dir;
}

const { refuseConnections, allowConnections, proxyCommand } = flaggedProxy("refuse-proxy-20");

/** A connection to server-a. */
function createConnectionA(name: string, beforeSave?: () => Promise<void>): Promise<void> {
  return createDirectConnection({
    name,
    host: TARGETS.a.host,
    port: TARGETS.a.sshPort,
    credentialName: CREDENTIAL_A,
    beforeSave,
  });
}

/**
 * A connection to server-a that `refuseConnections` can keep from coming back.
 * OpenBSD `nc` outlives a connection the server cut until something is written
 * to it, hence the short keepalive: see `15-resilience.spec.ts`.
 */
function createDroppableConnection(name: string): Promise<void> {
  return createDirectConnection({
    name,
    host: TARGETS.a.host,
    port: TARGETS.a.sshPort,
    credentialName: CREDENTIAL_A,
    proxyCommand: proxyCommand(),
    beforeSave: async () => {
      await reveal(sel.connectionFormKeepalive);
      await fill(sel.connectionFormKeepalive, "2");
    },
  });
}

const sessionIds = () =>
  browser.execute(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="terminal-container"]')].map(
      (el) => el.dataset.sessionId ?? "",
    ),
  );

/** Open a connection in a new tab, and give back its session once the shell is up. */
async function openShell(name: string, prompt = PROMPT_A): Promise<string> {
  await connectToConnection(name);
  await waitForTerminalContains(prompt);
  const ids = await sessionIds();
  expect(ids).toHaveLength(1);
  return ids[0];
}

/** Open a connection beside the shell of the active tab. */
async function splitWith(name: string, how: string = sel.terminalNewSplitRight): Promise<void> {
  await click(sel.terminalNewMenu);
  await click(how);
  await click(sel.connectPickerOption(name));
}

const textOf = (id: string) =>
  browser.execute((session: string) => window.__ssixTerminalText?.(session) ?? "", id);

async function stateOf(id: string) {
  const state = await browser.execute(
    (session: string) => window.__ssixTerminalState?.(session) ?? null,
    id,
  );
  if (!state) throw new Error(`No terminal for session ${id}`);
  return state;
}

async function waitForText(id: string, needle: string, timeout = 30_000): Promise<void> {
  await browser.waitUntil(async () => (await textOf(id)).includes(needle), {
    timeout,
    timeoutMsg: `The terminal never showed ${JSON.stringify(needle)}`,
  });
}

/** The shell of a pane split in beside `first`, once it is up. */
async function secondPane(first: string): Promise<string> {
  await browser.waitUntil(async () => (await sessionIds()).length === 2, {
    timeout: 30_000,
    timeoutMsg: "The split never opened a second terminal",
  });
  const second = (await sessionIds()).find((id) => id !== first);
  if (!second) throw new Error("No second pane");
  await waitForText(second, PROMPT_A);
  return second;
}

async function waitForFocus(id: string): Promise<void> {
  await browser.waitUntil(async () => (await stateOf(id)).focused, {
    timeout: 10_000,
    timeoutMsg: "The terminal did not get the keyboard back",
  });
}

/**
 * Press keys where the keyboard already is, one call per key: within a call
 * keys are held down together. No click first, so a test using this also proves
 * where the keyboard is.
 */
async function press(text: string): Promise<void> {
  for (const key of text) await browser.keys([key]);
}

async function typeIn(id: string, text: string): Promise<void> {
  await click(sel.terminalContainerBySession(id));
  await press(text);
}

const findShortcut = () => browser.keys(["Control", "Shift", "f"]);

async function expectGone(selector: string): Promise<void> {
  await browser.pause(SETTLE_MS);
  expect(await (await browser.$(selector)).isExisting()).toBe(false);
}

const lastTick = (text: string) =>
  Math.max(0, ...[...text.matchAll(/^TICK-(\d+)-/gm)].map((match) => Number(match[1])));

/**
 * Send the mouse to the line of a terminal that reads exactly `line`. Events
 * are dispatched where xterm listens for them, at the pixels of a cell in that
 * line, since its renderer draws to a canvas and leaves no element to aim at.
 * That also lets a test say outright which modifier a click carries.
 */
async function mouseOnLine(
  id: string,
  line: string,
  types: string[],
  init: MouseEventInit = {},
): Promise<void> {
  await browser.execute(
    (session: string, wanted: string, events: string[], options: MouseEventInit) => {
      const screen = document.querySelector(
        `[data-session-id="${session}"] .xterm-screen`,
      ) as HTMLElement;
      const state = window.__ssixTerminalState?.(session);
      const row = (window.__ssixTerminalText?.(session) ?? "").split("\n").indexOf(wanted);
      if (!state || row < 0) throw new Error(`No line ${wanted} in the terminal`);
      const rect = screen.getBoundingClientRect();
      const clientX = rect.left + (1.5 * rect.width) / state.cols;
      const clientY = rect.top + ((row - state.viewportY + 0.5) * rect.height) / state.rows;
      for (const type of events) {
        screen.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, ...options }),
        );
      }
    },
    id,
    line,
    types,
    init,
  );
}

const CLICK = ["mousedown", "mouseup"];

/** Print `text` as an OSC 8 hyperlink to `target`, and wait for it. */
async function printHyperlink(id: string, target: string, text: string): Promise<void> {
  await typeIn(id, `printf '\\033]8;;${target}\\033\\\\${text}\\033]8;;\\033\\\\\\n'\n`);
  await waitForText(id, `\n${text}\n`);
}

async function waitForSearchInputFocus(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (input: string) => document.activeElement === document.querySelector(input),
        sel.terminalSearchInput,
      ),
    { timeout: 10_000, timeoutMsg: "The find bar did not take the keyboard" },
  );
}

/** The shortcut to the find bar, Escape out of it, and the keyboard is back in the terminal. */
async function openFindThenEscape(id: string): Promise<void> {
  await findShortcut();
  await waitForSearchInputFocus();
  await browser.keys(["Escape"]);
  await (await browser.$(sel.terminalSearch)).waitForExist({ reverse: true, timeout: 10_000 });
  await waitForFocus(id);
}

async function waitForSearchStatus(expected: RegExp): Promise<string> {
  const status = await browser.$(sel.terminalSearchStatus);
  let last = "";
  await browser.waitUntil(
    async () => {
      last = await textContentOf(status);
      return expected.test(last);
    },
    { timeout: 10_000, timeoutMsg: `The find bar never said ${expected}; it said "${last}"` },
  );
  return last;
}

const toggleLabel = async () => textContentOf(await browser.$(sel.broadcastToggle));

async function waitForToggleLabel(expected: string): Promise<void> {
  await browser.waitUntil(async () => (await toggleLabel()).includes(expected), {
    timeout: 10_000,
    timeoutMsg: `The broadcast toggle never said "${expected}"`,
  });
}

async function waitForDrop(): Promise<void> {
  await (await browser.$(sel.reconnectStatus)).waitForExist({ timeout: 30_000 });
}

describe("Terminal UX", () => {
  before(async () => {
    await waitForServers(["a", "b"]);
    await waitForAppReady();
    await createPasswordCredential({
      name: CREDENTIAL_A,
      username: TARGETS.a.user,
      password: TARGETS.a.password,
    });
    await createPasswordCredential({
      name: CREDENTIAL_B,
      username: TARGETS.b.user,
      password: TARGETS.b.password,
    });
  });

  afterEach(async () => {
    allowConnections();
    await closeAllTabs();
  });

  describe("a terminal that just opened", () => {
    it("takes the keyboard with no click", async () => {
      await createConnectionA("conn-20-fresh");
      const id = await openShell("conn-20-fresh");
      await press("echo FRESH-$((40+2))\n");
      await waitForText(id, "FRESH-42", 10_000);
    });

    it("takes the keyboard in the new pane of a split asked for from the tab bar", async () => {
      await createConnectionA("conn-20-split-from");
      await createConnectionA("conn-20-split-to");
      const first = await openShell("conn-20-split-from");
      await splitWith("conn-20-split-to");
      const second = await secondPane(first);

      await press("echo SPLIT-$((40+2))\n");
      await waitForText(second, "SPLIT-42", 10_000);
      expect(await textOf(first)).not.toContain("SPLIT");
    });

    it("leaves the keyboard with someone typing when a slow connection arrives", async () => {
      await createConnectionA("conn-20-typing");
      await createDirectConnection({
        name: "conn-20-slow",
        host: TARGETS.a.host,
        port: TARGETS.a.sshPort,
        credentialName: CREDENTIAL_A,
        proxyCommand: `sleep 4; exec nc ${TARGETS.a.host} ${TARGETS.a.sshPort}`,
      });
      const first = await openShell("conn-20-typing");
      await splitWith("conn-20-slow");
      await typeIn(first, "echo TYPING-$((40+2))");
      const second = await secondPane(first);

      await press("\n");
      await waitForText(first, "TYPING-42", 10_000);
      expect(await textOf(second)).not.toContain("TYPING");
    });
  });

  describe("a tab split and put back", () => {
    /** Tag a terminal's element. A new terminal in its place would not have the tag. */
    const tagTerminal = (id: string) =>
      browser.execute((session: string) => {
        const element = document.querySelector<HTMLElement>(`[data-session-id="${session}"] .xterm`);
        if (element) element.dataset.tagged = "yes";
      }, id);

    const isTagged = (id: string) =>
      browser.execute(
        (session: string) =>
          document.querySelector<HTMLElement>(`[data-session-id="${session}"] .xterm`)?.dataset.tagged === "yes",
        id,
      );

    /** The terminal's share of its tab, across and down. */
    const shareOfTab = (id: string) =>
      browser.execute((session: string) => {
        const container = document.querySelector(`[data-session-id="${session}"]`);
        const tab = container?.closest('[role="tabpanel"]');
        if (!container || !tab) return { across: 0, down: 0 };
        const inner = container.getBoundingClientRect();
        const outer = tab.getBoundingClientRect();
        return { across: inner.width / outer.width, down: inner.height / outer.height };
      }, id);

    async function waitForShare(id: string, across: number, down: number): Promise<void> {
      await browser.waitUntil(
        async () => {
          const share = await shareOfTab(id);
          return Math.abs(share.across - across) < 0.02 && Math.abs(share.down - down) < 0.02;
        },
        {
          timeout: 10_000,
          timeoutMsg: `The terminal never took ${across} x ${down} of its tab`,
        },
      );
    }

    /** What a program in this terminal asked for, so that a new terminal would not have it. */
    async function askForBracketedPaste(id: string): Promise<void> {
      await typeIn(id, "printf '\\033[?2004h'\n");
      await browser.waitUntil(async () => (await stateOf(id)).bracketedPaste, {
        timeout: 10_000,
        timeoutMsg: "Bracketed paste never turned on",
      });
    }

    async function waitForAltScreen(id: string, on: boolean): Promise<void> {
      await browser.waitUntil(async () => (await stateOf(id)).altScreen === on, {
        timeout: 10_000,
        timeoutMsg: `The alternate screen never went ${on ? "on" : "off"}`,
      });
    }

    /** End the shell in `second`, and answer the question that follows. */
    async function closePane(second: string): Promise<void> {
      await typeIn(second, "exit\n");
      await clickDialogFooterButton(sel.confirmClosePaneConfirm);
      await browser.waitUntil(async () => (await sessionIds()).length === 1, {
        timeout: 10_000,
        timeoutMsg: "The pane did not close",
      });
    }

    it("keeps the terminal that stays, in full, when split to the right and put back", async () => {
      await createConnectionA("conn-20-keep");
      await createConnectionA("conn-20-keep-beside");
      const first = await openShell("conn-20-keep");
      await waitForShare(first, 1, 1);
      await typeIn(first, "echo BEFORE-$((40+2))\n");
      await waitForText(first, "BEFORE-42");
      await askForBracketedPaste(first);
      await tagTerminal(first);
      const alone = await stateOf(first);

      await splitWith("conn-20-keep-beside");
      const second = await secondPane(first);
      await waitForShare(first, 0.5, 1);
      await browser.waitUntil(async () => (await stateOf(first)).cols < alone.cols * 0.6, {
        timeout: 10_000,
        timeoutMsg: "The terminal did not fit its half of the tab",
      });
      const beside = await stateOf(first);
      expect(beside.cols).toBeGreaterThan(alone.cols * 0.4);
      expect(beside.rows).toBe(alone.rows);
      expect(beside.bracketedPaste).toBe(true);
      expect(await isTagged(first)).toBe(true);
      expect(await textOf(first)).toContain("BEFORE-42");

      // A full-screen program stays one when the split closes under it.
      await typeIn(first, "printf '\\033[?1049h'; echo ALT-$((40+2))\n");
      await waitForAltScreen(first, true);
      await waitForText(first, "ALT-42");
      await closePane(second);
      await waitForShare(first, 1, 1);
      await browser.waitUntil(async () => (await stateOf(first)).cols === alone.cols, {
        timeout: 10_000,
        timeoutMsg: "The terminal did not take the whole tab again",
      });
      const back = await stateOf(first);
      expect(back.rows).toBe(alone.rows);
      expect(back.altScreen).toBe(true);
      expect(back.bracketedPaste).toBe(true);
      expect(await isTagged(first)).toBe(true);
      expect(await textOf(first)).toContain("ALT-42");

      // The server was told, and the scrollback is there behind the program.
      await typeIn(first, "printf '\\033[?1049l'; stty size\n");
      await waitForAltScreen(first, false);
      await waitForText(first, `${alone.rows} ${alone.cols}`);
      expect(await textOf(first)).toContain("BEFORE-42");
    });

    it("keeps it through a split down too", async () => {
      await createConnectionA("conn-20-down");
      await createConnectionA("conn-20-down-below");
      const first = await openShell("conn-20-down");
      await typeIn(first, "echo BEFORE-$((40+2))\n");
      await waitForText(first, "BEFORE-42");
      await askForBracketedPaste(first);
      await tagTerminal(first);
      const alone = await stateOf(first);

      await splitWith("conn-20-down-below", sel.terminalNewSplitDown);
      const second = await secondPane(first);
      await waitForShare(first, 1, 0.5);
      await browser.waitUntil(async () => (await stateOf(first)).rows < alone.rows * 0.6, {
        timeout: 10_000,
        timeoutMsg: "The terminal did not fit its half of the tab",
      });
      expect((await stateOf(first)).cols).toBe(alone.cols);
      expect(await isTagged(first)).toBe(true);

      await closePane(second);
      await waitForShare(first, 1, 1);
      await browser.waitUntil(async () => (await stateOf(first)).rows === alone.rows, {
        timeout: 10_000,
        timeoutMsg: "The terminal did not take the whole tab again",
      });
      const back = await stateOf(first);
      expect(back.cols).toBe(alone.cols);
      expect(back.bracketedPaste).toBe(true);
      expect(await isTagged(first)).toBe(true);
      expect(await textOf(first)).toContain("BEFORE-42");
    });

    it("gives the keyboard to the pane that stays when a failed one is dismissed", async () => {
      await createConnectionA("conn-20-stays");
      await createDroppableConnection("conn-20-never");
      const first = await openShell("conn-20-stays");
      refuseConnections();
      await splitWith("conn-20-never");

      await click(sel.failedTerminalDismiss);
      await browser.waitUntil(async () => (await sessionIds()).length === 1, {
        timeout: 10_000,
        timeoutMsg: "The failed pane did not close",
      });
      await waitForFocus(first);
      await press("echo STAYS-$((40+2))\n");
      await waitForText(first, "STAYS-42", 10_000);
    });
  });

  describe("off screen", () => {
    it("keeps a terminal as it was across views, taking output but no keys", async () => {
      await createConnectionA("conn-20-views");
      const id = await openShell("conn-20-views");
      await typeIn(id, "echo BEFORE-$((40+2))\n");
      await waitForText(id, "BEFORE-42");
      // A program's terminal mode: a new terminal in its place would not have it.
      await typeIn(id, "printf '\\033[?2004h'\n");
      await browser.waitUntil(async () => (await stateOf(id)).bracketedPaste, {
        timeout: 10_000,
        timeoutMsg: "Bracketed paste never turned on",
      });
      const { cols, rows } = await stateOf(id);

      await typeIn(id, "for i in $(seq 90); do echo TICK-$i-$(stty size | tr ' ' x); sleep 1; done\n");
      await waitForText(id, "TICK-1-");

      await navigateTo("connections");
      const container = await browser.$(sel.terminalContainerBySession(id));
      expect(await container.isExisting()).toBe(true);
      expect(await container.isDisplayed()).toBe(false);
      expect((await stateOf(id)).focused).toBe(false);

      // Output lands while nothing shows it.
      const ticksAtHiding = lastTick(await textOf(id));
      await browser.waitUntil(async () => lastTick(await textOf(id)) >= ticksAtHiding + 2, {
        timeout: 15_000,
        timeoutMsg: "No output reached the terminal off screen",
      });

      // Keys typed elsewhere stay there, in a field or with the focus on nothing.
      await fill(sel.connectionSearchInput, "AWAY-KEYS");
      await click(sel.connectionSearchClear);
      await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
      await press("STRAY-KEYS\n");

      // The keyboard goes back without a click.
      await click(sel.navTerminals);
      await waitForFocus(id);
      await browser.keys(["Control", "c"]);
      await press("echo AFTER-$((40+2))\n");
      await waitForText(id, "AFTER-42");

      const text = await textOf(id);
      expect(text).toContain("BEFORE-42");
      expect(text).not.toContain("AWAY-KEYS");
      expect(text).not.toContain("STRAY-KEYS");
      // The shell was never resized to nothing, nor back and forth.
      const sizes = new Set([...text.matchAll(/^TICK-\d+-(\S+)$/gm)].map((match) => match[1]));
      expect([...sizes]).toEqual([`${rows}x${cols}`]);
      const state = await stateOf(id);
      expect([state.rows, state.cols]).toEqual([rows, cols]);
      expect(state.bracketedPaste).toBe(true);
    });

    it("reconnects off screen, with its status there on return", async () => {
      await createDroppableConnection("conn-20-drop");
      const id = await openShell("conn-20-drop");
      await typeIn(id, "echo BEFORE-DROP-$((40+2))\n");
      await waitForText(id, "BEFORE-DROP-42");

      refuseConnections();
      await typeIn(id, "kill -9 $PPID\n");
      await navigateTo("connections");
      await waitForDrop();
      expect(await (await browser.$(sel.reconnectStatus)).isDisplayed()).toBe(false);
      expect(await (await browser.$(sel.confirmClosePane)).isExisting()).toBe(false);

      await click(sel.navTerminals);
      expect(await (await browser.$(sel.reconnectStatus)).isDisplayed()).toBe(true);

      await navigateTo("connections");
      allowConnections();
      await waitForText(id, RECONNECTED, 40_000);

      await click(sel.navTerminals);
      await (await browser.$(sel.reconnectStatus)).waitForExist({ reverse: true, timeout: 10_000 });
      const text = await textOf(id);
      expect(text.indexOf("BEFORE-DROP-42")).toBeGreaterThan(-1);
      expect(text.indexOf("BEFORE-DROP-42")).toBeLessThan(text.indexOf(RECONNECTED));
      await typeIn(id, "echo AFTER-DROP-$((40+2))\n");
      await waitForText(id, "AFTER-DROP-42");
    });

    it("asks about a shell that ended only once its terminal is back", async () => {
      await createConnectionA("conn-20-ended");
      const id = await openShell("conn-20-ended");
      await typeIn(id, "exec sh -c 'sleep 10'\n");
      await navigateTo("connections");

      await waitForText(id, CLOSED);
      await expectGone(sel.confirmClosePane);

      await click(sel.navTerminals);
      await (await browser.$(sel.confirmClosePane)).waitForExist({ timeout: 10_000 });
    });

    it("asks about each shell of a split that ended off screen, one after the other", async () => {
      await createConnectionA("conn-20-ended-one");
      await createConnectionA("conn-20-ended-two");
      const first = await openShell("conn-20-ended-one");
      await splitWith("conn-20-ended-two");
      const second = await secondPane(first);
      await typeIn(first, "exec sh -c 'sleep 10'\n");
      await typeIn(second, "exec sh -c 'sleep 10'\n");
      await navigateTo("connections");

      await waitForText(first, CLOSED);
      await waitForText(second, CLOSED);
      await expectGone(sel.confirmClosePane);

      await click(sel.navTerminals);
      const question = await browser.$(sel.confirmClosePane);
      await question.waitForExist({ timeout: 10_000 });
      expect(await textContentOf(question)).toContain("conn-20-ended-one");

      await clickDialogFooterButton(sel.confirmClosePaneCancel);
      await browser.waitUntil(
        async () => (await textContentOf(await browser.$(sel.confirmClosePane))).includes("conn-20-ended-two"),
        { timeout: 10_000, timeoutMsg: "The second shell's question never came" },
      );
      // A careless Enter must not answer it for the one just answered.
      await browser.waitUntil(
        () =>
          browser.execute(
            (selector: string) => document.activeElement === document.querySelector(selector),
            sel.confirmClosePaneCancel,
          ),
        { timeout: 10_000, timeoutMsg: "The next question did not start on Cancel" },
      );

      await clickDialogFooterButton(sel.confirmClosePaneConfirm);
      await browser.waitUntil(async () => (await sessionIds()).length === 1, {
        timeout: 10_000,
        timeoutMsg: "The second pane did not close",
      });
      expect(await sessionIds()).toEqual([first]);
      await expectGone(sel.confirmClosePane);
    });
  });

  describe("find", () => {
    it("finds in the terminal's scrollback, and hands the keyboard back", async () => {
      await createConnectionA("conn-20-find");
      const id = await openShell("conn-20-find");
      await typeIn(id, "for i in 1 2 3; do echo NEEDLE-$((40+i)); done\n");
      await waitForText(id, "NEEDLE-43");

      await findShortcut();
      await waitForSearchInputFocus();
      await press("NEEDLE-4");

      const first = await waitForSearchStatus(/^\d of 3$/);
      await browser.keys(["Enter"]);
      const second = await waitForSearchStatus(new RegExp(`^(?!${first}$)\\d of 3$`));
      await browser.keys(["Shift", "Enter"]);
      await waitForSearchStatus(new RegExp(`^${first}$`));
      await click(sel.terminalSearchNext);
      await waitForSearchStatus(new RegExp(`^${second}$`));
      await click(sel.terminalSearchPrevious);
      await waitForSearchStatus(new RegExp(`^${first}$`));

      await fill(sel.terminalSearchInput, "NO-SUCH-TEXT");
      await waitForSearchStatus(/^No matches$/);
      expect(await (await browser.$(sel.terminalSearchNext)).isEnabled()).toBe(false);

      // Asking again brings the keyboard back to a bar already open.
      await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
      await openFindThenEscape(id);
      await press("echo BACK-$((40+2))\n");
      await waitForText(id, "BACK-42");
    });

    it("keeps its shortcut from the program in the terminal, and leaves Ctrl+F to it", async () => {
      await createConnectionA("conn-20-find-key");
      const id = await openShell("conn-20-find-key");
      await typeIn(id, "cat -v\n");

      await openFindThenEscape(id);

      await press("MARK\n");
      await waitForText(id, "MARK\nMARK");
      expect(await textOf(id)).not.toContain("^F");
      expect(await textOf(id)).not.toContain("^[");

      await browser.keys(["Control", "f"]);
      await press("\n");
      await waitForText(id, "^F");
      await expectGone(sel.terminalSearch);
      await browser.keys(["Control", "d"]);
    });

    it("acts only on a terminal the user can see", async () => {
      await createConnectionA("conn-20-find-hidden");
      await openShell("conn-20-find-hidden");

      await findShortcut();
      await (await browser.$(sel.terminalSearch)).waitForExist({ timeout: 10_000 });
      await navigateTo("connections");
      await (await browser.$(sel.terminalSearch)).waitForExist({ reverse: true, timeout: 10_000 });

      await findShortcut();
      await expectGone(sel.terminalSearch);
      await click(sel.navTerminals);
      await expectGone(sel.terminalSearch);
    });
  });

  describe("links", () => {
    it("shows the real target of a hyperlink and asks before opening it", async () => {
      await createConnectionA("conn-20-osc8");
      const id = await openShell("conn-20-osc8");
      await printHyperlink(id, "https://real-target.example/path", "SAFE-LOOKING-TEXT");

      await mouseOnLine(id, "SAFE-LOOKING-TEXT", ["mousemove"]);
      const hint = await browser.$(sel.terminalLinkHint);
      await hint.waitForExist({ timeout: 10_000 });
      expect(await textContentOf(hint)).toContain("https://real-target.example/path");

      // A click alone does nothing.
      await mouseOnLine(id, "SAFE-LOOKING-TEXT", CLICK);
      await expectGone(sel.terminalLinkConfirm);

      await mouseOnLine(id, "SAFE-LOOKING-TEXT", CLICK, { ctrlKey: true });
      const confirm = await browser.$(sel.terminalLinkConfirm);
      await confirm.waitForExist({ timeout: 10_000 });
      expect(await textContentOf(await browser.$(sel.terminalLinkConfirmHost))).toBe(
        "real-target.example",
      );
      expect(await textContentOf(await browser.$(sel.terminalLinkConfirmUrl))).toBe(
        "https://real-target.example/path",
      );
      await clickDialogFooterButton(sel.terminalLinkConfirmCancel);
      await confirm.waitForExist({ reverse: true, timeout: 10_000 });

      await mouseOnLine(id, "SAFE-LOOKING-TEXT", ["mouseleave"]);
      await hint.waitForExist({ reverse: true, timeout: 10_000 });
    });

    it("offers nothing for a hyperlink to anything but http or https", async () => {
      await createConnectionA("conn-20-file-link");
      const id = await openShell("conn-20-file-link");
      await printHyperlink(id, "file:///etc/passwd", "FILE-LINK-TEXT");

      await mouseOnLine(id, "FILE-LINK-TEXT", ["mousemove"]);
      await expectGone(sel.terminalLinkHint);
      await mouseOnLine(id, "FILE-LINK-TEXT", CLICK, { ctrlKey: true });
      await expectGone(sel.terminalLinkConfirm);
    });

    it("finds a URL in the text, and asks when its user name reads like a host", async () => {
      await createConnectionA("conn-20-url");
      const id = await openShell("conn-20-url");
      const url = "https://bank.example@evil.example/login";
      await typeIn(id, `echo ${url}\n`);
      await waitForText(id, `\n${url}\n`);

      await mouseOnLine(id, url, ["mousemove"]);
      const hint = await browser.$(sel.terminalLinkHint);
      await hint.waitForExist({ timeout: 10_000 });
      expect(await textContentOf(hint)).toContain(url);

      await mouseOnLine(id, url, CLICK);
      await expectGone(sel.terminalLinkConfirm);

      await mouseOnLine(id, url, CLICK, { ctrlKey: true });
      await (await browser.$(sel.terminalLinkConfirm)).waitForExist({ timeout: 10_000 });
      expect(await textContentOf(await browser.$(sel.terminalLinkConfirmHost))).toBe("evil.example");
      await clickDialogFooterButton(sel.terminalLinkConfirmCancel);
    });
  });

  describe("broadcast input", () => {
    const toggle = () => click(sel.broadcastToggle);

    /** Two panes in one tab: `a` on server-a, which can be dropped, `b` on server-b. */
    async function openSplit(suffix: string): Promise<[string, string]> {
      await createDroppableConnection(`conn-20-cast-a-${suffix}`);
      await createDirectConnection({
        name: `conn-20-cast-b-${suffix}`,
        host: TARGETS.b.host,
        port: TARGETS.b.sshPort,
        credentialName: CREDENTIAL_B,
      });
      await openShell(`conn-20-cast-a-${suffix}`);
      await splitWith(`conn-20-cast-b-${suffix}`);
      await waitForTerminalContains(PROMPT_B);
      const ids = await sessionIds();
      expect(ids).toHaveLength(2);
      return [ids[0], ids[1]];
    }

    /** Lose pane `a`'s connection for good, leaving broadcast as it was. */
    async function dropPane(a: string): Promise<void> {
      refuseConnections();
      await toggle();
      await typeIn(a, "kill -9 $PPID\n");
      await waitForDrop();
      await toggle();
    }

    it("is off by default, and on sends what is typed in either pane to both", async () => {
      const [a, b] = await openSplit("both");

      /** Run a command in pane `from`, and see it answer there and in `to`, or only there. */
      async function echoFrom(from: string, tag: string, to: string, reachesTo: boolean) {
        await typeIn(from, `echo ${tag}-$((40+2))\n`);
        await waitForText(from, `${tag}-42`);
        if (reachesTo) {
          await waitForText(to, `${tag}-42`);
        } else {
          await browser.pause(SETTLE_MS);
          expect(await textOf(to)).not.toContain(`${tag}-`);
        }
      }
      const toggleState = async (pressed: string, indicator: boolean) => {
        expect(await (await browser.$(sel.broadcastToggle)).getAttribute("aria-pressed")).toBe(pressed);
        expect(await (await browser.$(sel.broadcastIndicator)).isDisplayed()).toBe(indicator);
      };

      await toggleState("false", false);
      await echoFrom(a, "SOLO", b, false);

      await toggle();
      await toggleState("true", true);
      await waitForToggleLabel("Broadcasting to 2 of 2 panes");
      await echoFrom(a, "FROM-A", b, true);
      await echoFrom(b, "FROM-B", a, true);

      await toggle();
      await waitForToggleLabel("Broadcast input");
      await toggleState("false", false);
      await echoFrom(a, "SOLO-AGAIN", b, false);
    });

    it("runs nothing of a paste in a pane that has not asked for bracketed paste", async () => {
      const [a, b] = await openSplit("paste");
      // Only `a` asks for it, and only `cat` reads there: nothing can run in `a`.
      await typeIn(a, "printf '\\033[?2004h'\n");
      await browser.waitUntil(async () => (await stateOf(a)).bracketedPaste, {
        timeout: 10_000,
        timeoutMsg: "Bracketed paste never turned on",
      });
      await typeIn(a, "cat\n");
      await toggle();
      const pasteInA = (text: string) =>
        browser.execute(
          (sessionId: string, pasted: string) => {
            window.dispatchEvent(
              new CustomEvent("ssix:terminal-paste", { detail: { text: pasted, sessionId } }),
            );
          },
          a,
          text,
        );

      await pasteInA("echo FIRST-$((40+2))\necho SECOND-$((40+2))");
      await waitForText(a, "SECOND");
      const skipped = await browser.$(sel.broadcastSkipped);
      await browser.waitUntil(
        async () => (await textContentOf(skipped)).includes("conn-20-cast-b-paste"),
        { timeout: 10_000, timeoutMsg: "Nothing said the paste did not reach the other pane" },
      );
      await browser.pause(SETTLE_MS);
      expect(await textOf(b)).not.toContain("FIRST");

      // One line goes as text, with no markers, and waits for Enter.
      await pasteInA("echo ALONE-$((40+2))");
      await waitForText(b, "echo ALONE-$((40+2))");
      await browser.pause(SETTLE_MS);
      expect(await textOf(b)).not.toContain("ALONE-42");
      expect(await textOf(b)).not.toContain("200~");
      expect(await textContentOf(skipped)).toBe("");

      await typeIn(b, "\n");
      await waitForText(b, "ALONE-42");
    });

    it("does not mirror what describes one pane, such as a focus report", async () => {
      const [a, b] = await openSplit("focus");

      // `a` reports focus changes; `cat -v` in `b` would show one that arrived.
      await typeIn(a, "printf '\\033[?1004h'\n");
      await typeIn(b, "cat -v\n");

      await toggle();
      await typeIn(a, "MARK\n");
      await waitForText(b, "MARK\nMARK");
      await typeIn(b, "\n");
      const text = await textOf(b);
      expect(text).not.toContain("^[[I");
      expect(text).not.toContain("^[[O");
    });

    it("sends nothing to a pane that lost its connection, even after it returns", async () => {
      const [a, b] = await openSplit("drop");
      await toggle();
      await dropPane(a);
      await waitForToggleLabel("Broadcasting to 1 of 2 panes");

      await typeIn(b, "echo WHILE-DROPPED-$((40+2))\n");
      await waitForText(b, "WHILE-DROPPED-42");

      allowConnections();
      await waitForText(a, RECONNECTED, 40_000);
      await (await browser.$(sel.reconnectStatus)).waitForExist({ reverse: true, timeout: 10_000 });
      await waitForToggleLabel("Broadcasting to 2 of 2 panes");

      await typeIn(b, "echo RETURNED-$((40+2))\n");
      await waitForText(a, "RETURNED-42");
      expect(await textOf(a)).not.toContain("WHILE-DROPPED-");
    });

    it("goes off when closing a pane leaves one", async () => {
      const [a] = await openSplit("close");
      await toggle();
      await dropPane(a);

      // A pane offers to close only once it has stopped trying to reconnect.
      await click(sel.reconnectCancelButton);
      await (await browser.$(sel.reconnectStatusPhase("stopped"))).waitForExist({ timeout: 10_000 });
      await click(sel.failedTerminalDismiss);
      await browser.waitUntil(
        async () => {
          const confirm = await browser.$(sel.confirmClosePane);
          if (await confirm.isExisting()) await clickDialogFooterButton(sel.confirmClosePaneConfirm);
          return (await sessionIds()).length === 1;
        },
        { timeout: 10_000, timeoutMsg: "The pane did not close" },
      );

      const button = await browser.$(sel.broadcastToggle);
      expect(await button.getAttribute("aria-pressed")).toBe("false");
      expect(await button.isEnabled()).toBe(false);
      await expectGone(sel.broadcastIndicator);
    });
  });

  describe("the snippet palette beside a pane that lost its connection", () => {
    async function openPalette(): Promise<void> {
      await click(sel.snippetPaletteButton);
      await (await browser.$(sel.snippetPalette)).waitForExist({ timeout: 10_000 });
    }

    async function closePalette(): Promise<void> {
      await browser.keys(["Escape"]);
      await (await browser.$(sel.snippetPalette)).waitForExist({ reverse: true, timeout: 10_000 });
    }

    it("says why when no pane can take text", async () => {
      await createDroppableConnection("conn-20-paste-lost");
      const id = await openShell("conn-20-paste-lost");
      refuseConnections();
      await typeIn(id, "kill -9 $PPID\n");
      await waitForDrop();

      await openPalette();
      expect(await textContentOf(await browser.$(sel.snippetPaletteError))).toContain(
        "lost its connection",
      );
      await closePalette();
    });

    it("targets the healthy pane, though the other one had the keyboard", async () => {
      await createDroppableConnection("conn-20-paste-dropped");
      await createConnectionA("conn-20-paste-healthy");
      const first = await openShell("conn-20-paste-dropped");
      await splitWith("conn-20-paste-healthy");
      await secondPane(first);
      refuseConnections();
      await typeIn(first, "kill -9 $PPID\n");
      await waitForDrop();

      await openPalette();
      expect(await textContentOf(await browser.$(sel.snippetPaletteTarget))).toContain(
        "conn-20-paste-healthy",
      );
      expect(await (await browser.$(sel.snippetPaletteError)).isExisting()).toBe(false);
      await closePalette();
    });
  });

  describe("a connection's look", () => {
    it("takes the connection's font and colours, and follows an edit", async () => {
      await createConnectionA("conn-20-look", async () => {
        await reveal(sel.connectionFormColorScheme);
        await pickOption(sel.connectionFormColorScheme, "Dracula");
        await pickOption(sel.connectionFormFontSize, "18px");
      });
      const id = await openShell("conn-20-look");
      const opened = await stateOf(id);
      expect(opened.background).toBe("#282a36");
      expect(opened.fontSize).toBe(18);

      await openConnectionEditor("conn-20-look");
      await reveal(sel.connectionFormColorScheme);
      expect(await textContentOf(await browser.$(sel.connectionFormColorScheme))).toContain("Dracula");
      await pickOption(sel.connectionFormColorScheme, "Nord");
      await pickOption(sel.connectionFormFontSize, "12px");
      await saveConnectionForm();

      // Off screen, colours change at once and the font waits to be measured.
      await browser.waitUntil(async () => (await stateOf(id)).background === "#2e3440", {
        timeout: 10_000,
        timeoutMsg: "The saved scheme did not reach the open terminal",
      });
      expect((await stateOf(id)).fontSize).toBe(18);
      expect((await stateOf(id)).cols).toBe(opened.cols);

      await click(sel.navTerminals);
      await browser.waitUntil(async () => (await stateOf(id)).fontSize === 12, {
        timeout: 10_000,
        timeoutMsg: "The saved font did not reach the terminal when it came back",
      });
      // Smaller letters fit more of them, and the shell is told.
      await browser.waitUntil(async () => (await stateOf(id)).cols > opened.cols, {
        timeout: 10_000,
        timeoutMsg: "The terminal did not refit to its new font",
      });
      const { cols, rows } = await stateOf(id);
      await typeIn(id, "echo SIZE=$(stty size | tr ' ' x)\n");
      await waitForText(id, `SIZE=${rows}x${cols}`);
    });

    it("goes back to the app's colours when the scheme is cleared", async () => {
      await createConnectionA("conn-20-clear", async () => {
        await reveal(sel.connectionFormColorScheme);
        await pickOption(sel.connectionFormColorScheme, "Nord");
      });
      const id = await openShell("conn-20-clear");
      expect((await stateOf(id)).background).toBe("#2e3440");

      await openConnectionEditor("conn-20-clear");
      await reveal(sel.connectionFormColorScheme);
      await pickOption(sel.connectionFormColorScheme, "Follow the app theme");
      await saveConnectionForm();

      await browser.waitUntil(
        async () => APP_BACKGROUNDS.includes((await stateOf(id)).background ?? ""),
        { timeout: 10_000, timeoutMsg: "The terminal kept the cleared scheme" },
      );
    });

    it("opens a terminal with a stored scheme it does not know, and refuses only to save it", async () => {
      const name = "conn-20-retired";
      await createConnectionA(name);

      // As left by a build that had this palette.
      const dataFile = join(dataDir(), "data.json");
      const stored = () =>
        JSON.parse(readFileSync(dataFile, "utf8")) as {
          connections: { name: string; color_scheme?: string }[];
        };
      const data = stored();
      const connection = data.connections.find((candidate) => candidate.name === name);
      if (!connection) throw new Error(`${name} is not in data.json`);
      connection.color_scheme = "retired-palette";
      writeFileSync(dataFile, JSON.stringify(data, null, 2));
      await browser.refresh();
      await waitForAppReady();

      const id = await openShell(name);
      expect(APP_BACKGROUNDS).toContain((await stateOf(id)).background);

      await openConnectionEditor(name);
      const fieldError = await browser.$(sel.connectionFormColorSchemeError);
      await fieldError.waitForExist({ timeout: 10_000 });
      expect(await textContentOf(fieldError)).toContain("no longer available");

      await clickDialogFooterButton(sel.connectionFormSubmit);
      const formError = await browser.$(sel.connectionFormError);
      await formError.waitForExist({ timeout: 10_000 });
      expect(await textContentOf(formError)).toContain("Unknown color scheme");
      expect(await (await browser.$(sel.connectionForm)).isExisting()).toBe(true);

      await reveal(sel.connectionFormColorScheme);
      await pickOption(sel.connectionFormColorScheme, "Dracula");
      await saveConnectionForm();
      expect(stored().connections.find((candidate) => candidate.name === name)?.color_scheme).toBe(
        "dracula",
      );
    });
  });
});
