/**
 * Host-key mismatch errors from the backend start with a machine-readable
 * line (see `src-tauri/src/known_hosts.rs`):
 *
 *   HOST_KEY_MISMATCH host=<host> port=<port> fingerprint=<fp>
 *   <human-readable explanation>
 *
 * The marker may be wrapped by an outer error ("Jump host x: ...", or
 * "Target connect via jump host failed: ..."), so it is searched for
 * anywhere in the message.
 */
export interface HostKeyMismatch {
  host: string;
  port: number;
  fingerprint: string;
  /** Explanation to show the user (everything after the marker line). */
  message: string;
}

const MARKER = /HOST_KEY_MISMATCH host=(\S+) port=(\d+) fingerprint=(\S+)/;

export function parseHostKeyMismatch(error: string | undefined | null): HostKeyMismatch | null {
  if (!error) return null;
  const m = MARKER.exec(error);
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const afterMarker = error.slice(m.index + m[0].length).replace(/^\s*\n?/, "").trim();
  return {
    host: m[1],
    port,
    fingerprint: m[3],
    message: afterMarker || `The host key for ${m[1]}:${port} has changed.`,
  };
}
