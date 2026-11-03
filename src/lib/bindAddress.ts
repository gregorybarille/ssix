/**
 * The local address a local or dynamic forward listens on. The backend has the
 * last word (`listen_addr` in `forwards.rs`); this gives the form the same answer
 * beside the field, and says when a forward is open to other machines.
 */

export const DEFAULT_BIND_ADDRESS = "127.0.0.1";

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** The IPv6 address in its shortest form, or null when `text` is not one. */
function normalizeIpv6(text: string): string | null {
  if (!text.includes(":") || /[[\]/?#%@]/.test(text)) return null;
  try {
    return new URL(`http://[${text}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/** Why `text` cannot be a bind address, or null. Empty means the default. */
export function bindAddressError(text: string): string | null {
  const address = text.trim();
  if (!address || IPV4.test(address) || normalizeIpv6(address)) return null;
  return "Enter an IP address, such as 127.0.0.1. Names are not accepted.";
}

/** Whether a valid address reaches only this computer. Empty means the default. */
export function isLoopbackAddress(text: string): boolean {
  const address = text.trim();
  return !address || address.startsWith("127.") || normalizeIpv6(address) === "::1";
}

/** Where a forward listens, as `host:port`, with brackets around IPv6. */
export function listenAddress(conn: { bind_address?: string; local_port: number }): string {
  const host = conn.bind_address || DEFAULT_BIND_ADDRESS;
  return `${host.includes(":") ? `[${host}]` : host}:${conn.local_port}`;
}
