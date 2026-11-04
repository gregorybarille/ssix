/**
 * Spec 10: Host-key verification (trust-on-first-use).
 *
 * Plants bogus keys for server-a in the app's `known_hosts`, connects and
 * expects the backend to refuse with a HOST_KEY_MISMATCH error. Clicking
 * "Trust new host key" reconnects accepting the fingerprint shown; the shell
 * prompt must then appear and `known_hosts` must hold server-a's real key.
 *
 * A TCP relay in this process swaps the server between the refusal and the
 * click, which is the attack the fingerprint is there to stop.
 *
 * A key of a type never recorded for the host counts as a change too, and the
 * server is asked for the recorded types first. server-a holds RSA, ECDSA P-256
 * and Ed25519 keys (`ssh-keygen -A`), and libssh2 on its own picks ECDSA.
 *
 * Exercises `src-tauri/src/known_hosts.rs`, the `ssh_trust_host_key`
 * command and the FailedTerminal trust action.
 */
import { readFileSync } from "node:fs";
import { connect, createServer, type AddressInfo, type Server } from "node:net";
import { join } from "node:path";
import { waitForAppReady } from "../helpers/app.js";
import { currentTestDataDir } from "../helpers/data-dir.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import {
  click,
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
  let relay: Server;
  let relayTarget = TARGETS.a;
  const relayPort = () => (relay.address() as AddressInfo).port;

  before(async () => {
    await waitForServers(["a", "e"]);
    relay = createServer((client) => {
      const server = connect(relayTarget.sshPort, relayTarget.host);
      client.on("error", () => server.destroy());
      server.on("error", () => client.destroy());
      client.pipe(server).pipe(client);
    });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  });

  after(() => {
    relay.close();
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
  const trustAndExpectOnlyTheRealKey = async (
    knownHosts: string,
    planted: string[],
    entry = knownHostsName(TARGETS.a.host, TARGETS.a.sshPort),
  ) => {
    const trust = await browser.$(sel.trustHostKeyButton);
    await trust.waitForClickable({ timeout: 10_000 });
    await trust.click();

    await waitForTerminalContains("server-a:~$", 30_000);

    const after = readFileSync(knownHosts, "utf8");
    for (const key of planted) expect(after).not.toContain(key);
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

  it("accepts only the fingerprint shown: a key swapped before the reconnect is refused", async () => {
    const knownHosts = knownHostsFile();
    const fingerprintIn = (error: string) => /fingerprint=(\S+)/.exec(error)?.[1] ?? "";
    plantBogusHostKeys(knownHosts, "127.0.0.1", relayPort());
    const planted = readFileSync(knownHosts, "utf8");

    await navigateTo("connections");
    await createDirectConnection({
      name: "conn-10-relay",
      host: "127.0.0.1",
      port: relayPort(),
      credentialName: "cred-10-a",
    });
    await connectToConnection("conn-10-relay");
    const shown = fingerprintIn(await waitForFailedTerminalError("HOST_KEY_MISMATCH"));

    // Not server-b: servers a to d share one image layer, so they share host keys.
    relayTarget = TARGETS.e;
    await click(sel.trustHostKeyButton);

    const error = await waitForFailedTerminalError("not the key you chose to trust");
    const swapped = fingerprintIn(error);
    expect(swapped).toMatch(/^SHA256:/);
    expect(swapped).not.toBe(shown);
    expect(readFileSync(knownHosts, "utf8")).toBe(planted);

    // The refusal ended the agreement, so the first key has to be trusted anew.
    relayTarget = TARGETS.a;
    await click(sel.failedTerminalRetry);
    await waitForFailedTerminalError(`fingerprint=${shown}`);
    expect(readFileSync(knownHosts, "utf8")).toBe(planted);

    await trustAndExpectOnlyTheRealKey(
      knownHosts,
      BOGUS_KEYS,
      knownHostsName("127.0.0.1", relayPort()),
    );
  });
});
