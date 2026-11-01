import type { IDisposable } from "@xterm/xterm";
import type { TerminalExtension, TerminalExtensionContext } from "./extensions";

const listeners = new WeakMap<TerminalExtensionContext, IDisposable>();

/**
 * Opt-in auto-copy (`settings.auto_copy_selection`, off by default): classic
 * xterm behaviour of copying every selection immediately. The setting is read
 * on each selection, so the toggle takes effect without remounting.
 */
export const autoCopySelection: TerminalExtension = {
  id: "auto-copy-selection",
  onCreate(ctx) {
    const listener = ctx.term.onSelectionChange(() => {
      if (!ctx.settings?.auto_copy_selection) return;
      const selection = ctx.term.getSelection();
      if (selection) navigator.clipboard.writeText(selection).catch(() => {});
    });
    listeners.set(ctx, listener);
  },
  dispose(ctx) {
    listeners.get(ctx)?.dispose();
    listeners.delete(ctx);
  },
};
