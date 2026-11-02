import { create } from "zustand";

/** The link a terminal's mouse is over, and the link waiting for a yes before it opens. */
interface TerminalLinksState {
  hover: { sessionId: string; url: string } | null;
  /** A link whose target is not simply what the terminal shows. See `terminalLinks.ts`. */
  confirming: URL | null;
  setHover: (hover: { sessionId: string; url: string } | null) => void;
  clearHover: (sessionId: string) => void;
  setConfirming: (url: URL | null) => void;
}

export const useTerminalLinksStore = create<TerminalLinksState>((set, get) => ({
  hover: null,
  confirming: null,
  setHover: (hover) => set({ hover }),
  clearHover: (sessionId) => {
    if (get().hover?.sessionId === sessionId) set({ hover: null });
  },
  setConfirming: (confirming) => set({ confirming }),
}));
