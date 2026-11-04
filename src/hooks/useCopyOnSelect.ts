import { useEffect } from "react";
import { useSettingsStore } from "@/store/useSettingsStore";

/**
 * Editable: selecting there is how you paste over a field's text, and it could
 * be a password. A terminal has its own extension, `terminal/autoCopySelection.ts`.
 */
const NOT_COPIED = "input, textarea, [contenteditable], .xterm";

function isExcluded(node: EventTarget | null): boolean {
  if (!(node instanceof Node)) return false;
  const element = node instanceof Element ? node : node.parentElement;
  return !!element?.closest(NOT_COPIED);
}

/**
 * Opt-in copy on select (`settings.auto_copy_selection`) for the app outside its
 * terminals. It copies when a selection is finished, on pointer up or key up, and
 * only one that differs from the last time: any key or click would otherwise put
 * a selection still showing back over what was copied elsewhere since.
 *
 * shortcut: dragging over exactly the same text again does not copy it again.
 * `selectionchange` could tell, but it can arrive after a quick pointer up, and
 * would then copy on whatever comes next. Upgrade if anyone is caught out by this.
 */
export function useCopyOnSelect() {
  useEffect(() => {
    let last: unknown[] = [];
    const copy = (event: Event) => {
      const selection = window.getSelection();
      if (!selection) return;
      const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
      const current = [anchorNode, anchorOffset, focusNode, focusOffset];
      const changed = current.some((value, i) => value !== last[i]);
      last = current;
      if (!changed) return;
      // On macOS a right-click selects the word under it, which nobody chose to copy.
      if ((event as PointerEvent).button > 0) return;
      if (!useSettingsStore.getState().settings.auto_copy_selection) return;
      // A field's own selection is not always in `getSelection`, so ask where focus is.
      const inside = [event.target, document.activeElement, anchorNode, focusNode];
      if (inside.some(isExcluded)) return;
      const text = selection.toString();
      if (text.trim()) navigator.clipboard.writeText(text).catch(() => {});
    };
    // Capture, so a handler stopping these events cannot hide a selection's end.
    document.addEventListener("pointerup", copy, true);
    document.addEventListener("keyup", copy, true);
    return () => {
      document.removeEventListener("pointerup", copy, true);
      document.removeEventListener("keyup", copy, true);
    };
  }, []);
}
