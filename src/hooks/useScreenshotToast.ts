import { useCallback, useEffect, useRef } from "react";
import { useDialogsStore } from "@/store/useDialogsStore";
import { takeScreenshot } from "@/lib/screenshot";

const SUCCESS_MS = 4000;
const ERROR_MS = 6000;

/**
 * Runs a window capture and shows the result in the screenshot toast
 * (state lives in the dialogs store so the toast can render anywhere).
 * Owns the auto-dismiss timer, including clearing it on unmount.
 */
export function useScreenshotToast() {
  const setToast = useDialogsStore((s) => s.setScreenshotToast);
  const timeoutRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const show = useCallback(
    (kind: "success" | "error", message: string, timeoutMs: number) => {
      clearTimer();
      setToast({ kind, message });
      timeoutRef.current = window.setTimeout(() => {
        setToast(null);
        timeoutRef.current = null;
      }, timeoutMs);
    },
    [clearTimer, setToast],
  );

  const capture = useCallback(async () => {
    clearTimer();
    setToast(null);
    try {
      const path = await takeScreenshot();
      show("success", `Screenshot saved to ${path}`, SUCCESS_MS);
    } catch (error) {
      const message =
        error instanceof Error && error.message ? error.message : "Screenshot failed.";
      show("error", message, ERROR_MS);
    }
  }, [clearTimer, setToast, show]);

  return capture;
}
