/**
 * A real ssh-agent for the E2E suite, holding one fresh ed25519 key.
 *
 * `wdio.conf.ts` starts it in `onPrepare`, like `SSIX_DATA_DIR`, so that the
 * SSIX app inherits `SSH_AUTH_SOCK` and spec workers inherit the public key.
 * The dockerized runner and CI's Ubuntu image both ship OpenSSH's client tools.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The comment on the agent's key, which `ssh-add -L` prints back. */
export const AGENT_KEY_COMMENT = "ssix-e2e-agent-key";
const PUBLIC_KEY_ENV = "SSIX_E2E_AGENT_PUBKEY";

let agentPid: number | null = null;
let workDir: string | null = null;

export function startTestAgent(): void {
  // Short: a socket path is limited to about a hundred characters.
  workDir = mkdtempSync(join(tmpdir(), "ssix-agent-"));
  const socket = join(workDir, "agent.sock");
  // Without -D, ssh-agent returns once its socket accepts connections.
  const output = execFileSync("ssh-agent", ["-s", "-a", socket], { encoding: "utf8" });
  const pid = /SSH_AGENT_PID=(\d+)/.exec(output)?.[1];
  if (!pid) throw new Error(`Could not read the ssh-agent pid from: ${output}`);
  agentPid = Number(pid);

  const key = join(workDir, "key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", AGENT_KEY_COMMENT, "-f", key]);
  execFileSync("ssh-add", ["-q", key], { env: { ...process.env, SSH_AUTH_SOCK: socket } });

  process.env.SSH_AUTH_SOCK = socket;
  process.env[PUBLIC_KEY_ENV] = readFileSync(`${key}.pub`, "utf8").trim();
}

export function stopTestAgent(): void {
  if (agentPid !== null) {
    try {
      process.kill(agentPid);
    } catch {
      // already gone
    }
    agentPid = null;
  }
  if (workDir !== null) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
}

/** The agent key as one `authorized_keys` line. */
export function agentPublicKey(): string {
  const key = process.env[PUBLIC_KEY_ENV];
  if (!key) throw new Error(`${PUBLIC_KEY_ENV} is not set; wdio.conf.ts starts the test agent`);
  return key;
}
