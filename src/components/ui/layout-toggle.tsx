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
        title="List"
        onClick={() => onChange("list")}
        className={cn(
          "px-2 py-1 rounded-sm transition-colors",
          value === "list"
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <List className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-pressed={value === "tile"}
        title="Tiles"
        onClick={() => onChange("tile")}
        className={cn(
          "px-2 py-1 rounded-sm transition-colors",
          value === "tile"
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <LayoutGrid className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
