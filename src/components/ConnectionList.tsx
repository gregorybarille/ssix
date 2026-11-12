import { memo } from "react";
import { Connection, Credential, LayoutMode } from "@/types";
import { Server } from "lucide-react";
import { useLatestCallback } from "@/hooks/useLatestCallback";
import { useRovingFocus } from "@/hooks/useRovingFocus";
import {
  ConnectionRow,
  useConnectionRowMenu,
  useStableRowActions,
  type ConnectionRowActions,
} from "./ConnectionRow";
import { EmptyState } from "./ui/EmptyState";

interface ConnectionListProps extends ConnectionRowActions {
  connections: Connection[];
  credentials: Credential[];
  /** "tile" renders a grid of cards; "list" (default) renders rows. */
  layout?: LayoutMode;
}

export const ConnectionList = memo(function ConnectionList({
  connections,
  credentials,
  onEdit,
  onDelete,
  onClone,
  onConnect,
  onScp,
  onBrowse,
  layout = "list",
}: ConnectionListProps) {
  const isTile = layout === "tile";

  // Roving tabindex + activation for the list / grid. Click, Enter and
  // Space on a row connect. Action buttons inside the row stop propagation
  // and keep their own behaviour.
  const activateRow = useLatestCallback((conn: Connection) => onConnect?.(conn));
  const roving = useRovingFocus({
    itemCount: connections.length,
    onActivate: (index) => {
      if (connections[index]) activateRow(connections[index]);
    },
    orientation: isTile ? "grid" : "vertical",
  });

  const actions = useStableRowActions({ onEdit, onDelete, onClone, onConnect, onScp, onBrowse });
  const { onRowContextMenu, onRowKeyDown, menu } = useConnectionRowMenu(credentials, actions);

  if (connections.length === 0) {
    return (
      <EmptyState
        icon={Server}
        title="No connections yet"
        hint="Create your first SSH connection"
      />
    );
  }

  return (
    <>
      <div
        className={isTile ? "grid gap-3" : "space-y-1"}
        data-testid={isTile ? "connection-grid" : "connection-list-rows"}
        role="list"
        aria-label="Connections"
        onKeyDown={roving.onKeyDown}
        style={isTile ? { gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" } : undefined}
      >
        {connections.map((conn, index) => (
          <ConnectionRow
            key={conn.id}
            {...roving.getItemProps(index)}
            onRowContextMenu={onRowContextMenu}
            onRowKeyDown={onRowKeyDown}
            conn={conn}
            credentials={credentials}
            tile={isTile}
            actions={actions}
            onActivate={activateRow}
          />
        ))}
      </div>
      {menu}
    </>
  );
});
