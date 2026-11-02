import { create } from "zustand";
import { isPanelOpen } from "@/lib/focus";
import { activeSessionId } from "@/lib/terminalRegistry";
import { clearTerminalSearch, focusSearchablePane } from "@/lib/terminalSearch";

/**
 * The terminal find bar (Mod+F). One pane at a time has it open, and only a
 * pane the user can see: the bar closes when its pane is hidden.
 */
interface TerminalSearchState {
  /** The pane whose find bar is open. */
  sessionId: string | null;
  /** Grows with every `open`, so a bar already open takes the keyboard back. */
  focusRequest: number;
  /**
   * Open the find bar on the visible pane that last had focus. Does nothing
   * while a panel holds the keyboard, or when there is no such pane: see
   * `activeSessionId`.
   */
  open: () => void;
  /** Close the bar and clear its highlights. `refocus` returns the keyboard to the terminal. */
  close: (options?: { refocus?: boolean }) => void;
}

export const useTerminalSearchStore = create<TerminalSearchState>((set, get) => ({
  sessionId: null,
  focusRequest: 0,

  open: () => {
    if (isPanelOpen()) return;
    const target = activeSessionId();
    if (!target) return;
    const { sessionId: current, focusRequest } = get();
    if (current && current !== target) clearTerminalSearch(current);
    set({ sessionId: target, focusRequest: focusRequest + 1 });
  },

  close: ({ refocus = true } = {}) => {
    const { sessionId } = get();
    if (!sessionId) return;
    clearTerminalSearch(sessionId);
    set({ sessionId: null });
    if (refocus) focusSearchablePane(sessionId);
  },
}));
