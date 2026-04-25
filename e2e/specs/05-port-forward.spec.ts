/**
 * Spec 05: Port forward — local → server-a → server-c:22.
 *
 * Starts a tunnel via SSX, then opens a raw TCP socket from the
 * test runner to the local forwarded port and asserts the SSH
 * banner from server-c is received. Validates `start_port_forward`
 * and the `ssx:tunnel:status` event stream.
 */
import { connect } from "node:net";
import { waitForAppReady } from "../helpers/app.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import { createPasswordCredential, navigateTo } from "../helpers/flows.js";
import { sel } from "../helpers/selectors.js";

const LOCAL_PORT = 23456;

async function fill(selector: string, value: string) {
  const el = await browser.$(selector);
  await el.waitForClickable({ timeout: 10_000 });
  await el.setValue(value);
}
async function click(selector: string) {
  const el = await browser.$(selector);
  await el.waitForClickable({ timeout: 10_000 });
  await el.click();
}
async function pickCredential(triggerSelector: string, name: string) {
  await click(triggerSelector);
  const opt = await browser.$(`[role="option"][data-name="${name}"]`);
  await opt.waitForClickable({ timeout: 10_000 });
  await opt.click();
}

function readBanner(host: string, port: number, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const sock = connect({ host, port });
    let buf = "";
    const done = (err: Error | null) => {
      sock.destroy();
      if (err) rejectP(err);
      else resolveP(buf);
    };
    sock.setTimeout(timeoutMs);
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.includes("\n")) done(null);
    });
    sock.on("error", done);
    sock.on("timeout", () => done(new Error(`timeout reading banner from ${host}:${port}`)));
  });
}

describe("Port forward (server-a → server-c:22)", () => {
  before(async () => {
    await waitForServers(["a", "c"]);
  });

  it("forwards a local port to server-c via server-a", async () => {
    await waitForAppReady();
    await createPasswordCredential({
      name: "cred-a",
      username: TARGETS.a.user,
      password: TARGETS.a.password,
    });

    await navigateTo("connections");
    await click(sel.addConnectionButton);
    await fill(sel.connectionFormName, "tunnel-c");
    await click(sel.connectionFormKindPortForward);
    await fill(sel.connectionFormHost, TARGETS.a.host);
    await fill(sel.connectionFormPort, String(TARGETS.a.sshPort));
    await pickCredential(sel.connectionFormCredential, "cred-a");
    await fill(sel.connectionFormLocalPort, String(LOCAL_PORT));
    await fill(sel.connectionFormDestHost, "server-c");
    await fill(sel.connectionFormDestPort, "22");
    await click(sel.connectionFormSubmit);

    await navigateTo("tunnels");
    // The tunnel id is generated server-side; locate by display name.
    const tunnelRow = await browser.$(`[data-testid^="tunnel-row-"][data-name="tunnel-c"]`);
    await tunnelRow.waitForExist({ timeout: 10_000 });
    const startBtn = await tunnelRow.$('[data-testid^="tunnel-start-"]');
    await startBtn.waitForClickable({ timeout: 10_000 });
    await startBtn.click();

    // Wait for "active" status (testid value can be either text or
    // an attribute — try both).
    const statusEl = await tunnelRow.$('[data-testid^="tunnel-status-"]');
    await browser.waitUntil(
      async () => /active|running|up/i.test(await statusEl.getText()),
      { timeout: 30_000, timeoutMsg: "Tunnel did not reach active state" },
    );

    const banner = await readBanner("127.0.0.1", LOCAL_PORT);
    expect(banner.toUpperCase()).toContain("SSH-2.0");
  });
});
