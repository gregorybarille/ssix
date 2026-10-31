import { create } from "zustand";
import type { NavItem } from "@/components/Sidebar";
import type { FormSwitchGuard } from "@/store/useDialogsStore";

/**
 * Audit-4 Phase 5d: view state was a single `useState` in App.tsx that
 * every store-bound action had to mutate via callbacks. Promoting it
 * to its own tiny store lets terminal/port forward/dialog stores switch
 * views directly without prop-drilling setters or wiring custom
 * events back to App.
 */
interface ViewState {
  view: NavItem;
  /**
   * Registered by the open editor (see `useLeaveViewGuard`): leaving its
   * view goes through it, so unsaved changes are not dropped silently.
   */
  leaveGuard: FormSwitchGuard | null;
  setView: (view: NavItem) => void;
  setLeaveGuard: (guard: FormSwitchGuard | null) => void;
}

export const useViewStore = create<ViewState>((set, get) => ({
  view: "connections",
  leaveGuard: null,
  setView: (view) => {
    const { view: current, leaveGuard } = get();
    if (view !== current && leaveGuard) leaveGuard(() => set({ view }));
    else set({ view });
  },
  setLeaveGuard: (leaveGuard) => set({ leaveGuard }),
}));
