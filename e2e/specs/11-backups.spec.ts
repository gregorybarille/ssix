/**
 * Spec 11: local backups of ~/.ssix.
 *
 * Takes a manual backup from Settings, adds a credential, restores the
 * backup and expects the credential to be gone while the one made before
 * the backup stays. The restore keeps what it replaced as a
 * "before restore" backup.
 *
 * Restoring rewinds the shared data dir to this spec's own backup, so
 * only what this spec made in between is undone.
 */
import { waitForAppReady } from "../helpers/app.js";
import { click, createPasswordCredential, navigateTo, textContentOf } from "../helpers/flows.js";
import { sel } from "../helpers/selectors.js";

async function openBackups(): Promise<void> {
  await navigateTo("settings");
  const create = await browser.$(sel.backupCreate);
  await create.waitForExist({ timeout: 10_000 });
  await create.scrollIntoView({ block: "center" });
}

describe("Backups", () => {
  it("restores a backup and keeps what it replaced", async () => {
    await waitForAppReady();
    await createPasswordCredential({ name: "cred-11-kept", username: "u", password: "p" });

    await openBackups();
    await click(sel.backupCreate);
    const notice = await browser.$(sel.backupNotice);
    await notice.waitForExist({ timeout: 10_000 });
    expect(await textContentOf(notice)).toContain("ssix-backup-");

    await createPasswordCredential({ name: "cred-11-undone", username: "u", password: "p" });

    await openBackups();
    // Newest first: the first manual row is the backup taken above.
    const row = await browser.$(sel.backupRowByReason("manual"));
    await row.waitForExist({ timeout: 10_000 });
    const restore = await row.$(sel.backupRestoreButton);
    await restore.scrollIntoView({ block: "center" });
    await restore.click();
    await click(sel.backupRestoreConfirm);
    await (await browser.$(sel.backupRestoreDialog)).waitForExist({ reverse: true, timeout: 10_000 });
    await (await browser.$(sel.backupRowByReason("before_restore"))).waitForExist({ timeout: 10_000 });

    await navigateTo("credentials");
    await (await browser.$(sel.credentialRowByName("cred-11-kept"))).waitForExist({ timeout: 10_000 });
    await (await browser.$(sel.credentialRowByName("cred-11-undone"))).waitForExist({
      reverse: true,
      timeout: 10_000,
    });
  });
});
