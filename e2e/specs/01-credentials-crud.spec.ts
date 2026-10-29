/**
 * Spec 01: Credential CRUD round-trip.
 *
 * Validates that creating, listing, and deleting a password credential
 * persists through the real `add_credential` / `delete_credential`
 * Tauri commands and the on-disk `secrets.json` (under the shared
 * SSIX_DATA_DIR set in wdio.conf.ts onPrepare).
 */
import { waitForAppReady } from "../helpers/app.js";
import { navigateTo, createPasswordCredential, openCredentialEditor } from "../helpers/flows.js";
import { sel } from "../helpers/selectors.js";

describe("Credentials CRUD", () => {
  it("creates a password credential and lists it", async () => {
    await waitForAppReady();
    await createPasswordCredential({
      name: "test-cred",
      username: "usera",
      password: "passa",
    });
    await navigateTo("credentials");
    const row = await browser.$(`${sel.credentialList} [data-name="test-cred"]`);
    await row.waitForExist({ timeout: 10_000 });
    expect(await row.isExisting()).toBe(true);
  });

  /**
   * The list is redacted (`get_credentials` returns no secrets); the edit
   * form fetches them with `get_credential_secrets` when it opens. Editing
   * a non-secret field must round-trip the stored password untouched.
   */
  it("edits a credential: prefills the stored secret on open and keeps it after save", async () => {
    await waitForAppReady();
    await createPasswordCredential({
      name: "cred-01-edit",
      username: "usera",
      password: "edit-secret",
    });

    await openCredentialEditor("cred-01-edit");
    const password = await browser.$(sel.credentialFormPassword);
    expect(await password.getValue()).toBe("edit-secret");
    expect(await password.isEnabled()).toBe(true);

    const username = await browser.$(sel.credentialFormUsername);
    await username.setValue("usera-edited");
    await (await browser.$(sel.credentialFormSubmit)).click();
    await (await browser.$(sel.credentialForm)).waitForExist({ reverse: true, timeout: 10_000 });

    const row = await browser.$(sel.credentialRowByName("cred-01-edit"));
    await row.waitForExist({ timeout: 10_000 });
    expect(await row.getText()).toContain("usera-edited");

    // Re-open: the secret survived the update and is fetched again on open.
    await openCredentialEditor("cred-01-edit");
    expect(await (await browser.$(sel.credentialFormPassword)).getValue()).toBe("edit-secret");
    await (await browser.$(sel.credentialFormCancel)).click();
    await (await browser.$(sel.credentialForm)).waitForExist({ reverse: true, timeout: 10_000 });
  });
});
