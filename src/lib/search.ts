import type { Connection } from "@/types";

/**
 * Client-side connection search shared by the Connections view and the
 * Connect Picker. Terms are whitespace-separated, case-insensitive and
 * AND-matched across name, host, gateway/destination host and tags.
 *
 * Filtering happens on the already-loaded list: there is no backend
 * round trip per keystroke, and the store keeps the full, unfiltered
 * list so other views (tag groups, tunnels) always see every host.
 */
export function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function connectionMatches(conn: Connection, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  // Only port_forward/jump_shell carry destination/gateway hosts; for
  // direct connections the relevant search fields are name/host.
  const haystack = [
    conn.name,
    conn.host,
    conn.type !== "direct" ? conn.destination_host : undefined,
    conn.type !== "direct" ? conn.gateway_host : undefined,
    ...(conn.tags ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

export function filterConnections(connections: Connection[], query: string): Connection[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return connections;
  return connections.filter((c) => connectionMatches(c, tokens));
}
