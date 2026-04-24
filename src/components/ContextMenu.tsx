import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * A single item rendered inside a {@link ContextMenu}.
 *
 * Items are either selectable rows (with a `label` and `onClick`) or visual
 * separators (`{ separator: true }`). Selectable items may be marked as
 * `destructive` to render in the destructive color, or `disabled` to skip
 * them in keyboard navigation and ignore clicks.
 */
export type ContextMenuItem =
  | {
      separator: true;
    }
  | {
      separator?: false;
      label: string;
      /** Optional leading icon node (rendered with `aria-hidden`). */
      icon?: React.ReactNode;
      onClick: () => void;
      disabled?: boolean;
      destructive?: boolean;
    };

interface ContextMenuProps {
  /** Viewport-relative coordinates where the menu should anchor. */
  position: { x: number; y: number };
  items: ContextMenuItem[];
  onClose: () => void;
  /** Optional accessible label for the menu (defaults to "Context menu"). */
  ariaLabel?: string;
}

const SEP = (item: ContextMenuItem): item is { separator: true } =>
  "separator" in item && item.separator === true;

/**
 * Floating, keyboard-navigable context menu.
 *
 * - Roving focus: ArrowDown / ArrowUp move between enabled items, with
 *   Home / End jumping to ends. Disabled items and separators are skipped.
 * - Enter / Space activates the focused item.
 * - Escape, click-outside, or any window blur closes the menu.
 * - Focus is trapped inside the popover until close, then implicitly returned
 *   to whatever was focused before (callers don't need to manage this — the
 *   menu never steals focus from a typing surface; it only focuses its own
 *   first enabled item).
 * - The menu position is clamped inside the viewport so it never opens off-
 *   screen at the right or bottom edge.
 *
 * Rendered via a portal into `document.body` so it escapes overflow clips
 * and stacking contexts of the trigger.
 */
