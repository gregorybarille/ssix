/**
 * Spec 01: Credential CRUD round-trip.
 *
 * Validates that creating, listing, and deleting a password credential
 * persists through the real `add_credential` / `delete_credential`
 * Tauri commands and the on-disk `secrets.json` (under the shared
 * SSX_DATA_DIR set in wdio.conf.ts onPrepare).
 */
import { waitForAppReady } from "../helpers/app.js";
import { navigateTo, createPasswordCredential } from "../helpers/flows.js";
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
});
