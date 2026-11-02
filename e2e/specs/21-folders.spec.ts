/**
 * Spec 21: Folders.
 *
 * Connections filed from the form show in a tree of nested folders, which
 * opens and closes by click and by keyboard and remembers it, opens for a
 * search, takes a connection by drag or from the keyboard, and renames and
 * deletes a folder in one go. Port forwards stay out of the tree but keep
 * following their folder. Everything that changes is also read back from
 * `data.json`, since that is what Git Sync and backups carry.
 *
 * Other specs leave connections behind, all in no folder: this one looks at
 * its own folders and searches its own names when it needs them all on screen.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitForAppReady } from "../helpers/app.js";
import { currentTestDataDir } from "../helpers/data-dir.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import {
  click,
  clickDialogFooterButton,
  closeAllTabs,
  createDirectConnection,
  createPasswordCredential,
  ensureConnectionRowsLayout,
  fill,
  navigateTo,
  pickOption,
  saveConnectionForm,
  textContentOf,
  typeIntoTerminal,
  waitForTerminalContains,
} from "../helpers/flows.js";
import { sel } from "../helpers/selectors.js";

const CREDENTIAL = "cred-21-folders";
const WEB = "conn-21-web";
const DB = "conn-21-db";
const LOOSE = "conn-21-loose";
const TUNNEL = "conn-21-tunnel";
/** All of the names above, and nothing another spec created. */
const OWN_NAMES = "conn-21-";

const PROD = "e2e21-prod";
const EU = `${PROD}/eu`;
const LIVE = "e2e21-live";

interface StoredData {
  connections: { name: string; folder?: string | null }[];
  settings: { connection_layout: string };
}

function dataFile(): string {
  const dir = currentTestDataDir();
  if (!dir) throw new Error("SSIX_DATA_DIR is not set");
  return join(dir, "data.json");
}

const readStored = () => JSON.parse(readFileSync(dataFile(), "utf8")) as StoredData;

function storedFolder(name: string): string | null {
  const found = readStored().connections.find((c) => c.name === name);
  if (!found) throw new Error(`No stored connection is named ${name}`);
  return found.folder ?? null;
}

const waitForStoredFolder = (name: string, folder: string | null) =>
  browser.waitUntil(() => storedFolder(name) === folder, {
    timeout: 10_000,
    timeoutMsg: `${name} should be stored in ${folder ?? "no folder"}`,
  });

const rowOf = (name: string) => browser.$(sel.connectionRowByName(name));
const folderOf = (path: string) => browser.$(sel.folderRow(path));

const waitForRow = async (name: string) =>
  (await rowOf(name)).waitForExist({ timeout: 10_000 });
const waitForNoRow = async (name: string) =>
  (await rowOf(name)).waitForExist({ reverse: true, timeout: 10_000 });

async function showTree(): Promise<void> {
  await navigateTo("connections");
  await click(sel.layoutToggleFolders);
  await (await browser.$(sel.folderTree)).waitForExist({ timeout: 10_000 });
}

const countOf = async (path: string) =>
  textContentOf(await (await folderOf(path)).$(sel.folderCount));

const levelOf = async (name: string) => (await rowOf(name)).getAttribute("aria-level");

const waitForExpanded = (path: string, expanded: boolean) =>
  browser.waitUntil(
    async () => (await (await folderOf(path)).getAttribute("aria-expanded")) === String(expanded),
    { timeout: 10_000, timeoutMsg: `${path} should be ${expanded ? "open" : "closed"}` },
  );

/** Focus a tree row, as the arrow keys or a click on it would leave it. */
const focusRow = async (selector: string) =>
  browser.execute((s: string) => document.querySelector<HTMLElement>(s)?.focus(), selector);

const waitForFocusOn = (selector: string) =>
  browser.waitUntil(
    () => browser.execute((s: string) => document.activeElement?.matches(s) ?? false, selector),
    { timeout: 10_000, timeoutMsg: `Focus should be on ${selector}` },
  );

