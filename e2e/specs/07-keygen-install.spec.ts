/**
 * Spec 07: Generate SSH keypair, install on server-a, reconnect.
 *
 * Flow (matches the real UI):
 * 1. Create a password credential (used to bootstrap the install).
 * 2. Open the Add Credential form, name it "cred-a-key", switch to
 *    SSH-key mode, and use the embedded "Generate key…" dialog. The
 *    dialog generates a keypair and writes the private-key path back
 *    into the form. Submit the form to persist the key credential.
 * 3. Open the Install dialog from the new key credential's row, fill
 *    host/port/username/password (the password credential's secret),
 *    and submit — the backend appends the public key to the server's
 *    authorized_keys.
 * 4. Create a connection that uses the key credential and confirm the
 *    shell opens (key auth works without prompting).
 */
import { waitForAppReady } from "../helpers/app.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import {
  createPasswordCredential,
  createDirectConnection,
  navigateTo,
  waitForTerminalContains,
} from "../helpers/flows.js";
import { sel } from "../helpers/selectors.js";

describe("SSH keygen + install_public_key", () => {
  before(async () => {
    await waitForServers(["a"]);
  });

  it("generates a key, installs it, and reconnects with key auth", async () => {
    await waitForAppReady();

    // Step 1 — password credential we'll use to bootstrap the install.
    await createPasswordCredential({
      name: "cred-a-pw",
      username: TARGETS.a.user,
      password: TARGETS.a.password,
    });

    // Step 2 — open Add Credential form, switch to SSH-key, generate.
    await navigateTo("credentials");
    await (await browser.$(sel.addCredentialButton)).click();
    await (await browser.$(sel.credentialForm)).waitForExist({ timeout: 10_000 });
    await (await browser.$(sel.credentialFormName)).setValue("cred-a-key");
    await (await browser.$(sel.credentialFormUsername)).setValue(TARGETS.a.user);
    await (await browser.$(sel.credentialFormKindSshKey)).click();

    // Open the Generate Key dialog from inside the credential form.
    const genOpen = await browser.$(sel.generateKeyOpen);
    await genOpen.waitForClickable({ timeout: 10_000 });
    await genOpen.click();
    const genDialog = await browser.$(sel.generateKeyDialog);
    await genDialog.waitForExist({ timeout: 10_000 });
    // Defaults are fine — submit to generate the key. The dialog
    // writes the private-key path back into the credential form.
    await (await browser.$(sel.generateKeySubmit)).click();
    await genDialog.waitForExist({ reverse: true, timeout: 30_000 });

    // Wait for the generated path to appear in the form, then submit.
    const pathInput = await browser.$(sel.credentialFormPrivateKeyPath);
    await browser.waitUntil(
      async () => (await pathInput.getValue()).length > 0,
      { timeout: 10_000, timeoutMsg: "Generated key path was not populated" },
    );
    await (await browser.$(sel.credentialFormSubmit)).click();
    await (await browser.$(sel.credentialForm)).waitForExist({
      reverse: true,
      timeout: 10_000,
    });

    // Step 3 — install the new public key onto server-a.
    const keyRow = await browser.$(
      `${sel.credentialList} [data-name="cred-a-key"]`,
    );
    await keyRow.waitForExist({ timeout: 10_000 });
    const installBtn = await keyRow.$('[data-testid^="install-key-"]');
    await installBtn.waitForClickable({ timeout: 10_000 });
    await installBtn.click();
    const installDialog = await browser.$(sel.installKeyDialog);
    await installDialog.waitForExist({ timeout: 10_000 });
    await (await browser.$(sel.installKeyHost)).setValue(TARGETS.a.host);
    // Port input is preset; clear via setValue (which clears first).
    await (await browser.$(sel.installKeyPort)).setValue(String(TARGETS.a.sshPort));
    await (await browser.$(sel.installKeyUsername)).setValue(TARGETS.a.user);
    await (await browser.$(sel.installKeyPassword)).setValue(TARGETS.a.password);
    await (await browser.$(sel.installKeySubmit)).click();
    await installDialog.waitForExist({ reverse: true, timeout: 60_000 });

    // Step 4 — connect with the key credential.
    await createDirectConnection({
      name: "conn-a-key",
      host: TARGETS.a.host,
      port: TARGETS.a.sshPort,
      credentialName: "cred-a-key",
    });
    await navigateTo("connections");
    const connRow = await browser.$(sel.connectionRowByName("conn-a-key"));
    await connRow.waitForClickable({ timeout: 10_000 });
    await connRow.doubleClick();
    await waitForTerminalContains("usera@server-a", 30_000);
  });
});
