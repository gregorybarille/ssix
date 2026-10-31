import React from "react";
import { KIND_LABELS } from "@/lib/sshTerms";
import { Connection, Credential, LayoutMode } from "@/types";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  Server,
  Edit,
  Trash2,
  Copy,
  Cable,
  CornerDownRight,
  ChevronRight,
  Play,
  ArrowUpDown,
  Terminal as TerminalIcon,
  Clipboard,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getColorHex } from "@/lib/colors";
import { useRovingFocus } from "@/hooks/useRovingFocus";
import { ContextMenu, useContextMenu, type ContextMenuItem } from "./ContextMenu";
import { EmptyState } from "./ui/EmptyState";
import { buildSshCommand } from "@/lib/ssh-command";

interface ConnectionListProps {
  connections: Connection[];
  credentials: Credential[];
  onEdit: (connection: Connection) => void;
  onDelete: (id: string) => void;
  onClone: (connection: Connection) => void;
  onSelect?: (connection: Connection) => void;
  onConnect?: (connection: Connection) => void;
  onScp?: (connection: Connection) => void;
  selectedId?: string;
  /** "tile" renders a grid of cards; "list" (default) renders rows. */
  layout?: LayoutMode;
}

function ConnIcon({ conn, className }: { conn: Connection; className?: string }) {
  const cls = cn("h-5 w-5 text-muted-foreground", className);
  if (conn.type === "port_forward") return <Cable className={cls} aria-hidden="true" />;
  if (conn.type === "jump_shell") return <CornerDownRight className={cls} aria-hidden="true" />;
  return <Server className={cls} aria-hidden="true" />;
}

function describe(conn: Connection): React.ReactNode {
  if (conn.type === "port_forward") {
    return (
      <>
        127.0.0.1:{conn.local_port} → {conn.destination_host}:
        {conn.destination_port} via {conn.gateway_host}
      </>
    );
  }
  if (conn.type === "jump_shell") {
    return (
      <>
        {conn.destination_host}:{conn.destination_port} via {conn.gateway_host}
      </>
    );
  }
  return (
    <>
      {conn.host}:{conn.port}
    </>
  );
}

function TypeBadge({ conn }: { conn: Connection }) {
  if (conn.type === "direct") return null;
  return (
    <Badge variant="secondary" className="text-xs shrink-0">
      {KIND_LABELS[conn.type].toLowerCase()}
    </Badge>
  );
}

function TagBadges({ tags }: { tags?: string[] }) {
  return (
    <>
      {tags?.map((t) => (
        <Badge key={t} variant="outline" className="text-[10px] py-0 px-1.5">
          {t}
        </Badge>
      ))}
    </>
  );
}

const ACTION_BUTTON = "h-7 w-7";

/** Stops the row's own click (activate) from firing for an action button. */
function stop<T>(fn: (arg: T) => void, arg: T) {
  return (e: React.MouseEvent) => {
    e.stopPropagation();
    fn(arg);
  };
}

interface RowActionsProps {
  conn: Connection;
  onEdit: (connection: Connection) => void;
  onDelete: (id: string) => void;
  onClone: (connection: Connection) => void;
  onConnect?: (connection: Connection) => void;
  onScp?: (connection: Connection) => void;
}

