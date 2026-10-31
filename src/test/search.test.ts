import { describe, it, expect } from "vitest";
import { connectionMatches, filterConnections, tokenize } from "@/lib/search";
import type { Connection } from "@/types";

const direct = (id: string, name: string, host: string, tags: string[] = []): Connection => ({
  id,
  name,
  host,
  port: 22,
  type: "direct",
  tags,
});

const conns: Connection[] = [
  direct("1", "web-prod", "10.0.0.1", ["prod", "web"]),
  direct("2", "db-staging", "10.0.0.2", ["staging", "db"]),
  {
    id: "3",
    name: "bastion-fwd",
    host: "bastion.example",
    port: 22,
    type: "port_forward",
    gateway_host: "gw.example",
    gateway_port: 22,
    gateway_credential_id: "gw-cred",
    local_port: 5432,
    destination_host: "pg.internal",
    destination_port: 5432,
  },
];

describe("search", () => {
  it("tokenizes on whitespace, lower-cases and drops empties", () => {
    expect(tokenize("  Prod   DB ")).toEqual(["prod", "db"]);
    expect(tokenize("")).toEqual([]);
  });

  it("matches every token across name, host and tags (AND semantics)", () => {
    expect(connectionMatches(conns[0], ["prod", "web"])).toBe(true);
    expect(connectionMatches(conns[0], ["prod", "db"])).toBe(false);
    expect(connectionMatches(conns[1], ["10.0.0.2"])).toBe(true);
  });

  it("searches the first hop and far-end hosts of forwards and jump hosts", () => {
    expect(connectionMatches(conns[2], ["pg.internal"])).toBe(true);
    expect(connectionMatches(conns[2], ["gw"])).toBe(true);
  });

  it("filterConnections returns the same array for a blank query", () => {
    expect(filterConnections(conns, "   ")).toBe(conns);
    expect(filterConnections(conns, "staging").map((c) => c.id)).toEqual(["2"]);
    expect(filterConnections(conns, "absent")).toEqual([]);
  });
});
