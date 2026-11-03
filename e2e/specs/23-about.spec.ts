/**
 * Spec 23: the logo in the title bar, and the About section of Settings.
 *
 * Opening a link hands it to the system browser, which the test container does
 * not have, so only the unit tests follow the links.
 */
import { waitForAppReady } from "../helpers/app.js";
import { click, navigateTo, textContentOf } from "../helpers/flows.js";
import { sel } from "../helpers/selectors.js";

const textOf = async (selector: string) => textContentOf(await browser.$(selector));

describe("About", () => {
  before(async () => {
    await waitForAppReady();
    await navigateTo("settings");
  });

  it("shows the logo beside the name in the title bar, and the image loads", async () => {
    const brand = await browser.$(sel.titleBarBrand);
    await brand.waitForDisplayed();
    expect((await brand.getText()).trim()).toBe("ssix");
    const logo = await brand.$("img");
    await browser.waitUntil(
      async () =>
        browser.execute(
          (el) => (el as unknown as HTMLImageElement).naturalWidth > 0,
          logo as unknown as HTMLElement,
        ),
      { timeoutMsg: "The title bar's logo never loaded" },
    );
  });

  it("names the version and the author, and links to the source and licence", async () => {
    const about = await browser.$(sel.settingsAbout);
    await about.scrollIntoView();
    await about.waitForDisplayed();
    await browser.waitUntil(
      async () => /\d+\.\d+\.\d+/.test(await textOf(sel.aboutVersion)),
      { timeoutMsg: "The version never appeared" },
    );
    expect(await textOf(sel.aboutAuthor)).toContain("Gregory Barillé");
    expect(await textOf(sel.aboutRepositoryLink)).toContain("github.com/gregorybarille/ssix");
    expect(await textOf(sel.aboutLicenseLink)).toContain("MIT");
  });

  it("lists what ships inside, with each licence, and filters the list", async () => {
    await click(sel.aboutLicensesToggle);
    const libssh2 = await browser.$(sel.aboutLicenseRowByName("libssh2"));
    await libssh2.waitForExist();
    expect(await textOf(sel.aboutLicenseRowByName("libssh2"))).toContain("BSD-3-Clause");
    const before = (await browser.$$(sel.aboutLicenseRow)).length;
    expect(before).toBeGreaterThan(100);

    const filter = await browser.$(sel.aboutLicensesFilter);
    await filter.setValue("libssh2");
    await browser.waitUntil(
      async () => (await browser.$$(sel.aboutLicenseRow)).length < before,
      { timeoutMsg: "The filter never narrowed the list" },
    );
    expect(await browser.$(sel.aboutLicenseRowByName("react")).isExisting()).toBe(false);
    expect(await libssh2.isExisting()).toBe(true);
  });
});
