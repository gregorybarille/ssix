import { beforeEach, describe, expect, it } from "vitest";
import {
  NO_FOLDER,
  buildFolderTree,
  collapsedAfterMove,
  collapsedWithRevealed,
  connectionRowKey,
  describeFolderContents,
  flattenFolderTree,
  folderContents,
  folderParent,
  folderRenameError,
  folderRowKey,
  isWithinFolder,
  knownFolderPaths,
  loadCollapsedFolders,
  parseFolderPath,
  saveCollapsedFolders,
  typeaheadMatch,
  type FolderTreeFolderRow,
} from "@/lib/folders";
import type { Connection } from "@/types";
import fixture from "./fixtures/folder-paths.json";

const direct = (name: string, folder?: string): Connection => ({
  id: name,
  name,
  host: "h",
  port: 22,
  type: "direct",
  folder,
});

const forward = (name: string, folder?: string): Connection => ({
  id: name,
  name,
  host: "",
  port: 22,
  type: "dynamic_forward",
  gateway_host: "gw",
  gateway_port: 22,
  gateway_credential_id: "k",
  local_port: 1080,
  folder,
});

interface PathCase {
  input?: string;
  repeat?: { text: string; times: number };
  path?: string;
  unset?: boolean;
  same?: boolean;
  error?: string;
}

const inputOf = (c: PathCase) => c.input ?? c.repeat!.text.repeat(c.repeat!.times);

/**
 * `src-tauri/src/folder_path.rs` reads the same fixture, so a rule changed on
 * one side only fails that side's test.
 */
describe("folder paths agree with the backend", () => {
  it.each((fixture.cases as PathCase[]).map((c) => [JSON.stringify(c.input ?? c.repeat), c]))(
    "%s",
    (_, c) => {
      const case_ = c as PathCase;
      const input = inputOf(case_);
      const parsed = parseFolderPath(input);
      if (case_.error) {
        expect(parsed).toEqual({ error: case_.error });
      } else if (case_.unset) {
        expect(parsed).toEqual({ path: null });
      } else {
        expect(parsed).toEqual({ path: case_.same ? input : case_.path });
      }
    },
  );

  it.each(fixture.renames.map((c) => [`${c.from} to ${JSON.stringify(c.to)}`, c] as const))(
    "rename %s",
    (_, c) => {
      expect(folderRenameError(c.from, c.to)).toBe(c.error ?? null);
    },
  );

  it("is exercised by every kind of outcome", () => {
    const cases = fixture.cases as PathCase[];
    expect(cases.some((c) => c.error)).toBe(true);
    expect(cases.some((c) => c.unset)).toBe(true);
    expect(cases.some((c) => c.same)).toBe(true);
    expect(cases.some((c) => c.path)).toBe(true);
  });
});

describe("path helpers", () => {
  it("compares whole segments, case-sensitively", () => {
    expect(isWithinFolder("prod", "prod")).toBe(true);
    expect(isWithinFolder("prod/eu", "prod")).toBe(true);
    expect(isWithinFolder("production", "prod")).toBe(false);
    expect(isWithinFolder("Prod/eu", "prod")).toBe(false);
    expect(isWithinFolder("prod", "prod/eu")).toBe(false);
  });

  it("finds the parent", () => {
    expect(folderParent("prod/eu/west")).toBe("prod/eu");
    expect(folderParent("prod")).toBeNull();
  });

  it("lists every folder a path implies, once, whatever the connection kind", () => {
    expect(
      knownFolderPaths([
        direct("a", "prod/eu/west"),
        direct("b", "prod"),
        forward("c", "tunnels"),
        direct("d"),
      ]),
    ).toEqual(["prod", "prod/eu", "prod/eu/west", "tunnels"]);
  });

  it("keeps folders that differ only by case apart", () => {
    expect(knownFolderPaths([direct("a", "Prod"), direct("b", "prod")])).toEqual([
      "Prod",
      "prod",
    ]);
  });
});

