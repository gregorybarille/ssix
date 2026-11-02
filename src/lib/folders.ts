import type { Connection } from "@/types";
import { isForwardConnection } from "./sshTerms";

/**
 * Folders: a connection's `folder` is a `/`-separated path (`prod/eu`), and a
 * folder exists only as a path on its connections.
 *
 * `parseFolderPath` holds the same rules as `src-tauri/src/folder_path.rs`,
 * for the form's inline errors; both are tested against
 * `src/test/fixtures/folder-paths.json`, which fails whichever side changes
 * alone. See `docs/folders.md`.
 */
const MAX_CHARS = 512;
const MAX_DEPTH = 10;

/** The tree's section for connections with no folder; no real path is blank. */
export const NO_FOLDER = "";

/** `path` is the stored form, or null for a blank path, which means no folder. */
export type FolderParse =
  | { path: string | null; error?: undefined }
  | { path?: undefined; error: string };

/**
 * Matches what the backend trims: Unicode White_Space. `String.trim` is not
 * the same set: it also takes U+FEFF.
 */
function trimSegment(segment: string): string {
  return segment.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}

function segmentsOf(raw: string): string[] {
  return raw.split(/[/\\]/).map(trimSegment).filter(Boolean);
}

/** The stored form of a typed path, or why it cannot be used. */
export function parseFolderPath(raw: string): FolderParse {
  if (/\p{Cc}/u.test(raw)) {
    return { error: "A folder path cannot contain control characters" };
  }
  const segments = segmentsOf(raw);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { error: "A folder cannot be named . or .." };
  }
  if (segments.length === 0) return { path: null };
  const path = segments.join("/");
  // The backend counts characters, not UTF-16 units.
  if ([...path].length > MAX_CHARS) {
    return { error: `A folder path can be at most ${MAX_CHARS} characters` };
  }
  if (segments.length > MAX_DEPTH) {
    return { error: `Folders can nest at most ${MAX_DEPTH} levels` };
  }
  return { path };
}

/** Whether `folder` is `path` or lies under it. `Prod` is not `prod`. */
export function isWithinFolder(folder: string, path: string): boolean {
  return folder === path || folder.startsWith(`${path}/`);
}

/** The folder holding `path`, null at the top. */
export function folderParent(path: string): string | null {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? null : path.slice(0, slash);
}

/** Why `to` cannot be `from`'s new path, as `check_rename` would refuse it. */
export function folderRenameError(from: string, to: string): string | null {
  const parsed = parseFolderPath(to);
  if (parsed.error !== undefined) return parsed.error;
  if (parsed.path === null) return "A folder path is required";
  if (parsed.path !== from && isWithinFolder(parsed.path, from)) {
    return "A folder cannot move inside itself";
  }
  return null;
}

/** Every folder the connections name or imply, sorted (`a/b` also gives `a`). */
export function knownFolderPaths(connections: Connection[]): string[] {
  const paths = new Set<string>();
  for (const { folder } of connections) {
    let path = folder ? segmentsOf(folder).join("/") : "";
    while (path) {
      paths.add(path);
      path = folderParent(path) ?? "";
    }
  }
  return [...paths].sort(compareNames);
}

/** Case and accents only break ties; numbers sort by value (`web2` < `web10`). */
function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }) || (a < b ? -1 : 1);
}

export interface FolderNode {
  path: string;
  /** The path's last segment. */
  name: string;
  folders: FolderNode[];
  connections: Connection[];
  /** Connections in this folder and every folder under it. */
  count: number;
}

export interface FolderTreeData {
  folders: FolderNode[];
  /** Connections with no folder. */
  unfiled: Connection[];
}

