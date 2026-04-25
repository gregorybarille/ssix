/**
 * Spec 02: Connection CRUD round-trip.
 *
 * Creates a credential, then a Direct connection that references it.
 * Asserts the connection appears in the list (round-tripped through
 * `add_connection` and `data.json`).
 */
import { setupTestDataDir, cleanupTestDataDir } from "../helpers/data-dir.js";
import { waitForAppReady } from "../helpers/app.js";
import { TARGETS } from "../helpers/docker.js";
import {
  navigateTo,
  createPasswordCredential,
  createDirectConnection,
} from "../helpers/flows.js";
import { sel } from "../helpers/selectors.js";

describe("Connections CRUD", () => {
  before(() => {
    setupTestDataDir();
  });
  after(() => {
    cleanupTestDataDir();
  });

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
});
