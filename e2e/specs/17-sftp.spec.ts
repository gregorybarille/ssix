/**
 * Spec 17: the Files view (SFTP), direct and through a jump host.
 *
 * Two panes against server-a: folder and file operations, transfers both
 * ways (with overwrite, drag and cancel), recursive delete past a symlink,
 * and edit in place with a change on the server. Local paths are shared with
 * the app, which runs on the same machine as this runner.
 *
 * An external editor cannot be driven from here, so the edit tests write to
 * the temporary copy the panel names, as an editor would. Files dropped from
 * the desktop cannot be simulated through WebDriver either; unit tests cover
 * that path.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForAppReady } from "../helpers/app.js";
import { currentTestDataDir } from "../helpers/data-dir.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import {
  click,
  createDirectConnection,
  createPasswordCredential,
  ensureConnectionRowsLayout,
  fill,
  navigateTo,
  pickOption,
  saveConnectionForm,
  textContentOf,
} from "../helpers/flows.js";
import { sel } from "../helpers/selectors.js";

type Side = "local" | "remote";

const SPARSE_BYTES = 2 * 1024 * 1024 * 1024;
const REMOTE_DIR = `ssix-17-${process.pid}`;

let workDir: string;
let uploads: string;
let downloads: string;

async function paneIs(side: Side, path: string): Promise<void> {
  const pane = await browser.$(sel.filesPane(side));
  await browser.waitUntil(async () => (await pane.getAttribute("data-path")) === path, {
    timeout: 30_000,
    timeoutMsg: `The ${side} pane never reached ${path}`,
  });
}

async function panePath(side: Side): Promise<string> {
  const pane = await browser.$(sel.filesPane(side));
  await browser.waitUntil(async () => Boolean(await pane.getAttribute("data-path")), {
    timeout: 30_000,
    timeoutMsg: `The ${side} pane never listed a folder`,
  });
  return (await pane.getAttribute("data-path")) ?? "";
}

async function goTo(side: Side, path: string): Promise<void> {
  await fill(sel.filesPath(side), path);
  await browser.keys(["Enter"]);
  await paneIs(side, path);
}

async function refreshPane(side: Side): Promise<void> {
  await click(sel.filesRefresh(side));
}

async function rowAppears(side: Side, name: string): Promise<WebdriverIO.Element> {
  const row = await browser.$(sel.fileRow(side, name));
  await row.waitForExist({ timeout: 30_000, timeoutMsg: `No row ${name} in the ${side} pane` });
  return row;
}

/**
 * Wait for no node to match, asked in one script: finding a node through the
 * driver fails with a stale element if it goes while the handle is being made.
 */
async function nothingMatches(selector: string, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(
    () => browser.execute((s: string) => document.querySelector(s) === null, selector),
    { timeout: 30_000, timeoutMsg },
  );
}

async function rowGoes(side: Side, name: string): Promise<void> {
  await nothingMatches(sel.fileRow(side, name), `Row ${name} stayed`);
}

/** The names the pane lists now, hidden ones included. */
async function rowNames(side: Side): Promise<string[]> {
  return browser.execute(
    (pane: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(`${pane} [data-testid="file-row"]`)).map(
        (row) => row.dataset.name ?? "",
      ),
    sel.filesPane(side),
  );
}

/** Pick only this row; rows sit in an overflow list, so go through the page. */
async function pick(side: Side, name: string): Promise<void> {
  const row = await rowAppears(side, name);
  await row.scrollIntoView({ block: "center" });
  await row.click();
  await browser.waitUntil(async () => (await row.getAttribute("aria-current")) === "true", {
    timeout: 5_000,
    timeoutMsg: `Row ${name} was never selected`,
  });
}

async function openFolder(side: Side, name: string): Promise<void> {
  const before = await panePath(side);
  await pick(side, name);
  await browser.keys(["Enter"]);
  await paneIs(side, `${before === "/" ? "" : before}/${name}`);
}

async function waitForTransfer(name: string, status: string): Promise<void> {
  const row = await browser.$(sel.filesTransferRow(name, status));
  await row.waitForExist({
    timeout: 120_000,
    timeoutMsg: `Transfer ${name} never reached ${status}`,
  });
}

async function clearTransfers(): Promise<void> {
  const clear = await browser.$('[data-testid="files-transfers-clear"]');
  if (await clear.isExisting()) await clear.click();
  await nothingMatches('[data-testid="files-transfer"]', "The finished transfers stayed listed");
}

