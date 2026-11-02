import { SearchAddon } from "@xterm/addon-search";
import { normalizeEvent } from "@/hooks/useGlobalShortcuts";
import {
  registerSearchablePane,
  SEARCH_HIGHLIGHT_LIMIT,
  unregisterSearchablePane,
} from "@/lib/terminalSearch";
import { useTerminalSearchStore } from "@/store/useTerminalSearchStore";
import type { TerminalExtension } from "./extensions";

/** Normalized as in `SHORTCUTS`, which opens the find bar. */
const FIND_SHORTCUT = "mod+f";

/**
 * Search in a terminal's scrollback. The find bar itself is
 * `TerminalSearchBar`; this gives every terminal its addon, and keeps Mod+F
 * from a program in the terminal: xterm handles keys before the window's
 * shortcut listener sees them, and would send Ctrl+F on to the shell.
 */
export const terminalSearch: TerminalExtension = {
  id: "terminal-search",
  onCreate({ term, sessionId }) {
    // The addon highlights through decorations, a proposed xterm API.
    term.options.allowProposedApi = true;
    const addon = new SearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT });
    term.loadAddon(addon);
    registerSearchablePane(sessionId, { term, addon });
    return () => {
      const search = useTerminalSearchStore.getState();
      if (search.sessionId === sessionId) search.close({ refocus: false });
      unregisterSearchablePane(sessionId);
    };
  },
  onKey(_ctx, event) {
    return normalizeEvent(event) !== FIND_SHORTCUT;
  },
};
