import React, { useMemo, useState } from "react";
import { Connection, Credential, LayoutMode } from "@/types";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ConfirmDialog";
import { Cable, ChevronDown, ChevronRight, Copy, Pencil, Play, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TunnelSession {
  sessionId: string;
  connectionName: string;
  // Audit-4 Phase 4b: a tunnel session is, by construction, only ever
  // started for a port_forward connection. Narrow at the source so
  // <TunnelTab>'s prop type doesn't need a runtime guard.
  connection: Extract<Connection, { type: "port_forward" }>;
  error?: string;
  retrying?: boolean;
}

interface TunnelsViewProps {
  sessions: TunnelSession[];
  connections: Connection[];
  credentials: Credential[];
  layout: LayoutMode;
  onLayoutChange: (next: LayoutMode) => void;
  onCloseSession: (sessionId: string) => void;
  onConnect: (conn: Connection) => void;
  onEdit: (conn: Connection) => void;
  onDelete: (id: string) => void;
  onClone: (conn: Connection) => void;
}

export function TunnelsView({
  sessions,
  connections,
  credentials,
  layout: _layout,
  onLayoutChange: _onLayoutChange,
  onCloseSession,
  onConnect,
  onEdit,
  onDelete,
  onClone,
}: TunnelsViewProps) {
  const tunnelDefs = connections.filter((c) => c.type === "port_forward");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /*
   * Audit-2 #2: closing a live tunnel is destructive — every TCP
   * connection going through the forwarded port is dropped. AGENTS.md
   * requires destructive actions to go through <ConfirmDialog>; the
   * same standard that gates "close live terminal pane" applies here.
   */
  const [pendingClose, setPendingClose] = useState<{
    sessionId: string;
    name: string;
  } | null>(null);

  const getCredentialName = (id?: string) =>
    id ? credentials.find((c) => c.id === id)?.name ?? "Unknown credential" : "No credential";

  const latestSessionByConnectionId = useMemo(() => {
    const map = new Map<string, TunnelSession>();
    for (const session of sessions) {
      map.set(session.connection.id, session);
    }
    return map;
  }, [sessions]);

  const getLatestSession = (conn: Extract<Connection, { type: "port_forward" }>) =>
    latestSessionByConnectionId.get(conn.id) ?? null;

  const getStatus = (session: TunnelSession | null) => {
    if (!session) return "disconnected";
    if (session.error) return "error";
    if (session.retrying) return "connecting";
    return "connected";
  };

  const toggleExpanded = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <Cable aria-hidden="true" className="h-5 w-5" />
          Tunnels
        </h1>
        <span className="text-xs text-muted-foreground">
          {tunnelDefs.length} configured
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {tunnelDefs.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">
            No tunnel connections configured yet.
          </p>
        ) : (
          <div className="space-y-3">
            {tunnelDefs.map((conn) => {
              const session = getLatestSession(conn);
              const status = getStatus(session);
              const isExpanded = expanded.has(conn.id);
              const statusLabel =
                status === "connected"
                  ? "Connected"
                  : status === "error"
                    ? "Error connecting"
                    : status === "connecting"
                      ? "Connecting"
                      : "Not connected";
              return (
                <section
                  key={conn.id}
                  data-testid={`tunnel-row-${conn.id}`}
                  data-name={conn.name}
                  data-status={status}
                  data-session-id={session?.sessionId}
                  className="rounded-lg border bg-card overflow-hidden"
                >
                  <div className="flex items-center gap-3 px-3 py-2">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      onClick={() => toggleExpanded(conn.id)}
                      aria-expanded={isExpanded}
                      aria-controls={`tunnel-details-${conn.id}`}
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      )}
                      <span
                        data-testid={`tunnel-status-${conn.id}`}
                        className={cn(
                          "h-2.5 w-2.5 rounded-full border",
                          status === "connected" && "bg-green-500 border-green-400",
                          status === "error" && "bg-red-500 border-red-400",
                          (status === "disconnected" || status === "connecting") &&
                            "bg-muted-foreground/60 border-muted-foreground/50",
                        )}
                        aria-label={`${conn.name}: ${statusLabel}`}
                        role="img"
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{conn.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          127.0.0.1:{conn.local_port} → {conn.destination_host}:{conn.destination_port}
                        </span>
                      </span>
                    </button>
                    {status === "connected" || status === "connecting" ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() =>
                          session &&
                          setPendingClose({
                            sessionId: session.sessionId,
                            name: conn.name,
                          })
                        }
                        data-testid={`tunnel-stop-${conn.id}`}
                        aria-label={`Disconnect tunnel ${conn.name}`}
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => onConnect(conn)}
                        data-testid={`connect-button-${conn.id}`}
                        aria-label={`Connect ${conn.name}`}
                      >
                        <Play className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                  {isExpanded && (
                    <div
                      id={`tunnel-details-${conn.id}`}
                      className="border-t bg-background/40 px-4 py-3 text-sm"
                    >
                      <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[max-content_1fr]">
                        <dt className="text-muted-foreground">Status</dt>
                        <dd>{statusLabel}</dd>
                        <dt className="text-muted-foreground">Gateway</dt>
                        <dd>{conn.gateway_host}:{conn.gateway_port}</dd>
                        <dt className="text-muted-foreground">Credential</dt>
                        <dd>{getCredentialName(conn.gateway_credential_id)}</dd>
                        <dt className="text-muted-foreground">Destination</dt>
                        <dd>{conn.destination_host}:{conn.destination_port}</dd>
                        <dt className="text-muted-foreground">Local port</dt>
                        <dd>{conn.local_port}</dd>
                        {session?.error && (
                          <>
                            <dt className="text-muted-foreground">Error</dt>
                            <dd className="text-destructive">{session.error}</dd>
                          </>
                        )}
                      </dl>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button variant="outline" size="sm" onClick={() => onEdit(conn)}>
                          <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                          Edit
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => onClone(conn)}>
                          <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                          Clone
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => onDelete(conn.id)}>
                          <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                          Delete
                        </Button>
                      </div>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingClose !== null}
        onOpenChange={(open) => {
          if (!open) setPendingClose(null);
        }}
        title="Disconnect tunnel?"
        description={
          pendingClose
            ? `Disconnecting "${pendingClose.name}" will drop every TCP connection currently using the forwarded port.`
            : ""
        }
        confirmLabel="Disconnect"
        variant="destructive"
        onConfirm={() => {
          if (pendingClose) {
            onCloseSession(pendingClose.sessionId);
            setPendingClose(null);
          }
        }}
      />
    </div>
  );
}
