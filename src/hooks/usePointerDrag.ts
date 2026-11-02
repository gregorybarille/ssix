import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

/** How far the pointer moves before a press counts as a drag, not a click. */
const DRAG_THRESHOLD = 5;

export interface PointerDragChip<T> {
  x: number;
  y: number;
  label: string;
  /** What letting go here would drop onto, null over nothing. */
  target: T | null;
  /** Whether there is such a target. */
  overTarget: boolean;
}

/**
 * The release of a drag that started and ended on one element is also a click
 * on it, which on a connection row would open a session. The browser sends that
 * click in the same task as the release, so a timer is late enough to stop
 * listening without eating a later, real click.
 */
function swallowTrailingClick() {
  const swallow = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

/**
 * Dragging inside the page. Pointer events rather than HTML5 drag and drop:
 * dropping files from the desktop needs Tauri's `dragDropEnabled`, which on
 * Windows turns HTML5 drag and drop off inside the page.
 *
 * `targetAt` says what a point would drop onto. Escape cancels a drag.
 */
export function usePointerDrag<T>(targetAt: (x: number, y: number) => T | null) {
  const [chip, setChip] = useState<PointerDragChip<T> | null>(null);
  const endDrag = useRef<(() => void) | null>(null);
  const latestTargetAt = useRef(targetAt);
  useEffect(() => {
    latestTargetAt.current = targetAt;
  });

  useEffect(() => () => endDrag.current?.(), []);

  const startPress = useCallback(
    (event: ReactPointerEvent, label: () => string, onDrop: (target: T) => void) => {
      if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) return;
      endDrag.current?.();
      const { clientX: startX, clientY: startY } = event;
      let dragging = false;

      const onMove = (e: PointerEvent) => {
        if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
        dragging = true;
        const target = latestTargetAt.current(e.clientX, e.clientY);
        setChip({
          x: e.clientX,
          y: e.clientY,
          label: label(),
          target,
          overTarget: target !== null,
        });
      };
      const onUp = (e: PointerEvent) => {
        const target = dragging ? latestTargetAt.current(e.clientX, e.clientY) : null;
        if (dragging) swallowTrailingClick();
        end();
        if (target !== null) onDrop(target);
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
    [],
  );

  return { chip, startPress };
}
