import type { SearchAddon } from "@xterm/addon-search";
import { registeredTerminal } from "./terminalRegistry";
import { searchHighlight } from "./terminalTheme";

/**
 * Each terminal's search, by session id, for the find bar. The
 * `terminalSearch` extension fills this in; `useTerminalSearchStore` says
 * which pane has its bar open.
 */
const addons = new Map<string, SearchAddon>();

export function registerSearchablePane(sessionId: string, addon: SearchAddon): void {
  addons.set(sessionId, addon);
}

export function unregisterSearchablePane(sessionId: string): void {
  addons.delete(sessionId);
}

export interface SearchResults {
  /** Index of the active match; -1 when there are too many to number. */
  index: number;
  count: number;
}

/** Matches the addon highlights and counts. It can still move beyond them. */
export const SEARCH_HIGHLIGHT_LIMIT = 1000;

export type SearchDirection = "next" | "previous";

/**
 * Move to the next or previous match of `query`, highlighting all of them.
 * `incremental` is for a query being typed: it stays on a match that still
 * fits instead of moving on. Returns whether anything matched.
 */
export function findInTerminal(
  sessionId: string,
  query: string,
  direction: SearchDirection,
  incremental = false,
): boolean {
  const addon = addons.get(sessionId);
  if (!addon) return false;
  const decorations = searchHighlight(registeredTerminal(sessionId)?.options.theme ?? {});
  return direction === "next"
    ? addon.findNext(query, { incremental, decorations })
    : addon.findPrevious(query, { decorations });
}

/** Take the highlights and the selected match away. */
export function clearTerminalSearch(sessionId: string): void {
  const addon = addons.get(sessionId);
  if (!addon) return;
  addon.clearDecorations();
  registeredTerminal(sessionId)?.clearSelection();
}

/** Follow a pane's result count. Returns a function that stops listening. */
export function onSearchResults(
  sessionId: string,
  listener: (results: SearchResults) => void,
): () => void {
  const subscription = addons
    .get(sessionId)
    ?.onDidChangeResults(({ resultIndex, resultCount }) =>
      listener({ index: resultIndex, count: resultCount }),
    );
  return () => subscription?.dispose();
}
