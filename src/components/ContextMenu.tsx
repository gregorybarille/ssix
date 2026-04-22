import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface ContextMenuProps {
  position: { x: number; y: number };
  onClose: () => void;
  onTakeScreenshot: () => void;
}

export function ContextMenu({ position, onClose, onTakeScreenshot }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

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

  // Close on Escape.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleScreenshot = () => {
    onClose();
    onTakeScreenshot();
  };

  // Keep the menu inside the viewport.
  const MENU_W = 180;
  const MENU_H = 40;
  const x = Math.min(position.x, window.innerWidth - MENU_W - 8);
  const y = Math.min(position.y, window.innerHeight - MENU_H - 8);

  const menu = (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-[9999] min-w-[160px] rounded-md border bg-popover shadow-md py-1 text-sm text-popover-foreground"
      style={{ left: x, top: y }}
    >
      <button
        role="menuitem"
        className="w-full text-left px-3 py-1.5 hover:bg-accent hover:text-accent-foreground cursor-default"
        onClick={handleScreenshot}
      >
        📸 Take Screenshot
      </button>
    </div>
  );

  return createPortal(menu, document.body);
}
