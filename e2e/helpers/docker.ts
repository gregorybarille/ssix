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
 * Test runners that share docker's network (the dockerized
 * `e2e-runner` profile) hit the containers by hostname on port 22.
 * The default — both for local `npm run e2e:wdio` and for CI
 * (`xvfb-run -a npm run e2e:wdio` on the bare GHA runner) — is to hit
 * the published 220X ports on the host loopback (127.0.0.1). The bare
 * runner cannot resolve the docker-network hostnames (`server-a`, …),
 * so the SSX connection record itself MUST use 127.0.0.1 in that
 * mode, not just the probe.
 *
 * `host` here is what gets stored in the SSX connection record, so it
 * must be reachable FROM THE TAURI APP'S PROCESS. That is the same
 * machine as the test runner in both modes, so we keep `host` and
 * `probeHost` aligned.
 *
 * jump_shell / port_forward destination targets (server-c, server-d)
 * are still referenced by docker hostname because the gateway (server
 * -a) IS on the docker network and CAN resolve them — the destination
 * is dialled from the gateway, not the test runner. See specs 04+05
 * which use the explicit private hostname `server-c` for the dest.
 *
 * Detection: presence of `E2E_INSIDE_DOCKER=1`.
 */
const inside = process.env.E2E_INSIDE_DOCKER === "1";

export const TARGETS: Record<"a" | "b" | "c" | "d", SshTarget> = {
  a: {
    host: inside ? "server-a" : "127.0.0.1",
    probeHost: inside ? "server-a" : "127.0.0.1",
    probePort: inside ? 22 : 2201,
    sshPort: inside ? 22 : 2201,
    user: "usera",
    password: "passa",
  },
  b: {
    host: inside ? "server-b" : "127.0.0.1",
    probeHost: inside ? "server-b" : "127.0.0.1",
    probePort: inside ? 22 : 2202,
    sshPort: inside ? 22 : 2202,
    user: "userb",
    password: "passb",
  },
  c: {
    // server-c is on a private docker network only — never published
    // on the host. It's only reachable through a jump host (server-a),
    // so `host` stays as the docker hostname even outside docker. The
    // probe checks the published 2203 port, which proves only that the
    // server is up; actual dialling happens via the gateway.
    host: "server-c",
    probeHost: inside ? "server-c" : "127.0.0.1",
    probePort: inside ? 22 : 2203,
    sshPort: 22,
    user: "userc",
    password: "passc",
  },
  d: {
    host: "server-d",
    probeHost: inside ? "server-d" : "127.0.0.1",
    probePort: inside ? 22 : 2204,
    sshPort: 22,
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
