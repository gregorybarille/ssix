import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * Implements roving-tabindex keyboard navigation across a flat list of
 * focusable items.
 *
 * Usage pattern:
 *
 *   const { containerRef, getItemProps, focusedIndex } = useRovingFocus({
 *     itemCount: items.length,
 *     onActivate: (i) => onSelect(items[i]),
 *   });
 *
 *   <div ref={containerRef} role="list" onKeyDown={...}>
 *     {items.map((item, i) => (
 *       <div key={item.id} {...getItemProps(i)}>...</div>
 *     ))}
 *   </div>
 *
 * Only one item is in the focus order at a time (`tabIndex=0` on the
 * "current" item, `tabIndex=-1` on the rest). Arrow keys move focus
 * between items; Home/End jump to the ends; Enter/Space activate.
 *
 * The hook is presentation-agnostic: it doesn't impose a role or grid
 * vs list layout — callers pick the appropriate ARIA role for their
 * widget. By default the keyboard model is "vertical": ArrowUp/ArrowDown
 * traverse, ArrowLeft/ArrowRight are ignored. Pass `orientation: "grid"`
 * to also handle Left/Right (treated equivalently to Up/Down — sufficient
 * for a single-row "scan" through a grid; we don't try to model 2D
 * geometry because tile widths vary with viewport).
 */
export interface UseRovingFocusOptions {
  itemCount: number;
  onActivate?: (index: number) => void;
  orientation?: "vertical" | "grid";
  /** Initial focused index (defaults to 0). */
  initialIndex?: number;
}

export interface RovingFocusItemProps {
  ref: (el: HTMLElement | null) => void;
  tabIndex: number;
  onFocus: () => void;
  "data-roving-index": number;
}

export function useRovingFocus({
  itemCount,
  onActivate,
  orientation = "vertical",
  initialIndex = 0,
}: UseRovingFocusOptions) {
  const containerRef = useRef<HTMLElement | null>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const [focusedIndex, setFocusedIndex] = useState<number>(() =>
    Math.min(initialIndex, Math.max(0, itemCount - 1)),
  );

  // Keep focusedIndex in range when the list shrinks.
  useEffect(() => {
    if (itemCount === 0) {
      setFocusedIndex(0);
    } else if (focusedIndex >= itemCount) {
      setFocusedIndex(itemCount - 1);
    }
  }, [itemCount, focusedIndex]);

  const focusItem = useCallback((index: number) => {
    const el = itemRefs.current[index];
    if (el) el.focus();
  }, []);

  const moveFrom = useCallback(
    (origin: number, delta: number) => {
      if (itemCount === 0) return;
      const next = (origin + delta + itemCount) % itemCount;
      setFocusedIndex(next);
      queueMicrotask(() => focusItem(next));
    },
    [itemCount, focusItem],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      // Don't intercept keys typed into nested controls (inputs, buttons).
      // Resolve the originating item by matching the event target against
      // every registered item ref — relying on `focusedIndex` here would
      // race with state updates from `onFocus`.
      const target = e.target as HTMLElement;
      const originIndex = itemRefs.current.findIndex((el) => el === target);
      if (originIndex === -1) return;

      const isVertical = orientation === "vertical" || orientation === "grid";
      const isHorizontal = orientation === "grid";

      if (isVertical && e.key === "ArrowDown") {
        e.preventDefault();
        moveFrom(originIndex, 1);
      } else if (isVertical && e.key === "ArrowUp") {
        e.preventDefault();
        moveFrom(originIndex, -1);
      } else if (isHorizontal && e.key === "ArrowRight") {
        e.preventDefault();
        moveFrom(originIndex, 1);
      } else if (isHorizontal && e.key === "ArrowLeft") {
        e.preventDefault();
        moveFrom(originIndex, -1);
      } else if (e.key === "Home") {
        e.preventDefault();
        setFocusedIndex(0);
        queueMicrotask(() => focusItem(0));
      } else if (e.key === "End") {
        e.preventDefault();
        const last = Math.max(0, itemCount - 1);
        setFocusedIndex(last);
        queueMicrotask(() => focusItem(last));
      } else if ((e.key === "Enter" || e.key === " ") && onActivate) {
        e.preventDefault();
        onActivate(originIndex);
      }
    },
    [itemCount, moveFrom, onActivate, orientation, focusItem],
  );

  const getItemProps = useCallback(
    (index: number): RovingFocusItemProps => ({
      ref: (el) => {
        itemRefs.current[index] = el;
      },
      tabIndex: index === focusedIndex ? 0 : -1,
      onFocus: () => setFocusedIndex(index),
      "data-roving-index": index,
    }),
    [focusedIndex],
  );

  return {
    containerRef,
    onKeyDown,
    focusedIndex,
    setFocusedIndex,
    getItemProps,
    focusItem,
  };
}
