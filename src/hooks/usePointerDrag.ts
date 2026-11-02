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
 * A drag cancelled with the button still down: its release is still to come,
 * and the click that goes with it must not count either. A cancel or a new
 * press means that release was lost, and nothing may stay behind to eat a
 * later, real click.
 */
function swallowClickOfComingRelease() {
  const onRelease = () => {
    stopWaiting();
    swallowTrailingClick();
  };
  const stopWaiting = () => {
    window.removeEventListener("pointerup", onRelease, true);
    window.removeEventListener("pointercancel", stopWaiting, true);
    window.removeEventListener("pointerdown", stopWaiting, true);
  };
  window.addEventListener("pointerup", onRelease, true);
  window.addEventListener("pointercancel", stopWaiting, true);
  window.addEventListener("pointerdown", stopWaiting, true);
}

/**
 * Dragging inside the page. Pointer events rather than HTML5 drag and drop:
 * dropping files from the desktop needs Tauri's `dragDropEnabled`, which on
 * Windows turns HTML5 drag and drop off inside the page.
 *
 * `targetAt` says what a point would drop onto. Escape cancels a drag, and
 * goes no further: Radix hears it on the document on its way down, where it
 * would also close the side panel. A press that has not become a drag leaves
 * Escape alone.
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
        if (!dragging) {
          if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
          dragging = true;
          window.addEventListener("keydown", onKey, true);
        }
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
        if (e.key !== "Escape") return;
        e.stopPropagation();
        e.preventDefault();
        end();
        swallowClickOfComingRelease();
      };
      const end = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", end);
        window.removeEventListener("keydown", onKey, true);
        endDrag.current = null;
        setChip(null);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", end);
      endDrag.current = end;
    },
    [],
  );

  return { chip, startPress };
}
