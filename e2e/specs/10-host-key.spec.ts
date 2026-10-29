/**
 * Spec 10: Host-key verification (trust-on-first-use).
 *
 * Plants a bogus key for server-a in the app's `known_hosts`, connects and
 * expects the backend to refuse with a HOST_KEY_MISMATCH error. Clicking
 * "Trust new host key" forgets the stale entry and reconnects; the shell
 * prompt must then appear and `known_hosts` must hold server-a's real key.
 *
 * Exercises `src-tauri/src/known_hosts.rs`, the `ssh_forget_host_key`
 * command and the FailedTerminal trust action.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitForAppReady } from "../helpers/app.js";
import { currentTestDataDir } from "../helpers/data-dir.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import {
  connectToConnection,
  createPasswordCredential,
  createDirectConnection,
  waitForFailedTerminalError,
  waitForTerminalContains,
} from "../helpers/flows.js";
import { sel } from "../helpers/selectors.js";

// A throwaway ed25519 public key that no fixture server uses.
const BOGUS_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINDqw4Q/tk3vvsi5kelic6POXIcYwQuNkdf97J5o1gAb";

/** OpenSSH known_hosts spelling of a host: plain for port 22, `[host]:port` otherwise. */
function knownHostsName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

describe("Host-key verification", () => {
  before(async () => {
    await waitForServers(["a"]);
  });

  it("refuses a changed host key, then connects after the user trusts the new key", async () => {
    await waitForAppReady();
    const dataDir = currentTestDataDir();
    if (!dataDir) throw new Error("SSIX_DATA_DIR is not set; cannot plant a known_hosts entry");
    const knownHosts = join(dataDir, "known_hosts");
    const entry = knownHostsName(TARGETS.a.host, TARGETS.a.sshPort);

    // Earlier specs may already have recorded server-a's real key. Replace
    // the file with a single stale entry for it.
    writeFileSync(knownHosts, `${entry} ${BOGUS_KEY}\n`);

    await createPasswordCredential({
      name: "cred-10-a",
      username: TARGETS.a.user,
      password: TARGETS.a.password,
    });
    await createDirectConnection({
      name: "conn-10-a",
      host: TARGETS.a.host,
      port: TARGETS.a.sshPort,
      credentialName: "cred-10-a",
    });
    await connectToConnection("conn-10-a");

    const error = await waitForFailedTerminalError("HOST_KEY_MISMATCH");
    expect(error).toContain(`host=${TARGETS.a.host} port=${TARGETS.a.sshPort}`);
    // The stale key stays until the user acts.
    expect(readFileSync(knownHosts, "utf8")).toContain(BOGUS_KEY);

    const trust = await browser.$(sel.trustHostKeyButton);
    await trust.waitForClickable({ timeout: 10_000 });
    await trust.click();

    await waitForTerminalContains("server-a:~$", 30_000);

    const after = readFileSync(knownHosts, "utf8");
    expect(after).not.toContain(BOGUS_KEY);
    const lines = after.split("\n").filter((l) => l.startsWith(`${entry} `));
    expect(lines).toHaveLength(1);
  });
});
