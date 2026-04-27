import { describe, it, expect } from "vitest";
import {
  groupConnectionsByTag,
  filterTagGroups,
  sanitizeFilenameSegment,
  splitBasename,
  joinPath,
  suffixedLocalDownloadPath,
  UNTAGGED_KEY,
} from "@/lib/tags";
import type { Connection } from "@/types";

const conn = (id: string, name: string, tags?: string[]): Connection =>
  ({
    id,
    name,
    host: `${name}.example`,
    port: 22,
    type: "direct",
    tags,
  }) as Connection;

describe("groupConnectionsByTag", () => {
  it("buckets a connection under each of its tags", () => {
    const conns = [
      conn("1", "a", ["prod", "db"]),
      conn("2", "b", ["prod"]),
      conn("3", "c", ["db"]),
    ];
    const groups = groupConnectionsByTag(conns);
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
    expect(byKey["prod"].connections.map((c) => c.id)).toEqual(["1", "2"]);
    expect(byKey["db"].connections.map((c) => c.id)).toEqual(["1", "3"]);
  });

  it("collects untagged into the sentinel bucket", () => {
    const groups = groupConnectionsByTag([
      conn("1", "a"),
      conn("2", "b", ["prod"]),
    ]);
    const untagged = groups.find((g) => g.key === UNTAGGED_KEY);
    expect(untagged).toBeDefined();
    expect(untagged?.label).toBe("Untagged");
    expect(untagged?.connections.map((c) => c.id)).toEqual(["1"]);
  });

  it("omits untagged group when includeUntagged=false", () => {
    const groups = groupConnectionsByTag([conn("1", "a")], false);
    expect(groups).toHaveLength(0);
  });

  it("sorts real tags alphabetically and pins Untagged last", () => {
    const groups = groupConnectionsByTag([
      conn("1", "a", ["zeta"]),
      conn("2", "b"),
      conn("3", "c", ["alpha"]),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["alpha", "zeta", "Untagged"]);
  });
});

describe("filterTagGroups", () => {
  const groups = groupConnectionsByTag([
    conn("1", "a", ["prod"]),
    conn("2", "b", ["staging"]),
  ]);

  it("returns all groups when query is empty/whitespace", () => {
    expect(filterTagGroups(groups, "")).toEqual(groups);
    expect(filterTagGroups(groups, "   ")).toEqual(groups);
  });

  it("matches case-insensitively on the tag label", () => {
    const matched = filterTagGroups(groups, "PROD");
    expect(matched).toHaveLength(1);
    expect(matched[0].label).toBe("prod");
  });
});

describe("sanitizeFilenameSegment", () => {
  it("replaces unsafe path/separator chars with underscores", () => {
    expect(sanitizeFilenameSegment("foo/bar")).toBe("foo_bar");
    expect(sanitizeFilenameSegment("a:b*c?d|e")).toBe("a_b_c_d_e");
    expect(sanitizeFilenameSegment("a\\b")).toBe("a_b");
  });

  it("strips control chars", () => {
    expect(sanitizeFilenameSegment("foo\x00bar")).toBe("foo_bar");
  });

  it("trims leading/trailing dots and whitespace", () => {
    expect(sanitizeFilenameSegment("  .name. ")).toBe("name");
  });

  it("falls back to 'host' for empty results", () => {
    expect(sanitizeFilenameSegment("")).toBe("host");
    expect(sanitizeFilenameSegment("....")).toBe("host");
  });
});

describe("splitBasename", () => {
  it("splits on the first dot to keep multi-dot extensions intact", () => {
    expect(splitBasename("foo.tar.gz")).toEqual(["foo", ".tar.gz"]);
  });

  it("treats dotfiles as stem-only", () => {
    expect(splitBasename(".env")).toEqual([".env", ""]);
    expect(splitBasename(".gitignore")).toEqual([".gitignore", ""]);
  });

  it("returns empty extension for names without a dot", () => {
    expect(splitBasename("README")).toEqual(["README", ""]);
  });
});

describe("joinPath", () => {
  it("uses POSIX separator for forward-slash paths", () => {
    expect(joinPath("/tmp/", "a.txt")).toBe("/tmp/a.txt");
    expect(joinPath("/tmp", "a.txt")).toBe("/tmp/a.txt");
  });

  it("uses backslash for Windows-style paths", () => {
    expect(joinPath("C:\\Users\\me", "a.txt")).toBe("C:\\Users\\me\\a.txt");
  });
});

describe("suffixedLocalDownloadPath", () => {
  it("inserts -<conn> before the extension", () => {
    const out = suffixedLocalDownloadPath(
      "/tmp/dl",
      "/var/log/app.log",
      "server-a",
    );
    expect(out).toBe("/tmp/dl/app-server-a.log");
  });

  it("preserves multi-dot extensions", () => {
    expect(
      suffixedLocalDownloadPath("/tmp", "/foo/bar.tar.gz", "srvA"),
    ).toBe("/tmp/bar-srvA.tar.gz");
  });

  it("handles directory remote paths (recursive case)", () => {
    expect(
      suffixedLocalDownloadPath("/tmp", "/var/lib/app/", "srv1"),
    ).toBe("/tmp/app-srv1");
  });

  it("sanitizes connection names", () => {
    expect(
      suffixedLocalDownloadPath("/tmp", "/etc/hosts", "weird/name"),
    ).toBe("/tmp/hosts-weird_name");
  });
});
