import { FORWARD_TYPES, type Connection, type ConnectionType, type ForwardConnection, type ForwardType } from "@/types";

/**
 * OpenSSH's names for SSIX's connection kinds, so the UI reads like `ssh`.
 *
 * - A **local forward** is `ssh -L`: an SSH server forwards a local port to
 *   a remote host it can reach.
 * - A **jump host** connection is `ssh -J`: a jump host relays the session
 *   to the target.
 * - A **remote forward** is `ssh -R` and a **dynamic forward** `ssh -D`;
 *   both are data only until the forwards stream lands (`docs/roadmap.md`).
 *
 * The stored field names (`gateway_*`, `destination_*`, `port_forward`,
 * `jump_shell`) predate these terms and stay as they are in `data.json`;
 * only what users read follows OpenSSH.
 */
export const KIND_LABELS: Record<ConnectionType, string> = {
  direct: "Direct",
  port_forward: "Local forward",
  jump_shell: "Jump host",
  remote_forward: "Remote forward",
  dynamic_forward: "Dynamic forward",
};

/** The `ssh` flag each kind corresponds to. */
export const KIND_FLAGS: Record<ConnectionType, string | null> = {
  direct: null,
  port_forward: "-L",
  jump_shell: "-J",
  remote_forward: "-R",
  dynamic_forward: "-D",
};

/** Whether `type` is a forward (`ssh -L`, `-R` or `-D`): no shell, SCP or scripts. */
export function isForwardType(type: ConnectionType): type is ForwardType {
  return (FORWARD_TYPES as readonly ConnectionType[]).includes(type);
}

export function isForwardConnection(conn: Connection): conn is ForwardConnection {
  return isForwardType(conn.type);
}

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

/** The kinds with two hops; every kind but `direct`. */
export type TwoHopType = Exclude<ConnectionType, "direct">;

const FORWARD_HOP_TERMS: HopTerms = {
  hop: "SSH server",
  hopHost: "SSH server host",
  hopPort: "SSH server port",
  hopCredential: "SSH server credential",
  target: "Remote",
  targetHost: "Remote host",
  targetPort: "Remote port",
};

/** `ssh -R` runs the other way: its far end is on this machine's side. */
const REMOTE_FORWARD_HOP_TERMS: HopTerms = {
  ...FORWARD_HOP_TERMS,
  target: "Local target",
  targetHost: "Local target host",
  targetPort: "Local target port",
};

const HOP_TERMS: Record<TwoHopType, HopTerms> = {
  port_forward: FORWARD_HOP_TERMS,
  remote_forward: REMOTE_FORWARD_HOP_TERMS,
  // A dynamic forward has no fixed far end; the SOCKS client names it.
  dynamic_forward: FORWARD_HOP_TERMS,
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

export function hopTerms(type: TwoHopType): HopTerms {
  return HOP_TERMS[type];
}

/** What a forward carries, in one line, for lists and the Connect picker. */
export function forwardEndpoint(conn: ForwardConnection): string {
  switch (conn.type) {
    case "port_forward":
      return `127.0.0.1:${conn.local_port} → ${conn.destination_host}:${conn.destination_port}`;
    case "remote_forward":
      return `remote port ${conn.remote_port} → ${conn.destination_host}:${conn.destination_port}`;
    case "dynamic_forward":
      return `127.0.0.1:${conn.local_port} (SOCKS)`;
  }
}

/** "SSH server host" → "SSH Server Host", for form labels. */
export function titleCase(term: string): string {
  return term.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
