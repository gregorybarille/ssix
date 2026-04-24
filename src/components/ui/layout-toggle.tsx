import React from "react";
import { LayoutMode } from "@/types";
import { LayoutGrid, List } from "lucide-react";
import { cn } from "@/lib/utils";

interface LayoutToggleProps {
  value: LayoutMode;
  onChange: (next: LayoutMode) => void;
  className?: string;
}

export function LayoutToggle({ value, onChange, className }: LayoutToggleProps) {
  /*
   * Audit-3 follow-up P1#1: each toggle is icon-only. title= is
   * not exposed reliably to AT (and not at all on touch devices),
   * so an aria-label is required for the buttons to have an
   * accessible name beyond 'button, pressed'. The decorative
   * lucide glyph carries aria-hidden so AT does not double-
   * announce 'list, list view'.
   */
  return (
    <div
      role="group"
      aria-label="Layout"
      className={cn(
        "inline-flex rounded-md border border-input bg-background p-0.5",
        className,
      )}
    >
      <button
        type="button"
        aria-pressed={value === "list"}
        aria-label="List view"
        title="List view"
        onClick={() => onChange("list")}
        className={cn(
          "px-2 py-1 rounded-sm transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          value === "list"
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <List aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-pressed={value === "tile"}
        aria-label="Tile view"
        title="Tile view"
        onClick={() => onChange("tile")}
        className={cn(
          "px-2 py-1 rounded-sm transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          value === "tile"
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <LayoutGrid aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
