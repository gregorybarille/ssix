import React from "react";
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
  layout?: LayoutMode;
  /** Render a tile for each entry instead of a row. */
}

function ConnIcon({ conn, className }: { conn: Connection; className?: string }) {
  const cls = cn("h-5 w-5 text-muted-foreground", className);
  if (conn.type === "port_forward") return <Cable className={cls} />;
  if (conn.type === "jump_shell") return <CornerDownRight className={cls} />;
  return <Server className={cls} />;
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
  if (conn.type === "port_forward") {
    return (
      <Badge variant="secondary" className="text-xs shrink-0">
        port-forward
      </Badge>
    );
  }
  if (conn.type === "jump_shell") {
    return (
      <Badge variant="secondary" className="text-xs shrink-0">
        jump-shell
      </Badge>
    );
  }
  return null;
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
  const getCredentialName = (credId?: string) => {
    if (!credId) return null;
    return credentials.find((c) => c.id === credId)?.name ?? null;
  };

  // Roving tabindex + keyboard activation for the list / grid. Enter / Space
  // on a row prefers onSelect (caller-controlled selection); if no onSelect
  // is wired, fall back to onConnect (the primary action). Action buttons
  // inside the row keep their own focus and aren't intercepted.
  const activateRow = (index: number) => {
    const conn = connections[index];
    if (!conn) return;
    if (onSelect) onSelect(conn);
    else if (onConnect) onConnect(conn);
  };
  const roving = useRovingFocus({
    itemCount: connections.length,
    onActivate: activateRow,
    orientation: layout === "tile" ? "grid" : "vertical",
  });

  // Right-click context menu for any connection row/tile. We track which
  // connection the menu was opened for so the items list can close over the
  // correct connection without re-creating itself for every row on every
  // render.
  const ctx = useContextMenu();
  const [ctxConn, setCtxConn] = React.useState<Connection | null>(null);
  const openContextMenu = (e: React.MouseEvent, conn: Connection) => {
    setCtxConn(conn);
    ctx.open(e);
  };
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
          /* swallow — surfacing this would require a toast plumbed
             from App.tsx; the menu has already closed by now. */
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

  if (layout === "tile") {
    return (
      <>
      <div
        className="grid gap-3"
        data-testid="connection-grid"
        role="list"
        aria-label="Connections"
        onKeyDown={roving.onKeyDown}
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
      >
        {connections.map((conn, index) => {
          const color = getColorHex(conn.color);
          const itemProps = roving.getItemProps(index);
          return (
            <div
              key={conn.id}
              {...itemProps}
              role="listitem"
              data-testid={`connection-row-${conn.id}`}
              data-name={conn.name}
              aria-label={`${conn.name}${conn.tags && conn.tags.length > 0 ? `, tagged ${conn.tags.join(", ")}` : ""}`}
              aria-selected={selectedId === conn.id || undefined}
              className={cn(
                "group rounded-lg border p-3 cursor-pointer transition-colors hover:bg-accent flex flex-col gap-2 h-full",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                selectedId === conn.id && "bg-accent",
              )}
              style={
                color
                  ? { borderLeft: `3px solid ${color}` }
                  : undefined
              }
              onClick={() => onSelect?.(conn)}
              onContextMenu={(e) => openContextMenu(e, conn)}
              onKeyDown={(e) => {
                // Open the context menu via keyboard (Shift+F10 or
                // ContextMenu key). The container-level roving-focus
                // handler runs after this on bubble for arrow/Home/End,
                // so we don't need to delegate manually.
                if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
                  e.preventDefault();
                  e.stopPropagation();
                  setCtxConn(conn);
                  ctx.openAt(e.currentTarget);
                }
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <ConnIcon conn={conn} />
                  <span className="font-medium text-sm truncate">{conn.name}</span>
                </div>
                <TypeBadge conn={conn} />
              </div>
              <p className="text-xs text-muted-foreground truncate">
                {describe(conn)}
                {getCredentialName(conn.credential_id) && (
                  <span className="ml-1 text-muted-foreground-soft">
                    · {getCredentialName(conn.credential_id)}
                  </span>
                )}
              </p>
              {/* Tags row — always rendered (empty placeholder when no tags)
                  to keep the actions row pinned to the same baseline across
                  every tile in a grid row regardless of whether tags exist. */}
              <div className="flex flex-wrap gap-1 min-h-[18px]">
                {conn.tags?.map((t) => (
                  <Badge key={t} variant="outline" className="text-[10px] py-0 px-1.5">
                    {t}
                  </Badge>
                ))}
              </div>
              <div className="flex items-center justify-start gap-1 mt-auto">
                {onConnect && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-green-500 hover:text-green-600 focus-visible:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      onConnect(conn);
                    }}
                    aria-label={`Connect to ${conn.name}`}
                    data-testid={`connect-button-${conn.id}`}
                  >
                    <Play className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                )}
                <div className="flex items-center gap-1">
                {onScp && (
                  <span
                    title={
                      conn.type === "port_forward"
                        ? "SCP not available for port-forward connections"
                        : undefined
                    }
                    className="inline-flex"
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={conn.type === "port_forward"}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (conn.type !== "port_forward") onScp(conn);
                      }}
                      aria-label={
                        conn.type === "port_forward"
                          ? "SCP not available for port-forward connections"
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
                  className="h-7 w-7"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClone(conn);
                  }}
                  aria-label={`Clone ${conn.name}`}
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(conn);
                  }}
                  aria-label={`Edit ${conn.name}`}
                  data-testid={`edit-connection-${conn.id}`}
                >
                  <Edit className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(conn.id);
                  }}
                  aria-label={`Delete ${conn.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                </div>
              </div>
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

  return (
    <>
    <div
      className="space-y-1"
      data-testid="connection-list-rows"
      role="list"
      aria-label="Connections"
      onKeyDown={roving.onKeyDown}
    >
      {connections.map((conn, index) => {
        const color = getColorHex(conn.color);
        const itemProps = roving.getItemProps(index);
        return (
          <div
            key={conn.id}
            {...itemProps}
            role="listitem"
            data-testid={`connection-row-${conn.id}`}
            data-name={conn.name}
            aria-label={`${conn.name}${conn.tags && conn.tags.length > 0 ? `, tagged ${conn.tags.join(", ")}` : ""}`}
            aria-selected={selectedId === conn.id || undefined}
            className={cn(
              "group flex items-center gap-3 rounded-lg p-3 cursor-pointer transition-colors hover:bg-accent",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              selectedId === conn.id && "bg-accent",
            )}
            style={color ? { borderLeft: `3px solid ${color}` } : undefined}
            onClick={() => onSelect?.(conn)}
            onContextMenu={(e) => openContextMenu(e, conn)}
            onKeyDown={(e) => {
              // Keyboard alternative for context menu (WCAG 2.1.1).
              if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
                e.preventDefault();
                e.stopPropagation();
                setCtxConn(conn);
                ctx.openAt(e.currentTarget);
              }
            }}
          >
            <div className="flex-shrink-0">
              <ConnIcon conn={conn} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm truncate">{conn.name}</span>
                <TypeBadge conn={conn} />
                {conn.tags?.map((t) => (
                  <Badge key={t} variant="outline" className="text-[10px] py-0 px-1.5">
                    {t}
                  </Badge>
                ))}
              </div>
              <p className="text-xs text-muted-foreground truncate">
                {describe(conn)}
                {getCredentialName(conn.credential_id) && (
                  <span className="ml-2 text-muted-foreground-soft">
                    · {getCredentialName(conn.credential_id)}
                  </span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-1">
              {onConnect && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-green-500 hover:text-green-600"
                  onClick={(e) => {
                    e.stopPropagation();
                    onConnect(conn);
                  }}
                  aria-label={`Connect to ${conn.name}`}
                  data-testid={`connect-button-${conn.id}`}
                >
                  <Play className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              )}
              <div className="flex items-center gap-1">
              {onScp && (
                <span
                  title={
                    conn.type === "port_forward"
                      ? "SCP not available for port-forward connections"
                      : undefined
                  }
                  className="inline-flex"
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    disabled={conn.type === "port_forward"}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (conn.type !== "port_forward") onScp(conn);
                    }}
                    aria-label={
                      conn.type === "port_forward"
                        ? "SCP not available for port-forward connections"
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
                className="h-7 w-7"
                onClick={(e) => {
                  e.stopPropagation();
                  onClone(conn);
                }}
                aria-label={`Clone ${conn.name}`}
              >
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(conn);
                }}
                aria-label={`Edit ${conn.name}`}
                data-testid={`edit-connection-${conn.id}`}
              >
                <Edit className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(conn.id);
                }}
                aria-label={`Delete ${conn.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
              </div>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground-soft shrink-0" />
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
