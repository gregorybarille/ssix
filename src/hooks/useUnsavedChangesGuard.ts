import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Generic unsaved-changes guard for dialog-style forms.
 *
 * Pattern: forms collect state in many useState hooks. Rather than
 * shoehorn them into a single object or wire a "dirty" boolean through
 * every onChange, the guard takes a `dirty` boolean (computed by the
 * caller — typically `JSON.stringify(snapshot) !== JSON.stringify(initial)`)
 * and intercepts close attempts:
 *
 * - `requestClose(close)` — call this from your Cancel button AND from
 *   `onOpenChange={(o) => !o && requestClose(() => onOpenChange(false))}`.
 *   When clean, runs `close()` immediately. When dirty, raises a confirm
 *   dialog; on confirm, runs `close()`; on cancel, does nothing.
 * - `confirmOpen` / `setConfirmOpen` — wire into a `<ConfirmDialog>`.
 * - `confirmDiscard()` — call from the dialog's `onConfirm`.
 *
 * The guard automatically suppresses itself for one tick after a
 * successful save (call `markSaved()` from your submit handler before
 * closing the dialog) so saving doesn't trigger the discard prompt.
 *
 * Window-level beforeunload protection is intentionally not added: this
 * runs inside Tauri (no browser tab to close) and the in-app guard is
 * sufficient.
 */
export function useUnsavedChangesGuard(dirty: boolean) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const pendingCloseRef = useRef<(() => void) | null>(null);
  // After a save we want the next close to be silent. We don't read
  // `dirty` because the parent may not have re-rendered yet.
  const skipNextRef = useRef(false);

  const requestClose = useCallback(
    (close: () => void) => {
      if (skipNextRef.current || !dirty) {
        skipNextRef.current = false;
        close();
        return;
      }
      pendingCloseRef.current = close;
      setConfirmOpen(true);
    },
    [dirty],
  );

  const confirmDiscard = useCallback(() => {
    setConfirmOpen(false);
    const close = pendingCloseRef.current;
    pendingCloseRef.current = null;
    close?.();
  }, []);

  const cancelDiscard = useCallback(() => {
    setConfirmOpen(false);
    pendingCloseRef.current = null;
  }, []);

  const markSaved = useCallback(() => {
    skipNextRef.current = true;
  }, []);

  // Reset internal state when the consuming dialog unmounts so a future
  // open starts clean.
  useEffect(() => {
    return () => {
      skipNextRef.current = false;
      pendingCloseRef.current = null;
    };
  }, []);

  return {
    requestClose,
    confirmOpen,
    confirmDiscard,
    cancelDiscard,
    markSaved,
  };
}
