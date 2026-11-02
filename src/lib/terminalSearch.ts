import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal as XTerm } from "@xterm/xterm";
import { searchHighlight } from "./terminalTheme";

/**
 * Each terminal's search, by session id, for the find bar. The
 * `terminalSearch` extension fills this in; `useTerminalSearchStore` says
 * which pane has its bar open.
 */
interface SearchablePane {
  term: XTerm;
  addon: SearchAddon;
}

const panes = new Map<string, SearchablePane>();

export function registerSearchablePane(sessionId: string, pane: SearchablePane): void {
  panes.set(sessionId, pane);
}

export function unregisterSearchablePane(sessionId: string): void {
  panes.delete(sessionId);
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
  const pane = panes.get(sessionId);
  if (!pane) return false;
  const decorations = searchHighlight(pane.term.options.theme ?? {});
  return direction === "next"
    ? pane.addon.findNext(query, { incremental, decorations })
    : pane.addon.findPrevious(query, { decorations });
}

/** Take the highlights and the selected match away. */
export function clearTerminalSearch(sessionId: string): void {
  const pane = panes.get(sessionId);
  if (!pane) return;
  pane.addon.clearDecorations();
  pane.term.clearSelection();
}

export function focusSearchablePane(sessionId: string): void {
  panes.get(sessionId)?.term.focus();
}

/** Follow a pane's result count. Returns a function that stops listening. */
export function onSearchResults(
  sessionId: string,
  listener: (results: SearchResults) => void,
): () => void {
  const subscription = panes
    .get(sessionId)
    ?.addon.onDidChangeResults(({ resultIndex, resultCount }) =>
      listener({ index: resultIndex, count: resultCount }),
    );
  return () => subscription?.dispose();
}
