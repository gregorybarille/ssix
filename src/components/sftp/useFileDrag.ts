import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { PaneSide } from "@/store/useSftpStore";

/** How far the pointer moves before a press counts as a drag, not a click. */
const DRAG_THRESHOLD = 5;

export interface DragChip {
  x: number;
  y: number;
  label: string;
  /** Whether letting go here would start a copy. */
  overTarget: boolean;
}

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

/**
 * Dragging rows onto the other pane. Pointer events rather than HTML5 drag
 * and drop: dropping files from the desktop needs Tauri's `dragDropEnabled`,
 * which on Windows turns HTML5 drag and drop off inside the page.
 */
export function useFileDrag(side: PaneSide, onDrop: (paths: string[], dir: string) => void) {
  const [chip, setChip] = useState<DragChip | null>(null);
  const endDrag = useRef<(() => void) | null>(null);

  useEffect(() => () => endDrag.current?.(), []);

  const startPress = useCallback(
    (event: ReactPointerEvent, paths: () => string[], label: () => string) => {
      if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) return;
      endDrag.current?.();
      const { clientX: startX, clientY: startY } = event;
      let dragging = false;

      const onMove = (e: PointerEvent) => {
        if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
        dragging = true;
        setChip({
          x: e.clientX,
          y: e.clientY,
          label: label(),
          overTarget: dropFolderAt(e.clientX, e.clientY, side) !== null,
        });
      };
      const onUp = (e: PointerEvent) => {
        const dir = dragging ? dropFolderAt(e.clientX, e.clientY, side) : null;
        end();
        if (dir) onDrop(paths(), dir);
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") end();
      };
      const end = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", end);
        window.removeEventListener("keydown", onKey);
        endDrag.current = null;
        setChip(null);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", end);
      window.addEventListener("keydown", onKey);
      endDrag.current = end;
    },
    [side, onDrop],
  );

  return { chip, startPress };
}
