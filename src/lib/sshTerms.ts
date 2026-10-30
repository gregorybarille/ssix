import type { ConnectionType } from "@/types";

/**
 * OpenSSH's names for SSIX's connection kinds, so the UI reads like `ssh`.
 *
 * - A **local forward** is `ssh -L`: an SSH server forwards a local port to
 *   a remote host it can reach.
 * - A **jump host** connection is `ssh -J`: a jump host relays the session
 *   to the target.
 *
 * The stored field names (`gateway_*`, `destination_*`, `port_forward`,
 * `jump_shell`) predate these terms and stay as they are in `data.json`;
 * only what users read follows OpenSSH.
 */
export const KIND_LABELS: Record<ConnectionType, string> = {
  direct: "Direct",
  port_forward: "Local forward",
  jump_shell: "Jump host",
};

/** The `ssh` flag each kind corresponds to. */
export const KIND_FLAGS: Record<ConnectionType, string | null> = {
  direct: null,
  port_forward: "-L",
  jump_shell: "-J",
};

/** Names for the two hosts of a two-hop kind, in sentence case. */
export interface HopTerms {
  /** The first hop (`gateway_*` fields). */
  hop: string;
  hopHost: string;
  hopPort: string;
  hopCredential: string;
  /** The far end (`destination_*` fields). */
  target: string;
  targetHost: string;
  targetPort: string;
}

const HOP_TERMS: Record<"port_forward" | "jump_shell", HopTerms> = {
  port_forward: {
    hop: "SSH server",
    hopHost: "SSH server host",
    hopPort: "SSH server port",
    hopCredential: "SSH server credential",
    target: "Remote",
    targetHost: "Remote host",
    targetPort: "Remote port",
  },
  jump_shell: {
    hop: "Jump host",
    hopHost: "Jump host",
    hopPort: "Jump host port",
    hopCredential: "Jump host credential",
    target: "Target",
    targetHost: "Target host",
    targetPort: "Target port",
  },
};

export function hopTerms(type: "port_forward" | "jump_shell"): HopTerms {
  return HOP_TERMS[type];
}

/** "SSH server host" → "SSH Server Host", for form labels. */
export function titleCase(term: string): string {
  return term.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