/** A point on a row's name, clear of the buttons at its other end. */
const grabPoint = (selector: string) =>
  browser.execute((s: string) => {
    const element = document.querySelector<HTMLElement>(s);
    if (!element) throw new Error(`Nothing matches ${s}`);
    element.scrollIntoView({ block: "nearest" });
    const box = element.getBoundingClientRect();
    return { x: Math.round(box.left + 30), y: Math.round(box.top + box.height / 2) };
  }, selector);

async function dragRow(from: string, to: string): Promise<void> {
  const start = await grabPoint(from);
  const end = await grabPoint(to);
  await browser
    .action("pointer", { parameters: { pointerType: "mouse" } })
    .move({ x: start.x, y: start.y })
    .down({ button: 0 })
    .move({ x: start.x + 20, y: start.y + 4, duration: 100 })
    .move({ x: end.x, y: end.y, duration: 200 })
    .up({ button: 0 })
    .perform();
}

/** Type a path into a folder field that may sit below the fold of the form. */
async function fillFolderField(path: string): Promise<void> {
  const field = await browser.$(sel.connectionFormFolder);
  await field.waitForExist({ timeout: 10_000 });
  await field.scrollIntoView({ block: "center" });
  await fill(sel.connectionFormFolder, path);
}

async function openFolderDialog(path: string, button: string, opens: string): Promise<void> {
  const action = await (await folderOf(path)).$(button);
  await action.waitForClickable({ timeout: 10_000 });
  await action.click();
  await (await browser.$(opens)).waitForExist({ timeout: 10_000 });
}

const openRename = (path: string) => openFolderDialog(path, sel.folderRename, sel.folderRenameInput);
const openDelete = (path: string) => openFolderDialog(path, sel.folderDelete, sel.folderDeleteDialog);

async function closeRenameWithEscape(): Promise<void> {
  await browser.keys(["Escape"]);
  await (await browser.$(sel.folderRenameDialog)).waitForExist({ reverse: true, timeout: 10_000 });
}

const waitForTextIn = (selector: string, needle: string) =>
  browser.waitUntil(
    async () => {
      const element = await browser.$(selector);
      return (await element.isExisting()) && (await textContentOf(element)).includes(needle);
    },
    { timeout: 10_000, timeoutMsg: `${selector} should say ${needle}` },
  );

const createInFolder = (name: string, beforeSave?: () => Promise<void>) =>
  createDirectConnection({
    name,
    host: TARGETS.a.host,
    port: TARGETS.a.sshPort,
    credentialName: CREDENTIAL,
    beforeSave,
  });

