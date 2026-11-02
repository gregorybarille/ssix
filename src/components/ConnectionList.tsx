import { Connection, Credential, LayoutMode } from "@/types";
import { Server } from "lucide-react";
import { useRovingFocus } from "@/hooks/useRovingFocus";
import { ConnectionRow, useConnectionRowMenu, type ConnectionRowActions } from "./ConnectionRow";
import { EmptyState } from "./ui/EmptyState";

interface ConnectionListProps extends ConnectionRowActions {
  connections: Connection[];
  credentials: Credential[];
  onSelect?: (connection: Connection) => void;
  selectedId?: string;
  /** "tile" renders a grid of cards; "list" (default) renders rows. */
  layout?: LayoutMode;
}

export function ConnectionList({
  connections,
  credentials,
  onEdit,
  onDelete,
  onClone,
  onSelect,
  onConnect,
  onScp,
  onBrowse,
  selectedId,
  layout = "list",
}: ConnectionListProps) {
  const isTile = layout === "tile";

  // Roving tabindex + activation for the list / grid. Click, Enter and
  // Space on a row prefer onSelect (caller-controlled selection); if no
  // onSelect is wired, fall back to onConnect (the primary action). Action
  // buttons inside the row stop propagation and keep their own behaviour.
  const activateRow = (index: number) => {
    const conn = connections[index];
    if (!conn) return;
    if (onSelect) onSelect(conn);
    else if (onConnect) onConnect(conn);
  };
  const roving = useRovingFocus({
    itemCount: connections.length,
    onActivate: activateRow,
    orientation: isTile ? "grid" : "vertical",
  });

  const actions = { onEdit, onDelete, onClone, onConnect, onScp, onBrowse };
  const { rowMenuProps, menu } = useConnectionRowMenu(credentials, actions);

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
            {...rowMenuProps(conn)}
            conn={conn}
            credentials={credentials}
            tile={isTile}
            selected={selectedId === conn.id}
            actions={actions}
            onActivate={() => activateRow(index)}
          />
        ))}
      </div>
      {menu}
    </>
  );
}
