import { create } from "zustand";
import type { NavItem } from "@/components/Sidebar";

/**
 * Audit-4 Phase 5d: view state was a single `useState` in App.tsx that
 * every store-bound action had to mutate via callbacks. Promoting it
 * to its own tiny store lets terminal/tunnel/dialog stores switch
 * views directly without prop-drilling setters or wiring custom
 * events back to App.
 */
interface ViewState {
  view: NavItem;
  setView: (view: NavItem) => void;
}

export const useViewStore = create<ViewState>((set) => ({
  view: "connections",
  setView: (view) => set({ view }),
}));
