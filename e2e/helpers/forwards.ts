/**
 * Starting and stopping a saved forward from its row in the Port forwards view.
 */
import { clickDialogFooterButton, navigateTo } from "./flows.js";
import { sel } from "./selectors.js";

export const rowOf = (name: string) => browser.$(sel.forwardRowByName(name));

export async function waitForRow(
  name: string,
  attribute: string,
  isExpected: (value: string | null) => boolean,
  what: string,
  timeout = 20_000,
): Promise<void> {
  await browser.waitUntil(async () => isExpected(await (await rowOf(name)).getAttribute(attribute)), {
    timeout,
    timeoutMsg: `${name}: ${attribute} never became ${what}`,
  });
}

export const waitForStatus = (name: string, status: string, timeout?: number) =>
  waitForRow(name, "data-status", (value) => value === status, status, timeout);

export async function clickStart(name: string): Promise<void> {
  await navigateTo("forwards");
  const row = await rowOf(name);
  await row.waitForExist({ timeout: 10_000 });
  const start = await row.$('[data-testid^="connect-button-"]');
  await start.waitForClickable({ timeout: 10_000 });
  await start.click();
}

export async function startForward(name: string): Promise<void> {
  await clickStart(name);
  await waitForStatus(name, "connected");
}

export async function stopForward(name: string): Promise<void> {
  const stop = await (await rowOf(name)).$('[data-testid^="forward-stop-"]');
  await stop.waitForClickable({ timeout: 10_000 });
  await stop.click();
  await clickDialogFooterButton(sel.confirmStopForwardConfirm);
  await waitForStatus(name, "disconnected");
}