async function copyAndFinish(side: Side, name: string): Promise<void> {
  await pick(side, name);
  await click(sel.filesTransfer(side));
  await waitForTransfer(name, "done");
  await clearTransfers();
}

/** Bring a file down to a fresh folder and return its bytes. */
async function downloaded(name: string): Promise<Buffer> {
  const home = await panePath("local");
  const dir = mkdtempSync(join(downloads, "get-"));
  await goTo("local", dir);
  await copyAndFinish("remote", name);
  await goTo("local", home);
  return readFileSync(join(dir, name));
}

async function makeFolder(side: Side, name: string): Promise<void> {
  await click(sel.filesMkdir(side));
  await fill(sel.filesNameInput, name);
  await click(sel.filesNameSubmit);
  await rowAppears(side, name);
}

async function backToFiles(): Promise<void> {
  await click(sel.navFiles);
  await (await browser.$(sel.filesPane("remote"))).waitForExist({ timeout: 10_000 });
}

/**
 * Run a line of shell on server-a, as a saved script: the Files view cannot
 * make a symlink, and a script takes the line whole where a terminal takes it
 * one key at a time.
 */
async function onServer(name: string, line: string): Promise<void> {
  await navigateTo("scripts");
  await click(sel.addScriptButton);
  const form = await browser.$(sel.scriptForm);
  await form.waitForExist({ timeout: 10_000 });
  await fill(sel.scriptFormName, name);
  await fill(sel.scriptFormBody, line);
  await click(sel.scriptFormSubmit);
  await form.waitForExist({ reverse: true, timeout: 10_000 });
  const row = await browser.$(sel.scriptRowByName(name));
  await row.waitForExist({ timeout: 10_000 });
  await (await row.$(sel.scriptRowSelect)).click();
  await click(sel.scriptHostByName("conn-17-a"));
  await click(sel.scriptRun);
  const done = await browser.$(`${sel.scriptResultByName("conn-17-a")}[data-status="success"]`);
  await done.waitForExist({ timeout: 30_000, timeoutMsg: `The server never ran: ${line}` });
  await backToFiles();
}

/** Fail unless nothing but `expected` is in the folder: no partials. */
function expectExactly(dir: string, expected: string[]): void {
  expect(readdirSync(dir).sort()).toEqual([...expected].sort());
}

/** The temporary copy the open edit panel names. */
let tempPath = "";

async function changeCopy(content: string): Promise<void> {
  writeFileSync(tempPath, content);
  const save = await browser.$(sel.filesEditSave);
  await save.waitForClickable({
    timeout: 15_000,
    timeoutMsg: "Upload never became available after the copy changed",
  });
}

async function waitForUploaded(): Promise<void> {
  const status = await browser.$(sel.filesEditStatus);
  await browser.waitUntil(async () => (await status.getText()).startsWith("Uploaded"), {
    timeout: 30_000,
    timeoutMsg: "The edit was never uploaded",
  });
}

