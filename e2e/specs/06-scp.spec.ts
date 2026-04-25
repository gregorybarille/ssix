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
    // Open SCP dialog via the per-row affordance.
    const scpBtn = await row.$('[data-testid^="scp-open-"]');
    await scpBtn.waitForClickable({ timeout: 10_000 });
    await scpBtn.click();

    const dialog = await browser.$(sel.scpDialog);
    await dialog.waitForExist({ timeout: 10_000 });

    // Upload phase
    await (await browser.$(sel.scpModeUpload)).click();
    await (await browser.$(sel.scpLocalPath)).setValue(upload);
    await (await browser.$(sel.scpRemotePath)).setValue("/tmp/ssx-e2e-upload.txt");
    await (await browser.$(sel.scpUploadButton)).click();
    await browser.waitUntil(
      async () => /done|success|complete/i.test(await (await browser.$(sel.scpStatus)).getText()),
      { timeout: 30_000, timeoutMsg: "SCP upload did not complete" },
    );

    // Download phase
    await (await browser.$(sel.scpModeDownload)).click();
    await (await browser.$(sel.scpLocalPath)).setValue(download);
    await (await browser.$(sel.scpRemotePath)).setValue("/tmp/ssx-e2e-upload.txt");
    await (await browser.$(sel.scpDownloadButton)).click();
    await browser.waitUntil(
      async () => /done|success|complete/i.test(await (await browser.$(sel.scpStatus)).getText()),
      { timeout: 30_000, timeoutMsg: "SCP download did not complete" },
    );

    expect(readFileSync(download, "utf8")).toBe(PAYLOAD);
  });
});
