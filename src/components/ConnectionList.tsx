import React from "react";
import { Connection, Credential } from "@/types";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Server, Edit, Trash2, Copy, Network, ChevronRight, Play } from "lucide-react";
import { cn } from "@/lib/utils";

interface ConnectionListProps {
  connections: Connection[];
  credentials: Credential[];
  onEdit: (connection: Connection) => void;
  onDelete: (id: string) => void;
  onClone: (connection: Connection) => void;
  onSelect?: (connection: Connection) => void;
  onConnect?: (connection: Connection) => void;
  selectedId?: string;
}

export function ConnectionList({
  connections,
  credentials,
  onEdit,
  onDelete,
  onClone,
  onSelect,
  onConnect,
  selectedId,
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

  return (
    <div className="space-y-1">
      {connections.map((conn) => (
        <div
          key={conn.id}
          className={cn(
            "group flex items-center gap-3 rounded-lg p-3 cursor-pointer transition-colors hover:bg-accent",
            selectedId === conn.id && "bg-accent"
          )}
          onClick={() => onSelect?.(conn)}
        >
          <div className="flex-shrink-0">
            {conn.type !== "direct" ? (
              <Network className="h-5 w-5 text-muted-foreground" />
            ) : (
              <Server className="h-5 w-5 text-muted-foreground" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm truncate">{conn.name}</span>
              {conn.type === "port_forward" && (
                <Badge variant="secondary" className="text-xs shrink-0">
                  port-forward
                </Badge>
              )}
              {conn.type === "jump_shell" && (
                <Badge variant="secondary" className="text-xs shrink-0">
                  jump-shell
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground truncate">
              {conn.type === "port_forward" ? (
                <>
                  127.0.0.1:{conn.local_port} → {conn.destination_host}:
                  {conn.destination_port} via {conn.gateway_host}
                </>
              ) : conn.type === "jump_shell" ? (
                <>
                  {conn.destination_host}:{conn.destination_port} via{" "}
                  {conn.gateway_host}
                </>
              ) : (
                <>
                  {conn.host}:{conn.port}
                </>
              )}
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
      ))}
    </div>
  );
}