describe("buildFolderTree", () => {
  it("nests by path and counts everything under a folder", () => {
    const tree = buildFolderTree([
      direct("top", "prod"),
      direct("eu1", "prod/eu"),
      direct("eu2", "prod/eu"),
      direct("west", "prod/eu/west"),
      direct("loose"),
    ]);
    expect(tree.unfiled.map((c) => c.name)).toEqual(["loose"]);
    expect(tree.folders).toHaveLength(1);
    const prod = tree.folders[0];
    expect(prod).toMatchObject({ path: "prod", name: "prod", count: 4 });
    expect(prod.connections.map((c) => c.name)).toEqual(["top"]);
    const eu = prod.folders[0];
    expect(eu).toMatchObject({ path: "prod/eu", name: "eu", count: 3 });
    expect(eu.connections.map((c) => c.name)).toEqual(["eu1", "eu2"]);
    expect(eu.folders[0]).toMatchObject({ path: "prod/eu/west", name: "west", count: 1 });
  });

  it("sorts folders by name, numbers by value, and keeps connection order", () => {
    const tree = buildFolderTree([
      direct("z", "web10"),
      direct("y", "web2"),
      direct("x", "Alpha"),
      direct("w", "web2"),
    ]);
    expect(tree.folders.map((f) => f.path)).toEqual(["Alpha", "web2", "web10"]);
    expect(tree.folders[1].connections.map((c) => c.name)).toEqual(["y", "w"]);
  });

  it("treats a differently cased folder as another folder", () => {
    const tree = buildFolderTree([direct("a", "Prod"), direct("b", "prod")]);
    expect(tree.folders.map((f) => [f.path, f.count])).toEqual([
      ["Prod", 1],
      ["prod", 1],
    ]);
  });

  it("is safe with folder names that are also object keys", () => {
    const tree = buildFolderTree([
      direct("a", "__proto__/constructor"),
      direct("b", "constructor"),
    ]);
    expect(tree.folders.map((f) => f.path).sort()).toEqual(["__proto__", "constructor"]);
    expect(tree.folders.find((f) => f.path === "__proto__")?.folders[0].path).toBe(
      "__proto__/constructor",
    );
  });

  it("files a blank or slashes-only path under no folder", () => {
    const tree = buildFolderTree([direct("a", ""), direct("b", " / ")]);
    expect(tree.folders).toEqual([]);
    expect(tree.unfiled.map((c) => c.name)).toEqual(["a", "b"]);
  });
});

describe("flattenFolderTree", () => {
  const tree = buildFolderTree([
    direct("top", "prod"),
    direct("eu1", "prod/eu"),
    direct("loose"),
  ]);
  const allOpen = { isOpen: () => true, keepEmptySection: true };

  it("lists rows in order with the ARIA position of each", () => {
    const rows = flattenFolderTree(tree, allOpen);
    expect(rows.map((r) => r.key)).toEqual([
      folderRowKey("prod"),
      folderRowKey("prod/eu"),
      connectionRowKey("eu1"),
      connectionRowKey("top"),
      folderRowKey(NO_FOLDER),
      connectionRowKey("loose"),
    ]);
    expect(rows.map((r) => [r.level, r.posInSet, r.setSize])).toEqual([
      [1, 1, 2],
      [2, 1, 2],
      [3, 1, 1],
      [2, 2, 2],
      [1, 2, 2],
      [2, 1, 1],
    ]);
    expect(rows.map((r) => r.parentKey)).toEqual([
      null,
      folderRowKey("prod"),
      folderRowKey("prod/eu"),
      folderRowKey("prod"),
      null,
      folderRowKey(NO_FOLDER),
    ]);
  });

  it("leaves out what a closed folder holds", () => {
    const rows = flattenFolderTree(tree, {
      isOpen: (path) => path !== "prod",
      keepEmptySection: true,
    });
    expect(rows.map((r) => r.key)).toEqual([
      folderRowKey("prod"),
      folderRowKey(NO_FOLDER),
      connectionRowKey("loose"),
    ]);
    expect((rows[0] as FolderTreeFolderRow).open).toBe(false);
  });

  it("keeps an empty no-folder section only when asked", () => {
    const filed = buildFolderTree([direct("top", "prod")]);
    const withSection = flattenFolderTree(filed, allOpen);
    expect(withSection.at(-1)).toMatchObject({ path: NO_FOLDER, count: 0 });
    const without = flattenFolderTree(filed, { ...allOpen, keepEmptySection: false });
    expect(without.map((r) => r.key)).toEqual([folderRowKey("prod"), connectionRowKey("top")]);
    expect(without[0]).toMatchObject({ posInSet: 1, setSize: 1 });
  });
});