describe("Folders", () => {
  before(async () => {
    await waitForServers(["a"]);
    await waitForAppReady();
    await createPasswordCredential({
      name: CREDENTIAL,
      username: TARGETS.a.user,
      password: TARGETS.a.password,
    });
  });

  after(async () => {
    await closeAllTabs();
    await navigateTo("connections");
    await click(sel.layoutToggleList);
  });

  describe("the form", () => {
    it("refuses a bad path inline and stores a good one in its one written form", async () => {
      await createInFolder(WEB, async () => {
        await fillFolderField("a/..");
        await waitForTextIn(sel.connectionFormFolderError, "cannot be named");
        await clickDialogFooterButton(sel.connectionFormSubmit);
        await waitForTextIn(sel.connectionFormError, "highlighted fields");

        await fillFolderField(` /${PROD}//eu/ `);
        await (await browser.$(sel.connectionFormFolderError)).waitForExist({
          reverse: true,
          timeout: 10_000,
        });
      });
      expect(storedFolder(WEB)).toBe(EU);
    });

    it("offers the folders that exist", async () => {
      await createInFolder(DB, async () => {
        await fillFolderField("e2e21");
        await click(sel.folderPickerOption(PROD));
        expect(await (await browser.$(sel.connectionFormFolder)).getValue()).toBe(PROD);
      });
      expect(storedFolder(DB)).toBe(PROD);
    });

    it("leaves a connection in no folder by default", async () => {
      await createInFolder(LOOSE);
      expect(storedFolder(LOOSE)).toBeNull();
    });

    it("does not offer the field for a forward, which keeps a folder it has", async () => {
      await navigateTo("connections");
      await click(sel.addConnectionButton);
      await fill(sel.connectionFormName, TUNNEL);
      await click(sel.connectionFormKindDirect);
      await fillFolderField(EU);

      await click(sel.connectionFormKindLocalForward);
      await (await browser.$(sel.connectionFormFolder)).waitForExist({
        reverse: true,
        timeout: 10_000,
      });
      await fill(sel.connectionFormHopHost, TARGETS.a.host);
      await fill(sel.connectionFormHopPort, String(TARGETS.a.sshPort));
      await pickOption(sel.connectionFormHopCredential, CREDENTIAL);
      await fill(sel.connectionFormTargetHost, "127.0.0.1");
      await fill(sel.connectionFormTargetPort, "22");
      await fill(sel.connectionFormLocalPort, "38921");
      await saveConnectionForm();
      expect(storedFolder(TUNNEL)).toBe(EU);
    });
  });

  describe("the tree", () => {
    it("is a stored layout that nests rows under counted folders", async () => {
      await showTree();
      await browser.waitUntil(() => readStored().settings.connection_layout === "folders", {
        timeout: 10_000,
        timeoutMsg: "save_settings should accept the folders layout for connections",
      });

      await waitForRow(WEB);
      // The forward filed under eu is neither a row nor counted.
      expect(await countOf(PROD)).toBe("2");
      expect(await countOf(EU)).toBe("1");
      expect(await levelOf(WEB)).toBe("3");
      expect(await levelOf(DB)).toBe("2");
      expect(await levelOf(LOOSE)).toBe("2");
      await (await browser.$(sel.folderNoFolder)).waitForExist({ timeout: 10_000 });
      expect(await (await rowOf(TUNNEL)).isExisting()).toBe(false);

      const clone = await (await rowOf(DB)).$(sel.connectionRowCloneButton);
      expect(await clone.isExisting()).toBe(true);
    });

    it("closes and opens by click, and remembers it", async () => {
      await showTree();
      await click(sel.folderRow(EU));
      await waitForExpanded(EU, false);
      await waitForNoRow(WEB);

      await click(sel.layoutToggleList);
      await (await browser.$(sel.connectionList)).waitForExist({ timeout: 10_000 });
      await waitForRow(WEB);
      await click(sel.layoutToggleFolders);
      await waitForExpanded(EU, false);
      await waitForNoRow(WEB);

      await browser.refresh();
      await waitForAppReady();
      await navigateTo("connections");
      await waitForExpanded(EU, false);

      await click(sel.folderRow(EU));
      await waitForExpanded(EU, true);
      await waitForRow(WEB);
    });

    it("walks by keyboard", async () => {
      await showTree();
      await focusRow(sel.folderRow(PROD));

      await browser.keys(["ArrowRight"]);
      await waitForFocusOn(sel.folderRow(EU));
      await browser.keys(["ArrowLeft"]);
      await waitForExpanded(EU, false);
      await waitForNoRow(WEB);
      await browser.keys(["ArrowRight"]);
      await waitForExpanded(EU, true);
      await browser.keys(["ArrowDown"]);
      await waitForFocusOn(sel.connectionRowByName(WEB));
      await browser.keys(["ArrowLeft"]);
      await waitForFocusOn(sel.folderRow(EU));
      await browser.keys(["Enter"]);
      await waitForExpanded(EU, false);
      await browser.keys(["Enter"]);
      await waitForExpanded(EU, true);
      await browser.keys(["Home"]);
      await waitForFocusOn(sel.folderRow(PROD));
    });

    it("opens a closed folder for a search, then gives its state back", async () => {
      await showTree();
      await click(sel.folderRow(PROD));
      await waitForExpanded(PROD, false);
      await waitForNoRow(WEB);

      await fill(sel.connectionSearchInput, WEB);
      await waitForRow(WEB);
      await waitForNoRow(DB);
      await (await browser.$(sel.folderNoFolder)).waitForExist({ reverse: true, timeout: 10_000 });
      expect(await countOf(PROD)).toBe("1");

      await click(sel.connectionSearchClear);
      await waitForExpanded(PROD, false);
      await waitForNoRow(WEB);
      expect(await countOf(PROD)).toBe("2");

      await click(sel.folderRow(PROD));
      await waitForExpanded(PROD, true);
    });

    it("connects from a row", async () => {
      await showTree();
      const connect = await (await rowOf(WEB)).$('[data-testid^="connect-button-"]');
      await connect.waitForClickable({ timeout: 10_000 });
      await connect.click();
      await waitForTerminalContains("server-a:~$", 30_000);
      await typeIntoTerminal("whoami\n");
      await waitForTerminalContains(TARGETS.a.user, 10_000);
      await closeAllTabs();
    });

    it("gives way to the list for whoever needs a row that is folded away", async () => {
      await showTree();
      await click(sel.folderRow(PROD));
      await waitForExpanded(PROD, false);
      await waitForNoRow(DB);

      // What spec 02 does to reach a row.
      await ensureConnectionRowsLayout();
      const clone = await (await rowOf(DB)).$(sel.connectionRowCloneButton);
      await clone.waitForClickable({ timeout: 10_000 });
      await clone.click();
      await (await browser.$(sel.connectionForm)).waitForExist({ timeout: 10_000 });
      await click(sel.connectionFormCancel);
      await (await browser.$(sel.connectionForm)).waitForExist({ reverse: true, timeout: 10_000 });

      await showTree();
      await click(sel.folderRow(PROD));
      await waitForExpanded(PROD, true);
    });
  });

  describe("moving a connection", () => {
    it("drags a row onto a folder without opening a session", async () => {
      await showTree();
      await fill(sel.connectionSearchInput, OWN_NAMES);
      await waitForRow(LOOSE);
      const tabs = await browser.$$(sel.terminalTabCloseAny).length;

      await dragRow(sel.connectionRowByName(LOOSE), sel.folderRow(EU));
      await waitForStoredFolder(LOOSE, EU);
      await browser.waitUntil(async () => (await levelOf(LOOSE)) === "3", {
        timeout: 10_000,
        timeoutMsg: "The row should sit under the folder it was dropped on",
      });

      expect(await browser.$$(sel.terminalTabCloseAny).length).toBe(tabs);
      await (await browser.$(sel.folderTree)).waitForDisplayed({ timeout: 10_000 });
      await click(sel.connectionSearchClear);
    });

    it("drags a row out of its folder", async () => {
      await showTree();
      await waitForRow(LOOSE);
      await dragRow(sel.connectionRowByName(LOOSE), sel.folderNoFolder);
      await waitForStoredFolder(LOOSE, null);
      await browser.waitUntil(async () => (await levelOf(LOOSE)) === "2", {
        timeout: 10_000,
        timeoutMsg: "The row should sit in the no-folder section",
      });
    });

    it("changes nothing when a drag ends back in the folder it started in", async () => {
      await showTree();
      await dragRow(sel.connectionRowByName(DB), sel.folderRow(PROD));
      await (await browser.$(sel.folderTree)).waitForDisplayed({ timeout: 10_000 });
      expect(storedFolder(DB)).toBe(PROD);
    });

    it("moves from the keyboard, and gives focus back", async () => {
      await showTree();
      await fill(sel.connectionSearchInput, OWN_NAMES);
      await waitForRow(LOOSE);
      await focusRow(sel.connectionRowByName(LOOSE));
      await browser.keys(["Shift", "F10"]);

      const item = await browser.$(sel.folderMoveMenuItem);
      await item.waitForExist({ timeout: 10_000 });
      await browser.execute((node: HTMLElement) => node.focus(), item as unknown as HTMLElement);
      await browser.keys(["Enter"]);

      await waitForFocusOn(sel.folderMoveInput);
      await fill(sel.folderMoveInput, PROD);
      await browser.keys(["Enter"]);
      await (await browser.$(sel.folderMoveDialog)).waitForExist({
        reverse: true,
        timeout: 10_000,
      });
      await waitForStoredFolder(LOOSE, PROD);
      await waitForFocusOn(sel.connectionRowByName(LOOSE));
      await click(sel.connectionSearchClear);
    });
  });

  describe("a folder", () => {
    it("refuses a rename into itself, and warns of a merge", async () => {
      await showTree();
      await openRename(PROD);
      await fill(sel.folderRenameInput, `${PROD}/inner`);
      await clickDialogFooterButton(sel.folderRenameSubmit);
      await waitForTextIn(sel.folderRenameError, "cannot move inside itself");
      expect(storedFolder(DB)).toBe(PROD);
      await closeRenameWithEscape();

      await openRename(EU);
      await fill(sel.folderRenameInput, PROD);
      await waitForTextIn(sel.folderRenamePreview, "merge");
      await closeRenameWithEscape();
    });

    it("renames in one go, subfolders and forwards included", async () => {
      await showTree();
      await openRename(PROD);
      await fill(sel.folderRenameInput, LIVE);
      await clickDialogFooterButton(sel.folderRenameSubmit);
      await (await folderOf(LIVE)).waitForExist({ timeout: 10_000 });
      await (await folderOf(PROD)).waitForExist({ reverse: true, timeout: 10_000 });

      expect(storedFolder(WEB)).toBe(`${LIVE}/eu`);
      expect(storedFolder(DB)).toBe(LIVE);
      expect(storedFolder(LOOSE)).toBe(LIVE);
      expect(storedFolder(TUNNEL)).toBe(`${LIVE}/eu`);
      await waitForRow(WEB);
    });

    it("deletes after saying how many it moves, and keeps every connection", async () => {
      await showTree();
      await openDelete(`${LIVE}/eu`);
      await waitForTextIn(sel.folderDeleteContents, "1 connection and 1 port forward");
      await waitForTextIn(sel.folderDeleteDialog, `to ${LIVE}.`);
      await clickDialogFooterButton(sel.folderDeleteConfirm);
      await (await folderOf(`${LIVE}/eu`)).waitForExist({ reverse: true, timeout: 10_000 });

      expect(storedFolder(WEB)).toBe(LIVE);
      expect(storedFolder(TUNNEL)).toBe(LIVE);
      await waitForRow(WEB);

      await openDelete(LIVE);
      await waitForTextIn(sel.folderDeleteContents, "3 connections and 1 port forward");
      await waitForTextIn(sel.folderDeleteDialog, "out of any folder");
      await clickDialogFooterButton(sel.folderDeleteConfirm);
      await (await folderOf(LIVE)).waitForExist({ reverse: true, timeout: 10_000 });

      for (const name of [WEB, DB, LOOSE, TUNNEL]) expect(storedFolder(name)).toBeNull();
      await waitForRow(DB);
    });

    it("leaves the forward in the Port Forwards view throughout", async () => {
      await navigateTo("forwards");
      await (await browser.$(sel.forwardRowByName(TUNNEL))).waitForExist({ timeout: 10_000 });
    });
  });

  describe("stored data from elsewhere", () => {
    it("repairs a path outside the rules instead of refusing to load", async () => {
      const data = readStored();
      const db = data.connections.find((c) => c.name === DB);
      if (!db) throw new Error(`No stored connection is named ${DB}`);
      db.folder = "e2e21-synced/../repaired";
      writeFileSync(dataFile(), JSON.stringify(data, null, 2));

      await browser.refresh();
      await waitForAppReady();
      await showTree();
      await (await folderOf("e2e21-synced/repaired")).waitForExist({ timeout: 10_000 });
      await waitForRow(DB);
      await (await browser.$(sel.connectionsLoadError)).waitForExist({
        reverse: true,
        timeout: 10_000,
      });
    });
  });
});
