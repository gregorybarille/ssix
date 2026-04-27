import React from "react";
import type { Connection } from "@/types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ArrowUpDown, Play, Tags as TagsIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { getColorHex } from "@/lib/colors";
import { useRovingFocus } from "@/hooks/useRovingFocus";
import { EmptyState } from "./ui/EmptyState";
import {
  filterTagGroups,
  groupConnectionsByTag,
  UNTAGGED_KEY,
  type TagGroup,
} from "@/lib/tags";
import { isBulkActionable } from "@/lib/bulk-actions";

interface TagGroupGridProps {
  connections: Connection[];
  /**
   * Free-text query — matched against the tag label only (the whole
   * point of the tags view is to filter by tag, not by host/name).
   * Empty / whitespace shows every group.
   */
  query?: string;
  /** Bulk-connect every actionable connection in the group. */
  onConnectAll: (group: TagGroup) => void;
  /** Open the bulk-SCP dialog for every actionable connection. */
  onScpAll: (group: TagGroup) => void;
}

/**
 * The third connection-list view mode: one tile per distinct tag.
 *
 * Each tile shows the tag name, member count, a stack of color
 * accent dots (the union of member colors, deduped), inline member
 * names (truncated when the list runs long), and two action
 * buttons — Connect-all (opens a tab per host) and SCP (opens the
 * bulk transfer dialog). A connection that carries multiple tags
 * appears under each of its tags so bulk operations on `prod`
 * really do hit every prod host even when some are also in `db`.
 *
 * Connections with no tags collect into an "Untagged" tile pinned
 * at the end of the grid so it never shifts the position of real
 * tags as the user adds new ones.
 */
export function TagGroupGrid({
  connections,
  query = "",
  onConnectAll,
  onScpAll,
}: TagGroupGridProps) {
  const groups = React.useMemo(
    () => filterTagGroups(groupConnectionsByTag(connections), query),
    [connections, query],
  );

  // Roving focus across the grid mirrors the tile-mode behaviour
  // for ConnectionList: arrow keys move between tiles, Enter/Space
  // triggers the primary (Connect-all) action.
  const roving = useRovingFocus({
    itemCount: groups.length,
    onActivate: (index) => {
      const group = groups[index];
      if (group) onConnectAll(group);
    },
    orientation: "grid",
  });

  if (connections.length === 0) {
    return (
      <EmptyState
        icon={TagsIcon}
        title="No connections yet"
        hint="Create your first SSH connection — tagged connections will be grouped here."
      />
    );
  }

  if (groups.length === 0) {
    return (
      <EmptyState
        icon={TagsIcon}
        title="No matching tags"
        hint={`No tag groups match "${query}".`}
      />
    );
  }

  return (
    <div
      className="grid gap-3"
      data-testid="tag-group-grid"
      role="list"
      aria-label="Connections grouped by tag"
      onKeyDown={roving.onKeyDown}
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}
    >
      {groups.map((group, index) => {
        const itemProps = roving.getItemProps(index);
        const actionable = group.connections.filter(isBulkActionable).length;
        const skipped = group.connections.length - actionable;
        // Dedupe colors so a 12-host `prod` group with three colors
        // shows three dots, not twelve.
        const colors = Array.from(
          new Set(
            group.connections
              .map((c) => getColorHex(c.color))
              .filter((c): c is string => Boolean(c)),
          ),
        ).slice(0, 6);
        const isUntagged = group.key === UNTAGGED_KEY;
        return (
          <div
            key={group.key}
            {...itemProps}
            role="listitem"
            data-testid={`tag-group-${isUntagged ? "untagged" : group.label}`}
            data-tag={isUntagged ? "" : group.label}
            aria-label={`Tag ${group.label}, ${group.connections.length} connection${group.connections.length === 1 ? "" : "s"}`}
            className={cn(
              "group rounded-lg border p-3 flex flex-col gap-2 transition-colors hover:bg-accent",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              isUntagged && "border-dashed",
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <TagsIcon
                  className="h-4 w-4 text-muted-foreground shrink-0"
                  aria-hidden="true"
                />
                <span className="font-medium text-sm truncate">
                  {group.label}
                </span>
              </div>
              <Badge variant="secondary" className="text-xs shrink-0">
                {group.connections.length}
              </Badge>
            </div>

            {colors.length > 0 && (
              <div className="flex items-center gap-1" aria-hidden="true">
                {colors.map((c) => (
                  <span
                    key={c}
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            )}

            <p className="text-xs text-muted-foreground line-clamp-2">
              {group.connections.map((c) => c.name).join(", ")}
            </p>

            {skipped > 0 && (
              <p className="text-[11px] text-muted-foreground-soft">
                {skipped} port-forward connection
                {skipped === 1 ? "" : "s"} will be skipped.
              </p>
            )}

            <div className="flex items-center justify-end gap-1 mt-auto pt-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-green-500 hover:text-green-600"
                onClick={(e) => {
                  e.stopPropagation();
                  onConnectAll(group);
                }}
                disabled={actionable === 0}
                aria-label={`Connect to all ${actionable} connection${actionable === 1 ? "" : "s"} tagged ${group.label}`}
                data-testid={`tag-connect-all-${isUntagged ? "untagged" : group.label}`}
              >
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={(e) => {
                  e.stopPropagation();
                  onScpAll(group);
                }}
                disabled={actionable === 0}
                aria-label={`Transfer files to all ${actionable} connection${actionable === 1 ? "" : "s"} tagged ${group.label}`}
                data-testid={`tag-scp-all-${isUntagged ? "untagged" : group.label}`}
              >
                <ArrowUpDown className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
