import { SearchAddon } from "@xterm/addon-search";
import { FIND_COMBO, normalizeEvent } from "@/hooks/useGlobalShortcuts";
import {
  registerSearchablePane,
  SEARCH_HIGHLIGHT_LIMIT,
  unregisterSearchablePane,
} from "@/lib/terminalSearch";
import { useTerminalSearchStore } from "@/store/useTerminalSearchStore";
import type { TerminalExtension } from "./extensions";

/**
 * Search in a terminal's scrollback. The find bar itself is
 * `TerminalSearchBar`; this gives every terminal its addon, and keeps the
 * shortcut from a program in the terminal: xterm handles keys before the
 * window's shortcut listener sees them.
 */
export const terminalSearch: TerminalExtension = {
  id: "terminal-search",
  onCreate({ term, sessionId }) {
    // The addon highlights through decorations, a proposed xterm API.
    term.options.allowProposedApi = true;
    const addon = new SearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT });
    term.loadAddon(addon);
    registerSearchablePane(sessionId, addon);
    return () => {
      const search = useTerminalSearchStore.getState();
      if (search.sessionId === sessionId) search.close({ refocus: false });
      unregisterSearchablePane(sessionId);
    };
  },
  onKey(_ctx, event) {
    return normalizeEvent(event) !== FIND_COMBO;
  },
};
