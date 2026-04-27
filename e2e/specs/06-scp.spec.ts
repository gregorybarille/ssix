/**
 * Spec 06: SCP upload + download round-trip against server-a.
 *
 * Writes a fixture file, uploads via SCP dialog, downloads back to
 * a separate local path, asserts byte-for-byte equality.
 */
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForAppReady } from "../helpers/app.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import {
  createPasswordCredential,
  createDirectConnection,
  navigateTo,
} from "../helpers/flows.js";
import { sel } from "../helpers/selectors.js";

let workDir: string;
let upload: string;
let download: string;
const PAYLOAD = "ssx-scp-roundtrip-payload\n";

describe("SCP upload + download", () => {
  before(async () => {
    await waitForServers(["a"]);
    workDir = mkdtempSync(join(tmpdir(), "ssx-scp-"));
    upload = join(workDir, "upload.txt");
    download = join(workDir, "download.txt");
    writeFileSync(upload, PAYLOAD);
  });
  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("uploads then downloads a file and gets identical bytes back", async () => {
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

    await navigateTo("connections");
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

    // Upload phase. NOTE: SSX's resolve_remote_target_path() always
    // appends the local file name to the remote_path argument
    // (treating it as a directory). So if local is /tmp/ssx-scp-XYZ/upload.txt
    // and remote_path is "/tmp/", the actual remote file is /tmp/upload.txt.
    await (await browser.$(sel.scpModeUpload)).click();
    await (await browser.$(sel.scpLocalPath)).setValue(upload);
    await (await browser.$(sel.scpRemotePath)).setValue("/tmp/");
    await (await browser.$(sel.scpUploadButton)).click();
    await waitForScpStatusOrFail("upload");

    // Download phase. The remote file is at /tmp/upload.txt (SSX
    // appended the source file name during upload). For download,
    // remote_path is the source file directly — resolve_download_remote_path
    // does not append anything.
    await (await browser.$(sel.scpModeDownload)).click();
    await (await browser.$(sel.scpLocalPath)).setValue(download);
    await (await browser.$(sel.scpRemotePath)).setValue("/tmp/upload.txt");
    await (await browser.$(sel.scpDownloadButton)).click();
    await waitForScpStatusOrFail("download");

    expect(readFileSync(download, "utf8")).toBe(PAYLOAD);
  });
});

/**
 * wdio's `timeoutMsg` is a string, not an async callback, so we can't
 * inline a "scrape the on-screen status" message. Wrap waitUntil in a
 * try/catch and rethrow with the trailing scp-status text — this is
 * the difference between "SCP upload did not complete" (useless) and
 * "SCP upload did not complete. status: 'Permission denied (publickey)'"
 * (immediately actionable).
 */
async function waitForScpStatusOrFail(phase: "upload" | "download"): Promise<void> {
  try {
    await browser.waitUntil(
      async () =>
        /transferred|done|success|complete/i.test(
          await (await browser.$(sel.scpStatus)).getText(),
        ),
      { timeout: 30_000, timeoutMsg: `SCP ${phase} did not complete` },
    );
  } catch (err) {
    const status = await (await browser.$(sel.scpStatus)).getText().catch(() => "");
    throw new Error(
      `SCP ${phase} did not complete within 30s. Last status text: ${JSON.stringify(status)}\n${(err as Error).message}`,
    );
  }
}
