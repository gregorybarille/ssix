/**
 * Spec 06: SCP upload + download round-trip against server-a.
 *
 * Writes a private fixture larger than one transfer chunk, uploads via SCP
 * dialog, downloads back to a separate local path, asserts byte-for-byte
 * equality and that the mode survived both directions. Then stops a transfer
 * of a big sparse file each way: what was at the target stays. A temporary file
 * left on the server is not visible from here; the live tests in
 * src-tauri/src/commands/scp/live_tests.rs cover that.
 */
import {
  writeFileSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  statSync,
  truncateSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForAppReady } from "../helpers/app.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import {
  createPasswordCredential,
  createDirectConnection,
  ensureConnectionRowsLayout,
} from "../helpers/flows.js";
import { sel } from "../helpers/selectors.js";

let workDir: string;
let upload: string;
let download: string;
// 128 KiB is the chunk size, so this takes several.
const PAYLOAD = Buffer.alloc(3 * 128 * 1024 + 5, "ssix-scp-roundtrip-payload\n");
// Unique, since a file that is already on the server would keep its own mode.
const REMOTE_NAME = `scp-06-${Date.now()}.bin`;
// Long enough to click Stop on, and sparse, so it costs no disk here.
const BIG_BYTES = 2 * 1024 * 1024 * 1024;

describe("SCP upload + download", () => {
  before(async () => {
    await waitForServers(["a"]);
    workDir = mkdtempSync(join(tmpdir(), "ssix-scp-"));
    upload = join(workDir, REMOTE_NAME);
    download = join(workDir, "download.bin");
    writeFileSync(upload, PAYLOAD, { mode: 0o600 });
  });
  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("uploads then downloads a file and gets identical bytes and mode back", async () => {
    await waitForAppReady();
    await createPasswordCredential({
      name: "cred-06-a",
      username: TARGETS.a.user,
      password: TARGETS.a.password,
    });
    await createDirectConnection({
      name: "conn-06-a",
      host: TARGETS.a.host,
      port: TARGETS.a.sshPort,
      credentialName: "cred-06-a",
    });

    await ensureConnectionRowsLayout();
    const row = await browser.$(sel.connectionRowByName("conn-06-a"));
    await row.waitForExist({ timeout: 10_000 });
    // SCP button lives in the row's `opacity-0 group-hover` action
    // cluster, so we have to hover before it becomes interactable.
    await row.moveTo();
    // Open SCP dialog via the per-row affordance.
    const scpBtn = await row.$('[data-testid^="scp-open-"]');
    await scpBtn.waitForClickable({ timeout: 10_000 });
    await scpBtn.click();

    const dialog = await browser.$(sel.scpDialog);
    await dialog.waitForExist({ timeout: 10_000 });

    // Upload phase. NOTE: SSIX's resolve_remote_target_path() always
    // appends the local file name to the remote_path argument
    // (treating it as a directory). So if local is /tmp/ssix-scp-XYZ/<name>
    // and remote_path is "/tmp/", the actual remote file is /tmp/<name>.
    await (await browser.$(sel.scpModeUpload)).click();
    await (await browser.$(sel.scpLocalPath)).setValue(upload);
    await (await browser.$(sel.scpRemotePath)).setValue("/tmp/");
    await (await browser.$(sel.scpUploadButton)).click();
    await waitForScpStatusOrFail("upload", upload);

    // Download phase. The remote file is at /tmp/<name> (SSIX
    // appended the source file name during upload). For download,
    // remote_path is the source file directly — resolve_download_remote_path
    // does not append anything.
    await (await browser.$(sel.scpModeDownload)).click();
    await (await browser.$(sel.scpLocalPath)).setValue(download);
    await (await browser.$(sel.scpRemotePath)).setValue(`/tmp/${REMOTE_NAME}`);
    await (await browser.$(sel.scpDownloadButton)).click();
    await waitForScpStatusOrFail("download", download);

    expect(readFileSync(download).equals(PAYLOAD)).toBe(true);
    expect(statSync(download).mode & 0o777).toBe(0o600);

    // `~` is the login folder, which SFTP alone would take as a plain name.
    const tildeName = `tilde-${REMOTE_NAME}`;
    const tildeUpload = join(workDir, tildeName);
    const tildeDownload = join(workDir, "tilde-download.bin");
    writeFileSync(tildeUpload, PAYLOAD);
    await (await browser.$(sel.scpModeUpload)).click();
    await (await browser.$(sel.scpLocalPath)).setValue(tildeUpload);
    await (await browser.$(sel.scpRemotePath)).setValue("~/");
    await (await browser.$(sel.scpUploadButton)).click();
    await waitForScpStatusOrFail("upload", tildeUpload);

    await (await browser.$(sel.scpModeDownload)).click();
    await (await browser.$(sel.scpLocalPath)).setValue(tildeDownload);
    await (await browser.$(sel.scpRemotePath)).setValue(`~/${tildeName}`);
    await (await browser.$(sel.scpDownloadButton)).click();
    await waitForScpStatusOrFail("download", tildeDownload);

    expect(readFileSync(tildeDownload).equals(PAYLOAD)).toBe(true);
  });

  it("stops an upload and a download midway and keeps what was at the target", async () => {
    // The dialog is still open from the test above. A small file first, for the
    // stopped upload to leave alone.
    const name = `stop-${REMOTE_NAME}`;
    const source = join(workDir, name);
    writeFileSync(source, "old on the server\n");
    await (await browser.$(sel.scpModeUpload)).click();
    await (await browser.$(sel.scpLocalPath)).setValue(source);
    await (await browser.$(sel.scpRemotePath)).setValue("/tmp/");
    await (await browser.$(sel.scpUploadButton)).click();
    await waitForScpStatusOrFail("upload", source);

    truncateSync(source, BIG_BYTES);
    await (await browser.$(sel.scpUploadButton)).click();
    await stopAndExpectStatus();

    // Nothing partial replaced it.
    const check = join(workDir, "stop-check.bin");
    await (await browser.$(sel.scpModeDownload)).click();
    await (await browser.$(sel.scpLocalPath)).setValue(check);
    await (await browser.$(sel.scpRemotePath)).setValue(`/tmp/${name}`);
    await (await browser.$(sel.scpDownloadButton)).click();
    await waitForScpStatusOrFail("download", check);
    expect(readFileSync(check, "utf8")).toBe("old on the server\n");

    // The whole file goes up, then comes back and stops, over a local file. It
    // stays in the fixture's /tmp until the containers go: SCP cannot delete it.
    const bigName = `stop-big-${REMOTE_NAME}`;
    const bigSource = join(workDir, bigName);
    writeFileSync(bigSource, "");
    truncateSync(bigSource, BIG_BYTES / 2);
    await (await browser.$(sel.scpModeUpload)).click();
    await (await browser.$(sel.scpLocalPath)).setValue(bigSource);
    await (await browser.$(sel.scpRemotePath)).setValue("/tmp/");
    await (await browser.$(sel.scpUploadButton)).click();
    await waitForScpStatusOrFail("upload", bigSource, 300_000);

    const dropDir = mkdtempSync(join(workDir, "stop-down-"));
    const kept = join(dropDir, "kept.bin");
    writeFileSync(kept, "old here\n");
    await (await browser.$(sel.scpModeDownload)).click();
    await (await browser.$(sel.scpLocalPath)).setValue(kept);
    await (await browser.$(sel.scpRemotePath)).setValue(`/tmp/${bigName}`);
    await (await browser.$(sel.scpDownloadButton)).click();
    await stopAndExpectStatus();

    expect(readFileSync(kept, "utf8")).toBe("old here\n");
    expect(readdirSync(dropDir)).toEqual(["kept.bin"]);
  });
});

