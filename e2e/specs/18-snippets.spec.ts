/**
 * Spec 18: save snippets and paste them into a real shell.
 *
 * The first test runs before any terminal is open: the palette must explain
 * that instead of failing silently. The next saves, edits and deletes snippets
 * and checks what reaches `data.json`.
 *
 * The rest paste into server-a. Its shell is BusyBox ash, which has no
 * bracketed paste, so a line break really would run a line: a paste that ran
 * anything shows up as output before the test presses Enter. A multi-line
 * snippet is refused there. The last test asks the terminal for bracketed
 * paste and runs `cat`, whose tty echo shows the markers it received.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { waitForAppReady } from "../helpers/app.js";
import { currentTestDataDir } from "../helpers/data-dir.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import {
  click,
  clickDialogFooterButton,
  connectToConnection,
  createDirectConnection,
  createPasswordCredential,
  fill,
  pressPaletteShortcut,
  readTerminalText,
  textContentOf,
  waitForGone,
  waitForTerminalContains,
} from "../helpers/flows.js";
import { sel } from "../helpers/selectors.js";

/** Long enough for a stray line to run and print. */
const QUIET_MS = 1_500;

async function openSnippetsView(): Promise<void> {
  await click(sel.navSnippets);
  await (await browser.$(sel.addSnippetButton)).waitForExist({ timeout: 10_000 });
}

/** WebKit's WebDriver drops "\n" from typed text, so press Enter between lines. */
async function saveSnippet(name: string, lines: string[]): Promise<void> {
  await openSnippetsView();
  await click(sel.addSnippetButton);
  const form = await browser.$(sel.snippetForm);
  await form.waitForExist({ timeout: 10_000 });
  await fill(sel.snippetFormName, name);
  await fill(sel.snippetFormCommand, lines[0]);
  const command = await browser.$(sel.snippetFormCommand);
  for (const line of lines.slice(1)) {
    await browser.keys(["Enter"]);
    if (line) await command.addValue(line);
  }
  await clickDialogFooterButton(sel.snippetFormSubmit);
  await waitForGone(sel.snippetForm);
  await (await browser.$(sel.snippetRowByName(name))).waitForExist({ timeout: 10_000 });
}

async function snippetRowButton(name: string, button: string): Promise<WebdriverIO.Element> {
  const row = await browser.$(sel.snippetRowByName(name));
  await row.waitForExist({ timeout: 10_000 });
  return row.$(button);
}

function savedSnippets(): { id: string; name: string; command: string; tags?: string[] }[] {
  const dir = currentTestDataDir();
  if (!dir) throw new Error("SSIX_DATA_DIR is not set");
  return JSON.parse(readFileSync(join(dir, "data.json"), "utf8")).snippets;
}

/** Open the palette the way a user does: from the keyboard, inside the terminal. */
async function openPaletteFromTerminal(): Promise<void> {
  await (await browser.$(sel.terminalContainer)).click();
  await pressPaletteShortcut();
}

/** In the open palette: filter to one snippet. */
async function filterTo(name: string): Promise<void> {
  await fill(sel.snippetPaletteSearch, name);
  await (await browser.$(sel.snippetPaletteOptionByName(name))).waitForExist({ timeout: 10_000 });
}

/** In the open palette: filter to one snippet and choose it from the keyboard. */
async function choose(name: string): Promise<void> {
  await filterTo(name);
  await browser.keys(["Enter"]);
}

/** Press or release a real Enter, without doing the other, unlike `browser.keys`. */
async function realEnter(action: "keyDown" | "keyUp"): Promise<void> {
  await browser.performActions([
    { type: "key", id: "held-enter", actions: [{ type: action, value: "\uE007" }] },
  ]);
}

async function waitForPaletteClosed(): Promise<void> {
  await waitForGone(sel.snippetPalette);
}

/** How many terminals are on screen: they stay mounted while another view is. */
async function panesOnScreen(): Promise<number> {
  return browser.execute(
    (selector: string) =>
      Array.from(document.querySelectorAll(selector)).filter((pane) => pane.getClientRects().length > 0)
        .length,
    sel.terminalContainer,
  );
}

/** The text of each open pane, in the order they are mounted. */
async function paneTexts(): Promise<string[]> {
  return browser.execute(
    (selector: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(selector)).map(
        (pane) => window.__ssixTerminalText?.(pane.dataset.sessionId) ?? "",
      ),
    sel.terminalContainer,
  );
}