describe("Files view (SFTP)", () => {
  before(async () => {
    await waitForServers(["a"]);
    workDir = realpathSync(mkdtempSync(join(tmpdir(), "ssix-17-")));
    uploads = join(workDir, "uploads");
    downloads = join(workDir, "downloads");
    mkdirSync(uploads);
    mkdirSync(downloads);

    await waitForAppReady();
    await createPasswordCredential({
      name: "cred-17-a",
      username: TARGETS.a.user,
      password: TARGETS.a.password,
    });
    await createDirectConnection({
      name: "conn-17-a",
      host: TARGETS.a.host,
      port: TARGETS.a.sshPort,
      credentialName: "cred-17-a",
    });
  });

  after(async () => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("opens a connection from its Browse files row action", async () => {
    await navigateTo("connections");
    await ensureConnectionRowsLayout();
    const row = await browser.$(sel.connectionRowByName("conn-17-a"));
    await row.waitForExist({ timeout: 10_000 });
    await row.moveTo();
    const browse = await row.$(sel.browseFilesButton);
    await browse.waitForClickable({ timeout: 10_000 });
    await browse.click();

    const status = await browser.$(sel.filesStatus);
    await browser.waitUntil(async () => (await status.getAttribute("data-state")) === "connected", {
      timeout: 60_000,
      timeoutMsg: "The Files view never connected",
    });
    expect(await panePath("remote")).toMatch(/^\//);
    expect(await panePath("local")).toMatch(/^\//);
  });

  it("offers neither the row action nor the picker for a forward", async () => {
    await navigateTo("connections");
    await click(sel.addConnectionButton);
    await fill(sel.connectionFormName, "forward-17");
    await click(sel.connectionFormKindLocalForward);
    await fill(sel.connectionFormHopHost, TARGETS.a.host);
    await fill(sel.connectionFormHopPort, String(TARGETS.a.sshPort));
    await pickOption(sel.connectionFormHopCredential, "cred-17-a");
    await fill(sel.connectionFormTargetHost, "server-c");
    await fill(sel.connectionFormTargetPort, "22");
    await fill(sel.connectionFormLocalPort, "23417");
    await saveConnectionForm();

    await navigateTo("forwards");
    const forwardRow = await browser.$(sel.forwardRowByName("forward-17"));
    await forwardRow.waitForExist({ timeout: 10_000 });
    expect(await (await forwardRow.$(sel.browseFilesButton)).isExisting()).toBe(false);

    // Wherever else a forward is listed, it has no such action either.
    await navigateTo("connections");
    const browseOnForward = await browser.execute(
      (button: string) => document.querySelector(`[data-name="forward-17"] ${button}`) !== null,
      sel.browseFilesButton,
    );
    expect(browseOnForward).toBe(false);

    await backToFiles();
    await click(sel.filesConnectionSelect);
    const listed = await browser.$('[role="option"][data-name="conn-17-a"]');
    await listed.waitForExist({ timeout: 10_000 });
    const forward = await browser.$('[role="option"][data-name="forward-17"]');
    expect(await forward.isExisting()).toBe(false);
    await browser.keys(["Escape"]);
  });

  it("creates, renames and changes the mode of a folder", async () => {
    await makeFolder("remote", REMOTE_DIR);
    await makeFolder("remote", `${REMOTE_DIR}-old`);

    await pick("remote", `${REMOTE_DIR}-old`);
    await click(sel.filesRename("remote"));
    await fill(sel.filesNameInput, `${REMOTE_DIR}-new`);
    await click(sel.filesNameSubmit);
    await rowAppears("remote", `${REMOTE_DIR}-new`);
    await rowGoes("remote", `${REMOTE_DIR}-old`);

    await pick("remote", `${REMOTE_DIR}-new`);
    await click(sel.filesChmod("remote"));
    await fill(sel.filesChmodInput, "750");
    await click(sel.filesChmodSubmit);
    const row = await rowAppears("remote", `${REMOTE_DIR}-new`);
    await browser.waitUntil(async () => (await row.getAttribute("data-mode")) === "750", {
      timeout: 15_000,
      timeoutMsg: "The mode never changed",
    });
  });

  it("refuses a mode that is not octal", async () => {
    await pick("remote", `${REMOTE_DIR}-new`);
    await click(sel.filesChmod("remote"));
    await fill(sel.filesChmodInput, "999");
    await click(sel.filesChmodSubmit);
    const dialog = await browser.$('[data-testid="files-chmod-dialog"] [role="alert"]');
    await dialog.waitForExist({ timeout: 10_000 });
    expect(await dialog.getText()).toContain("octal");
    await browser.keys(["Escape"]);
    const row = await rowAppears("remote", `${REMOTE_DIR}-new`);
    expect(await row.getAttribute("data-mode")).toBe("750");
  });

  it("uploads and downloads a file byte for byte", async () => {
    await openFolder("remote", REMOTE_DIR);
    const payload = Buffer.from([0, 1, 2, 255, 10, 13, 10, 0, 7]);
    writeFileSync(join(uploads, "round.bin"), payload);
    await goTo("local", uploads);

    await copyAndFinish("local", "round.bin");
    await rowAppears("remote", "round.bin");
    expect((await downloaded("round.bin")).equals(payload)).toBe(true);
  });

  it("asks before replacing, and leaves the file alone on no", async () => {
    writeFileSync(join(uploads, "round.bin"), "second version\n");
    await pick("local", "round.bin");
    await click(sel.filesTransfer("local"));
    const cancel = await browser.$(sel.filesOverwriteCancel);
    await cancel.waitForClickable({ timeout: 30_000 });
    await cancel.click();
    await cancel.waitForExist({ timeout: 10_000, reverse: true });
    expect((await downloaded("round.bin")).toString()).not.toContain("second version");

    await pick("local", "round.bin");
    await click(sel.filesTransfer("local"));
    await click(sel.filesOverwriteConfirm);
    await waitForTransfer("round.bin", "done");
    await clearTransfers();
    expect((await downloaded("round.bin")).toString()).toBe("second version\n");
  });

  it("copies a folder, skipping the symlinks inside it", async () => {
    const tree = join(uploads, "tree");
    mkdirSync(join(tree, "inner"), { recursive: true });
    writeFileSync(join(tree, "inner", "deep.txt"), "deep\n");
    writeFileSync(join(workDir, "outside.txt"), "outside\n");
    symlinkSync(join(workDir, "outside.txt"), join(tree, "link.txt"));
    await refreshPane("local");

    await copyAndFinish("local", "tree");
    await openFolder("remote", "tree");
    await rowAppears("remote", "inner");
    expect(await rowNames("remote")).toEqual(["inner"]);
    await openFolder("remote", "inner");
    await rowAppears("remote", "deep.txt");
    await click(sel.filesUp("remote"));
    await rowAppears("remote", "inner");
    await click(sel.filesUp("remote"));
    await rowAppears("remote", "tree");
  });

  it("copies by dragging a row onto the other pane", async () => {
    writeFileSync(join(uploads, "dragged.txt"), "dragged\n");
    await refreshPane("local");
    const row = await rowAppears("local", "dragged.txt");
    await row.scrollIntoView({ block: "center" });
    const target = await browser.$('[data-testid="files-list-remote"]');
    const from = await browser.execute(
      (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) };
      },
      row as unknown as HTMLElement,
    );
    const to = await browser.execute(
      (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom - 10) };
      },
      target as unknown as HTMLElement,
    );
    await browser
      .action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ x: from.x, y: from.y })
      .down({ button: 0 })
      .move({ x: from.x + 20, y: from.y + 4, duration: 100 })
      .move({ x: to.x, y: to.y, duration: 200 })
      .up({ button: 0 })
      .perform();

    await waitForTransfer("dragged.txt", "done");
    await clearTransfers();
    await rowAppears("remote", "dragged.txt");
    expect((await downloaded("dragged.txt")).toString()).toBe("dragged\n");
  });

  it("cancels an upload and leaves nothing on the server", async () => {
    const big = join(uploads, "big-up.bin");
    writeFileSync(big, "");
    truncateSync(big, SPARSE_BYTES);
    await refreshPane("local");

    await pick("local", "big-up.bin");
    await click(sel.filesTransfer("local"));
    const running = await browser.$(sel.filesTransferRow("big-up.bin", "running"));
    await running.waitForExist({ timeout: 30_000 });
    await click(sel.filesTransferCancel);
    await waitForTransfer("big-up.bin", "cancelled");
    await clearTransfers();

    await refreshPane("remote");
    await browser.waitUntil(
      async () => {
        const names = await rowNames("remote");
        return !names.includes("big-up.bin") && !names.some((n) => n.startsWith(".ssix-part-"));
      },
      { timeout: 15_000, timeoutMsg: "A cancelled upload left a file on the server" },
    );
    rmSync(big);
    await refreshPane("local");
  });

  it("cancels a download and leaves no partial file, keeping the old one", async () => {
    // Large enough that cancelling beats the end of the copy.
    const seed = join(uploads, "big-down.bin");
    writeFileSync(seed, "");
    truncateSync(seed, SPARSE_BYTES / 2);
    await refreshPane("local");
    await copyAndFinish("local", "big-down.bin");
    await rowAppears("remote", "big-down.bin");
    rmSync(seed);
    await refreshPane("local");

    const home = await panePath("local");
    const dir = mkdtempSync(join(downloads, "cancel-"));
    await goTo("local", dir);
    await pick("remote", "big-down.bin");
    await click(sel.filesTransfer("remote"));
    const running = await browser.$(sel.filesTransferRow("big-down.bin", "running"));
    await running.waitForExist({ timeout: 30_000 });
    await click(sel.filesTransferCancel);
    await waitForTransfer("big-down.bin", "cancelled");
    await clearTransfers();
    expectExactly(dir, []);

    // Over an existing file, which must come through a cancel unchanged.
    writeFileSync(join(dir, "big-down.bin"), "previous\n");
    await refreshPane("local");
    await pick("remote", "big-down.bin");
    await click(sel.filesTransfer("remote"));
    await click(sel.filesOverwriteConfirm);
    const again = await browser.$(sel.filesTransferRow("big-down.bin", "running"));
    await again.waitForExist({ timeout: 30_000 });
    await click(sel.filesTransferCancel);
    await waitForTransfer("big-down.bin", "cancelled");
    await clearTransfers();
    expectExactly(dir, ["big-down.bin"]);
    expect(readFileSync(join(dir, "big-down.bin"), "utf8")).toBe("previous\n");

    await goTo("local", home);
    await pick("remote", "big-down.bin");
    await click(sel.filesDelete("remote"));
    await click(sel.filesDeleteConfirm);
    await rowGoes("remote", "big-down.bin");
  });

  it("deletes a folder on the server without following a symlink in it", async () => {
    const remoteDir = await panePath("remote");
    await onServer(
      "script-17-links",
      `mkdir -p ${remoteDir}/doomed/sub && echo keep > ${remoteDir}/keep.txt && ln -s ${remoteDir}/keep.txt ${remoteDir}/doomed/sub/link.txt && ln -s ${remoteDir} ${remoteDir}/doomed/up`,
    );
    await refreshPane("remote");
    await rowAppears("remote", "doomed");

    await pick("remote", "doomed");
    await click(sel.filesDelete("remote"));
    await click(sel.filesDeleteConfirm);
    await rowGoes("remote", "doomed");
    await rowAppears("remote", "keep.txt");
    expect((await downloaded("keep.txt")).toString()).toBe("keep\n");
  });

  it("deletes a local folder without following a symlink in it", async () => {
    const kept = join(workDir, "kept");
    mkdirSync(kept);
    writeFileSync(join(kept, "file.txt"), "kept\n");
    mkdirSync(join(uploads, "doomed-local"));
    symlinkSync(kept, join(uploads, "doomed-local", "link"));
    await refreshPane("local");

    await pick("local", "doomed-local");
    await click(sel.filesDelete("local"));
    await click(sel.filesDeleteConfirm);
    await rowGoes("local", "doomed-local");
    expect(existsSync(join(uploads, "doomed-local"))).toBe(false);
    expect(readFileSync(join(kept, "file.txt"), "utf8")).toBe("kept\n");
  });

  it("edit in place: downloads a private copy and uploads the changes when asked", async () => {
    writeFileSync(join(uploads, "conf.txt"), "original\n");
    chmodSync(join(uploads, "conf.txt"), 0o640);
    await refreshPane("local");
    await copyAndFinish("local", "conf.txt");
    await rowAppears("remote", "conf.txt");

    await pick("remote", "conf.txt");
    await click(sel.filesEdit);
    const panel = await browser.$(sel.filesEditPanel);
    await panel.waitForExist({ timeout: 30_000 });
    tempPath = (await panel.getAttribute("data-temp-path")) ?? "";
    expect(readFileSync(tempPath, "utf8")).toBe("original\n");
    expect(statSync(tempPath).mode & 0o777).toBe(0o600);

    await changeCopy("edited\n");
    await click(sel.filesEditSave);
    await waitForUploaded();
  });

  it("edit in place: asks when the server's file changed, and keeps it on no", async () => {
    // Someone else changes the file: here, a copy from the other pane.
    writeFileSync(join(uploads, "conf.txt"), "from the server\n");
    await pick("local", "conf.txt");
    await click(sel.filesTransfer("local"));
    await click(sel.filesOverwriteConfirm);
    await waitForTransfer("conf.txt", "done");
    await clearTransfers();

    await changeCopy("edited again\n");
    await click(sel.filesEditSave);
    const conflict = await browser.$(sel.filesEditConflict);
    await conflict.waitForExist({ timeout: 30_000 });
    await click(sel.filesEditConflictCancel);
    await conflict.waitForExist({ timeout: 10_000, reverse: true });
    expect(readFileSync(tempPath, "utf8")).toBe("edited again\n");
  });

  it("edit in place: overwrites only after the user says so", async () => {
    await click(sel.filesEditSave);
    await click(sel.filesEditConflictConfirm);
    await waitForUploaded();
  });

  it("edit in place: removes the temporary copy on close", async () => {
    await click(sel.filesEditClose);
    await nothingMatches(sel.filesEditPanel, "The edit panel stayed open");
    await browser.waitUntil(async () => !existsSync(tempPath), {
      timeout: 10_000,
      timeoutMsg: "The temporary copy outlived the edit",
    });
    expect((await downloaded("conf.txt")).toString()).toBe("edited again\n");
  });

  it("removes its work from the server", async () => {
    await click(sel.filesUp("remote"));
    await rowAppears("remote", REMOTE_DIR);
    await pick("remote", REMOTE_DIR);
    await click(sel.filesDelete("remote"));
    await click(sel.filesDeleteConfirm);
    await rowGoes("remote", REMOTE_DIR);
    await pick("remote", `${REMOTE_DIR}-new`);
    await click(sel.filesDelete("remote"));
    await click(sel.filesDeleteConfirm);
    await rowGoes("remote", `${REMOTE_DIR}-new`);
  });

  it("refuses a changed host key until the user trusts the new one", async () => {
    const dataDir = currentTestDataDir();
    if (!dataDir) throw new Error("SSIX_DATA_DIR is not set; cannot change a known_hosts entry");
    const knownHosts = join(dataDir, "known_hosts");
    const { host, sshPort } = TARGETS.a;
    const entry = sshPort === 22 ? host : `[${host}]:${sshPort}`;
    const before = readFileSync(knownHosts, "utf8");
    // The key this server was seen with, one bit different.
    const changed = before.split("\n").map((line) => {
      const [name, algorithm, key] = line.split(" ");
      if (name !== entry || !key) return line;
      const blob = Buffer.from(key, "base64");
      blob[blob.length - 1] ^= 1;
      return `${name} ${algorithm} ${blob.toString("base64")}`;
    });
    expect(changed.join("\n")).not.toBe(before);
    writeFileSync(knownHosts, changed.join("\n"));

    await click(sel.filesDisconnect);
    await pickOption(sel.filesConnectionSelect, "conn-17-a");
    const error = await browser.$(sel.filesConnectError);
    await error.waitForExist({ timeout: 60_000 });
    expect(await error.getText()).toContain("has changed");
    const status = await browser.$(sel.filesStatus);
    expect(await status.getAttribute("data-state")).toBe("idle");

    await click(sel.filesTrustHostKey);
    await browser.waitUntil(async () => (await status.getAttribute("data-state")) === "connected", {
      timeout: 60_000,
      timeoutMsg: "Trusting the new key never connected",
    });
    expect(await error.isExisting()).toBe(false);
  });

  it("browses and transfers through a jump host", async () => {
    await createPasswordCredential({
      name: "cred-17-c",
      username: TARGETS.c.user,
      password: TARGETS.c.password,
    });
    await navigateTo("connections");
    await click(sel.addConnectionButton);
    await fill(sel.connectionFormName, "jump-17-c");
    await click(sel.connectionFormKindJumpHost);
    await fill(sel.connectionFormHopHost, TARGETS.a.host);
    await fill(sel.connectionFormHopPort, String(TARGETS.a.sshPort));
    await pickOption(sel.connectionFormHopCredential, "cred-17-a");
    await fill(sel.connectionFormTargetHost, "server-c");
    await fill(sel.connectionFormTargetPort, "22");
    await pickOption(sel.connectionFormTargetCredential, "cred-17-c");
    await saveConnectionForm();

    await backToFiles();
    await pickOption(sel.filesConnectionSelect, "jump-17-c");
    const status = await browser.$(sel.filesStatus);
    await browser.waitUntil(
      async () =>
        (await status.getAttribute("data-state")) === "connected" &&
        (await textContentOf(status)).includes("server-c"),
      { timeout: 60_000, timeoutMsg: "The jump host connection never opened" },
    );
    await panePath("remote");

    await makeFolder("remote", REMOTE_DIR);
    await openFolder("remote", REMOTE_DIR);
    writeFileSync(join(uploads, "via-jump.txt"), "via the jump host\n");
    await goTo("local", uploads);
    await copyAndFinish("local", "via-jump.txt");
    await rowAppears("remote", "via-jump.txt");
    expect((await downloaded("via-jump.txt")).toString()).toBe("via the jump host\n");

    await click(sel.filesUp("remote"));
    await rowAppears("remote", REMOTE_DIR);
    await pick("remote", REMOTE_DIR);
    await click(sel.filesDelete("remote"));
    await click(sel.filesDeleteConfirm);
    await rowGoes("remote", REMOTE_DIR);

    await click(sel.filesDisconnect);
    await browser.waitUntil(
      async () => (await status.getAttribute("data-state")) === "idle",
      { timeout: 10_000, timeoutMsg: "The Files view never disconnected" },
    );
  });
});
