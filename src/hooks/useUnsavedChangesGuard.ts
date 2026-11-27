import { useCallback, useRef, useState } from "react";

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
 * A successful save closes the form directly, not through `requestClose`,
 * so it never asks.
 *
 * Window-level beforeunload protection is intentionally not added: this
 * runs inside Tauri (no browser tab to close) and the in-app guard is
 * sufficient.
 */
export function useUnsavedChangesGuard(dirty: boolean) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const pendingCloseRef = useRef<(() => void) | null>(null);

  const requestClose = useCallback(
    (close: () => void) => {
      if (!dirty) {
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

  return {
    requestClose,
    confirmOpen,
    confirmDiscard,
    cancelDiscard,
  };
}