describe("typeaheadMatch", () => {
  const labels = ["alpha", "beta", "Bravo", "gamma"];

  it("finds the next row starting with a key, wrapping around", () => {
    expect(typeaheadMatch(labels, 0, "b")).toBe(1);
    expect(typeaheadMatch(labels, 1, "b")).toBe(2);
    expect(typeaheadMatch(labels, 2, "b")).toBe(1);
    expect(typeaheadMatch(labels, 3, "a")).toBe(0);
  });

  it("stays on a row a longer word still fits", () => {
    expect(typeaheadMatch(labels, 2, "br")).toBe(2);
  });

  it("reports no match", () => {
    expect(typeaheadMatch(labels, 0, "z")).toBe(-1);
  });
});

describe("folderContents", () => {
  const connections = [
    direct("a", "prod"),
    direct("b", "prod/eu"),
    forward("c", "prod/eu"),
    direct("d", "production"),
    direct("e"),
  ];

  it("counts a folder and its subfolders, keeping forwards apart", () => {
    expect(folderContents(connections, "prod")).toEqual({ shells: 2, forwards: 1 });
    expect(folderContents(connections, "prod/eu")).toEqual({ shells: 1, forwards: 1 });
  });

  it("names a forward only when one is affected", () => {
    expect(describeFolderContents({ shells: 2, forwards: 0 })).toBe("2 connections");
    expect(describeFolderContents({ shells: 1, forwards: 0 })).toBe("1 connection");
    expect(describeFolderContents({ shells: 2, forwards: 1 })).toBe(
      "2 connections and 1 port forward",
    );
    expect(describeFolderContents({ shells: 1, forwards: 2 })).toBe(
      "1 connection and 2 port forwards",
    );
  });
});

describe("remembered folders", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips", () => {
    saveCollapsedFolders(new Set(["prod", NO_FOLDER]));
    expect(loadCollapsedFolders()).toEqual(new Set(["prod", NO_FOLDER]));
  });

  it("starts empty", () => {
    expect(loadCollapsedFolders()).toEqual(new Set());
  });

  it.each([
    ["not JSON", "{oops"],
    ["an object", '{"prod":true}'],
    ["a number", "7"],
    ["null", "null"],
  ])("survives %s", (_, stored) => {
    localStorage.setItem("ssix.folders.collapsed", stored);
    expect(loadCollapsedFolders()).toEqual(new Set());
  });

  it("drops entries that are not paths", () => {
    localStorage.setItem("ssix.folders.collapsed", '["prod", 3, null, {"a":1}]');
    expect(loadCollapsedFolders()).toEqual(new Set(["prod"]));
  });

  it("survives storage that throws", () => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(loadCollapsedFolders()).toEqual(new Set());
      expect(() => saveCollapsedFolders(new Set(["prod"]))).not.toThrow();
    } finally {
      Storage.prototype.getItem = getItem;
      Storage.prototype.setItem = setItem;
    }
  });

  it("follows a rename, including subfolders, and forgets a deleted folder", () => {
    const collapsed = new Set(["prod", "prod/eu", "production", NO_FOLDER]);
    expect(collapsedAfterMove(collapsed, "prod", "staging")).toEqual(
      new Set(["staging", "staging/eu", "production", NO_FOLDER]),
    );
    expect(collapsedAfterMove(collapsed, "prod", null)).toEqual(
      new Set(["production", NO_FOLDER]),
    );
  });

  it("reveals a folder by opening it and everything above it", () => {
    const collapsed = new Set(["prod", "prod/eu", "prod/eu/west", "other", NO_FOLDER]);
    expect(collapsedWithRevealed(collapsed, "prod/eu")).toEqual(
      new Set(["prod/eu/west", "other", NO_FOLDER]),
    );
    expect(collapsedWithRevealed(collapsed, null)).toEqual(
      new Set(["prod", "prod/eu", "prod/eu/west", "other"]),
    );
  });
});
