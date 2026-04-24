import React, { useState } from "react";
import { Connection, Credential, LayoutMode } from "@/types";
import { TunnelTab } from "./TunnelTab";
import { ConnectionList } from "./ConnectionList";
import { LayoutToggle } from "./ui/layout-toggle";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ConfirmDialog";
import { Cable, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TunnelSession {
  sessionId: string;
  connectionName: string;
  connection: Connection;
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
  layout,
  onLayoutChange,
  onCloseSession,
  onConnect,
  onEdit,
  onDelete,
  onClone,
}: TunnelsViewProps) {
  const tunnelDefs = connections.filter((c) => c.type === "port_forward");
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

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <Cable aria-hidden="true" className="h-5 w-5" />
          Tunnels
        </h1>
        <LayoutToggle value={layout} onChange={onLayoutChange} />
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
        {/* Active sessions */}
        <section>
          <h2 className="text-sm font-medium text-muted-foreground mb-2">
            Active ({sessions.length})
          </h2>
          {sessions.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              No tunnel is currently running.
            </p>
          ) : (
            <div className="space-y-3">
              {sessions.map((s) => (
                <div
                  key={s.sessionId}
                  className={cn(
                    "rounded-lg border bg-card overflow-hidden relative",
                  )}
                >
                  <div className="flex items-center justify-between border-b px-3 py-1.5">
                    <span className="text-sm font-medium">{s.connectionName}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() =>
                        setPendingClose({
                          sessionId: s.sessionId,
                          name: s.connectionName,
                        })
                      }
                      aria-label={`Disconnect tunnel ${s.connectionName}`}
                      title="Disconnect tunnel"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                  <div className="h-[260px] relative">
                    <TunnelTab
                      sessionId={s.sessionId}
                      connection={s.connection}
                      isVisible
                      onDisconnect={() =>
                        setPendingClose({
                          sessionId: s.sessionId,
                          name: s.connectionName,
                        })
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Tunnel definitions */}
        <section>
          <h2 className="text-sm font-medium text-muted-foreground mb-2">
            Tunnel definitions ({tunnelDefs.length})
          </h2>
          <ConnectionList
            connections={tunnelDefs}
            credentials={credentials}
            onEdit={onEdit}
            onDelete={onDelete}
            onClone={onClone}
            onConnect={onConnect}
            layout={layout}
          />
        </section>
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