export function ContextMenu({
  position,
  items,
  onClose,
  ariaLabel = "Context menu",
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Snapshot the element that had focus when the menu opened so we can
  // restore focus there on close (Shift+F10/ContextMenu-key opens
  // typically come FROM the trigger row — we want focus to return to
  // it, not vanish into <body>).
  const restoreTargetRef = useRef<HTMLElement | null>(null);
  if (restoreTargetRef.current === null && typeof document !== "undefined") {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      restoreTargetRef.current = active;
    }
  }

  // Indices of items that can receive focus (skip separators + disabled).
  const focusableIndices = items
    .map((item, idx) =>
      SEP(item) || item.disabled ? -1 : idx,
    )
    .filter((idx) => idx >= 0);

  const [focusedIndex, setFocusedIndex] = useState<number>(
    focusableIndices[0] ?? -1,
  );

  // Focus the first enabled item on mount so the menu is keyboard-usable
  // immediately after opening. Restore focus to whatever opened the
  // menu when it unmounts.
  useEffect(() => {
    const first = focusableIndices[0];
    if (first === undefined) return;
    setFocusedIndex(first);
    // Defer focus so the portal is mounted before we move focus into it.
    queueMicrotask(() => {
      itemRefs.current[first]?.focus();
    });
    const restoreTarget = restoreTargetRef.current;
    return () => {
      if (restoreTarget && restoreTarget.isConnected) {
        // Use a microtask so we run after React has detached the portal
        // (otherwise focus can briefly land on <body>).
        queueMicrotask(() => restoreTarget.focus());
      }
    };
    // We intentionally only run this on mount; subsequent item changes are
    // rare and recomputing focus would steal it from the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close on click outside.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Close on Escape (handled at document level so it works even if the menu
  // hasn't received focus yet for any reason).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Close when the window loses focus (e.g. user alt-tabs away).
  useEffect(() => {
    const handler = () => onClose();
    window.addEventListener("blur", handler);
    return () => window.removeEventListener("blur", handler);
  }, [onClose]);

  const moveFocus = (direction: 1 | -1) => {
    if (focusableIndices.length === 0) return;
    const currentPos = focusableIndices.indexOf(focusedIndex);
    const nextPos =
      currentPos === -1
        ? direction === 1
          ? 0
          : focusableIndices.length - 1
        : (currentPos + direction + focusableIndices.length) %
          focusableIndices.length;
    const nextIdx = focusableIndices[nextPos];
    setFocusedIndex(nextIdx);
    itemRefs.current[nextIdx]?.focus();
  };

  const focusEnd = (which: "first" | "last") => {
    if (focusableIndices.length === 0) return;
    const idx =
      which === "first"
        ? focusableIndices[0]
        : focusableIndices[focusableIndices.length - 1];
    setFocusedIndex(idx);
    itemRefs.current[idx]?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusEnd("first");
    } else if (e.key === "End") {
      e.preventDefault();
      focusEnd("last");
    }
  };

  const activate = (item: ContextMenuItem) => {
    if (SEP(item) || item.disabled) return;
    onClose();
    // Defer the click handler until after onClose has settled, so any
    // dialog/menu the handler opens isn't immediately closed by the
    // outside-click handler that's about to run as part of unmount.
    queueMicrotask(() => item.onClick());
  };

  // Clamp position inside the viewport. Use real measured size if mounted;
  // otherwise fall back to a conservative estimate so the first paint is
  // already on-screen.
  const MENU_W = menuRef.current?.offsetWidth ?? 200;
  const MENU_H = menuRef.current?.offsetHeight ?? items.length * 32 + 8;
  const x = Math.max(4, Math.min(position.x, window.innerWidth - MENU_W - 8));
  const y = Math.max(4, Math.min(position.y, window.innerHeight - MENU_H - 8));

  const menu = (
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className="fixed z-[9999] min-w-[180px] rounded-md border bg-popover shadow-md py-1 text-sm text-popover-foreground"
      style={{ left: x, top: y }}
    >
      {items.map((item, idx) => {
        if (SEP(item)) {
          return (
            <div
              key={`sep-${idx}`}
              role="separator"
              aria-orientation="horizontal"
              className="my-1 h-px bg-border"
            />
          );
        }
        const isFocused = focusedIndex === idx;
        return (
          <button
            key={`item-${idx}`}
            ref={(el) => {
              itemRefs.current[idx] = el;
            }}
            type="button"
            role="menuitem"
            tabIndex={isFocused ? 0 : -1}
            disabled={item.disabled}
            onClick={() => activate(item)}
            onMouseEnter={() => {
              if (!item.disabled) setFocusedIndex(idx);
            }}
            className={cn(
              "w-full text-left px-3 py-1.5 flex items-center gap-2 cursor-default",
              "focus:outline-none focus:bg-accent focus:text-accent-foreground",
              "hover:bg-accent hover:text-accent-foreground",
              item.destructive &&
                "text-destructive focus:text-destructive hover:text-destructive",
              item.disabled && "opacity-50 cursor-not-allowed pointer-events-none",
            )}
          >
            {item.icon && (
              <span className="shrink-0 inline-flex" aria-hidden="true">
                {item.icon}
              </span>
            )}
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
  );

  return createPortal(menu, document.body);
}

/**
 * Ergonomic hook for callers that just need to track open/position state
 * for a {@link ContextMenu}. Wire `onContextMenu={open}` on any element and
 * conditionally render the menu when `state` is non-null.
 *
 * For full keyboard accessibility, also wire `onKeyDown={onKeyDown}` on
 * the same element. This opens the menu when the user presses the
 * platform-standard context-menu shortcuts:
 *   - Shift+F10  (works on every desktop OS — WCAG 2.1.1 keyboard)
 *   - ContextMenu key  (the dedicated key on most full-size keyboards)
 *
 * The keyboard-opened menu is anchored to the bottom-left of the
 * triggering element rather than the mouse cursor, so the menu still
 * appears in a sensible place when there is no pointer event.
 *
 * ```tsx
 * const ctx = useContextMenu();
 * return (
 *   <>
 *     <div
 *       onContextMenu={ctx.open}
 *       onKeyDown={ctx.onKeyDown}
 *       tabIndex={0}
 *     >
 *       right-click or Shift+F10 me
 *     </div>
 *     {ctx.state && (
 *       <ContextMenu position={ctx.state} onClose={ctx.close} items={...} />
 *     )}
 *   </>
 * );
 * ```
 */
export function useContextMenu() {
  const [state, setState] = useState<{ x: number; y: number } | null>(null);
  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setState({ x: e.clientX, y: e.clientY });
  };
  const openAt = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    // Anchor at bottom-left of the element with a small inset so the
    // menu never overlaps the trigger.
    setState({ x: rect.left + 4, y: rect.bottom + 2 });
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    // Shift+F10 is the WCAG/AAA keyboard shortcut for opening a context
    // menu and works across all desktop platforms. The ContextMenu key
    // (key === "ContextMenu") is the dedicated physical key on most
    // full-size keyboards. We treat both identically.
    const isShiftF10 = e.shiftKey && e.key === "F10";
    const isMenuKey = e.key === "ContextMenu";
    if (!isShiftF10 && !isMenuKey) return;
    e.preventDefault();
    e.stopPropagation();
    openAt(e.currentTarget);
  };
  const close = () => setState(null);
  return { state, open, openAt, onKeyDown, close };
}