/** Group connections by path. Subfolders sort by name; connections keep their order. */
export function buildFolderTree(connections: Connection[]): FolderTreeData {
  const top: FolderNode[] = [];
  const unfiled: Connection[] = [];
  const nodes = new Map<string, FolderNode>();
  for (const connection of connections) {
    const segments = segmentsOf(connection.folder ?? "");
    if (segments.length === 0) {
      unfiled.push(connection);
      continue;
    }
    let siblings = top;
    let path = "";
    let node: FolderNode | undefined;
    for (const name of segments) {
      path = path ? `${path}/${name}` : name;
      node = nodes.get(path);
      if (!node) {
        node = { path, name, folders: [], connections: [], count: 0 };
        nodes.set(path, node);
        siblings.push(node);
      }
      node.count += 1;
      siblings = node.folders;
    }
    node?.connections.push(connection);
  }
  const sort = (folders: FolderNode[]) => {
    folders.sort((a, b) => compareNames(a.name, b.name));
    folders.forEach((folder) => sort(folder.folders));
  };
  sort(top);
  return { folders: top, unfiled };
}

interface TreeRowBase {
  /** Stable across moves, so React keeps a row's element and its focus. */
  key: string;
  /** What the tree announces and type-ahead matches. */
  label: string;
  level: number;
  posInSet: number;
  setSize: number;
  /** The row Left moves to; null at the top. */
  parentKey: string | null;
}

export interface FolderTreeFolderRow extends TreeRowBase {
  kind: "folder";
  /** {@link NO_FOLDER} for the section of connections with no folder. */
  path: string;
  count: number;
  open: boolean;
}

export interface FolderTreeConnectionRow extends TreeRowBase {
  kind: "connection";
  connection: Connection;
}

export type FolderTreeRow = FolderTreeFolderRow | FolderTreeConnectionRow;

export const folderRowKey = (path: string) => `folder:${path}`;
export const connectionRowKey = (id: string) => `connection:${id}`;

interface FlattenOptions {
  isOpen: (path: string) => boolean;
  /** Keep the no-folder section with nothing in it, as a place to drop on. */
  keepEmptySection: boolean;
}

/**
 * The rows on screen, in order, as one flat list for roving focus. The nesting
 * reaches assistive technology through `aria-level`, `aria-posinset` and
 * `aria-setsize`; a flat list also lets a row keep its element when it moves.
 */
export function flattenFolderTree(
  tree: FolderTreeData,
  { isOpen, keepEmptySection }: FlattenOptions,
): FolderTreeRow[] {
  const rows: FolderTreeRow[] = [];
  const addConnections = (
    connections: Connection[],
    level: number,
    parentKey: string | null,
    before: number,
    setSize: number,
  ) => {
    connections.forEach((connection, index) => {
      rows.push({
        kind: "connection",
        key: connectionRowKey(connection.id),
        label: connection.name,
        connection,
        level,
        posInSet: before + index + 1,
        setSize,
        parentKey,
      });
    });
  };
  const addFolder = (
    node: FolderNode,
    level: number,
    parentKey: string | null,
    posInSet: number,
    setSize: number,
  ) => {
    const key = folderRowKey(node.path);
    const open = isOpen(node.path);
    rows.push({
      kind: "folder",
      key,
      label: node.name,
      path: node.path,
      count: node.count,
      open,
      level,
      posInSet,
      setSize,
      parentKey,
    });
    if (!open) return;
    const children = node.folders.length + node.connections.length;
    node.folders.forEach((child, index) => addFolder(child, level + 1, key, index + 1, children));
    addConnections(node.connections, level + 1, key, node.folders.length, children);
  };

  const hasSection = tree.unfiled.length > 0 || keepEmptySection;
  const topSize = tree.folders.length + (hasSection ? 1 : 0);
  tree.folders.forEach((node, index) => addFolder(node, 1, null, index + 1, topSize));
  if (hasSection) {
    const key = folderRowKey(NO_FOLDER);
    const open = isOpen(NO_FOLDER);
    rows.push({
      kind: "folder",
      key,
      label: "No folder",
      path: NO_FOLDER,
      count: tree.unfiled.length,
      open,
      level: 1,
      posInSet: topSize,
      setSize: topSize,
      parentKey: null,
    });
    if (open) addConnections(tree.unfiled, 2, key, 0, tree.unfiled.length);
  }
  return rows;
}

