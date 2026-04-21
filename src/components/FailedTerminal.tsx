import React from "react";
import { AlertCircle, RefreshCw, Pencil } from "lucide-react";
import { Button } from "./ui/button";
import { Connection } from "@/types";

interface FailedTerminalProps {
  connectionName: string;
  error?: string;
  connection?: Connection;
  isVisible: boolean;
  retrying?: boolean;
  onRetry: (conn: Connection) => void;
  onEdit: (conn: Connection) => void;
  onClose: () => void;
}

export function FailedTerminal({
  connectionName,
  error,
  connection,
  isVisible,
  retrying = false,
  onRetry,
  onEdit,
  onClose,
}: FailedTerminalProps) {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-[#1a1b26]"
      style={{ display: isVisible ? "flex" : "none" }}
    >
      <div className="flex flex-col items-center gap-4 max-w-md w-full mx-6 text-center">
        <AlertCircle className={`h-10 w-10 shrink-0 ${error ? "text-destructive" : "text-muted-foreground"}`} />
        <div>
          <p className="text-sm font-semibold text-foreground mb-1">
            {error ? `Could not connect to ${connectionName}` : `Connecting to ${connectionName}…`}
          </p>
          {error && (
            <p className="text-xs text-muted-foreground font-mono break-all">{error}</p>
          )}
        </div>
        <div className="flex gap-2 flex-wrap justify-center">
          {connection && (
            <>
              <Button
                size="sm"
                disabled={retrying}
                onClick={() => onRetry(connection)}
              >
                <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${retrying ? "animate-spin" : ""}`} />
                {retrying ? "Retrying…" : "Retry"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={retrying}
                onClick={() => onEdit(connection)}
              >
                <Pencil className="h-3.5 w-3.5 mr-1.5" />
                Edit Connection
              </Button>
            </>
          )}
          <Button size="sm" variant={retrying && !error ? "destructive" : "ghost"} onClick={onClose}>
            {retrying && !error ? "Cancel" : "Dismiss"}
          </Button>
        </div>
      </div>
    </div>
  );
}