async function waitForPane(index: number, text: string): Promise<void> {
  await browser.waitUntil(async () => (await paneTexts())[index]?.includes(text) ?? false, {
    timeout: 30_000,
    timeoutMsg: `pane ${index} never showed ${text}`,
  });
}

/** An auto-repeat of Enter at whatever has the keyboard. WebDriver's own keys never repeat. */
async function enterRepeat(): Promise<void> {
  await browser.execute(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

async function expectNotInTerminal(text: string): Promise<void> {
  await browser.pause(QUIET_MS);
  expect(await readTerminalText()).not.toContain(text);
}

describe("Snippets", () => {
  before(async () => {
    await waitForServers(["a"]);
    await waitForAppReady();
  });

  it("explains that there is no terminal to paste into", async () => {
    await saveSnippet("snip-18-alone", ["uptime"]);
    await pressPaletteShortcut();
    const error = await browser.$(sel.snippetPaletteError);
    await error.waitForExist({ timeout: 10_000 });
    expect(await textContentOf(error)).toContain("no live terminal");

    await choose("snip-18-alone");
    await browser.pause(500);
    expect(await (await browser.$(sel.snippetPalette)).isExisting()).toBe(true);
    expect(await textContentOf(await browser.$(sel.snippetPaletteError))).toContain(
      "no live terminal",
    );

    await browser.keys(["Escape"]);
    await waitForPaletteClosed();
  });

  it("saves, refuses a duplicate, edits and deletes", async () => {
    await openSnippetsView();
    await click(sel.addSnippetButton);
    const form = await browser.$(sel.snippetForm);
    await form.waitForExist({ timeout: 10_000 });

    const notice = await textContentOf(await browser.$(sel.snippetFormGitSyncNotice));
    expect(notice).toContain("Git Sync exports snippets exactly as written");

    await fill(sel.snippetFormName, "  snip-18-crud  ");
    await fill(sel.snippetFormCommand, "tail -f {{file}} {{file}}");
    await browser.waitUntil(
      async () =>
        (await textContentOf(await browser.$(sel.snippetFormVariables))).includes(
          "Asks for: file",
        ),
      { timeout: 5_000, timeoutMsg: "the form never listed the variable" },
    );
    const tags = await browser.$(sel.snippetFormTags);
    await tags.click();
    await tags.setValue("logs-18");
    await browser.keys(["Enter"]);
    await clickDialogFooterButton(sel.snippetFormSubmit);
    await waitForGone(sel.snippetForm);

    const row = await browser.$(sel.snippetRowByName("snip-18-crud"));
    await row.waitForExist({ timeout: 10_000 });
    expect(await textContentOf(row)).toContain("logs-18");
    const saved = savedSnippets().find((s) => s.name === "snip-18-crud");
    expect(saved?.command).toBe("tail -f {{file}} {{file}}");
    expect(saved?.tags).toEqual(["logs-18"]);
    expect(saved?.id).toMatch(/^[0-9a-f-]{36}$/);

    // The same name again is refused, and the form stays open to say so.
    await click(sel.addSnippetButton);
    await form.waitForExist({ timeout: 10_000 });
    await fill(sel.snippetFormName, "snip-18-crud");
    await fill(sel.snippetFormCommand, "uptime");
    await clickDialogFooterButton(sel.snippetFormSubmit);
    const error = await browser.$(sel.snippetFormError);
    await error.waitForExist({ timeout: 10_000 });
    expect(await textContentOf(error)).toContain("already exists");

    // The fields survived the refusal, so another name is all it takes.
    await fill(sel.snippetFormName, "snip-18-crud-2");
    await clickDialogFooterButton(sel.snippetFormSubmit);
    await (await browser.$(sel.snippetRowByName("snip-18-crud-2"))).waitForExist({
      timeout: 10_000,
    });
    expect(savedSnippets().find((s) => s.name === "snip-18-crud-2")?.command).toBe("uptime");

    await (await snippetRowButton("snip-18-crud", sel.snippetRowEdit)).click();
    await form.waitForExist({ timeout: 10_000 });
    await fill(sel.snippetFormCommand, "tail -n 5 {{file}}");
    await clickDialogFooterButton(sel.snippetFormSubmit);
    await waitForGone(sel.snippetForm);
    await browser.waitUntil(
      async () => (await textContentOf(row)).includes("tail -n 5 {{file}}"),
      { timeout: 10_000, timeoutMsg: "the row never showed the edit" },
    );
    expect(savedSnippets().find((s) => s.id === saved?.id)?.command).toBe("tail -n 5 {{file}}");

    for (const name of ["snip-18-crud", "snip-18-crud-2"]) {
      await (await snippetRowButton(name, sel.snippetRowDelete)).click();
      await clickDialogFooterButton(sel.snippetDeleteConfirm);
      await waitForGone(sel.snippetRowByName(name));
      expect(savedSnippets().map((s) => s.name)).not.toContain(name);
    }
  });

  it("pastes into the active pane and leaves running it to the user", async () => {
    await createPasswordCredential({
      name: "cred-18-a",
      username: TARGETS.a.user,
      password: TARGETS.a.password,
    });
    await createDirectConnection({
      name: "conn-18-a",
      host: TARGETS.a.host,
      port: TARGETS.a.sshPort,
      credentialName: "cred-18-a",
    });
    await saveSnippet("snip-18-calc", ["echo calc-$((6*7))"]);

    await connectToConnection("conn-18-a");
    await waitForTerminalContains("server-a:~$", 30_000);

    await openPaletteFromTerminal();
    expect(await textContentOf(await browser.$(sel.snippetPaletteTarget))).toContain("conn-18-a");
    await choose("snip-18-calc");
    await waitForPaletteClosed();

    await waitForTerminalContains("echo calc-$((6*7))", 10_000);
    await expectNotInTerminal("calc-42");

    // The palette gave the keyboard back, so this Enter goes to the shell.
    await browser.keys(["Enter"]);
    await waitForTerminalContains("calc-42", 10_000);
  });

  it("goes to the terminal when opened from another view", async () => {
    await saveSnippet("snip-18-away", ["echo away-$((3*3))"]);
    await click(sel.snippetPaletteButton);
    await (await browser.$(sel.snippetPalette)).waitForExist({ timeout: 10_000 });
    await browser.waitUntil(async () => (await panesOnScreen()) === 1, {
      timeout: 10_000,
      timeoutMsg: "the terminal never came on screen",
    });
    expect(await textContentOf(await browser.$(sel.snippetPaletteTarget))).toContain("conn-18-a");
    expect(await (await browser.$(sel.snippetPaletteError)).isExisting()).toBe(false);

    await choose("snip-18-away");
    await waitForPaletteClosed();
    await waitForTerminalContains("echo away-$((3*3))", 10_000);
    await expectNotInTerminal("away-9");
    await browser.keys(["Enter"]);
    await waitForTerminalContains("away-9", 10_000);
  });

  it("drops the newline at the end of a saved snippet", async () => {
    await saveSnippet("snip-18-newline", ["echo newline-$((5*5))", ""]);
    expect(savedSnippets().find((s) => s.name === "snip-18-newline")?.command).toBe(
      "echo newline-$((5*5))\n",
    );
    await pressPaletteShortcut();
    await choose("snip-18-newline");
    await waitForPaletteClosed();
    await waitForTerminalContains("echo newline-$((5*5))", 10_000);
    await expectNotInTerminal("newline-25");
    await browser.keys(["Enter"]);
    await waitForTerminalContains("newline-25", 10_000);
  });

  it("asks for each variable once and pastes the values", async () => {
    await saveSnippet("snip-18-vars", ["echo {{who}}-{{who}}-{{ place }}"]);
    await pressPaletteShortcut();
    await choose("snip-18-vars");

    const preview = await browser.$(sel.snippetVariablesPreview);
    await preview.waitForExist({ timeout: 10_000 });
    expect((await browser.$$(sel.snippetVariable)).length).toBe(2);
    await fill(sel.snippetVariableByName("who"), "ann");
    await fill(sel.snippetVariableByName("place"), "paris");
    expect(await textContentOf(preview)).toBe("echo ann-ann-paris");
    await click(sel.snippetVariablesSubmit);
    await waitForPaletteClosed();

    await waitForTerminalContains("echo ann-ann-paris", 10_000);
    await browser.pause(QUIET_MS);
    expect(await readTerminalText()).not.toContain("\nann-ann-paris");
    await browser.keys(["Enter"]);
    await waitForTerminalContains("\nann-ann-paris", 10_000);
  });

  it("pastes an unclosed {{ and other tools' templates as written", async () => {
    await saveSnippet("snip-18-literal", ["echo '{{.Names}} {{open'"]);
    await pressPaletteShortcut();
    await choose("snip-18-literal");
    await waitForPaletteClosed();
    await waitForTerminalContains("echo '{{.Names}} {{open'", 10_000);
    await browser.keys(["Enter"]);
    await waitForTerminalContains("\n{{.Names}} {{open", 10_000);
  });

  it("does not run the command while the Enter that chose it is held down", async () => {
    await saveSnippet("snip-18-held", ["echo held-$((4*4))"]);
    await click(sel.navTerminals);
    await openPaletteFromTerminal();
    await filterTo("snip-18-held");

    await realEnter("keyDown");
    await waitForPaletteClosed();
    await waitForTerminalContains("echo held-$((4*4))", 10_000);
    for (let i = 0; i < 5; i++) await enterRepeat();
    await expectNotInTerminal("held-16");

    // Once released, the same event reaches the shell, so the wait above proved something.
    await realEnter("keyUp");
    await browser.releaseActions();
    await enterRepeat();
    await waitForTerminalContains("held-16", 10_000);
  });

  it("keeps a backslash in front of a variable when it is doubled", async () => {
    await saveSnippet("snip-18-path", ["echo 'C:\\Users\\\\{{user}}\\Docs' '\\{{end}}'"]);
    await pressPaletteShortcut();
    await choose("snip-18-path");

    const preview = await browser.$(sel.snippetVariablesPreview);
    await preview.waitForExist({ timeout: 10_000 });
    expect((await browser.$$(sel.snippetVariable)).length).toBe(1);
    await fill(sel.snippetVariableByName("user"), "ann");
    await click(sel.snippetVariablesSubmit);
    await waitForPaletteClosed();

    await waitForTerminalContains("echo 'C:\\Users\\ann\\Docs' '{{end}}'", 10_000);
    await browser.keys(["Enter"]);
  });

  it("refuses several lines where a line break would run them", async () => {
    await saveSnippet("snip-18-lines", ["echo multi-$((1+1))", "echo multi-$((2+2))"]);
    await click(sel.navTerminals);
    await openPaletteFromTerminal();
    await choose("snip-18-lines");
    const error = await browser.$(sel.snippetPaletteError);
    await error.waitForExist({ timeout: 10_000 });
    expect(await textContentOf(error)).toContain("several lines");
    expect(await (await browser.$(sel.snippetPalette)).isExisting()).toBe(true);

    await browser.keys(["Escape"]);
    await waitForPaletteClosed();
    await expectNotInTerminal("multi-");
  });

  it("keeps keys out of a terminal clicked while the palette is open", async () => {
    await openPaletteFromTerminal();
    // The panel sits beside the terminal: a click there retargets it and moves the focus.
    await (await browser.$(sel.terminalContainer)).click();
    await browser.keys(["l", "e", "a", "k", "e", "d", "Enter"]);
    await browser.keys(["Escape"]);
    await waitForPaletteClosed();
    await expectNotInTerminal("leaked");
  });

  it("refuses a tab where the shell would read it as a completion", async () => {
    await openSnippetsView();
    await click(sel.addSnippetButton);
    await fill(sel.snippetFormName, "snip-18-tab");
    // WebDriver's Tab moves the focus. Users get a tab into the form by pasting one.
    await browser.execute(
      (selector: string, value: string) => {
        const area = document.querySelector<HTMLTextAreaElement>(selector)!;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
          area,
          value,
        );
        area.dispatchEvent(new Event("input", { bubbles: true }));
      },
      sel.snippetFormCommand,
      "echo tabbed\tword",
    );
    await clickDialogFooterButton(sel.snippetFormSubmit);
    await waitForGone(sel.snippetForm);
    expect(savedSnippets().find((s) => s.name === "snip-18-tab")?.command).toBe(
      "echo tabbed\tword",
    );

    await click(sel.navTerminals);
    await openPaletteFromTerminal();
    await choose("snip-18-tab");
    const error = await browser.$(sel.snippetPaletteError);
    await error.waitForExist({ timeout: 10_000 });
    expect(await textContentOf(error)).toContain("has a tab");

    await browser.keys(["Escape"]);
    await waitForPaletteClosed();
    await expectNotInTerminal("tabbed");
  });

  // It leaves this terminal asking for bracketed paste, which ash cannot read,
  // so the tests after it use panes of their own.
  it("sends several lines as a bracketed paste when the program asks for one", async () => {
    await saveSnippet("snip-18-bracket", ["printf '\\033[?2004h'; cat"]);
    await click(sel.navTerminals);
    await openPaletteFromTerminal();
    await choose("snip-18-bracket");
    await waitForPaletteClosed();
    await waitForTerminalContains("2004h", 10_000);
    await browser.keys(["Enter"]);
    await browser.pause(500);

    await openPaletteFromTerminal();
    await choose("snip-18-lines");
    await waitForPaletteClosed();

    // `cat` reads the tty, which echoes ESC as ^[ and turns the CR into a new line.
    await waitForTerminalContains("^[[200~echo multi-$((1+1))", 10_000);
    await waitForTerminalContains("echo multi-$((2+2))^[[201~", 10_000);

    // `cat` printed the first line back but not the second, whose line never
    // ended: the paste added no line break. And nothing ran: no `multi-2`.
    await browser.pause(QUIET_MS);
    const text = await readTerminalText();
    expect(text.split("echo multi-$((1+1))").length - 1).toBe(2);
    expect(text.split("echo multi-$((2+2))").length - 1).toBe(1);
    expect(text).not.toContain("multi-2");
    expect(text).not.toContain("multi-4");

    await browser.keys(["Control", "c"]);
  });

  it("returns to the pane that last had focus after another view", async () => {
    for (const name of ["conn-18-b", "conn-18-c"]) {
      await createDirectConnection({
        name,
        host: TARGETS.a.host,
        port: TARGETS.a.sshPort,
        credentialName: "cred-18-a",
      });
    }
    await connectToConnection("conn-18-b");
    await waitForPane(1, "server-a:~$");
    await click(sel.terminalNewMenu);
    await click(sel.terminalSplitRight);
    await click(sel.connectPickerOption("conn-18-c"));
    await waitForPane(2, "server-a:~$");

    // The second pane takes the keyboard, then another view takes the screen.
    await (await browser.$$(sel.terminalContainer))[2].click();
    await saveSnippet("snip-18-pane", ["echo pane-$((8*8))"]);
    expect(await panesOnScreen()).toBe(0);

    await pressPaletteShortcut();
    await browser.waitUntil(
      async () =>
        (await textContentOf(await browser.$(sel.snippetPaletteTarget))).includes("conn-18-c"),
      { timeout: 10_000, timeoutMsg: "the palette did not name the pane that last had focus" },
    );
    await choose("snip-18-pane");
    await waitForPaletteClosed();
    await waitForPane(2, "echo pane-$((8*8))");
    expect((await paneTexts())[1]).not.toContain("pane-");
  });

  it("opens only once an editor with unsaved changes lets the view change", async () => {
    await openSnippetsView();
    await click(sel.addSnippetButton);
    await (await browser.$(sel.snippetForm)).waitForExist({ timeout: 10_000 });
    await fill(sel.snippetFormName, "snip-18-unsaved");

    await browser.keys(["Control", "Shift", "s"]);
    await (await browser.$(sel.snippetDiscardCancel)).waitForExist({ timeout: 10_000 });
    expect(await (await browser.$(sel.snippetPalette)).isExisting()).toBe(false);

    // Keep editing: the form stays, on its view, and no palette opens behind it.
    await click(sel.snippetDiscardCancel);
    await waitForGone(sel.snippetDiscardCancel);
    expect(await (await browser.$(sel.snippetPalette)).isExisting()).toBe(false);
    expect(await (await browser.$(sel.snippetFormName)).getValue()).toBe("snip-18-unsaved");
    expect(await panesOnScreen()).toBe(0);

    await browser.keys(["Control", "Shift", "s"]);
    await click(sel.snippetDiscardConfirm);
    await (await browser.$(sel.snippetPalette)).waitForExist({ timeout: 10_000 });
    await browser.waitUntil(async () => (await panesOnScreen()) === 2, {
      timeout: 10_000,
      timeoutMsg: "the terminals never came back",
    });
    await waitForGone(sel.snippetForm);

    await browser.keys(["Escape"]);
    await waitForPaletteClosed();
  });

  it("follows a change of tab, keeping the keyboard and dropping a refusal", async () => {
    await pressPaletteShortcut();
    await choose("snip-18-lines");
    await (await browser.$(sel.snippetPaletteError)).waitForExist({ timeout: 10_000 });

    // From inside the page, like a shortcut: WebDriver's click would focus the tab itself.
    await clickDialogFooterButton(sel.terminalTabByName("conn-18-a"));
    await waitForGone(sel.snippetPaletteError);
    expect(await textContentOf(await browser.$(sel.snippetPaletteTarget))).toContain("conn-18-a");

    // A terminal that becomes visible takes focus after a short delay, if it may.
    await browser.pause(QUIET_MS);
    const focused = await browser.execute(
      () => document.activeElement?.getAttribute("data-testid") ?? null,
    );
    expect(focused).toBe("snippet-palette-search");

    await browser.keys(["Escape"]);
    await waitForPaletteClosed();
  });
});
