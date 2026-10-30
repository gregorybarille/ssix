/**
 * Spec 02: Connection CRUD round-trip.
 *
 * Creates a credential, then a Direct connection that references it.
 * Asserts the connection appears in the list (round-tripped through
 * `add_connection` and `data.json`), and that the form refuses to save a
 * connection without a credential.
 */
import { waitForAppReady } from "../helpers/app.js";
import { TARGETS } from "../helpers/docker.js";
import {
  navigateTo,
  click,
  clickDialogFooterButton,
  createPasswordCredential,
  createDirectConnection,
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
});
