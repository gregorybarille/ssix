/**
 * Spec 05: Port forward — local → server-a → server-c:22.
 *
 * Starts a local forward via SSIX, then opens a raw TCP socket from the
 * test runner to the local forwarded port and asserts the SSH
 * banner from server-c is received. Validates `start_port_forward`
 * and the `ssix:forward:status` event stream.
 */
import { connect } from "node:net";
import { waitForAppReady } from "../helpers/app.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import {
  click,
  createPasswordCredential,
  fill,
  navigateTo,
  pickOption,
} from "../helpers/flows.js";
import { sel } from "../helpers/selectors.js";

const LOCAL_PORT = 23456;

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

/**
 * Poll-and-retry wrapper: the active forward row appears in the UI as
 * soon as the placeholder is set, BEFORE `ssh_connect` resolves and
 * the local listener is bound. Block until the local port actually
 * accepts a TCP connection (or give up after `totalTimeoutMs`).
 */
async function readBannerEventually(
  host: string,
  port: number,
  totalTimeoutMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + totalTimeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await readBanner(host, port, 2_000);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`Could not read banner from ${host}:${port} within ${totalTimeoutMs}ms`);
}

describe("Port forward (server-a → server-c:22)", () => {
  before(async () => {
    await waitForServers(["a"]);
  });

  it("forwards a local port to server-c via server-a", async () => {
    await waitForAppReady();
    await createPasswordCredential({
      name: "cred-05-a",
      username: TARGETS.a.user,
      password: TARGETS.a.password,
    });

    await navigateTo("connections");
    await click(sel.addConnectionButton);
    await fill(sel.connectionFormName, "forward-05-c");
    await click(sel.connectionFormKindLocalForward);
    // port_forward = local forward: uses SSH server/remote fields, not the
    // top-level direct host/port. Auth section is hidden (port_forward
    // has no remote shell, so only the SSH server needs creds).
    await fill(sel.connectionFormHopHost, TARGETS.a.host);
    await fill(sel.connectionFormHopPort, String(TARGETS.a.sshPort));
    await pickOption(sel.connectionFormHopCredential, "cred-05-a");
    await fill(sel.connectionFormTargetHost, "server-c");
    await fill(sel.connectionFormTargetPort, "22");
    await fill(sel.connectionFormLocalPort, String(LOCAL_PORT));
    await click(sel.connectionFormSubmit);

    await navigateTo("forwards");
    // The port forwards view renders one row per local forward
    // and updates that row in place as the session comes up.
    const forwardRow = await browser.$(sel.forwardRowByName("forward-05-c"));
    await forwardRow.waitForExist({ timeout: 10_000 });
    const startBtn = await forwardRow.$('[data-testid^="connect-button-"]');
    await startBtn.waitForClickable({ timeout: 10_000 });
    await startBtn.click();

    await browser.waitUntil(
      async () => (await forwardRow.getAttribute("data-status")) !== "disconnected",
      {
        timeout: 10_000,
        timeoutMsg: "Forward row never left the disconnected state after starting",
      },
    );

    const banner = await readBannerEventually("127.0.0.1", LOCAL_PORT);
    expect(banner.toUpperCase()).toContain("SSH-2.0");
  });
});
