/**
 * Spec 10: Host-key verification (trust-on-first-use).
 *
 * Plants bogus keys for server-a in the app's `known_hosts`, connects and
 * expects the backend to refuse with a HOST_KEY_MISMATCH error. Clicking
 * "Trust new host key" forgets the stale entries and reconnects; the shell
 * prompt must then appear and `known_hosts` must hold server-a's real key.
 *
 * A key of a type never recorded for the host counts as a change too, and the
 * server is asked for the recorded types first. server-a holds RSA, ECDSA P-256
 * and Ed25519 keys (`ssh-keygen -A`), and libssh2 on its own picks ECDSA.
 *
 * Exercises `src-tauri/src/known_hosts.rs`, the `ssh_forget_host_key`
 * command and the FailedTerminal trust action.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { waitForAppReady } from "../helpers/app.js";
import { currentTestDataDir } from "../helpers/data-dir.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import {
  closeAllTabs,
  connectToConnection,
  createPasswordCredential,
  createDirectConnection,
  navigateTo,
  waitForFailedTerminalError,
  waitForTerminalContains,
} from "../helpers/flows.js";
import { BOGUS_KEYS, bogusKey, knownHostsName, plantBogusHostKeys } from "../helpers/known-hosts.js";
import { sel } from "../helpers/selectors.js";

describe("Host-key verification", () => {
  before(async () => {
    await waitForServers(["a"]);
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  const knownHostsFile = () => {
    const dataDir = currentTestDataDir();
    if (!dataDir) throw new Error("SSIX_DATA_DIR is not set; cannot plant a known_hosts entry");
    return join(dataDir, "known_hosts");
  };

  /** Trust the refused key: the planted one must go, the real one take its place. */
  const trustAndExpectOnlyTheRealKey = async (knownHosts: string, planted: string[]) => {
    const trust = await browser.$(sel.trustHostKeyButton);
    await trust.waitForClickable({ timeout: 10_000 });
    await trust.click();

    await waitForTerminalContains("server-a:~$", 30_000);

    const after = readFileSync(knownHosts, "utf8");
    for (const key of planted) expect(after).not.toContain(key);
    const entry = knownHostsName(TARGETS.a.host, TARGETS.a.sshPort);
    expect(after.split("\n").filter((l) => l.startsWith(`${entry} `))).toHaveLength(1);
  };

  it("refuses a changed host key, then connects after the user trusts the new key", async () => {
    await waitForAppReady();
    const knownHosts = knownHostsFile();

    // Earlier specs may already have recorded server-a's real key. Replace
    // the file with stale entries for it, one per algorithm.
    plantBogusHostKeys(knownHosts, TARGETS.a.host, TARGETS.a.sshPort);

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
    // The stale keys stay until the user acts.
    const during = readFileSync(knownHosts, "utf8");
    for (const key of BOGUS_KEYS) expect(during).toContain(key);

    await trustAndExpectOnlyTheRealKey(knownHosts, BOGUS_KEYS);
  });

  it("refuses a key of a type never recorded for the host, and trusting it replaces the record", async () => {
    const knownHosts = knownHostsFile();
    // server-a has no P-521 key, so it has to present another type.
    const planted = bogusKey("ecdsa-sha2-nistp521");
    plantBogusHostKeys(knownHosts, TARGETS.a.host, TARGETS.a.sshPort, [planted]);

    await navigateTo("connections");
    await connectToConnection("conn-10-a");

    const error = await waitForFailedTerminalError("HOST_KEY_MISMATCH");
    expect(error).toContain("on record are of type ecdsa-sha2-nistp521");
    expect(readFileSync(knownHosts, "utf8")).toContain(planted);

    await trustAndExpectOnlyTheRealKey(knownHosts, [planted]);
  });

  it("asks the server for the recorded key type rather than the one libssh2 prefers", async () => {
    const knownHosts = knownHostsFile();
    const planted = bogusKey("ssh-ed25519");
    plantBogusHostKeys(knownHosts, TARGETS.a.host, TARGETS.a.sshPort, [planted]);

    await navigateTo("connections");
    await connectToConnection("conn-10-a");

    // Presenting ECDSA, libssh2's pick, would report a new key type instead.
    const error = await waitForFailedTerminalError("HOST_KEY_MISMATCH");
    expect(error).not.toContain("on record are of type");

    await trustAndExpectOnlyTheRealKey(knownHosts, [planted]);
  });
});
