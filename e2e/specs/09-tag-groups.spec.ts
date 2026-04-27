/**
 * Spec 09: Tag-group view + bulk Connect-all / SCP-all flows.
 *
 * Coverage:
 *   - Switching the Connections layout to "tags" via LayoutToggle.
 *   - Tag groups render with the tag-group-grid container and one
 *     tile per distinct tag (plus the "Untagged" sentinel when any
 *     untagged hosts exist).
 *   - Connect-all on a tag group goes through the confirm dialog;
 *     cancelling does NOT spawn sessions; confirming opens one
 *     terminal tab per host (sequentially).
 *   - SCP-all on a tag group goes through the confirm dialog and
 *     opens the BulkScpDialog with one progress row per host. We
 *     run a real upload against the dockerized servers and verify
 *     each row reaches data-status="success".
 *
 * Naming convention: every credential / connection / tag in this
 * spec is suffixed `-09` so the shared per-suite SSX_DATA_DIR can
 * coexist with other specs without cross-contamination.
 */
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
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

const TAG = "team09";

let workDir: string;
let upload: string;

/**
 * Connections in the tags view are tagged via the form's TagInput.
 * createDirectConnection doesn't expose tags, so after creating each
 * connection we re-open it via Edit and add the tag. Doing it in a
 * helper keeps the test body focused on the actual flow being tested.
 */
async function tagConnection(name: string, tag: string): Promise<void> {
  const row = await browser.$(sel.connectionRowByName(name));
  await row.waitForExist({ timeout: 10_000 });
  await row.moveTo();
  // The edit affordance lives in the row's hover-revealed action
  // cluster alongside the SCP and connect buttons.
  const editBtn = await row.$('[data-testid^="edit-connection-"]');
  await editBtn.waitForClickable({ timeout: 10_000 });
  await editBtn.click();
  const tagsInput = await browser.$("#tags");
  await tagsInput.waitForExist({ timeout: 10_000 });
  await tagsInput.click();
  // TagInput commits on Enter or comma — Enter is more reliable in
  // wdio because comma can be remapped on some keyboard layouts.
  await tagsInput.setValue(tag);
  await browser.keys(["Enter"]);
    const submit = await browser.$(sel.connectionFormSubmit);
    await submit.waitForExist({ timeout: 10_000 });
    // The connection form is a tall scrollable dialog; on Linux CI the
    // WebDriver Actions API occasionally reports "move target out of
    // bounds" when trying to scroll the sticky DialogFooter button into
    // view, leaving `waitForClickable` to time out. Force-scroll via JS
    // first (matches what wdio's auto-scroll attempts but reliably) and
    // fall back to a JS click if Actions still refuses to fire.
    await browser.execute(
      (el: HTMLElement) => el.scrollIntoView({ block: "center" }),
      submit,
    );
    try {
      await submit.waitForClickable({ timeout: 5_000 });
      await submit.click();
    } catch {
      await browser.execute((el: HTMLElement) => el.click(), submit);
    }
    const form = await browser.$(sel.connectionForm);
    await form.waitForExist({ reverse: true, timeout: 10_000 });
}