/** The per-row action cluster, identical in row and tile layouts. */
function RowActions({ conn, onEdit, onDelete, onClone, onConnect, onScp }: RowActionsProps) {
  const scpBlocked = conn.type === "port_forward";
  return (
    <div className="flex items-center gap-1">
      {onConnect && (
        <Button
          variant="ghost"
          size="icon"
          className={cn(ACTION_BUTTON, "text-green-500 hover:text-green-600")}
          onClick={stop(onConnect, conn)}
          aria-label={`Connect to ${conn.name}`}
          data-testid={`connect-button-${conn.id}`}
        >
          <Play className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      )}
      {onScp && (
        <span
          title={scpBlocked ? "SCP not available for local forwards" : undefined}
          className="inline-flex"
        >
          <Button
            variant="ghost"
            size="icon"
            className={ACTION_BUTTON}
            disabled={scpBlocked}
            onClick={stop((c: Connection) => {
              if (c.type !== "port_forward") onScp(c);
            }, conn)}
            aria-label={
              scpBlocked
                ? "SCP not available for local forwards"
                : `Transfer files to ${conn.name}`
            }
            data-testid={`scp-open-${conn.id}`}
          >
            <ArrowUpDown className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </span>
      )}
      <Button
        variant="ghost"
        size="icon"
        className={ACTION_BUTTON}
        onClick={stop(onClone, conn)}
        aria-label={`Clone ${conn.name}`}
        data-testid={`clone-connection-${conn.id}`}
      >
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={ACTION_BUTTON}
        onClick={stop(onEdit, conn)}
        aria-label={`Edit ${conn.name}`}
        data-testid={`edit-connection-${conn.id}`}
      >
        <Edit className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={cn(ACTION_BUTTON, "text-destructive hover:text-destructive")}
        onClick={stop(onDelete, conn.id)}
        aria-label={`Delete ${conn.name}`}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
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
  selectedId,
  layout = "list",
}: ConnectionListProps) {
  const isTile = layout === "tile";

  const getCredentialName = (credId?: string) => {
    if (!credId) return null;
    return credentials.find((c) => c.id === credId)?.name ?? null;
  };

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

  // Right-click context menu for any connection row/tile. We track which
  // connection the menu was opened for so the items list can close over the
  // correct connection without re-creating itself for every row.
  const ctx = useContextMenu();
  const [ctxConn, setCtxConn] = React.useState<Connection | null>(null);
  const buildItems = (conn: Connection): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    if (onConnect) {
      items.push({
        label: "Connect",
        icon: <TerminalIcon className="h-3.5 w-3.5" />,
        onClick: () => onConnect(conn),
      });
    }
    items.push({
      label: "Edit",
      icon: <Edit className="h-3.5 w-3.5" />,
      onClick: () => onEdit(conn),
    });
    items.push({
      label: "Clone",
      icon: <Copy className="h-3.5 w-3.5" />,
      onClick: () => onClone(conn),
    });
    if (onScp && conn.type !== "port_forward") {
      items.push({
        label: "Transfer files",
        icon: <ArrowUpDown className="h-3.5 w-3.5" />,
        onClick: () => onScp(conn),
      });
    }
    items.push({ separator: true });
    items.push({
      label: "Copy SSH command",
      icon: <Clipboard className="h-3.5 w-3.5" />,
      onClick: () => {
        const cmd = buildSshCommand(conn, credentials);
        // Best-effort; clipboard is async but we don't need to wait.
        navigator.clipboard?.writeText(cmd).catch(() => {
          /* surfacing this would require a toast plumbed from App.tsx;
             the menu has already closed by now. */
        });
      },
    });
    items.push({ separator: true });
    items.push({
      label: "Delete",
      icon: <Trash2 className="h-3.5 w-3.5" />,
      destructive: true,
      onClick: () => onDelete(conn.id),
    });
    return items;
  };

  if (connections.length === 0) {
    return (
      <EmptyState
        icon={Server}
        title="No connections yet"
        hint="Create your first SSH connection"
      />
    );
  }

  const actionProps = { onEdit, onDelete, onClone, onConnect, onScp };

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
        {connections.map((conn, index) => {
          const color = getColorHex(conn.color);
          const credentialName = getCredentialName(conn.credential_id);
          const selected = selectedId === conn.id;
          return (
            <div
              key={conn.id}
              {...roving.getItemProps(index)}
              role="listitem"
              data-testid={`connection-row-${conn.id}`}
              data-name={conn.name}
              aria-label={`${conn.name}${conn.tags && conn.tags.length > 0 ? `, tagged ${conn.tags.join(", ")}` : ""}`}
              aria-current={selected || undefined}
              className={cn(
                "group rounded-lg cursor-pointer transition-colors hover:bg-accent",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                isTile ? "border p-3 flex flex-col gap-2 h-full" : "flex items-center gap-3 p-3",
                selected && "bg-accent",
              )}
              style={color ? { borderLeft: `3px solid ${color}` } : undefined}
              // The second click of a double-click must not activate again
              // (it used to open two sessions).
              onClick={(e) => e.detail <= 1 && activateRow(index)}
              onContextMenu={(e) => {
                setCtxConn(conn);
                ctx.open(e);
              }}
              onKeyDown={(e) => {
                // Keyboard alternative for the context menu (Shift+F10 or
                // the ContextMenu key). The container-level roving-focus
                // handler still runs on bubble for arrows / Home / End.
                if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
                  e.preventDefault();
                  e.stopPropagation();
                  setCtxConn(conn);
                  ctx.openAt(e.currentTarget);
                }
              }}
            >
              {isTile ? (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <ConnIcon conn={conn} />
                      <span className="font-medium text-sm truncate">{conn.name}</span>
                    </div>
                    <TypeBadge conn={conn} />
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {describe(conn)}
                    {credentialName && (
                      <span className="ml-1 text-muted-foreground-soft">· {credentialName}</span>
                    )}
                  </p>
                  {/* Always rendered (empty when untagged) so the action row
                      sits on the same baseline across every tile. */}
                  <div className="flex flex-wrap gap-1 min-h-[18px]">
                    <TagBadges tags={conn.tags} />
                  </div>
                  <div className="flex items-center justify-start mt-auto">
                    <RowActions conn={conn} {...actionProps} />
                  </div>
                </>
              ) : (
                <>
                  <div className="flex-shrink-0">
                    <ConnIcon conn={conn} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate">{conn.name}</span>
                      <TypeBadge conn={conn} />
                      <TagBadges tags={conn.tags} />
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {describe(conn)}
                      {credentialName && (
                        <span className="ml-2 text-muted-foreground-soft">· {credentialName}</span>
                      )}
                    </p>
                  </div>
                  <RowActions conn={conn} {...actionProps} />
                  <ChevronRight
                    className="h-4 w-4 text-muted-foreground-soft shrink-0"
                    aria-hidden="true"
                  />
                </>
              )}
            </div>
          );
        })}
      </div>
      {ctx.state && ctxConn && (
        <ContextMenu
          position={ctx.state}
          onClose={() => {
            ctx.close();
            setCtxConn(null);
          }}
          ariaLabel={`Actions for ${ctxConn.name}`}
          items={buildItems(ctxConn)}
        />
      )}
    </>
  );
}
