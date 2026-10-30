/**
 * Spec 11: a failed load is shown, never mistaken for an empty catalogue.
 *
 * Corrupts `data.json`, reloads the app, and expects the Connections,
 * Credentials and Settings views to show a load-error banner naming the
 * file. Restoring the file and clicking Retry brings the data back.
 *
 * Runs last: while the file is corrupt every backend read fails.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitForAppReady } from "../helpers/app.js";
import { currentTestDataDir } from "../helpers/data-dir.js";
import { createPasswordCredential, navigateTo, textContentOf } from "../helpers/flows.js";
import { sel } from "../helpers/selectors.js";

describe("Load errors", () => {
  let dataFile = "";
  let original: string | null = null;

  before(async () => {
    await waitForAppReady();
    const dir = currentTestDataDir();
    if (!dir) throw new Error("SSIX_DATA_DIR is not set; cannot corrupt data.json");
    dataFile = join(dir, "data.json");
    // A known row makes a successful retry distinguishable from an empty list.
    await createPasswordCredential({ name: "cred-11", username: "usera", password: "p11" });
    original = readFileSync(dataFile, "utf8");
  });

  after(() => {
    if (original !== null) writeFileSync(dataFile, original);
  });

  it("shows a load-error banner in each view and recovers on retry", async () => {
    writeFileSync(dataFile, "{ not json");
    await browser.refresh();
    await waitForAppReady();

    await navigateTo("connections");
    const connections = await browser.$(sel.connectionsLoadError);
    await connections.waitForExist({ timeout: 10_000 });
    const message = await textContentOf(connections);
    expect(message).toContain("Could not load connections");
    expect(message).toContain("data.json is not valid SSIX data");

    await navigateTo("credentials");
    await (await browser.$(sel.credentialsLoadError)).waitForExist({ timeout: 10_000 });
    await navigateTo("settings");
    await (await browser.$(sel.settingsLoadError)).waitForExist({ timeout: 10_000 });

    writeFileSync(dataFile, original!);

    await (await browser.$(sel.settingsLoadErrorRetry)).click();
    await (await browser.$(sel.settingsLoadError)).waitForExist({ reverse: true, timeout: 10_000 });

    await navigateTo("connections");
    await (await browser.$(sel.connectionsLoadErrorRetry)).click();
    await connections.waitForExist({ reverse: true, timeout: 10_000 });

    await navigateTo("credentials");
    await (await browser.$(sel.credentialsLoadErrorRetry)).click();
    await (await browser.$(sel.credentialsLoadError)).waitForExist({ reverse: true, timeout: 10_000 });
    await (await browser.$(sel.credentialRowByName("cred-11"))).waitForExist({ timeout: 10_000 });
  });
});
