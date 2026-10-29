/**
 * Spec 02: Connection CRUD round-trip.
 *
 * Creates a credential, then a Direct connection that references it.
 * Asserts the connection appears in the list (round-tripped through
 * `add_connection` and `data.json`).
 */
import { waitForAppReady } from "../helpers/app.js";
import { TARGETS } from "../helpers/docker.js";
import {
  navigateTo,
  createPasswordCredential,
  createDirectConnection,
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
});
