import React from "react";
import { LayoutMode } from "@/types";
import { LayoutGrid, List, Tags as TagsIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface LayoutToggleProps {
  value: LayoutMode;
  onChange: (next: LayoutMode) => void;
  className?: string;
  /**
   * Whether to render the third "Tags" button. Only the Connections
   * view supports tag grouping today (each tile aggregates a tag
   * group and offers Connect-all / SCP-all), so the Credential and
   * Tunnel toggles omit it. Defaults to false to keep callers
   * conservative.
   */
  showTags?: boolean;
}

export function LayoutToggle({
  value,
  onChange,
  className,
  showTags = false,
}: LayoutToggleProps) {
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
        data-testid="layout-toggle-list"
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
        data-testid="layout-toggle-tile"
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
      {showTags && (
        <button
          type="button"
          aria-pressed={value === "tags"}
          aria-label="Tag groups view"
          title="Tag groups view"
          onClick={() => onChange("tags")}
          data-testid="layout-toggle-tags"
          className={cn(
            "px-2 py-1 rounded-sm transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === "tags"
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <TagsIcon aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
