import type { ConnectionLayout, LayoutMode } from "@/types";
import { FolderTree, LayoutGrid, List, Tags as TagsIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface LayoutToggleProps<L extends ConnectionLayout> {
  value: L;
  onChange: (next: L) => void;
  className?: string;
  /**
   * Whether to render the "Tags" button. Only the Connections
   * view supports tag grouping today (each tile aggregates a tag
   * group and offers Connect-all / SCP-all), so the Credential and
   * Port forward toggles omit it. Defaults to false to keep callers
   * conservative.
   */
  showTags?: boolean;
  /**
   * Whether to render the "Folders" button. Only a list whose layout can
   * be `"folders"` may ask for it, so the credential and port forward
   * toggles cannot offer a layout they could not store.
   */
  showFolders?: "folders" extends L ? boolean : never;
}

const BUTTONS: { layout: ConnectionLayout; label: string; icon: LucideIcon }[] = [
  { layout: "list", label: "List view", icon: List },
  { layout: "tile", label: "Tile view", icon: LayoutGrid },
  { layout: "tags", label: "Tag groups view", icon: TagsIcon },
  { layout: "folders", label: "Folders view", icon: FolderTree },
];

export function LayoutToggle<L extends ConnectionLayout = LayoutMode>({
  value,
  onChange,
  className,
  showTags = false,
  showFolders,
}: LayoutToggleProps<L>) {
  /*
   * Audit-3 follow-up P1#1: each toggle is icon-only. title= is
   * not exposed reliably to AT (and not at all on touch devices),
   * so an aria-label is required for the buttons to have an
   * accessible name beyond 'button, pressed'. The decorative
   * lucide glyph carries aria-hidden so AT does not double-
   * announce 'list, list view'.
   */
  const buttons = BUTTONS.filter(
    ({ layout }) => (layout !== "tags" || showTags) && (layout !== "folders" || showFolders),
  );
  return (
    <div
      role="group"
      aria-label="Layout"
      className={cn(
        "inline-flex rounded-md border border-input bg-background p-0.5",
        className,
      )}
    >
      {buttons.map(({ layout, label, icon: Icon }) => (
        <button
          key={layout}
          type="button"
          aria-pressed={value === layout}
          aria-label={label}
          title={label}
          onClick={() => onChange(layout as L)}
          data-testid={`layout-toggle-${layout}`}
          className={cn(
            "px-2 py-1 rounded-sm transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === layout
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}
