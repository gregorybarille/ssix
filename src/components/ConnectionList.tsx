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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getColorHex } from "@/lib/colors";

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

  if (connections.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Server className="h-12 w-12 mb-3 opacity-30" />
        <p className="text-sm">No connections yet</p>
        <p className="text-xs mt-1">Create your first SSH connection</p>
      </div>
    );
  }

  if (layout === "tile") {
    return (
      <div
        className="grid gap-3"
        data-testid="connection-grid"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
      >
        {connections.map((conn) => {
          const color = getColorHex(conn.color);
          return (
            <div
              key={conn.id}
              className={cn(
                "group rounded-lg border p-3 cursor-pointer transition-colors hover:bg-accent flex flex-col gap-2",
                selectedId === conn.id && "bg-accent",
              )}
              style={
                color
                  ? { borderLeft: `3px solid ${color}` }
                  : undefined
              }
              onClick={() => onSelect?.(conn)}
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
                  <span className="ml-1 text-muted-foreground/70">
                    · {getCredentialName(conn.credential_id)}
                  </span>
                )}
              </p>
              {conn.tags && conn.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {conn.tags.map((t) => (
                    <Badge key={t} variant="outline" className="text-[10px] py-0 px-1.5">
                      {t}
                    </Badge>
                  ))}
                </div>
              )}
              <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {onConnect && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-green-500 hover:text-green-600"
                    onClick={(e) => {
                      e.stopPropagation();
                      onConnect(conn);
                    }}
                    title="Connect"
                  >
                    <Play className="h-3.5 w-3.5" />
                  </Button>
                )}
                {onScp && conn.type !== "port_forward" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={(e) => {
                      e.stopPropagation();
                      onScp(conn);
                    }}
                    title="Transfer files"
                  >
                    <ArrowUpDown className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClone(conn);
                  }}
                  title="Clone connection"
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(conn);
                  }}
                  title="Edit connection"
                >
                  <Edit className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(conn.id);
                  }}
                  title="Delete connection"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {connections.map((conn) => {
        const color = getColorHex(conn.color);
        return (
          <div
            key={conn.id}
            className={cn(
              "group flex items-center gap-3 rounded-lg p-3 cursor-pointer transition-colors hover:bg-accent",
              selectedId === conn.id && "bg-accent",
            )}
            style={color ? { borderLeft: `3px solid ${color}` } : undefined}
            onClick={() => onSelect?.(conn)}
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
                  <span className="ml-2 text-muted-foreground/70">
                    · {getCredentialName(conn.credential_id)}
                  </span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              {onConnect && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-green-500 hover:text-green-600"
                  onClick={(e) => {
                    e.stopPropagation();
                    onConnect(conn);
                  }}
                  title="Connect"
                >
                  <Play className="h-3.5 w-3.5" />
                </Button>
              )}
              {onScp && conn.type !== "port_forward" && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={(e) => {
                    e.stopPropagation();
                    onScp(conn);
                  }}
                  title="Transfer files"
                >
                  <ArrowUpDown className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={(e) => {
                  e.stopPropagation();
                  onClone(conn);
                }}
                title="Clone connection"
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(conn);
                }}
                title="Edit connection"
              >
                <Edit className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(conn.id);
                }}
                title="Delete connection"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0" />
          </div>
        );
      })}
    </div>
  );
}