/**
 * Type-ahead: the first row after `from`, wrapping around, whose label starts
 * with `text`; -1 when there is none. While a word is being typed the current
 * row may match too, so it does not jump away from a row it still fits.
 */
export function typeaheadMatch(labels: string[], from: number, text: string): number {
  const prefix = text.toLowerCase();
  const start = prefix.length > 1 ? from : from + 1;
  for (let offset = 0; offset < labels.length; offset++) {
    const index = (start + offset) % labels.length;
    if (labels[index].toLowerCase().startsWith(prefix)) return index;
  }
  return -1;
}

/** How many connections a rename or delete of `path` touches, by what they are. */
export function folderContents(
  connections: Connection[],
  path: string,
): { shells: number; forwards: number } {
  let shells = 0;
  let forwards = 0;
  for (const connection of connections) {
    if (!connection.folder || !isWithinFolder(connection.folder, path)) continue;
    if (isForwardConnection(connection)) forwards += 1;
    else shells += 1;
  }
  return { shells, forwards };
}

export const pluralConnections = (count: number) =>
  `${count} ${count === 1 ? "connection" : "connections"}`;

/** "3 connections", or "3 connections and 1 port forward" when a forward is filed too. */
export function describeFolderContents({ shells, forwards }: { shells: number; forwards: number }) {
  if (forwards === 0) return pluralConnections(shells);
  return `${pluralConnections(shells)} and ${forwards} ${forwards === 1 ? "port forward" : "port forwards"}`;
}

const COLLAPSED_KEY = "ssix.folders.collapsed";

/**
 * Which folders this viewer has collapsed, a convenience kept in the webview's
 * storage. Everything starts open, so empty or corrupt storage just means that.
 */
export function loadCollapsedFolders(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((path): path is string => typeof path === "string"));
  } catch {
    return new Set();
  }
}

export function saveCollapsedFolders(collapsed: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Storage can be full or blocked; the tree just opens fully next time.
  }
}

/** `collapsed` after `from` and its subfolders moved to `to` (null: went away). */
export function collapsedAfterMove(
  collapsed: Set<string>,
  from: string,
  to: string | null,
): Set<string> {
  const next = new Set<string>();
  for (const path of collapsed) {
    if (path === NO_FOLDER || !isWithinFolder(path, from)) next.add(path);
    else if (to !== null) next.add(`${to}${path.slice(from.length)}`);
  }
  return next;
}

/**
 * `collapsed` after a rename. The folder keeps its own state where it lands,
 * but everything above it opens so that it can be seen. Merging into a folder
 * opens that too: what moved would otherwise be out of sight inside it.
 */
export function collapsedAfterRename(
  collapsed: Set<string>,
  from: string,
  to: string,
  merges: boolean,
): Set<string> {
  const moved = collapsedAfterMove(collapsed, from, to);
  if (merges) return collapsedWithRevealed(moved, to);
  const parent = folderParent(to);
  return parent === null ? moved : collapsedWithRevealed(moved, parent);
}

/** `collapsed` after deleting `path`, with the place its contents moved to open. */
export function collapsedAfterDelete(collapsed: Set<string>, path: string): Set<string> {
  return collapsedWithRevealed(collapsedAfterMove(collapsed, path, null), folderParent(path));
}

/** `collapsed` with `path` and every folder above it open, so `path` shows. */
export function collapsedWithRevealed(collapsed: Set<string>, path: string | null): Set<string> {
  const next = new Set(collapsed);
  if (path === null) {
    next.delete(NO_FOLDER);
    return next;
  }
  let current: string | null = path;
  while (current !== null) {
    next.delete(current);
    current = folderParent(current);
  }
  return next;
}
