/**
 * Docker fixture readiness checks for E2E specs.
 *
 * The compose file declares healthchecks (`nc -z localhost 22` inside
 * each container), so the canonical readiness gate is
 * `docker compose up -d --wait`. These helpers cover the case where
 * the developer (or CI) ran `docker:up` separately and we just need
 * to confirm sshd is reachable from the test process.
 */
import { connect, type Socket } from "node:net";

export interface SshTarget {
  /** Hostname to use INSIDE the SSX connection record (server-a, server-b, ...). */
  host: string;
  /** Hostname/IP to probe FROM the test runner (host loopback OR docker DNS). */
  probeHost: string;
  /** Port to probe from the test runner. */
  probePort: number;
  user: string;
  password: string;
  /** Port the SSH connection record uses (22 inside docker net, 220X from host). */
  sshPort: number;
}

/**
 * Test runners that share docker's network (CI service, dockerized
 * runner) hit the containers by hostname on port 22. A developer
 * running wdio directly on their host hits the published 220X ports
 * on 127.0.0.1. Detection: presence of `E2E_INSIDE_DOCKER=1`.
 */
const inside = process.env.E2E_INSIDE_DOCKER === "1";

export const TARGETS: Record<"a" | "b" | "c" | "d", SshTarget> = {
  a: {
    host: "server-a",
    probeHost: inside ? "server-a" : "127.0.0.1",
    probePort: inside ? 22 : 2201,
    sshPort: inside ? 22 : 2201,
    user: "usera",
    password: "passa",
  },
  b: {
    host: "server-b",
    probeHost: inside ? "server-b" : "127.0.0.1",
    probePort: inside ? 22 : 2202,
    sshPort: inside ? 22 : 2202,
    user: "userb",
    password: "passb",
  },
  c: {
    host: "server-c",
    probeHost: inside ? "server-c" : "127.0.0.1",
    probePort: inside ? 22 : 2203,
    sshPort: inside ? 22 : 2203,
    user: "userc",
    password: "passc",
  },
  d: {
    host: "server-d",
    probeHost: inside ? "server-d" : "127.0.0.1",
    probePort: inside ? 22 : 2204,
    sshPort: inside ? 22 : 2204,
    user: "userd",
    password: "passd",
  },
};

function tcpPing(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolveP) => {
    let done = false;
    const sock: Socket = connect({ host, port });
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolveP(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    sock.once("timeout", () => finish(false));
  });
}

/**
 * Block until every named target's sshd is accepting connections.
 * Throws after `totalTimeoutMs` so a stuck container doesn't make
 * the test hang silently.
 */
export async function waitForServers(
  keys: ReadonlyArray<keyof typeof TARGETS> = ["a", "b", "c", "d"],
  totalTimeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + totalTimeoutMs;
  for (const k of keys) {
    const t = TARGETS[k];
    while (Date.now() < deadline) {
      if (await tcpPing(t.probeHost, t.probePort)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!(await tcpPing(t.probeHost, t.probePort))) {
      throw new Error(
        `Docker SSH target server-${k} (${t.probeHost}:${t.probePort}) ` +
          `did not become reachable. Did you run \`npm run docker:up\`?`,
      );
    }
  }
}
