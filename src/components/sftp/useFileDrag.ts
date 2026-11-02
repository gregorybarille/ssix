import { useCallback, type PointerEvent as ReactPointerEvent } from "react";
import { usePointerDrag } from "@/hooks/usePointerDrag";
import type { PaneSide } from "@/store/useSftpStore";

/**
 * The folder a drag from `from` would copy into at this point: a folder row
 * in the other pane, or else the folder that pane shows.
 */
export function dropFolderAt(x: number, y: number, from: PaneSide): string | null {
  const element = document.elementFromPoint(x, y);
  const pane = element?.closest<HTMLElement>("[data-drop-side]");
  if (!element || !pane || pane.dataset.dropSide === from) return null;
  const row = element.closest<HTMLElement>("[data-drop-dir]");
  return row?.dataset.dropDir || pane.dataset.path || null;
}

/** Dragging rows onto the other pane. */
export function useFileDrag(side: PaneSide, onDrop: (paths: string[], dir: string) => void) {
  const { chip, startPress: start } = usePointerDrag<string>((x, y) => dropFolderAt(x, y, side));
  const startPress = useCallback(
    (event: ReactPointerEvent, paths: () => string[], label: () => string) =>
      start(event, label, (dir) => onDrop(paths(), dir)),
    [start, onDrop],
  );
  return { chip, startPress };
}
