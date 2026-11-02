import { useTerminalSearchStore } from "@/store/useTerminalSearchStore";
import type { TerminalExtension } from "./extensions";

/**
 * Opt-in auto-copy (`settings.auto_copy_selection`, off by default): classic
 * xterm behaviour of copying every selection immediately. The setting is read
 * on each selection, so the toggle takes effect without remounting. A search
 * selects each match it moves to, which is not the user selecting anything, so
 * this leaves the clipboard alone while the pane's find bar is open.
 */
export const autoCopySelection: TerminalExtension = {
  id: "auto-copy-selection",
  onCreate(ctx) {
    const listener = ctx.term.onSelectionChange(() => {
      if (!ctx.settings?.auto_copy_selection) return;
      if (useTerminalSearchStore.getState().sessionId === ctx.sessionId) return;
      const selection = ctx.term.getSelection();
      if (selection) navigator.clipboard.writeText(selection).catch(() => {});
    });
    return () => listener.dispose();
  },
};
