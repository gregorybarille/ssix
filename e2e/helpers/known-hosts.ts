/**
 * Stale `known_hosts` entries, to make the app see a changed host key.
 *
 * The server is asked for the recorded types first, so by default one bogus key
 * of every algorithm it may negotiate is planted: whichever it presents, the
 * stored key of that type differs.
 */
import { writeFileSync } from "node:fs";

/** Algorithms an OpenSSH server may present; libssh2 picks one of them. */
const ALGORITHMS = ["ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"];

/**
 * A syntactically valid public-key blob (`string algorithm` + body) with a
 * body no real server has. known_hosts only needs the algorithm prefix and
 * base64 to parse it.
 */
export function bogusKey(algorithm: string): string {
  const name = Buffer.from(algorithm, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(name.length);
  const body = Buffer.alloc(32, 0x42);
  return `${algorithm} ${Buffer.concat([len, name, body]).toString("base64")}`;
}

export const BOGUS_KEYS = ALGORITHMS.map(bogusKey);

/** OpenSSH known_hosts spelling of a host: plain for port 22, `[host]:port` otherwise. */
export function knownHostsName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** Replace the file with stale entries for this host, one per algorithm. */
export function plantBogusHostKeys(
  knownHostsPath: string,
  host: string,
  port: number,
  keys: string[] = BOGUS_KEYS,
): void {
  const entry = knownHostsName(host, port);
  writeFileSync(knownHostsPath, keys.map((key) => `${entry} ${key}\n`).join(""));
}
