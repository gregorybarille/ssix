import { useEffect, useRef, useState, type KeyboardEvent } from "react";

interface ListboxNavigationOptions {
  /** How many rows the list shows right now. */
  count: number;
  /** Enter on the active row. Not called while the list is empty. */
  onChoose: (index: number) => void;
}

/**
 * The keyboard and pointer model of a search box that drives a listbox, as
 * in the Connect Picker and the snippet palette: focus stays in the input and
 * an active row moves under it. ArrowUp/ArrowDown wrap, Home/End jump, Enter
 * chooses.
 *
 * Hover follows the pointer only when it really moved. The active row's
 * `scrollIntoView` slides other rows under a stationary cursor and the browser
 * fires `mouseenter` for them; following those would clobber the keyboard's
 * selection and snap the highlight back to whatever is under the pointer.
 */
export function useListboxNavigation({ count, onChoose }: ListboxNavigationOptions) {
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pointerMovedRef = useRef(false);

  // Clamp when the list shrinks.
  useEffect(() => {
    if (activeIndex >= count) setActiveIndex(count === 0 ? 0 : count - 1);
  }, [count, activeIndex]);

  // Keep the active row scrolled into view.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, count]);

  const moveTo = (e: KeyboardEvent, index: number) => {
    e.preventDefault();
    pointerMovedRef.current = false;
    setActiveIndex(index);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      moveTo(e, count === 0 ? 0 : (activeIndex + 1) % count);
    } else if (e.key === "ArrowUp") {
      moveTo(e, count === 0 ? 0 : (activeIndex - 1 + count) % count);
    } else if (e.key === "Home") {
      moveTo(e, 0);
    } else if (e.key === "End") {
      moveTo(e, count === 0 ? 0 : count - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (count > 0) onChoose(activeIndex);
    }
  };

  return {
    activeIndex,
    setActiveIndex,
    onKeyDown,
    /** Spread on the element with `role="listbox"`. */
    listProps: {
      ref: listRef,
      onPointerMove: () => {
        pointerMovedRef.current = true;
      },
    },
    /** Spread on each `role="option"` row. */
    rowProps: (index: number) => ({
      "data-index": index,
      onPointerEnter: () => {
        if (pointerMovedRef.current) setActiveIndex(index);
      },
    }),
  };
}
