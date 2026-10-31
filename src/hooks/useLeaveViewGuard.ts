import { useEffect, useRef } from "react";
import { useViewStore } from "@/store/useViewStore";
import type { FormSwitchGuard } from "@/store/useDialogsStore";

/**
 * While `active`, switching to another view first goes through
 * `requestClose` (from `useUnsavedChangesGuard`): a clean editor closes
 * and the view changes at once, a dirty one asks before discarding, and
 * "keep editing" stays on the view.
 */
export function useLeaveViewGuard(
  active: boolean,
  requestClose: (close: () => void) => void,
  close: () => void,
) {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!active) return;
    const guard: FormSwitchGuard = (proceed) =>
      requestClose(() => {
        closeRef.current();
        proceed();
      });
    const { setLeaveGuard } = useViewStore.getState();
    setLeaveGuard(guard);
    return () => {
      if (useViewStore.getState().leaveGuard === guard) setLeaveGuard(null);
    };
  }, [active, requestClose]);
}