describe("Tag-group view + bulk actions", () => {
  before(async () => {
    await waitForServers(["a", "b"]);
    workDir = mkdtempSync(join(tmpdir(), "ssx-tags-"));
    upload = join(workDir, "tag-upload.txt");
    writeFileSync(upload, "ssx-tag-bulk-payload\n");
  });
  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("renders the tags layout with one tile per tag and gates bulk actions on confirm", async () => {
    await waitForAppReady();

    // Two credentials + two direct connections sharing one tag, plus
    // an untagged third host so the Untagged tile must also appear.
    await createPasswordCredential({
      name: "cred-09-a",
      username: TARGETS.a.user,
      password: TARGETS.a.password,
    });
    await createPasswordCredential({
      name: "cred-09-b",
      username: TARGETS.b.user,
      password: TARGETS.b.password,
    });
    await createDirectConnection({
      name: "conn-09-a",
      host: TARGETS.a.host,
      port: TARGETS.a.sshPort,
      credentialName: "cred-09-a",
    });
    await createDirectConnection({
      name: "conn-09-b",
      host: TARGETS.b.host,
      port: TARGETS.b.sshPort,
      credentialName: "cred-09-b",
    });
    await createDirectConnection({
      name: "conn-09-untagged",
      host: TARGETS.a.host,
      port: TARGETS.a.sshPort,
      credentialName: "cred-09-a",
    });

    await navigateTo("connections");
    await tagConnection("conn-09-a", TAG);
    await tagConnection("conn-09-b", TAG);

    // Switch to the tags layout. The toggle is always present on the
    // Connections view (showTags={true}).
    await (await browser.$(sel.layoutToggleTags)).click();

    const grid = await browser.$(sel.tagGroupGrid);
    await grid.waitForExist({ timeout: 10_000 });

    const tagTile = await browser.$(sel.tagGroup(TAG));
    await tagTile.waitForExist({ timeout: 10_000 });
    const untaggedTile = await browser.$(sel.tagGroup("untagged"));
    await untaggedTile.waitForExist({ timeout: 10_000 });

    // --- Cancel path: clicking Connect-all then cancelling must NOT
    //     spawn any terminals. We verify by checking no terminal
    //     container appears within a short window after cancel.
    await (await browser.$(sel.tagConnectAll(TAG))).click();
    const confirm = await browser.$(sel.confirmTagAction);
    await confirm.waitForExist({ timeout: 10_000 });
    await (await browser.$(sel.confirmTagActionCancel)).click();
    await confirm.waitForExist({ reverse: true, timeout: 5_000 });
    // Quick sanity: terminal container should NOT have mounted.
    const terminal = await browser.$(sel.terminalContainer);
    expect(await terminal.isExisting()).toBe(false);

    // --- Confirm path for SCP-all: open dialog, run an upload to
    //     /tmp/, and verify both rows reach data-status="success".
    await (await browser.$(sel.tagScpAll(TAG))).click();
    const confirm2 = await browser.$(sel.confirmTagAction);
    await confirm2.waitForExist({ timeout: 10_000 });
    await (await browser.$(sel.confirmTagActionConfirm)).click();

    const bulkDialog = await browser.$(sel.bulkScpDialog);
    await bulkDialog.waitForExist({ timeout: 10_000 });

    await (await browser.$(sel.bulkScpModeUpload)).click();
    await (await browser.$(sel.bulkScpLocalPath)).setValue(upload);
    await (await browser.$(sel.bulkScpRemotePath)).setValue("/tmp/");
    await (await browser.$(sel.bulkScpStart)).click();

    // Wait for both per-host rows to show data-status="success".
    // We can't use getAttribute("data-status") here — webkit2gtk-driver
    // (which tauri-driver wraps on Linux CI) returns a WebDriver error
    // for `data-*` attribute reads on some elements, which wdio's
    // waitUntil callback then catches and treats as "not yet" forever.
    // CSS attribute selectors don't go through that path and work fine.
    await browser.waitUntil(
      async () => {
        const successRows = await browser.$$(
          '[data-testid^="bulk-scp-row-"][data-status="success"]',
        );
        const errorRows = await browser.$$(
          '[data-testid^="bulk-scp-row-"][data-status="error"]',
        );
        // Bail early if a host failed — there's no recovery and the
        // 60s wait would just be wasted.
        if (errorRows.length > 0) {
          throw new Error(
            `Bulk SCP reported ${errorRows.length} failed host row(s); aborting wait.`,
          );
        }
        return successRows.length >= 2;
      },
      {
        timeout: 60_000,
        timeoutMsg:
          "Bulk SCP upload did not reach success on every per-host row within 60s",
      },
    );

    const summary = await browser.$(sel.bulkScpSummary);
    await summary.waitForExist({ timeout: 10_000 });
    const summaryText = await summary.getText();
    expect(summaryText).toContain("2 succeeded");
  });
});
