/**
 * Spec 10: Host-key verification (trust-on-first-use).
 *
 * Plants bogus keys for server-a in the app's `known_hosts`, connects and
 * expects the backend to refuse with a HOST_KEY_MISMATCH error. Clicking
 * "Trust new host key" forgets the stale entries and reconnects; the shell
 * prompt must then appear and `known_hosts` must hold server-a's real key.
 *
 * Keys are matched per algorithm (a server that gains a second key type is
 * not an interception), so one bogus key of every algorithm the server may
 * negotiate is planted: whichever libssh2 picks, the stored key differs.
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

/** Algorithms an OpenSSH server may present; libssh2 picks one of them. */
const ALGORITHMS = ["ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"];

/**
 * A syntactically valid public-key blob (`string algorithm` + body) with a
 * body no real server has. known_hosts only needs the algorithm prefix and
 * base64 to parse it.
 */
function bogusKey(algorithm: string): string {
  const name = Buffer.from(algorithm, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(name.length);
  const body = Buffer.alloc(32, 0x42);
  return `${algorithm} ${Buffer.concat([len, name, body]).toString("base64")}`;
}
const BOGUS_KEYS = ALGORITHMS.map(bogusKey);

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
    // the file with stale entries for it, one per algorithm.
    writeFileSync(knownHosts, BOGUS_KEYS.map((k) => `${entry} ${k}\n`).join(""));

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

    const trust = await browser.$(sel.trustHostKeyButton);
    await trust.waitForClickable({ timeout: 10_000 });
    await trust.click();

    await waitForTerminalContains("server-a:~$", 30_000);

    const after = readFileSync(knownHosts, "utf8");
    for (const key of BOGUS_KEYS) expect(after).not.toContain(key);
    const lines = after.split("\n").filter((l) => l.startsWith(`${entry} `));
    expect(lines).toHaveLength(1);
  });
});
