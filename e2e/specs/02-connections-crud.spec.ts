/**
 * Spec 02: Connection CRUD round-trip.
 *
 * Creates a credential, then a Direct connection that references it.
 * Asserts the connection appears in the list (round-tripped through
 * `add_connection` and `data.json`), then covers the credential rules:
 *   - a connection cannot be saved without a credential;
 *   - a refused save deletes the inline credential it created;
 *   - a clone keeps every field of its form;
 */
import { waitForAppReady } from "../helpers/app.js";
import { TARGETS } from "../helpers/docker.js";
import {
  navigateTo,
  click,
  clickDialogFooterButton,
  createPasswordCredential,
  createDirectConnection,
  ensureConnectionRowsLayout,
  fill,
  pickCredential,
  saveConnectionForm,
  textContentOf,
} from "../helpers/flows.js";
import { sel } from "../helpers/selectors.js";

describe("Connections CRUD", () => {
  it("creates a Direct connection referencing a credential", async () => {
    await waitForAppReady();
    await createPasswordCredential({
      name: "cred-a",
      username: TARGETS.a.user,
      password: TARGETS.a.password,
    });
    await createDirectConnection({
      name: "conn-a",
      host: TARGETS.a.host,
      port: TARGETS.a.sshPort,
      credentialName: "cred-a",
    });
    await navigateTo("connections");
    const row = await browser.$(sel.connectionRowByName("conn-a"));
    await row.waitForExist({ timeout: 10_000 });
    expect(await row.isExisting()).toBe(true);
  });

  it("filters the list client-side as the user types", async () => {
    await createDirectConnection({
      name: "conn-a-other",
      host: TARGETS.b.host,
      port: TARGETS.b.sshPort,
      credentialName: "cred-a",
    });
    await navigateTo("connections");
    await (await browser.$(sel.connectionRowByName("conn-a-other"))).waitForExist({ timeout: 10_000 });

    const search = await browser.$(sel.connectionSearchInput);
    await search.setValue("other");
    await browser.waitUntil(
      async () => !(await (await browser.$(sel.connectionRowByName("conn-a"))).isExisting()),
      { timeout: 5_000, timeoutMsg: "non-matching row should disappear" },
    );
    expect(await (await browser.$(sel.connectionRowByName("conn-a-other"))).isExisting()).toBe(true);

    // Terms are AND-matched; a token that matches nothing empties the list.
    await search.setValue("other nope");
    await browser.waitUntil(
      async () => !(await (await browser.$(sel.connectionRowByName("conn-a-other"))).isExisting()),
      { timeout: 5_000 },
    );

    // Clearing restores the full list without a reload.
    await (await browser.$(sel.connectionSearchClear)).click();
    await (await browser.$(sel.connectionRowByName("conn-a"))).waitForExist({ timeout: 5_000 });
    expect(await (await browser.$(sel.connectionRowByName("conn-a-other"))).isExisting()).toBe(true);
  });

  it("requires a credential and keeps the one picked through a refused save", async () => {
    await navigateTo("connections");
    await click(sel.addConnectionButton);
    await fill(sel.connectionFormName, "conn-a-checked");
    await click(sel.connectionFormKindDirect);
    await fill(sel.connectionFormHost, TARGETS.a.host);
    await fill(sel.connectionFormPort, String(TARGETS.a.sshPort));

    // No credential picked: the save is refused and the picker is flagged.
    await clickDialogFooterButton(sel.connectionFormSubmit);
    const credentialError = await browser.$(sel.connectionFormCredentialError);
    await credentialError.waitForDisplayed({ timeout: 10_000 });
    expect(await credentialError.getText()).toBe("Credential is required");
    const picker = await browser.$(sel.connectionFormCredential);
    expect(await picker.getAttribute("aria-invalid")).toBe("true");

    await pickCredential(sel.connectionFormCredential, "cred-a");
    await credentialError.waitForExist({ reverse: true, timeout: 5_000 });

    // A save refused for another reason must not drop the picked credential
    // (a form reset after the refusal used to put the picker back to None).
    await fill(sel.connectionFormPort, "not-a-port");
    await clickDialogFooterButton(sel.connectionFormSubmit);
    const formError = await browser.$(sel.connectionFormError);
    await browser.waitUntil(
      async () => (await textContentOf(formError)).includes("port fields"),
      { timeout: 10_000, timeoutMsg: "the bad port should refuse the save" },
    );
    expect(await textContentOf(picker)).toContain("cred-a");

    await fill(sel.connectionFormPort, String(TARGETS.a.sshPort));
    await saveConnectionForm();
    await (await browser.$(sel.connectionRowByName("conn-a-checked"))).waitForExist({
      timeout: 10_000,
    });
  });

  it("deletes the credential it made when the connection save is refused", async () => {
    await navigateTo("connections");
    await click(sel.addConnectionButton);
    // "conn-a" is taken, so the backend refuses this connection after the
    // form has already created its inline credential.
    await fill(sel.connectionFormName, "conn-a");
    await click(sel.connectionFormKindDirect);
    await fill(sel.connectionFormHost, TARGETS.a.host);
    await fill(sel.connectionFormPort, String(TARGETS.a.sshPort));
    await click(sel.connectionFormAuthPassword);
    await fill(sel.connectionFormInlineUsername, TARGETS.a.user);
    await fill(sel.connectionFormInlinePassword, TARGETS.a.password);
    await click(sel.connectionFormSaveCredential);
    await fill(sel.connectionFormSaveCredentialName, "cred-02-inline");
    await clickDialogFooterButton(sel.connectionFormSubmit);
    // Re-query each poll: the error line only appears once the save is refused.
    await browser.waitUntil(
      async () => {
        const formError = await browser.$(sel.connectionFormError);
        return (
          (await formError.isExisting()) &&
          (await textContentOf(formError)).includes("connection named 'conn-a'")
        );
      },
      { timeout: 10_000, timeoutMsg: "the taken name should refuse the save" },
    );

    // The credential was deleted again, so its name is free for the retry.
    await fill(sel.connectionFormName, "conn-a-inline");
    await saveConnectionForm();
    await navigateTo("credentials");
    await (await browser.$(sel.credentialRowByName("cred-02-inline"))).waitForExist({
      timeout: 10_000,
    });
    expect(await browser.$$(sel.credentialRowByName("cred-02-inline")).length).toBe(1);
  });

  it("saves every field of the clone form", async () => {
    await ensureConnectionRowsLayout();
    const row = await browser.$(sel.connectionRowByName("conn-a"));
    await row.waitForExist({ timeout: 10_000 });
    const cloneButton = await row.$(sel.connectionRowCloneButton);
    await cloneButton.waitForClickable({ timeout: 10_000 });
    await cloneButton.click();
    await fill(sel.connectionFormName, "conn-a-clone");
    // Tags used to be dropped: a clone only kept name, host, port and credential.
    const tagsInput = await browser.$("#tags");
    await tagsInput.waitForExist({ timeout: 10_000 });
    await tagsInput.click();
    await tagsInput.setValue("cloned");
    await browser.keys(["Enter"]);
    await saveConnectionForm();

    const clone = await browser.$(sel.connectionRowByName("conn-a-clone"));
    await clone.waitForExist({ timeout: 10_000 });
    expect(await clone.getAttribute("aria-label")).toContain("tagged cloned");
  });
});
