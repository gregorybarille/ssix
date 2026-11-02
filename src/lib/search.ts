import type { Connection } from "@/types";

/**
 * Client-side connection search shared by the Connections view and the
 * Connect Picker. Terms are whitespace-separated, case-insensitive and
 * AND-matched across name, host, jump host / SSH server, target / remote host, tags
 * and folder path.
 *
 * Filtering happens on the already-loaded list: there is no backend
 * round trip per keystroke, and the store keeps the full, unfiltered
 * list so other views (tag groups, port forwards) always see every host.
 */
export function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function connectionMatches(conn: Connection, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  // Two-hop kinds carry a gateway host and, except a dynamic forward, a
  // destination host; for direct connections the fields are name/host.
  const haystack = [
    conn.name,
    conn.host,
    "destination_host" in conn ? conn.destination_host : undefined,
    conn.type !== "direct" ? conn.gateway_host : undefined,
    ...(conn.tags ?? []),
    conn.folder,
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
