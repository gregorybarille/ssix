import { useEffect, useRef } from "react";
import { log } from "@/lib/log";
import { errorMessage } from "@/lib/errors";
import { isTauriRuntime } from "@/lib/runtime";

/**
 * Files dropped from the desktop: the webview reports them to Tauri instead
 * of the page, with their full paths and the position in physical pixels.
 */
export function useOsFileDrop(onDrop: (paths: string[], x: number, y: number) => void) {
  const latest = useRef(onDrop);
  useEffect(() => {
    latest.current = onDrop;
  });

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let stopped = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const stop = await getCurrentWebview().onDragDropEvent(({ payload }) => {
          if (payload.type !== "drop") return;
          const scale = window.devicePixelRatio || 1;
          latest.current(payload.paths, payload.position.x / scale, payload.position.y / scale);
        });
        if (stopped) stop();
        else unlisten = stop;
      } catch (err) {
        log.warn("sftp", `Dropping files from the desktop is unavailable: ${errorMessage(err)}`);
      }
    })();
    return () => {
      stopped = true;
      unlisten?.();
    };
  }, []);
}