async function stopAndExpectStatus(): Promise<void> {
  const stop = await browser.$(sel.scpStop);
  await stop.waitForClickable({ timeout: 30_000 });
  await stop.click();
  await stop.waitForExist({ reverse: true, timeout: 60_000 });
  const status = await browser.$(sel.scpStatus);
  await status.waitForExist({ timeout: 10_000 });
  expect(await status.getText()).toContain("Transfer stopped");
  expect(await (await browser.$('[data-testid="scp-error"]')).isExisting()).toBe(false);
}

/**
 * wdio's `timeoutMsg` is a string, not an async callback, so we can't
 * inline a "scrape the on-screen status" message. Wrap waitUntil in a
 * try/catch and rethrow with the trailing scp-status text — this is
 * the difference between "SCP upload did not complete" (useless) and
 * "SCP upload did not complete. status: 'Permission denied (publickey)'"
 * (immediately actionable).
 */
async function waitForScpStatusOrFail(
  phase: "upload" | "download",
  localPath: string,
  timeout = 30_000,
): Promise<void> {
  try {
    await browser.waitUntil(
      async () => {
        // The action returns { error, result }; on success result is set
        // and `scp-status` mounts; on failure error is set and `scp-error`
        // mounts. Either condition resolves the wait — error path is
        // diagnosed in the catch block. The status names the local path,
        // which tells this transfer's result apart from the previous one.
        const status = await (await browser.$(sel.scpStatus)).getText().catch(() => "");
        if (/transferred|done|success|complete/i.test(status) && status.includes(localPath)) {
          return true;
        }
        const errorEl = await browser.$('[data-testid="scp-error"]');
        if (await errorEl.isExisting()) return true;
        return false;
      },
      { timeout, timeoutMsg: `SCP ${phase} did not complete` },
    );
  } catch (err) {
    const status = await (await browser.$(sel.scpStatus)).getText().catch(() => "(no status)");
    const errorText = await (await browser.$('[data-testid="scp-error"]')).getText().catch(() => "(no error)");
    throw new Error(
      `SCP ${phase} did not complete within ${timeout / 1000}s.\n  status: ${JSON.stringify(status)}\n  error: ${JSON.stringify(errorText)}\n${(err as Error).message}`,
    );
  }
  // Surface backend error if the action came back with an error rather
  // than success — the caller expects a successful round-trip.
  const errorEl = await browser.$('[data-testid="scp-error"]');
  if (await errorEl.isExisting()) {
    const errorText = await errorEl.getText();
    throw new Error(`SCP ${phase} returned error from backend: ${errorText}`);
  }
}
