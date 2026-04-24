import React, { useEffect, useState } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { Connection } from "@/types";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";
import { Network, ArrowRight, Activity, AlertCircle } from "lucide-react";

/**
 * Status payload emitted on `tunnel-status-{sessionId}`. Mirror of
 * `TunnelStatus` in `src-tauri/src/ssh.rs`.
 */
export interface TunnelStatusPayload {
  state: "listening" | "client_connected" | "client_closed" | "error";
  local_port: number;
  destination: string;
  message?: string | null;
  active_clients: number;
}

interface TunnelTabProps {
  sessionId: string;
  connection: Connection;
  isVisible: boolean;
  onDisconnect: () => void;
}

interface LogEntry {
  ts: number;
  state: TunnelStatusPayload["state"];
  message: string;
}

export function TunnelTab({
  sessionId,
  connection,
  isVisible,
  onDisconnect,
}: TunnelTabProps) {
  const [activeClients, setActiveClients] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    (async () => {
      try {
        unlisten = await listen<TunnelStatusPayload>(
          `tunnel-status-${sessionId}`,
          (event) => {
            const payload = event.payload;
            if (cancelled) return;
            setActiveClients(payload.active_clients);
            if (payload.state === "error") {
              setLastError(payload.message ?? "tunnel error");
            }
            setLog((prev) =>
              [
                ...prev,
                {
                  ts: Date.now(),
                  state: payload.state,
                  message: payload.message ?? payload.state,
                },
              ].slice(-50),
            );
          },
        );
      } catch {
        // ignore — listener wiring failure is non-fatal for the UI
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [sessionId]);

  const localPort = connection.local_port;
  const destination = `${connection.destination_host}:${connection.destination_port}`;
  const gateway = `${connection.gateway_host}:${connection.gateway_port}`;

  return (
    <div
      className={cn(
        "absolute inset-0 flex flex-col bg-background overflow-y-auto",
        isVisible ? "block" : "hidden",
      )}
    >
      <div className="p-6 max-w-2xl mx-auto w-full space-y-6">
        <div className="flex items-center gap-3">
          <Network aria-hidden="true" className="h-6 w-6 text-primary" />
          <div>
            <h2 className="text-lg font-semibold">{connection.name}</h2>
            <p className="text-xs text-muted-foreground">
              SSH port forward · session {sessionId.slice(0, 8)}
            </p>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-4 space-y-3">
          <div className="flex items-center gap-3 text-sm">
            <code className="px-2 py-1 rounded bg-muted text-xs">
              127.0.0.1:{localPort}
            </code>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
            <code className="px-2 py-1 rounded bg-muted text-xs">
              {gateway}
            </code>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
            <code className="px-2 py-1 rounded bg-muted text-xs">
              {destination}
            </code>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Activity
              aria-hidden="true"
              className={cn(
                "h-4 w-4",
                activeClients > 0 ? "text-green-500" : "text-muted-foreground",
              )}
            />
            {/*
             * Audit-2 #3: tunnel status changes (a client connects /
             * disconnects, listener (re)opens) are meaningful to AT
             * users but were previously silent. The line below is the
             * single source of truth for the current state and lives
             * in an always-mounted polite live region so subscriptions
             * persist across renders. Text toggles, the region itself
             * does not get re-mounted.
             */}
            <span role="status" aria-live="polite" aria-atomic="true">
              {activeClients} active client{activeClients === 1 ? "" : "s"}
            </span>
          </div>
        </div>

        {/*
         * Audit-2 #3: tunnel errors (e.g. listener bind failure, remote
         * channel rejected) need to be announced immediately to AT
         * users. role="alert" + aria-live="assertive" interrupts the
         * current AT speech queue. Conditional mount is the standard
         * pattern for role=alert (announcement fires on insertion).
         */}
        {lastError && (
          <div
            role="alert"
            aria-live="assertive"
            className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            <AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{lastError}</span>
          </div>
        )}

        <div className="rounded-lg border bg-card">
          <div className="border-b px-4 py-2 text-xs font-medium text-muted-foreground">
            Activity
          </div>
          <div className="max-h-[260px] overflow-y-auto p-3 space-y-1">
            {log.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Waiting for events…
              </p>
            ) : (
              log.map((entry, i) => (
                <div key={i} className="flex gap-2 text-xs font-mono">
                  <span className="text-muted-foreground shrink-0">
                    {new Date(entry.ts).toLocaleTimeString()}
                  </span>
                  <span
                    className={cn(
                      "shrink-0",
                      entry.state === "error"
                        ? "text-destructive"
                        : entry.state === "client_connected"
                          ? "text-green-500"
                          : "text-muted-foreground",
                    )}
                  >
                    {entry.state}
                  </span>
                  <span className="text-foreground/80 truncate">
                    {entry.message}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="flex justify-end">
          {/*
            Audit-3 P2#12: this is a destructive action on a live
            session — disconnecting drops every TCP connection
            currently using the forwarded port. Per the AGENTS.md
            destructive-action contract, `onDisconnect` is REQUIRED
            to open a <ConfirmDialog> in the caller (see
            TunnelsView.setPendingClose). Do NOT wire this prop
            directly to a state-mutating dispatch — go through the
            confirm flow. The contract is pinned by the
            "Stop tunnel button opens the confirm dialog" test in
            TunnelsView.test.tsx.
          */}
          <Button variant="destructive" size="sm" onClick={onDisconnect}>
            Stop tunnel
          </Button>
        </div>
      </div>
    </div>
  );
}
