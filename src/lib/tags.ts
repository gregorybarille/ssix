import type { Connection } from "@/types";

/**
 * Sentinel "tag" key used to bucket connections that have no tags
 * defined. Picked to be unrepresentable as a real user-typed tag
 * (`normalize_tags` on the Rust side trims whitespace and drops
 * empties, so a leading null sentinel can never collide). The
 * presentation layer maps this to the localized "Untagged" label.
 */
export const UNTAGGED_KEY = "\u0000__untagged__";

/** A grouping of connections that share a tag. */
export interface TagGroup {
  /** Internal key — the raw tag string, or {@link UNTAGGED_KEY}. */
  key: string;
  /** User-facing label ("Untagged" for the sentinel, otherwise the tag). */
  label: string;
  /** All connections that carry this tag (or are untagged). */
  connections: Connection[];
}

/**
 * Bucket connections by tag. A connection with multiple tags is
 * intentionally listed under each of its tags (this is what makes
 * tag-based bulk actions natural — operating on the `prod` group
 * should hit every prod host even if some are also tagged `db`).
 *
 * Connections with no tags are collected into a single
 * {@link UNTAGGED_KEY} bucket and only included in the result when
 * `includeUntagged` is true (default).
 *
 * Groups are returned sorted alphabetically by label, with the
 * Untagged bucket — when present — pinned to the end so it doesn't
 * push real tags around when names start with leading punctuation.
 */
export function groupConnectionsByTag(
  connections: Connection[],
  includeUntagged = true,
): TagGroup[] {
  const buckets = new Map<string, Connection[]>();
  for (const conn of connections) {
    const tags = conn.tags ?? [];
    if (tags.length === 0) {
      if (!includeUntagged) continue;
      const list = buckets.get(UNTAGGED_KEY) ?? [];
      list.push(conn);
      buckets.set(UNTAGGED_KEY, list);
      continue;
    }
    for (const tag of tags) {
      const list = buckets.get(tag) ?? [];
      list.push(conn);
      buckets.set(tag, list);
    }
  }

  const groups: TagGroup[] = [];
  let untagged: TagGroup | null = null;
  for (const [key, conns] of buckets) {
    const group: TagGroup = {
      key,
      label: key === UNTAGGED_KEY ? "Untagged" : key,
      connections: conns,
    };
    if (key === UNTAGGED_KEY) untagged = group;
    else groups.push(group);
  }
  groups.sort((a, b) => a.label.localeCompare(b.label));
  if (untagged) groups.push(untagged);
  return groups;
}

/**
 * Filter a list of tag groups by a free-text query that matches the
 * group label only (i.e. the tag itself). Empty/whitespace queries
 * pass everything through untouched.
 */
export function filterTagGroups(
  groups: TagGroup[],
  query: string,
): TagGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups.filter((g) => g.label.toLowerCase().includes(q));
}

/**
 * Replace every character that is unsafe in a filename across the
 * three big platforms (POSIX, macOS, Windows) with `_`. The set
 * covers POSIX path separators, Windows reserved characters
 * (`<>:"/\\|?*`), control codes, and trims leading/trailing dots
 * + whitespace (Windows refuses to create those). An all-empty
 * result falls back to `"host"` so callers always get a usable
 * disambiguator.
 */
export function sanitizeFilenameSegment(input: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = input
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  return cleaned.length > 0 ? cleaned : "host";
}

/**
 * Split a basename into its `[stem, ext]` pair, where `ext`
 * preserves the leading dot (or is empty). Hidden files like
 * `.env` are treated as stem-only — the leading dot is part of
 * the name, not an extension. Multi-dot files (`foo.tar.gz`) keep
 * everything after the FIRST dot as the extension so suffixed
 * names round-trip cleanly: `foo.tar.gz` → `foo-srvA.tar.gz`.
 */
export function splitBasename(name: string): [string, string] {
  if (!name) return ["", ""];
  // Hidden / dotfile: no extension to split off.
  if (name.startsWith(".") && name.lastIndexOf(".") === 0) {
    return [name, ""];
  }
  const firstDot = name.indexOf(".", 1);
  if (firstDot === -1) return [name, ""];
  return [name.slice(0, firstDot), name.slice(firstDot)];
}

/**
 * Detect whether the given path uses Windows-style backslash
 * separators. Used to choose the right separator when joining
 * a target directory with a per-host filename. We don't try to
 * guess from `process.platform` — the user's typed string is
 * authoritative.
 */
function isWindowsPath(p: string): boolean {
  return /\\/.test(p) && !/\//.test(p);
}

/**
 * Join a directory with a filename using the directory's apparent
 * path style (Windows backslash vs POSIX forward-slash). Trailing
 * separators on `dir` are collapsed.
 */
export function joinPath(dir: string, name: string): string {
  const sep = isWindowsPath(dir) ? "\\" : "/";
  const trimmed = dir.replace(/[\\/]+$/g, "");
  return `${trimmed}${sep}${name}`;
}

/**
 * Compute the per-host local destination for a bulk download.
 *
 * Given:
 *  - `localDir`     — the user-chosen directory on disk,
 *  - `remotePath`   — the source path on the remote host,
 *  - `connectionName` — the connection display name (used as the
 *                       per-host suffix; see {@link sanitizeFilenameSegment}).
 *
 * The result is `<localDir>/<basename>-<sanitized-name>[.ext]` where
 * the basename is derived from the remote path's last segment. For
 * recursive directory transfers the suffix is applied to the
 * top-level folder (no `.ext` to worry about), so per-host downloads
 * land in `mydir-<conn>/...` side-by-side under `localDir`.
 *
 * The function does no I/O — callers feed the result straight into
 * `scp_download`'s `local_path` field.
 */
export function suffixedLocalDownloadPath(
  localDir: string,
  remotePath: string,
  connectionName: string,
): string {
  const remoteBasename =
    remotePath
      .replace(/[\\/]+$/g, "")
      .split(/[\\/]/)
      .pop() ?? "download";
  const safeBase = remoteBasename.length > 0 ? remoteBasename : "download";
  const suffix = sanitizeFilenameSegment(connectionName);
  const [stem, ext] = splitBasename(safeBase);
  const finalName = `${stem}-${suffix}${ext}`;
  return joinPath(localDir, finalName);
}
